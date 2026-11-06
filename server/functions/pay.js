// 微信支付（直连商户号，API v3）：咖啡和借书共用咖啡的商户号；洗车是另一个执照，用洗车自己的商户号（shop: 'carwash'）。
// 商户号、API 证书、APIv3 密钥填在服务器的配置文件里（见 README），店主在后台「店铺设置」里只管开关。
// 支付成功后微信会通知服务器 /pay/notify/<模块名>，通知里再向微信查一次单、核对金额，才标成已付。
// 下面的 shop 参数不传就是咖啡。
const cloud = require('../platform')
const { BizError } = require('./base')
const { readShop } = require('./shop')

const DEFAULTS = { payEnabled: false, allowCounter: true }

function payReady(shop) {
  return cloud.payOf(shop).ready()
}

// 付款人在这个小程序里的 openid：微信支付认的是小程序自己的 openid，不是用户 id（见 lib/identity.js）。
// 咖啡的单只能在咖啡小程序里付，洗车的只能在洗车小程序里付
function payerOpenid(shop, openid) {
  const ctx = cloud.getWXContext()
  const want = shop === 'carwash' ? 'carwash' : 'coffee'
  if (ctx.APP && ctx.APP !== want) {
    throw new BizError(want === 'carwash' ? '请在洗车小程序里付款' : '请在进山咖啡小程序里付款', 'WRONG_APP')
  }
  return ctx.APP_OPENID || openid
}

async function getSettings(db) {
  const s = Object.assign({}, DEFAULTS, await readShop(db))
  return { payEnabled: !!(s.payEnabled && payReady()), allowCounter: s.allowCounter !== false }
}

// 给顾客端看的：能不能微信支付、还能不能到吧台付
function publicPay(settings) {
  return { enabled: settings.payEnabled, allowCounter: !settings.payEnabled || settings.allowCounter }
}

// 下单，返回给 wx.requestPayment 用的参数；openid 是付款的顾客
// timeExpire：过了这个时间不能再付（毫秒时间戳，可不传）
async function unifiedOrder(settings, { body, outTradeNo, totalFee, openid, notify, timeExpire, shop }) {
  if (!settings.payEnabled) throw new BizError('店里还没开通微信支付，请到吧台付款', 'PAY_DISABLED')
  if (!Number.isInteger(totalFee) || totalFee <= 0) throw new BizError('金额不对')
  if (!openid) throw new BizError('请在微信里打开小程序付款')
  const payer = payerOpenid(shop, openid)
  try {
    return await cloud.payOf(shop).jsapi({
      description: Array.from(body).slice(0, 40).join(''),
      outTradeNo,
      total: totalFee,
      openid: payer,
      notifyPath: '/pay/notify/' + notify,
      timeExpire
    })
  } catch (e) {
    console.error('wxpay jsapi failed', outTradeNo, e)
    throw new BizError('发起微信支付失败：' + (e.wxMessage || '请稍后再试'))
  }
}

// 向微信查单：真的付了才返回 { transactionId, totalFee, payerOpenid }，否则返回 null。
// payerOpenid 是付款人在这个小程序里的 openid，上传发货信息要用（见 shipping.js）
async function queryPaid(outTradeNo, shop) {
  if (!payReady(shop) || !outTradeNo) return null
  try {
    const res = await cloud.payOf(shop).query(outTradeNo)
    if (res && res.tradeState === 'SUCCESS') return { transactionId: res.transactionId || '', totalFee: Number(res.total), payerOpenid: res.payerOpenid || '' }
  } catch (e) {
    console.error('wxpay query failed', outTradeNo, e)
  }
  return null
}

// 原路退款；refundFee 默认全额。微信受理了（处理中或已成功）就算退了
async function refund({ outTradeNo, outRefundNo, totalFee, refundFee, shop }) {
  if (!payReady(shop)) throw new BizError('服务器上没有配置微信支付，退不了款')
  let res
  try {
    res = await cloud.payOf(shop).refund({ outTradeNo, outRefundNo, total: totalFee, refund: refundFee || totalFee })
  } catch (e) {
    console.error('wxpay refund failed', outTradeNo, e)
    throw new BizError('微信退款失败：' + (e.wxMessage || '请稍后再试'))
  }
  if (!res || (res.status !== 'SUCCESS' && res.status !== 'PROCESSING')) {
    console.error('wxpay refund result', outTradeNo, res)
    throw new BizError('微信退款失败：' + ((res && res.status) || '请稍后再试'))
  }
  return true
}

module.exports = { payReady, getSettings, publicPay, unifiedOrder, queryPaid, refund }
