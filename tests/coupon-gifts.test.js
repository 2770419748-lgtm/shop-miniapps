// 代金券限品类（小食券不能用在咖啡上）和储值送券（充值档位送哪几张券，充值成功自动发）
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap, getDoc, modules } = require('./helpers/load')
const { couponBase, couponDiscount, pickCoupon } = require('../server/functions/pricing')
const { addDays } = require('../server/functions/wallet')
const { cnDay } = require('../server/functions/base')

const owner = as('OWNER')
const alice = as('ALICE')
const bob = as('BOB')
const carol = as('CAROL')
const barista = as('BARISTA')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

let menu
const product = (name) => menu.products.find((p) => p.name === name)
const category = (name) => menu.categories.find((c) => c.name === name)
const americano = () => product('美式') // 18 元，咖啡
const pour = () => product('手冲') // 32 元，咖啡
const cake = () => product('芝士蛋糕') // 28 元，甜点
const lemon = () => product('柠檬茶') // 18 元，非咖啡
const hot = [{ name: '杯型', option: '中杯' }, { name: '温度', option: '热' }]
const cash = (openid) => db.collection('vouchers').where({ _openid: openid, type: 'cash' }).limit(100).get().then((r) => r.data)

test('怎么算：限了品类的券只看能用的那几样商品，赠饮券、集星抵掉的不算', () => {
  const lines = [
    { productId: 'latte', categoryId: 'coffee', unitPrice: 2200, qty: 2, subtotal: 4400 },
    { productId: 'cake', categoryId: 'snack', unitPrice: 2800, qty: 1, subtotal: 2800 }
  ]
  const snack = { _id: 's', amount: 400, minSpend: 1200, categoryIds: ['snack'], productIds: [], expiresDay: '2026-12-01' }
  const drink = { _id: 'd', amount: 1500, minSpend: 0, categoryIds: [], productIds: ['latte'], expiresDay: '2026-12-30' }
  const any = { _id: 'a', amount: 500, minSpend: 3000, expiresDay: '2026-12-01' }
  const cart = { lines, offs: [], left: 7200 }
  assert.equal(couponBase(snack, cart), 2800)
  assert.equal(couponBase(drink, cart), 4400)
  assert.equal(couponBase(any, cart), 7200, '全场券看整单')
  assert.equal(couponDiscount(snack, cart), 400)
  // 只点咖啡：小食券用不上
  const coffeeOnly = { lines: [lines[0]], offs: [], left: 4400 }
  assert.equal(couponDiscount(snack, coffeeOnly), 0)
  assert.equal(pickCoupon([snack], coffeeOnly).coupon, null)
  assert.equal(pickCoupon([snack, drink], coffeeOnly).coupon._id, 'd')
  // 一杯拿铁被赠饮券抵掉了，饮品券只剩另一杯能抵
  const covered = { lines, offs: [{ productId: 'latte', discount: 2200 }], left: 5000 }
  assert.equal(couponBase(drink, covered), 2200)
  assert.equal(couponDiscount(drink, covered), 1500)
  // 门槛只算能用的商品：蛋糕被抵到 1000，不够 12 元门槛
  const snackCovered = { lines, offs: [{ productId: 'cake', discount: 1800 }], left: 5400 }
  assert.equal(couponDiscount(snack, snackCovered), 0)
  // 原来只传一个数的写法照旧
  assert.equal(couponDiscount(any, 3000), 500)
})

test('准备：店主、咖啡师、菜单', async () => {
  db.reset()
  state.payReady = true
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.coffee('seedDemo'))
  const invite = await ok(owner.common('createInvite', { role: 'barista' }))
  await ok(barista.common('bindStaff', { code: invite.code, name: '小林' }))
  menu = await ok(alice.coffee('getMenu'))
})

let snackId
let drinkId
let anyId

test('代金券设适用范围：选分类或商品；选的东西不在了不行；后台列表写清范围', async () => {
  await fails(owner.coffee('saveCoupon', { coupon: { amount: 400, validDays: 30, categoryIds: ['nope'] } }))
  snackId = (await ok(owner.coffee('saveCoupon', { coupon: { title: '小食立减4元券', amount: 400, minSpend: 1200, validDays: 60, categoryIds: [category('甜点')._id, category('甜点')._id] } }))).id
  drinkId = (await ok(owner.coffee('saveCoupon', { coupon: { title: '基础饮品券', amount: 1800, validDays: 90, productIds: [americano()._id, lemon()._id, 'gone'], giftOnly: true } }))).id
  anyId = (await ok(owner.coffee('saveCoupon', { coupon: { amount: 300, validDays: 7, perUser: 2 } }))).id
  const list = await ok(owner.coffee('adminListCoupons'))
  const snack = list.find((c) => c._id === snackId)
  assert.deepEqual(snack.categoryIds, [category('甜点')._id], '去重')
  assert.equal(snack.scope, '限甜点可用')
  const drink = list.find((c) => c._id === drinkId)
  assert.deepEqual(drink.productIds, [americano()._id, lemon()._id], '删掉的商品不留')
  assert.equal(drink.scope, '限美式、柠檬茶可用')
  assert.equal(drink.giftOnly, true)
  assert.equal(list.find((c) => c._id === anyId).scope, '', '全场能用')
  assert.equal(list.find((c) => c._id === anyId).giftOnly, false)
})

test('只在充值时送的券：领券中心看不到、领不了，首页也不算可领', async () => {
  const center = await ok(alice.coffee('couponCenter'))
  assert.deepEqual(center.coupons.map((c) => c._id).sort(), [snackId, anyId].sort())
  assert.equal(center.coupons.find((c) => c._id === snackId).scope, '限甜点可用')
  await fails(alice.coffee('claimCoupon', { id: drinkId }), 'COUPON_GONE')
  assert.equal((await ok(alice.common('getHome'))).claimableCoupons, 2)
})

test('结算：小食券点咖啡用不上，写清为什么；有甜点才抵，门槛只算甜点', async () => {
  const mineId = (await ok(alice.coffee('claimCoupon', { id: snackId })))._id
  // 只点咖啡（满 12 元也不行）
  let q = await ok(alice.coffee('quote', { items: [{ productId: pour()._id, qty: 1 }] }))
  assert.equal(q.coupon, null, '不会自动用上小食券')
  assert.equal(q.couponFee, 0)
  const opt = q.coupons.find((c) => c.id === mineId)
  assert.equal(opt.discount, 0)
  assert.equal(opt.reason, '这单没有能用的商品')
  assert.equal(opt.scope, '限甜点可用')
  // 硬要用：下单失败
  await fails(alice.coffee('createOrder', { items: [{ productId: pour()._id, qty: 1 }], mode: 'dine_in', couponId: mineId }), 'VOUCHER_CHANGED')
  assert.equal((await cash('ALICE'))[0].status, 'unused', '券没被用掉')
  // 咖啡 + 蛋糕：抵 4 元
  const items = [{ productId: pour()._id, qty: 1 }, { productId: cake()._id, qty: 1 }]
  q = await ok(alice.coffee('quote', { items }))
  assert.equal(q.coupon.id, mineId)
  assert.equal(q.couponFee, 400)
  assert.equal(q.payFee, 3200 + 2800 - 400)
  const { id } = await ok(alice.coffee('createOrder', { items, mode: 'dine_in', couponId: mineId }))
  assert.equal((await getDoc('coffee_orders', id)).couponFee, 400)
})

test('店主后来才改适用范围：已经领到手的券也跟着变', async () => {
  await ok(bob.coffee('claimCoupon', { id: anyId }))
  let q = await ok(bob.coffee('quote', { items: [{ productId: americano()._id, qty: 1, specs: hot }] }))
  assert.equal(q.couponFee, 300, '原来全场能用')
  await ok(owner.coffee('saveCoupon', { coupon: { _id: anyId, amount: 300, validDays: 7, perUser: 2, categoryIds: [category('甜点')._id] } }))
  q = await ok(bob.coffee('quote', { items: [{ productId: americano()._id, qty: 1, specs: hot }] }))
  assert.equal(q.couponFee, 0, '改成限甜点以后，手里的券点咖啡就用不上了')
  const mine = await ok(bob.coffee('myVouchers'))
  assert.equal(mine.usable[0].scope, '限甜点可用')
  // 旧版后台保存时不带适用范围：原来的范围不动
  await ok(owner.coffee('saveCoupon', { coupon: { _id: anyId, amount: 300, validDays: 7, perUser: 2 } }))
  assert.deepEqual((await getDoc('coffee_coupons', anyId)).categoryIds, [category('甜点')._id])
  // 改回全场
  await ok(owner.coffee('saveCoupon', { coupon: { _id: anyId, amount: 300, validDays: 7, perUser: 2, categoryIds: [], productIds: [] } }))
  q = await ok(bob.coffee('quote', { items: [{ productId: americano()._id, qty: 1, specs: hot }] }))
  assert.equal(q.couponFee, 300)
})

let plan300
let plan500

test('充值档位配送券：选哪张券、送几张；券不在、重复、张数不对都不行', async () => {
  await fails(owner.member('savePlan', { plan: { price: 30000, bonus: 5000, gifts: [{ couponId: 'nope', count: 1 }] } }))
  await fails(owner.member('savePlan', { plan: { price: 30000, bonus: 5000, gifts: [{ couponId: drinkId, count: 0 }] } }))
  await fails(owner.member('savePlan', { plan: { price: 30000, bonus: 5000, gifts: [{ couponId: drinkId, count: 21 }] } }))
  await fails(owner.member('savePlan', { plan: { price: 30000, bonus: 5000, gifts: [{ couponId: drinkId, count: 1 }, { couponId: drinkId, count: 2 }] } }))
  await fails(owner.member('savePlan', { plan: { price: 30000, bonus: 5000, gifts: 'x' } }))
  await fails(barista.member('savePlan', { plan: { price: 30000, gifts: [] } }), 'FORBIDDEN')
  plan300 = (await ok(owner.member('savePlan', { plan: { price: 30000, bonus: 5000, gifts: [{ couponId: drinkId, count: 1 }] } }))).id
  plan500 = (await ok(owner.member('savePlan', { plan: { price: 50000, bonus: 10000, gifts: [{ couponId: drinkId, count: 2 }, { couponId: snackId, count: '1' }] } }))).id
  await ok(owner.member('saveMemberSettings', { enabled: true, freeCategories: ['漫画'], notice: '储值余额不兑现、不找零，赠券有效期 90 天' }))
  const s = await ok(owner.member('getMemberSettings'))
  const p500 = s.plans.find((p) => p._id === plan500)
  assert.deepEqual(p500.gifts.map((g) => [g.couponId, g.count]), [[drinkId, 2], [snackId, 1]])
  assert.equal(p500.giftText, '送基础饮品券 2 张、小食立减4元券 1 张')
  assert.ok(s.coupons.some((c) => c._id === drinkId && c.giftOnly && c.scope === '限美式、柠檬茶可用'), '列出能送的券给店主选')
  // 旧版后台保存档位时不带 gifts：原来的送券不动
  await ok(owner.member('savePlan', { plan: { _id: plan300, price: 30000, bonus: 5000 } }))
  assert.deepEqual((await getDoc('member_plans', plan300)).gifts, [{ couponId: drinkId, count: 1 }])
  // 顾客在会员中心看得到送什么，首页也写上
  const m = await ok(carol.member('getMember'))
  assert.equal(m.plans.find((p) => p._id === plan300).giftText, '送基础饮品券 1 张')
  assert.equal((await ok(carol.common('getHome'))).member.promo, '充 300 送 50，送基础饮品券 1 张')
  // 还在送的券不能删
  await fails(owner.coffee('deleteCoupon', { id: drinkId }), 'COUPON_IN_PLAN')
})

test('吧台代充：钱充上，券同时送到，90 天有效；充值送的不占领券中心的名额', async () => {
  await ok(alice.member('getMember'))
  const no = (await ok(alice.member('getMember'))).member.memberNo
  const res = await ok(barista.member('counterRecharge', { memberNo: no, planId: plan500 }))
  assert.equal(res.balance, 60000)
  assert.deepEqual(res.gifts, [{ title: '基础饮品券', count: 2 }, { title: '小食立减4元券', count: 1 }])
  assert.equal(res.giftError, '')
  const gifted = (await cash('ALICE')).filter((v) => v.source === 'recharge')
  assert.equal(gifted.length, 3)
  const drink = gifted.find((v) => v.couponId === drinkId)
  assert.equal(drink.amount, 1800)
  assert.equal(drink.expiresDay, addDays(cnDay(), 89), '充值当天算第 1 天')
  assert.ok(drink.refNo.indexOf('JC') === 0)
  // 送的小食券不算「已领」：领券中心里这张券 Alice 之前领过 1 张，每人限 1 张，还是显示已领 1 张
  const center = await ok(alice.coffee('couponCenter'))
  assert.equal(center.coupons.find((c) => c._id === snackId).mine, 1)
  // 送的基础饮品券：点美式全抵掉，点手冲用不上
  let q = await ok(alice.coffee('quote', { items: [{ productId: americano()._id, qty: 1, specs: hot }] }))
  assert.equal(q.coupon.title, '基础饮品券')
  assert.equal(q.payFee, 0)
  q = await ok(alice.coffee('quote', { items: [{ productId: pour()._id, qty: 1 }] }))
  assert.equal(q.coupon, null)
  const mine = await ok(alice.coffee('myVouchers'))
  assert.equal(mine.usable.filter((v) => v.title === '基础饮品券').length, 2)
  assert.equal(mine.usable.find((v) => v.title === '基础饮品券').scope, '限美式、柠檬茶可用')
  // 后台列表：已送几张
  const list = await ok(owner.coffee('adminListCoupons'))
  assert.equal(list.find((c) => c._id === drinkId).gifted, 2)
})

test('在线充值：付款成功后送券；通知来两次也只送一次；按下单时那一档的设置送', async () => {
  await ok(owner.common('saveShopSettings', { payEnabled: true, allowCounter: true }))
  await ok(carol.member('getMember'))
  const r = await ok(carol.member('createRecharge', { planId: plan300 }))
  const recharge = await getDoc('member_recharges', r.id)
  assert.deepEqual(recharge.gifts, [{ couponId: drinkId, count: 1 }])
  // 下单后店主改了这一档，按下单时的送
  await ok(owner.member('savePlan', { plan: { _id: plan300, price: 30000, bonus: 5000, gifts: [{ couponId: drinkId, count: 3 }] } }))
  state.payOrders[recharge.rechargeNo].paid = true
  await modules.member.onPayNotify({ outTradeNo: recharge.rechargeNo })
  await modules.member.onPayNotify({ outTradeNo: recharge.rechargeNo })
  assert.deepEqual(await ok(carol.member('confirmPay', { id: r.id })), { payStatus: 'paid' })
  const gifted = (await cash('CAROL')).filter((v) => v.source === 'recharge')
  assert.equal(gifted.length, 1)
  assert.deepEqual((await getDoc('member_recharges', r.id)).giftsSent, [{ title: '基础饮品券', count: 1 }])
  await ok(owner.common('saveShopSettings', { payEnabled: false, allowCounter: true }))
})

test('不送券的档位照旧；把券从档位里去掉以后就能删了', async () => {
  const plain = (await ok(owner.member('savePlan', { plan: { price: 10000 } }))).id
  const no = (await ok(bob.member('getMember'))).member.memberNo
  const res = await ok(barista.member('counterRecharge', { memberNo: no, planId: plain }))
  assert.deepEqual(res.gifts, [])
  assert.equal((await cash('BOB')).filter((v) => v.source === 'recharge').length, 0)
  await ok(owner.member('savePlan', { plan: { _id: plan300, price: 30000, bonus: 5000, gifts: [] } }))
  await ok(owner.member('savePlan', { plan: { _id: plan500, price: 50000, bonus: 10000, gifts: [{ couponId: snackId, count: 1 }] } }))
  await ok(owner.coffee('deleteCoupon', { id: drinkId }))
  // 模板删了，顾客手里送的券还能用，按券上记的范围
  const q = await ok(alice.coffee('quote', { items: [{ productId: americano()._id, qty: 1, specs: hot }] }))
  assert.equal(q.coupon.title, '基础饮品券')
  const q2 = await ok(alice.coffee('quote', { items: [{ productId: pour()._id, qty: 1 }] }))
  assert.notEqual(q2.coupon && q2.coupon.title, '基础饮品券')
})
