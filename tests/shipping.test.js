// 微信发货信息管理：微信支付到账后记一条，每分钟传给微信；没开这项服务时不传；失败了过一会儿再试
const test = require('node:test')
const assert = require('node:assert/strict')
const platform = require('../server/platform')
const { db, state, as, unwrap, getDoc, setDoc, modules } = require('./helpers/load')
const shipping = require('../server/functions/shipping')

const owner = as('OWNER')
const alice = as('ALICE')

const ok = (p) => unwrap(p)
const notify = (name, outTradeNo) => modules[name].onPayNotify({ outTradeNo })
const sync = () => modules.coffee.syncShipping()
const queued = (tx) => getDoc('ship_queue', tx)
// 让排着的这条马上能再试
const due = (tx) => setDoc('ship_queue', tx, { nextAt: new Date(Date.now() - 1000) })

let menu

function reset() {
  state.shipping.managed = true
  state.shipping.managedError = false
  state.shipping.uploadError = 0
  state.shipping.uploads.length = 0
  shipping.resetCache()
}

// 下一单外带并用微信付掉，返回订单
async function paidTakeaway(items) {
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items }))
  await ok(alice.coffee('payOrder', { id }))
  const order = await ok(alice.coffee('getOrder', { id }))
  state.payOrders[order.orderNo].paid = true
  await notify('coffee', order.orderNo)
  return order
}

test('准备：店主、菜单、书、开微信支付', async () => {
  db.reset()
  state.payReady = true
  reset()
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.coffee('seedDemo'))
  await ok(owner.book('seedDemo'))
  await ok(owner.common('saveShopSettings', { payEnabled: true, allowCounter: true }))
  menu = await ok(alice.coffee('getMenu'))
})

const product = (name) => menu.products.find((p) => p.name === name)

test('咖啡外带：付款后记一条，下一分钟按「用户自提」传上去，只传一次', async () => {
  reset()
  const order = await paidTakeaway([{ productId: product('手冲')._id, qty: 2 }, { productId: product('芝士蛋糕')._id, qty: 1 }])
  const tx = 'tx' + order.orderNo
  // 通知重复到达也只记一条
  await notify('coffee', order.orderNo)
  const item = await queued(tx)
  assert.equal(item.status, 'pending')
  assert.equal(state.shipping.uploads.length, 0, '付款当时不传，等每分钟的任务')

  await sync()
  assert.equal(state.shipping.uploads.length, 1)
  const body = state.shipping.uploads[0]
  assert.deepEqual(body.order_key, { order_number_type: 2, transaction_id: tx })
  assert.equal(body.logistics_type, 4)
  assert.equal(body.delivery_mode, 1)
  assert.deepEqual(body.payer, { openid: 'ALICE' }, '付款人是微信查单返回的 openid')
  assert.equal(body.shipping_list[0].item_desc, '进山咖啡-取餐号' + order.pickupNo + '：手冲×2、芝士蛋糕')
  assert.match(body.upload_time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/)
  assert.equal((await queued(tx)).status, 'done')

  await sync()
  assert.equal(state.shipping.uploads.length, 1, '传过的不再传')
})

test('付款途中顾客取消了：钱原路退回，不传发货信息', async () => {
  reset()
  const { id } = await ok(alice.coffee('createOrder', { mode: 'takeaway', items: [{ productId: product('手冲')._id, qty: 1 }] }))
  await ok(alice.coffee('payOrder', { id }))
  await ok(alice.coffee('cancelOrder', { id }))
  const order = await ok(alice.coffee('getOrder', { id }))
  state.payOrders[order.orderNo].paid = true
  await notify('coffee', order.orderNo)
  assert.equal((await ok(alice.coffee('getOrder', { id }))).payStatus, 'refunded')
  assert.equal(await queued('tx' + order.orderNo), null)
})

test('借书租金按「用户自提」，超时费按「虚拟商品」', async () => {
  reset()
  const shelf = await ok(alice.book('getShelf'))
  const hourly = shelf.rules.find((r) => r.type === 'hourly')
  const book = shelf.books.find((b) => b.title === '小王子')
  const h = await ok(alice.book('createRental', { bookId: book._id, ruleId: hourly._id, hours: 1 }))
  await ok(alice.book('payRental', { id: h.id }))
  const rental = await ok(alice.book('getRental', { id: h.id }))
  state.payOrders[rental.rentalNo].paid = true
  await notify('book', rental.rentalNo)
  await ok(owner.book('handOut', { id: h.id }))
  await setDoc('book_rentals', h.id, { dueAt: new Date(Date.now() - 90 * 60000) })
  await ok(owner.book('returnBook', { id: h.id }))
  await ok(alice.book('payRental', { id: h.id, kind: 'overtime' }))
  const otNo = 'JO' + rental.rentalNo.slice(2)
  state.payOrders[otNo].paid = true
  await notify('book', otNo)

  await sync()
  const byTx = (tx) => state.shipping.uploads.find((u) => u.order_key.transaction_id === tx)
  assert.equal(byTx('tx' + rental.rentalNo).logistics_type, 4)
  assert.equal(byTx('tx' + rental.rentalNo).shipping_list[0].item_desc, '进山书屋-借阅《小王子》')
  assert.equal(byTx('tx' + otNo).logistics_type, 3)
  assert.equal(byTx('tx' + otNo).shipping_list[0].item_desc, '进山书屋-超时费《小王子》')
})

test('会员储值按「虚拟商品」', async () => {
  reset()
  await ok(owner.member('saveMemberSettings', { enabled: true }))
  const planId = (await ok(owner.member('savePlan', { plan: { price: 30000, bonus: 10000, memberDays: 365 } }))).id
  const r = await ok(alice.member('createRecharge', { planId }))
  const recharge = await getDoc('member_recharges', r.id)
  state.payOrders[recharge.rechargeNo].paid = true
  await notify('member', recharge.rechargeNo)
  await notify('member', recharge.rechargeNo)
  await sync()
  assert.equal(state.shipping.uploads.length, 1)
  assert.equal(state.shipping.uploads[0].logistics_type, 3)
  assert.equal(state.shipping.uploads[0].order_key.transaction_id, 'tx' + recharge.rechargeNo)
  assert.equal(state.shipping.uploads[0].shipping_list[0].item_desc, '进山会员-' + recharge.title)
})

test('外送按「同城配送」；描述太长截到 100 个字', async () => {
  reset()
  const long = '外送'.repeat(80)
  assert.equal(await shipping.record({ type: 'delivery', paid: { transactionId: 'txD1', payerOpenid: 'ALICE' }, desc: long }), true)
  assert.equal(await shipping.record({ type: 'delivery', paid: { transactionId: 'txD1', payerOpenid: 'ALICE' }, desc: long }), false, '同一笔不重复记')
  assert.equal(await shipping.record({ type: 'nope', paid: { transactionId: 'txD2' } }), false)
  assert.equal(await shipping.record({ type: 'pickup', paid: { transactionId: '' } }), false)
  await sync()
  assert.equal(state.shipping.uploads.length, 1)
  assert.equal(state.shipping.uploads[0].logistics_type, 2)
  assert.equal(Array.from(state.shipping.uploads[0].shipping_list[0].item_desc).length, 100)
})

test('小程序没开发货信息管理：不传，一小时后再问；一天后不再管', async () => {
  reset()
  state.shipping.managed = false
  await shipping.record({ type: 'pickup', paid: { transactionId: 'txN1', payerOpenid: 'ALICE' }, desc: '手冲' })
  await sync()
  assert.equal(state.shipping.uploads.length, 0)
  const item = await queued('txN1')
  assert.equal(item.status, 'pending')
  assert.ok(item.nextAt.getTime() > Date.now() + 50 * 60000, '一小时后再看')

  await setDoc('ship_queue', 'txN1', { nextAt: new Date(Date.now() - 1000), createdAt: new Date(Date.now() - 25 * 3600 * 1000) })
  await sync()
  assert.equal((await queued('txN1')).status, 'not_needed')

  // 问微信出错时这一轮先不动
  reset()
  state.shipping.managedError = true
  await shipping.record({ type: 'pickup', paid: { transactionId: 'txN2', payerOpenid: 'ALICE' }, desc: '手冲' })
  await sync()
  const n2 = await queued('txN2')
  assert.equal(n2.status, 'pending')
  assert.equal(n2.tries, 0)
  state.shipping.managedError = false
  await sync()
  assert.equal((await queued('txN2')).status, 'done')
})

test('上传失败过一会儿再试，次数多了不再试；已发过货算完成，退了款的不再传', async () => {
  reset()
  state.shipping.uploadError = 10060012
  await shipping.record({ type: 'pickup', paid: { transactionId: 'txE1', payerOpenid: 'ALICE' }, desc: '手冲' })
  await sync()
  let item = await queued('txE1')
  assert.equal(item.status, 'pending')
  assert.equal(item.tries, 1)
  assert.match(item.lastError, /10060012/)
  const wait = item.nextAt.getTime() - Date.now()
  assert.ok(wait > 50 * 1000 && wait <= 60 * 1000, '第一次失败一分钟后再试')
  await sync()
  assert.equal((await queued('txE1')).tries, 1, '没到时间不重试')

  await due('txE1')
  await sync()
  item = await queued('txE1')
  assert.equal(item.tries, 2)
  assert.ok(item.nextAt.getTime() - Date.now() > 110 * 1000, '第二次失败两分钟后再试')

  await setDoc('ship_queue', 'txE1', { tries: 11, nextAt: new Date(Date.now() - 1000) })
  await sync()
  assert.equal((await queued('txE1')).status, 'failed')

  state.shipping.uploadError = 10060002
  await shipping.record({ type: 'pickup', paid: { transactionId: 'txE2', payerOpenid: 'ALICE' }, desc: '手冲' })
  await sync()
  assert.equal((await queued('txE2')).status, 'done')

  state.shipping.uploadError = 10060004
  await shipping.record({ type: 'pickup', paid: { transactionId: 'txE3', payerOpenid: 'ALICE' }, desc: '手冲' })
  await sync()
  assert.equal((await queued('txE3')).status, 'skipped')
})

test('测试版不传', async () => {
  reset()
  await shipping.record({ type: 'pickup', paid: { transactionId: 'txT1', payerOpenid: 'ALICE' }, desc: '手冲' })
  platform.configure({ env: 'test' })
  try {
    await sync()
  } finally {
    platform.configure({ env: null })
  }
  assert.equal(state.shipping.uploads.length, 0)
  assert.equal((await queued('txT1')).status, 'pending')
})

test('北京时间格式', () => {
  assert.equal(shipping.rfc3339(Date.UTC(2026, 10, 6, 10, 30, 5)), '2026-11-06T18:30:05+08:00')
  assert.equal(shipping.describe('  '), '进山咖啡')
})
