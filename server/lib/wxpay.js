// 微信支付 API v3（直连商户）：小程序下单、查单、退款、解密支付通知。
// 需要：商户号、商户 API 证书的序列号和私钥文件（apiclient_key.pem）、APIv3 密钥。这些都填在服务器配置文件里，不进代码仓库。
// 支付通知用 APIv3 密钥解密（AES-GCM 本身能防篡改），业务代码收到后还会再查一次单、核对金额。
// 如果配置了「微信支付公钥」，还会校验通知的签名。
const crypto = require('crypto')

const API = 'https://api.mch.weixin.qq.com'

function payError(status, data) {
  const msg = (data && data.message) || ('HTTP ' + status)
  const e = new Error('wxpay ' + status + ' ' + ((data && data.code) || '') + ' ' + msg)
  e.status = status
  e.wxCode = (data && data.code) || ''
  e.wxMessage = msg
  return e
}

function nonce() {
  return crypto.randomBytes(16).toString('hex')
}

// options: { appId, mchId, serialNo, privateKey, apiV3Key, publicKey, publicKeyId, notifyBase, fetch }
function createWxpay(options) {
  const o = Object.assign({ fetch: globalThis.fetch }, options || {})

  function ready() {
    return !!(o.appId && o.mchId && o.serialNo && o.privateKey && o.apiV3Key && String(o.apiV3Key).length === 32 && o.notifyBase)
  }

  function sign(message) {
    return crypto.createSign('RSA-SHA256').update(message).sign(o.privateKey, 'base64')
  }

  async function request(method, path, body) {
    if (!ready()) throw payError(0, { code: 'NOT_CONFIGURED', message: '服务器上还没配置微信支付' })
    const text = body ? JSON.stringify(body) : ''
    const ts = Math.floor(Date.now() / 1000).toString()
    const n = nonce()
    const signature = sign(method + '\n' + path + '\n' + ts + '\n' + n + '\n' + text + '\n')
    const auth = 'WECHATPAY2-SHA256-RSA2048 mchid="' + o.mchId + '",nonce_str="' + n + '",signature="' + signature +
      '",timestamp="' + ts + '",serial_no="' + o.serialNo + '"'
    const res = await o.fetch(API + path, {
      method,
      headers: { authorization: auth, accept: 'application/json', 'content-type': 'application/json', 'user-agent': 'jinshan-coffee' },
      body: text || undefined
    })
    const raw = await res.text()
    let data = null
    try {
      data = raw ? JSON.parse(raw) : {}
    } catch (e) {
      data = { message: raw.slice(0, 200) }
    }
    if (res.status < 200 || res.status >= 300) throw payError(res.status, data)
    return data
  }

  // 小程序下单，返回 wx.requestPayment 要的参数
  // timeExpire（毫秒时间戳，可不传）：过了这个时间微信就不让付了，预约单用它
  async function jsapi({ description, outTradeNo, total, openid, notifyPath, timeExpire }) {
    const body = {
      appid: o.appId,
      mchid: o.mchId,
      description,
      out_trade_no: outTradeNo,
      notify_url: o.notifyBase.replace(/\/+$/, '') + notifyPath,
      amount: { total, currency: 'CNY' },
      payer: { openid }
    }
    if (timeExpire) body.time_expire = new Date(timeExpire + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00'
    const data = await request('POST', '/v3/pay/transactions/jsapi', body)
    const timeStamp = Math.floor(Date.now() / 1000).toString()
    const nonceStr = nonce()
    const pkg = 'prepay_id=' + data.prepay_id
    return { timeStamp, nonceStr, package: pkg, signType: 'RSA', paySign: sign(o.appId + '\n' + timeStamp + '\n' + nonceStr + '\n' + pkg + '\n') }
  }

  // 查单：返回 { tradeState, transactionId, total, payerOpenid }；单子不存在返回 null
  async function query(outTradeNo) {
    try {
      const data = await request('GET', '/v3/pay/transactions/out-trade-no/' + encodeURIComponent(outTradeNo) + '?mchid=' + encodeURIComponent(o.mchId))
      return {
        tradeState: data.trade_state,
        transactionId: data.transaction_id || '',
        total: data.amount ? data.amount.total : 0,
        payerOpenid: (data.payer && data.payer.openid) || ''
      }
    } catch (e) {
      if (e.status === 404 || e.wxCode === 'ORDER_NOT_EXIST') return null
      throw e
    }
  }

  // 退款（同一个退款单号重复提交，微信只退一次）
  async function refund({ outTradeNo, outRefundNo, total, refund: amount }) {
    const data = await request('POST', '/v3/refund/domestic/refunds', {
      out_trade_no: outTradeNo,
      out_refund_no: outRefundNo,
      amount: { refund: amount, total, currency: 'CNY' }
    })
    return { status: data.status, refundId: data.refund_id || '' }
  }

  function decrypt(resource) {
    const key = Buffer.from(String(o.apiV3Key), 'utf8')
    const buf = Buffer.from(resource.ciphertext, 'base64')
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'))
    decipher.setAuthTag(buf.subarray(buf.length - 16))
    if (resource.associated_data) decipher.setAAD(Buffer.from(resource.associated_data, 'utf8'))
    return Buffer.concat([decipher.update(buf.subarray(0, buf.length - 16)), decipher.final()]).toString('utf8')
  }

  // 解析支付通知；格式不对、解不开、签名不对都会抛错（服务器回 500，微信过一会儿重发）
  function parseNotify(headers, rawBody) {
    if (!ready()) throw new Error('wxpay not configured')
    const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '')
    if (o.publicKey) {
      const h = (k) => String(headers[k] || '')
      if (o.publicKeyId && h('wechatpay-serial') !== o.publicKeyId) throw new Error('wxpay notify serial mismatch')
      const ts = Number(h('wechatpay-timestamp'))
      if (!ts || Math.abs(Date.now() / 1000 - ts) > 300) throw new Error('wxpay notify timestamp too old')
      const message = h('wechatpay-timestamp') + '\n' + h('wechatpay-nonce') + '\n' + text + '\n'
      const ok = crypto.createVerify('RSA-SHA256').update(message).verify(o.publicKey, h('wechatpay-signature'), 'base64')
      if (!ok) throw new Error('wxpay notify bad signature')
    }
    const body = JSON.parse(text)
    if (!body.resource || body.resource.algorithm !== 'AEAD_AES_256_GCM') throw new Error('wxpay notify bad resource')
    const data = JSON.parse(decrypt(body.resource))
    return { eventType: body.event_type || '', outTradeNo: data.out_trade_no || '', tradeState: data.trade_state || '', data }
  }

  return { get mchId() { return ready() ? o.mchId : '' }, ready, jsapi, query, refund, parseNotify, decrypt }
}

module.exports = { createWxpay }
