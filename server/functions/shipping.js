// 微信「小程序发货信息管理服务」：公众平台给小程序开了这项服务的话，每一笔微信支付都要告诉微信「东西已经给顾客了」，
// 不传的话微信不给结算（钱压着），顾客的微信里也一直显示「待发货」。
// 做法：微信支付到账时 record() 记一条（集合 ship_queue，按微信支付单号一条，重复记不会多传），
// 服务器每分钟跑一次 sync()，把还没传的传上去，失败的过一会儿再试：
//   堂食、外带、预约、借书（到吧台取书）：用户自提；外送：同城配送；会员储值、借书超时费：虚拟商品
// 小程序没开这项服务时不传（每小时问一次微信开没开），记着的单子一天后就不管了。
// 测试版不收钱，不会有要传的单。洗车小程序还没上线，没接（以后接的话 record 时 shop 传 carwash）。
const cloud = require('../platform')

const db = cloud.database()
const _ = db.command
const COL = 'ship_queue'

// 微信的物流方式：2 同城配送，3 虚拟商品，4 用户自提
const LOGISTICS = { delivery: 2, virtual: 3, pickup: 4 }
const MANAGED_TTL = 3600 * 1000
const UNMANAGED_GIVE_UP = 24 * 3600 * 1000
const MAX_TRIES = 12
const BATCH = 20
const DESC_MAX = 100
// 10060002：这笔已经发过货了；10060004：这笔已经不能发货了（比如全额退款了）
const ALREADY_SHIPPED = 10060002
const NOT_SHIPPABLE = 10060004

const managedCache = {}

function shopOf(shop) {
  return shop === 'carwash' ? 'carwash' : 'coffee'
}

// 北京时间 RFC 3339，例如 2026-11-06T18:30:00+08:00
function rfc3339(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19) + '+08:00'
}

// 一单买了什么，给微信看的一句话
function describe(text) {
  const s = String(text || '').replace(/[\r\n\t]+/g, ' ').trim()
  return Array.from(s || '进山咖啡').slice(0, DESC_MAX).join('')
}

// 咖啡单的商品描述：手冲×2、拿铁
function describeItems(prefix, items) {
  const names = (Array.isArray(items) ? items : []).map((i) => (i.name || '') + (i.qty > 1 ? '×' + i.qty : ''))
  return describe(prefix + (names.length ? '：' + names.join('、') : ''))
}

// 微信支付到账时调：type 是 pickup / delivery / virtual，paid 是 pay.queryPaid 的结果。不会抛错，不影响收款
async function record({ shop, type, paid, desc }) {
  try {
    if (!paid || !paid.transactionId || !LOGISTICS[type]) return false
    await db.collection(COL).add({
      data: {
        _id: paid.transactionId,
        shop: shopOf(shop),
        logisticsType: LOGISTICS[type],
        payerOpenid: paid.payerOpenid || '',
        desc: describe(desc),
        status: 'pending',
        tries: 0,
        nextAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date()
      }
    })
    return true
  } catch (e) {
    if (!/duplicate key/.test(String(e && e.message))) console.error('记发货信息失败', paid && paid.transactionId, e)
    return false
  }
}

// 这个小程序开没开发货信息管理；问不到微信时返回 null（这一轮先不传）
async function isManaged(shop) {
  const hit = managedCache[shop]
  if (hit && hit.until > Date.now()) return hit.value
  try {
    const value = await cloud.wechatOf(shop).isTradeManaged()
    managedCache[shop] = { value, until: Date.now() + MANAGED_TTL }
    return value
  } catch (e) {
    console.error('查发货信息管理开没开失败', shop, e)
    return null
  }
}

function update(id, data) {
  return db.collection(COL).doc(id).update({ data: Object.assign({ updatedAt: new Date() }, data) })
}

async function upload(item) {
  const wx = cloud.wechatOf(item.shop)
  try {
    await wx.uploadShipping({
      order_key: { order_number_type: 2, transaction_id: item._id },
      logistics_type: item.logisticsType,
      delivery_mode: 1,
      shipping_list: [{ item_desc: item.desc }],
      upload_time: rfc3339(Date.now()),
      payer: { openid: item.payerOpenid }
    })
    await update(item._id, { status: 'done', doneAt: new Date() })
  } catch (e) {
    if (e.errCode === ALREADY_SHIPPED) return update(item._id, { status: 'done', doneAt: new Date() })
    if (e.errCode === NOT_SHIPPABLE) return update(item._id, { status: 'skipped', lastError: String(e.message || e) })
    const tries = (item.tries || 0) + 1
    const failed = tries >= MAX_TRIES
    // 1、2、4、8……分钟后再试，最多隔一小时
    const wait = Math.min(Math.pow(2, tries - 1), 60) * 60 * 1000
    if (failed) console.error('上传发货信息一直失败，不再重试，要到公众平台「发货信息管理」里手动录入', item._id, e)
    await update(item._id, {
      status: failed ? 'failed' : 'pending',
      tries,
      nextAt: new Date(Date.now() + wait),
      lastError: String(e.message || e)
    })
  }
}

// 服务器每分钟跑一次：把该传的发货信息传上去
async function sync() {
  if (cloud.isTest()) return
  const list = (await db.collection(COL).where({ status: 'pending', nextAt: _.lte(new Date()) }).orderBy('nextAt', 'asc').limit(BATCH).get()).data
  for (const item of list) {
    if (!cloud.wechatOf(item.shop).ready()) continue
    const managed = await isManaged(item.shop)
    if (managed === null) continue
    if (!managed) {
      const created = item.createdAt instanceof Date ? item.createdAt.getTime() : Date.now()
      if (Date.now() - created > UNMANAGED_GIVE_UP) await update(item._id, { status: 'not_needed' })
      else await update(item._id, { nextAt: new Date(Date.now() + MANAGED_TTL) })
      continue
    }
    await upload(item)
  }
}

// 测试用：忘掉「开没开」的缓存
function resetCache() {
  Object.keys(managedCache).forEach((k) => delete managedCache[k])
}

module.exports = { LOGISTICS, record, sync, describe, describeItems, rfc3339, resetCache }
