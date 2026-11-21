// 一单用几张代金券：饮品券抵饮品、小食券抵小食，可以一起用；能用在同一样商品上的券（两张饮品券、全场券）只能用一张。
// 旧版小程序（1.0.1）只传 couponId，照旧一单一张。
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, state, as, unwrap, getDoc } = require('./helpers/load')
const { stackCoupons, bestCoupons, couponsClash } = require('../server/functions/pricing')
const { cnDay } = require('../server/functions/base')

const owner = as('OWNER')
const alice = as('ALICE')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

test('怎么挑：各管各的券一起用，撞了的只用一张；自动挑抵得最多的一组', () => {
  const lines = [
    { productId: 'latte', categoryId: 'coffee', subtotal: 2200 },
    { productId: 'lemon', categoryId: 'tea', subtotal: 1800 },
    { productId: 'cake', categoryId: 'snack', subtotal: 2800 }
  ]
  const cart = { lines, offs: [], left: 6800 }
  const drink = { _id: 'd1', title: '饮品券', amount: 400, categoryIds: ['coffee', 'tea'], expiresDay: '2026-12-30' }
  const drink2 = { _id: 'd2', title: '饮品券', amount: 400, categoryIds: ['coffee', 'tea'], expiresDay: '2026-12-01' }
  const snack = { _id: 's', title: '小食券', amount: 400, categoryIds: ['snack'], expiresDay: '2026-12-30' }
  const latteOnly = { _id: 'l', title: '拿铁券', amount: 300, productIds: ['latte'], expiresDay: '2026-12-30' }
  const any = { _id: 'a', title: '满30减6', amount: 600, minSpend: 3000, expiresDay: '2026-12-30' }

  assert.equal(couponsClash(drink, snack, cart), false)
  assert.equal(couponsClash(drink, latteOnly, cart), true, '都能用在拿铁上')
  assert.equal(couponsClash(any, snack, cart), true, '全场券和谁都撞')
  // 只点了咖啡：饮品券和小食券不撞，但小食券本来就用不上
  assert.deepEqual(stackCoupons([drink, snack], { lines: [lines[0]], offs: [], left: 2200 }).picked.map((p) => p.coupon._id), ['d1'])

  assert.deepEqual(stackCoupons([drink, snack], cart).picked.map((p) => p.coupon._id), ['d1', 's'])
  assert.equal(stackCoupons([drink, snack], cart).discount, 800)
  assert.deepEqual(stackCoupons([drink, drink2, snack], cart).picked.map((p) => p.coupon._id), ['d1', 's'], '两张饮品券只用一张')
  assert.deepEqual(stackCoupons([any, drink, snack], cart).picked.map((p) => p.coupon._id), ['a'], '按给的顺序，先来的留下')
  assert.deepEqual(stackCoupons([drink, drink], cart).picked.length, 1, '同一张不会用两次')

  // 自动挑：4+4 比全场 6 多
  assert.deepEqual(bestCoupons([any, drink, snack], cart).picked.map((p) => p.coupon._id).sort(), ['d1', 's'])
  // 全场 10 比 4+4 多
  const big = Object.assign({}, any, { _id: 'b', amount: 1000 })
  assert.deepEqual(bestCoupons([drink, snack, big], cart).picked.map((p) => p.coupon._id), ['b'])
  // 抵得一样多：少用几张
  const eight = Object.assign({}, any, { _id: 'e', amount: 800 })
  assert.deepEqual(bestCoupons([drink, snack, eight], cart).picked.map((p) => p.coupon._id), ['e'])
  // 同一类里挑先过期的
  assert.deepEqual(bestCoupons([drink, drink2], cart).picked.map((p) => p.coupon._id), ['d2'])
  // 拿铁券 3 + 小食券 4，比饮品券 4 + 小食券 4 少：拿铁券不用
  assert.deepEqual(bestCoupons([latteOnly, drink, snack], cart).picked.map((p) => p.coupon._id).sort(), ['d1', 's'])
  // 抵不了比剩下要付的钱还多
  const huge = Object.assign({}, snack, { _id: 'h', amount: 5000 })
  assert.equal(stackCoupons([drink, huge], cart).discount, 400 + 2800)
  // 老写法只给一个数：不知道商品，当作都撞，只用一张
  assert.equal(stackCoupons([any, snack], 4000).picked.length, 1)
})

let menu
const product = (name) => menu.products.find((p) => p.name === name)
const category = (name) => menu.categories.find((c) => c.name === name)
const item = (name) => ({ productId: product(name)._id, qty: 1, specs: product(name).specs.map((s) => ({ name: s.name, option: s.options[0].name })) })
let drinkA
let drinkB
let snack
let any

test('准备：菜单、三种券，Alice 各领到手', async () => {
  db.reset()
  state.payReady = true
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.coffee('seedDemo'))
  menu = await ok(alice.coffee('getMenu'))
  // 饮品券：咖啡和非咖啡都算饮品
  const drinkT = (await ok(owner.coffee('saveCoupon', { coupon: { title: '饮品券', amount: 500, validDays: 90, perUser: 2, categoryIds: [category('咖啡')._id, category('非咖啡')._id] } }))).id
  const snackT = (await ok(owner.coffee('saveCoupon', { coupon: { title: '小食券', amount: 400, validDays: 90, categoryIds: [category('甜点')._id] } }))).id
  const anyT = (await ok(owner.coffee('saveCoupon', { coupon: { title: '满30减3', amount: 300, minSpend: 3000, validDays: 7 } }))).id
  drinkA = (await ok(alice.coffee('claimCoupon', { id: drinkT })))._id
  drinkB = (await ok(alice.coffee('claimCoupon', { id: drinkT })))._id
  snack = (await ok(alice.coffee('claimCoupon', { id: snackT })))._id
  any = (await ok(alice.coffee('claimCoupon', { id: anyT })))._id
})

const items = () => [item('拿铁'), item('柠檬茶'), item('芝士蛋糕')] // 22 + 18 + 28 = 68 元

test('结算页（新版）：自动用上饮品券 + 小食券；撞了的写会换掉哪张', async () => {
  const q = await ok(alice.coffee('quote', { items: items(), couponIds: 'auto' }))
  assert.equal(q.usedCoupons.length, 2)
  assert.deepEqual(q.usedCoupons.map((c) => c.title).sort(), ['小食券', '饮品券'])
  assert.equal(q.couponFee, 900)
  assert.equal(q.payFee, 6800 - 900)
  assert.equal(q.discountFee, 900)
  const opt = (id) => q.coupons.find((c) => c.id === id)
  assert.equal(opt(snack).picked, true)
  assert.equal(opt(any).picked, false)
  assert.equal(opt(any).clash, q.usedCoupons.map((c) => c.title).join('、'), '全场券和两张都撞')
  const otherDrink = opt(drinkA).picked ? drinkB : drinkA
  assert.equal(opt(otherDrink).clash, '饮品券', '另一张饮品券和用上的那张撞')
  assert.equal(opt(snack).clash, '')
})

test('结算页（新版）：顾客自己选，按顺序用，撞了的、用不上的跳过；空数组是不用', async () => {
  let q = await ok(alice.coffee('quote', { items: items(), couponIds: [any, drinkA, snack] }))
  assert.deepEqual(q.usedCoupons.map((c) => c.id), [any], '先选了全场券，饮品券、小食券就用不上')
  assert.equal(q.couponFee, 300)
  q = await ok(alice.coffee('quote', { items: items(), couponIds: [drinkA, drinkB, snack] }))
  assert.deepEqual(q.usedCoupons.map((c) => c.id), [drinkA, snack], '两张饮品券只用一张')
  q = await ok(alice.coffee('quote', { items: items(), couponIds: [] }))
  assert.equal(q.couponFee, 0)
  assert.equal(q.coupon, null)
  // 只点饮品：小食券用不上，选了也跳过
  q = await ok(alice.coffee('quote', { items: [item('柠檬茶')], couponIds: [snack, drinkA] }))
  assert.deepEqual(q.usedCoupons.map((c) => c.id), [drinkA], '非咖啡也算饮品')
  assert.equal(q.payFee, 1800 - 500)
})

test('旧版小程序：不传 couponIds 还是一单一张', async () => {
  const q = await ok(alice.coffee('quote', { items: items() }))
  assert.equal(q.usedCoupons.length, 1)
  assert.equal(q.couponFee, 500)
  assert.equal(q.payFee, 6800 - 500)
  const { id } = await ok(alice.coffee('createOrder', { items: items(), mode: 'takeaway', couponId: q.coupon.id }))
  const order = await getDoc('coffee_orders', id)
  assert.equal(order.couponFee, 500)
  assert.deepEqual(order.coupon, q.coupon)
  await ok(alice.coffee('cancelOrder', { id }))
  assert.equal((await getDoc('vouchers', q.coupon.id)).status, 'unused')
})

test('下单：饮品券 + 小食券一起核销，取消时两张都退回；撞了的不能下单', async () => {
  await fails(alice.coffee('createOrder', { items: items(), mode: 'takeaway', couponIds: [any, drinkA] }), 'VOUCHER_CHANGED')
  await fails(alice.coffee('createOrder', { items: items(), mode: 'takeaway', couponIds: [drinkA, drinkB] }), 'VOUCHER_CHANGED')
  await fails(alice.coffee('createOrder', { items: [item('拿铁')], mode: 'takeaway', couponIds: [drinkA, snack] }), 'VOUCHER_CHANGED')
  for (const id of [any, drinkA, drinkB, snack]) assert.equal((await getDoc('vouchers', id)).status, 'unused', '没下成的单不占券')

  const { id } = await ok(alice.coffee('createOrder', { items: items(), mode: 'takeaway', couponIds: [drinkA, snack] }))
  const order = await getDoc('coffee_orders', id)
  assert.deepEqual(order.coupons.map((c) => [c.id, c.discount]), [[drinkA, 500], [snack, 400]])
  assert.equal(order.coupon.id, drinkA, '第一张也写在 coupon 里，旧版订单页能看到')
  assert.equal(order.couponFee, 900)
  assert.equal(order.payFee, 5900)
  assert.equal((await getDoc('vouchers', drinkA)).status, 'used')
  assert.equal((await getDoc('vouchers', snack)).status, 'used')
  // 顾客看订单：coupons 两张
  const mine = await ok(alice.coffee('getOrder', { id }))
  assert.equal(mine.coupons.length, 2)
  // 店主看账：用了 2 张代金券
  const sum = await ok(owner.coffee('daySummary', { from: cnDay(), to: cnDay() }))
  assert.equal(sum.totals.couponsUsed, 2)
  assert.equal(sum.totals.couponFee, 900)
  await ok(alice.coffee('cancelOrder', { id }))
  assert.equal((await getDoc('vouchers', drinkA)).status, 'unused')
  assert.equal((await getDoc('vouchers', snack)).status, 'unused')
})

test('以前只有 coupon 一张的订单：订单页也给 coupons', async () => {
  const q = await ok(alice.coffee('quote', { items: [item('拿铁')] }))
  const { id } = await ok(alice.coffee('createOrder', { items: [item('拿铁')], mode: 'takeaway', couponId: q.coupon.id }))
  await db.collection('coffee_orders').doc(id).update({ data: { coupons: null } })
  const raw = await getDoc('coffee_orders', id)
  assert.equal(raw.coupons, null)
  const mine = await ok(alice.coffee('getOrder', { id }))
  assert.deepEqual(mine.coupons, [raw.coupon])
})
