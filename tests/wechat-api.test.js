// 直接对接微信的两部分：微信接口（登录、小程序码、订阅消息）和微信支付 v3（签名、下单、查单、退款、解密通知）
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { createWechat } = require('../server/lib/wechat')
const { createWxpay } = require('../server/lib/wxpay')
const { fakeFetch, encryptNotify, API_V3_KEY } = require('./helpers/wx')

test('小程序登录：code 换 openid；微信报错时带上错误码', async () => {
  const fetch = fakeFetch([{ body: { openid: 'o123', session_key: 'k' } }, { body: { errcode: 40029, errmsg: 'invalid code' } }])
  const wx = createWechat({ appId: 'wxapp', appSecret: 'secret', fetch })
  assert.deepEqual(await wx.code2session('c1'), { openid: 'o123', unionid: '' })
  assert.match(fetch.calls[0].url, /\/sns\/jscode2session\?appid=wxapp&secret=secret&js_code=c1&grant_type=authorization_code$/)
  await assert.rejects(wx.code2session('bad'), (e) => e.errCode === 40029)
  await assert.rejects(createWechat({ appId: 'wxapp', appSecret: '' }).code2session('x'), /appSecret/)
})

test('小程序码：返回图片；access_token 缓存起来，失效时刷新一次再试', async () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
  const fetch = fakeFetch([
    { body: { access_token: 'T1', expires_in: 7200 } },
    { body: png, type: 'image/png' },
    { body: { errcode: 40001, errmsg: 'invalid credential' } },
    { body: { access_token: 'T2', expires_in: 7200 } },
    { body: png, type: 'image/jpeg' },
    { body: { errcode: 41030, errmsg: 'invalid page' } }
  ])
  const wx = createWechat({ appId: 'wxapp', appSecret: 'secret', fetch })
  const a = await wx.getUnlimited({ scene: 'w=abc', page: 'admin/pages/web-login/web-login', checkPath: true, envVersion: 'release', width: 430 })
  assert.deepEqual(a.buffer, png)
  assert.equal(a.contentType, 'image/png')
  const sent = JSON.parse(fetch.calls[1].init.body)
  assert.deepEqual(sent, { scene: 'w=abc', page: 'admin/pages/web-login/web-login', check_path: true, env_version: 'release', width: 430 })
  assert.match(fetch.calls[1].url, /access_token=T1$/)
  // 第二次用缓存的 token，失效后刷新
  const b = await wx.getUnlimited({ scene: 't=5', page: 'pages/menu/menu', checkPath: false, envVersion: 'trial' })
  assert.deepEqual(b.buffer, png)
  assert.match(fetch.calls[2].url, /access_token=T1$/)
  assert.equal(JSON.parse(fetch.calls[3].init.body).force_refresh, true)
  assert.match(fetch.calls[4].url, /access_token=T2$/)
  // 别的错误照原样抛出，业务代码靠 errCode 判断（41030 时改用体验版）
  await assert.rejects(wx.getUnlimited({ scene: 'x', page: 'p' }), (e) => e.errCode === 41030)
})

test('订阅消息：读我的模板、发消息；token 失效时刷新一次，别的错误带错误码抛出', async () => {
  const fetch = fakeFetch([
    { body: { access_token: 'T1', expires_in: 7200 } },
    { body: { errcode: 0, errmsg: 'ok', data: [{ priTmplId: 'TPL', title: '取餐提醒', content: '取餐号:{{character_string1.DATA}}\n' }] } },
    { body: { errcode: 42001, errmsg: 'access_token expired' } },
    { body: { access_token: 'T2', expires_in: 7200 } },
    { body: { errcode: 0, errmsg: 'ok' } },
    { body: { errcode: 43101, errmsg: 'user refuse to accept the msg' } }
  ])
  const wx = createWechat({ appId: 'wxapp', appSecret: 'secret', fetch })
  const list = await wx.getTemplateList()
  assert.equal(list[0].priTmplId, 'TPL')
  assert.match(fetch.calls[1].url, /\/wxaapi\/newtmpl\/gettemplate\?access_token=T1$/)
  assert.equal(fetch.calls[1].init.method, 'GET')
  const msg = { touser: 'o1', templateId: 'TPL', page: 'pages/order-detail/order-detail?id=1', data: { character_string1: { value: '012' } }, miniprogramState: 'trial' }
  assert.equal(await wx.sendSubscribe(msg), true)
  assert.match(fetch.calls[4].url, /\/cgi-bin\/message\/subscribe\/send\?access_token=T2$/)
  assert.deepEqual(JSON.parse(fetch.calls[4].init.body), {
    touser: 'o1', template_id: 'TPL', page: 'pages/order-detail/order-detail?id=1',
    data: { character_string1: { value: '012' } }, miniprogram_state: 'trial', lang: 'zh_CN'
  })
  await assert.rejects(wx.sendSubscribe(msg), (e) => e.errCode === 43101)
})

test('发货信息管理：问开没开、上传发货信息；微信的错误码带出来', async () => {
  const fetch = fakeFetch([
    { body: { access_token: 'T1', expires_in: 7200 } },
    { body: { errcode: 0, errmsg: 'ok', is_trade_managed: true } },
    { body: { errcode: 0, errmsg: 'ok' } },
    { body: { errcode: 10060002, errmsg: 'already shipped' } }
  ])
  const wx = createWechat({ appId: 'wxapp', appSecret: 'secret', fetch })
  assert.equal(await wx.isTradeManaged(), true)
  assert.match(fetch.calls[1].url, /\/wxa\/sec\/order\/is_trade_managed\?access_token=T1$/)
  assert.deepEqual(JSON.parse(fetch.calls[1].init.body), { appid: 'wxapp' })
  const body = { order_key: { order_number_type: 2, transaction_id: 'tx1' }, logistics_type: 4, delivery_mode: 1, shipping_list: [{ item_desc: '手冲' }], upload_time: '2026-11-06T18:00:00+08:00', payer: { openid: 'o1' } }
  assert.equal(await wx.uploadShipping(body), true)
  assert.match(fetch.calls[2].url, /\/wxa\/sec\/order\/upload_shipping_info\?access_token=T1$/)
  assert.deepEqual(JSON.parse(fetch.calls[2].init.body), body)
  await assert.rejects(wx.uploadShipping(body), (e) => e.errCode === 10060002)
})

const keys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const merchantKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' })
const merchantPub = keys.publicKey
const platform = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })

function payWith(fetch, extra) {
  return createWxpay(Object.assign({
    appId: 'wxapp',
    mchId: '1900000109',
    serialNo: 'SERIAL1',
    privateKey: merchantKey,
    apiV3Key: API_V3_KEY,
    notifyBase: 'https://shop.example.com/',
    fetch
  }, extra || {}))
}

test('支付配置不全时不算开通', () => {
  assert.equal(payWith(null).ready(), true)
  assert.equal(payWith(null).mchId, '1900000109')
  assert.equal(payWith(null, { apiV3Key: 'short' }).ready(), false)
  assert.equal(payWith(null, { privateKey: '' }).ready(), false)
  assert.equal(payWith(null, { notifyBase: '' }).ready(), false)
  assert.equal(payWith(null, { mchId: '' }).mchId, '')
})

test('下单：请求带商户签名，返回给小程序的参数也签好名', async () => {
  const fetch = fakeFetch([{ body: { prepay_id: 'wx201410272009395522657a690389285100' } }])
  const pay = payWith(fetch)
  const p = await pay.jsapi({ description: '进山咖啡-取餐号5', outTradeNo: 'JS1', total: 3200, openid: 'o123', notifyPath: '/pay/notify/coffee' })
  const call = fetch.calls[0]
  assert.equal(call.url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi')
  const body = JSON.parse(call.init.body)
  assert.deepEqual(body, {
    appid: 'wxapp', mchid: '1900000109', description: '进山咖啡-取餐号5', out_trade_no: 'JS1',
    notify_url: 'https://shop.example.com/pay/notify/coffee', amount: { total: 3200, currency: 'CNY' }, payer: { openid: 'o123' }
  })
  // 用商户公钥验一下 Authorization 里的签名
  const auth = call.init.headers.authorization
  const f = Object.fromEntries([...auth.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
  assert.ok(auth.startsWith('WECHATPAY2-SHA256-RSA2048 '))
  assert.equal(f.mchid, '1900000109')
  assert.equal(f.serial_no, 'SERIAL1')
  const message = 'POST\n/v3/pay/transactions/jsapi\n' + f.timestamp + '\n' + f.nonce_str + '\n' + call.init.body + '\n'
  assert.ok(crypto.createVerify('RSA-SHA256').update(message).verify(merchantPub, f.signature, 'base64'))
  // 小程序 wx.requestPayment 的参数
  assert.equal(p.package, 'prepay_id=wx201410272009395522657a690389285100')
  assert.equal(p.signType, 'RSA')
  const payMessage = 'wxapp\n' + p.timeStamp + '\n' + p.nonceStr + '\n' + p.package + '\n'
  assert.ok(crypto.createVerify('RSA-SHA256').update(payMessage).verify(merchantPub, p.paySign, 'base64'))
})

test('预约单下单时带上最晚付款时间（北京时间）', async () => {
  const fetch = fakeFetch([{ body: { prepay_id: 'wx1' } }])
  await payWith(fetch).jsapi({ description: 'x', outTradeNo: 'JS2', total: 100, openid: 'o1', notifyPath: '/pay/notify/coffee', timeExpire: Date.parse('2026-10-25T07:15:30Z') })
  assert.equal(JSON.parse(fetch.calls[0].init.body).time_expire, '2026-10-25T15:15:30+08:00')
})

test('查单、退款；查不到的单返回 null，其他错误带上微信的说明', async () => {
  const fetch = fakeFetch([
    { body: { trade_state: 'SUCCESS', transaction_id: 'tx1', amount: { total: 3200, payer_total: 3200 }, payer: { openid: 'oPayer' } } },
    { status: 404, body: { code: 'ORDER_NOT_EXIST', message: '订单不存在' } },
    { body: { status: 'PROCESSING', refund_id: 'rf1' } },
    { status: 403, body: { code: 'NOT_ENOUGH', message: '基本账户余额不足' } }
  ])
  const pay = payWith(fetch)
  assert.deepEqual(await pay.query('JS1'), { tradeState: 'SUCCESS', transactionId: 'tx1', total: 3200, payerOpenid: 'oPayer' })
  assert.equal(fetch.calls[0].init.method, 'GET')
  assert.equal(fetch.calls[0].url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/out-trade-no/JS1?mchid=1900000109')
  assert.equal(await pay.query('JS2'), null)
  assert.deepEqual(await pay.refund({ outTradeNo: 'JS1', outRefundNo: 'RJS1', total: 3200, refund: 3200 }), { status: 'PROCESSING', refundId: 'rf1' })
  assert.deepEqual(JSON.parse(fetch.calls[2].init.body), { out_trade_no: 'JS1', out_refund_no: 'RJS1', amount: { refund: 3200, total: 3200, currency: 'CNY' } })
  await assert.rejects(pay.refund({ outTradeNo: 'JS1', outRefundNo: 'RJS1', total: 3200, refund: 3200 }), (e) => e.wxMessage === '基本账户余额不足')
  await assert.rejects(payWith(null, { mchId: '' }).query('JS1'), (e) => e.wxCode === 'NOT_CONFIGURED')
})

test('支付通知：用 APIv3 密钥解开；密钥不对、内容被改都解不开', () => {
  const pay = payWith(null)
  const raw = encryptNotify({ out_trade_no: 'JS1', trade_state: 'SUCCESS', amount: { total: 3200 } })
  const note = pay.parseNotify({}, Buffer.from(raw))
  assert.equal(note.eventType, 'TRANSACTION.SUCCESS')
  assert.equal(note.outTradeNo, 'JS1')
  assert.equal(note.tradeState, 'SUCCESS')
  assert.throws(() => pay.parseNotify({}, encryptNotify({ out_trade_no: 'JS1' }, 'x'.repeat(32))))
  const tampered = JSON.parse(raw)
  tampered.resource.associated_data = 'other'
  assert.throws(() => pay.parseNotify({}, JSON.stringify(tampered)))
  assert.throws(() => pay.parseNotify({}, 'not json'))
})

test('配置了微信支付公钥时还要验签名', () => {
  const publicKey = platform.publicKey.export({ type: 'spki', format: 'pem' })
  const pay = payWith(null, { publicKey, publicKeyId: 'PUB_KEY_ID_1' })
  const raw = encryptNotify({ out_trade_no: 'JB1', trade_state: 'SUCCESS' })
  const ts = String(Math.floor(Date.now() / 1000))
  const nonce = 'n1'
  const sig = crypto.createSign('RSA-SHA256').update(ts + '\n' + nonce + '\n' + raw + '\n').sign(platform.privateKey, 'base64')
  const headers = { 'wechatpay-timestamp': ts, 'wechatpay-nonce': nonce, 'wechatpay-signature': sig, 'wechatpay-serial': 'PUB_KEY_ID_1' }
  assert.equal(pay.parseNotify(headers, raw).outTradeNo, 'JB1')
  assert.throws(() => pay.parseNotify(Object.assign({}, headers, { 'wechatpay-signature': 'AAAA' }), raw), /bad signature/)
  assert.throws(() => pay.parseNotify(Object.assign({}, headers, { 'wechatpay-serial': 'OTHER' }), raw), /serial/)
  assert.throws(() => pay.parseNotify(Object.assign({}, headers, { 'wechatpay-timestamp': String(Number(ts) - 3600) }), raw), /too old/)
})
