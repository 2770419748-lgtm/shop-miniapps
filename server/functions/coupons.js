// 代金券的两件事：适用范围（限哪些分类、哪些商品能用）和储值送券（充值档位送哪几张券，充值成功时发到顾客手里）。
// 券的模板在 coffee_coupons，顾客手里的券在 vouchers（type 为 cash）。咖啡（coffee.js）、会员（member.js）、首页（common.js）都用这里。
// 适用范围以模板为准：店主改了范围，已经领到手、送出去的券也跟着变；模板删掉了就按券上记的那一份。
// 模板的 giftOnly 为 true 表示「只在充值时送」：领券中心看不到、领不了。
// 送出去的券 source 为 recharge，不算领券中心的「已领」和「每人限领」；同一笔充值只送一次（券的 _id 由充值单号算出来）。
const crypto = require('crypto')
const { BizError, isMissingCollection, cnDay } = require('./base')
const { addDays } = require('./wallet')
const { couponLimited } = require('./pricing')

// 一张券最多限 50 个分类、200 个商品；一个充值档位最多送 5 种券、每种 20 张
const MAX_SCOPE_CATEGORIES = 50
const MAX_SCOPE_PRODUCTS = 200
const MAX_GIFT_KINDS = 5
const MAX_GIFT_COUNT = 20
// 适用范围的说明里最多列几个名字，多了写「等」
const SCOPE_NAMES_SHOWN = 3

async function safeList(query) {
  try {
    return (await query.get()).data
  } catch (e) {
    if (isMissingCollection(e)) return []
    throw e
  }
}

function idList(value) {
  const list = []
  ;(Array.isArray(value) ? value : []).forEach((v) => {
    const id = typeof v === 'string' ? v.trim() : ''
    if (id && list.indexOf(id) === -1) list.push(id)
  })
  return list
}

// 后台保存券时整理适用范围：只留现在还在的分类和商品。都不选就是全部商品
async function cleanScope(db, c) {
  const categoryIds = idList(c.categoryIds)
  const productIds = idList(c.productIds)
  if (categoryIds.length > MAX_SCOPE_CATEGORIES) throw new BizError('最多选 ' + MAX_SCOPE_CATEGORIES + ' 个分类')
  if (productIds.length > MAX_SCOPE_PRODUCTS) throw new BizError('最多选 ' + MAX_SCOPE_PRODUCTS + ' 个商品')
  const _ = db.command
  const [cats, prods] = await Promise.all([
    categoryIds.length ? safeList(db.collection('coffee_categories').where({ _id: _.in(categoryIds) }).limit(MAX_SCOPE_CATEGORIES)) : [],
    productIds.length ? safeList(db.collection('coffee_products').where({ _id: _.in(productIds) }).limit(MAX_SCOPE_PRODUCTS)) : []
  ])
  const scope = {
    categoryIds: categoryIds.filter((id) => cats.some((x) => x._id === id)),
    productIds: productIds.filter((id) => prods.some((x) => x._id === id))
  }
  if ((categoryIds.length || productIds.length) && !couponLimited(scope)) throw new BizError('选的分类或商品已经删掉了，请重新选')
  return scope
}

// 分类、商品的名字，写适用范围的说明用
async function loadNames(db) {
  const [cats, prods] = await Promise.all([
    safeList(db.collection('coffee_categories').field({ name: true }).limit(100)),
    safeList(db.collection('coffee_products').field({ name: true }).limit(500))
  ])
  const names = { cats: {}, prods: {} }
  cats.forEach((c) => { names.cats[c._id] = c.name })
  prods.forEach((p) => { names.prods[p._id] = p.name })
  return names
}

// 适用范围的说明，比如「限小食、甜点可用」「限美式、拿铁等 5 样可用」；全场能用是 ''
function scopeText(c, names) {
  if (!couponLimited(c)) return ''
  const list = []
  ;(c.categoryIds || []).forEach((id) => { if (names.cats[id]) list.push(names.cats[id]) })
  ;(c.productIds || []).forEach((id) => { if (names.prods[id]) list.push(names.prods[id]) })
  if (!list.length) return '限指定商品可用'
  if (list.length > SCOPE_NAMES_SHOWN) return '限' + list.slice(0, SCOPE_NAMES_SHOWN).join('、') + '等 ' + list.length + ' 样可用'
  return '限' + list.join('、') + '可用'
}

// 顾客手里的券换上模板现在的适用范围（模板删掉了的、洗车送的券保持原样）
async function withScope(db, vouchers) {
  const ids = []
  vouchers.forEach((v) => {
    if (v.couponId && String(v.couponId).indexOf('cw:') !== 0 && ids.indexOf(v.couponId) === -1) ids.push(v.couponId)
  })
  if (!ids.length) return vouchers
  const templates = await safeList(db.collection('coffee_coupons').where({ _id: db.command.in(ids) }).limit(100))
  const byId = {}
  templates.forEach((t) => { byId[t._id] = t })
  return vouchers.map((v) => {
    const t = byId[v.couponId]
    return t ? Object.assign({}, v, { categoryIds: t.categoryIds || [], productIds: t.productIds || [] }) : v
  })
}

// 所有券的模板，按 _id 放好
async function templateMap(db) {
  const list = await safeList(db.collection('coffee_coupons').orderBy('sort', 'asc').limit(100))
  const byId = {}
  list.forEach((c) => { byId[c._id] = c })
  return { list, byId }
}

// 后台保存充值档位时整理送券：[{ couponId, count }]，券要还在，同一种券只写一行
async function cleanGifts(db, gifts) {
  if (gifts === undefined || gifts === null) return []
  if (!Array.isArray(gifts)) throw new BizError('送券的格式不对')
  if (gifts.length > MAX_GIFT_KINDS) throw new BizError('一个档位最多送 ' + MAX_GIFT_KINDS + ' 种券')
  const { byId } = await templateMap(db)
  const out = []
  gifts.forEach((g) => {
    const couponId = String((g && g.couponId) || '')
    const c = byId[couponId]
    if (!c) throw new BizError('送的券不存在了，请重新选')
    if (out.some((x) => x.couponId === couponId)) throw new BizError('「' + c.title + '」选了两次，合成一行改张数就好')
    const count = Number(g.count)
    if (!Number.isInteger(count) || count < 1 || count > MAX_GIFT_COUNT) throw new BizError('「' + c.title + '」送几张请填 1 到 ' + MAX_GIFT_COUNT)
    out.push({ couponId, count })
  })
  return out
}

// 档位上的送券，带上券的名字；模板删掉了的不算
function giftList(gifts, byId) {
  return (gifts || []).filter((g) => byId[g.couponId]).map((g) => {
    const c = byId[g.couponId]
    return { couponId: g.couponId, title: c.title, amount: c.amount, count: g.count }
  })
}

// 送券的说明，比如「送基础饮品券 1 张、小食券 1 张」；不送是 ''
function giftText(list) {
  return list.length ? '送' + list.map((g) => g.title + ' ' + g.count + ' 张').join('、') : ''
}

function giftVoucherId(refNo, couponId, i) {
  return 'rg' + crypto.createHash('sha1').update(refNo + ':' + couponId + ':' + i).digest('hex').slice(0, 24)
}

// 充值成功后送券。gifts：[{ couponId, count }]；refNo：充值单号，同一个单号只送一次。
// 券按模板现在的金额、门槛、有效天数、适用范围发，充值当天算第 1 天。返回送了哪些 [{ title, count }]
async function issueGifts(db, openid, gifts, refNo) {
  if (!openid || !refNo || !(gifts || []).length) return []
  const { byId } = await templateMap(db)
  const today = cnDay()
  const out = []
  for (const g of gifts) {
    const c = byId[g.couponId]
    if (!c) {
      console.error('送券的模板不在了', refNo, g.couponId)
      continue
    }
    for (let i = 0; i < g.count; i++) {
      const voucher = {
        _id: giftVoucherId(refNo, c._id, i),
        _openid: openid,
        type: 'cash',
        source: 'recharge',
        couponId: c._id,
        title: c.title,
        amount: c.amount,
        minSpend: c.minSpend || 0,
        categoryIds: c.categoryIds || [],
        productIds: c.productIds || [],
        claimDay: today,
        expiresDay: addDays(today, c.validDays - 1),
        status: 'unused',
        orderNo: '',
        orderId: '',
        refNo,
        createdAt: new Date()
      }
      try {
        await db.collection('vouchers').add({ data: voucher })
      } catch (e) {
        // 这一张已经送过了（付款通知重复到达等）
        if (!/duplicate key|UNIQUE/i.test(String(e && e.message))) throw e
      }
    }
    out.push({ title: c.title, count: g.count })
  }
  return out
}

// 有哪些充值档位在送这张券（删券前提醒店主）
async function plansGiving(db, couponId) {
  const plans = await safeList(db.collection('member_plans').limit(50))
  return plans.filter((p) => (p.gifts || []).some((g) => g.couponId === couponId))
}

module.exports = {
  MAX_GIFT_KINDS,
  MAX_GIFT_COUNT,
  cleanScope,
  loadNames,
  scopeText,
  withScope,
  templateMap,
  cleanGifts,
  giftList,
  giftText,
  issueGifts,
  plansGiving
}
