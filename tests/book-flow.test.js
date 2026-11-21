// 用内存数据库把第 2 步的借书流程跑一遍：导入示例 → 顾客借书 → 收款交书 → 还书算超时；包天送的赠饮券在点单时抵扣
const test = require('node:test')
const assert = require('node:assert/strict')
const { db, as, unwrap, getDoc, setDoc } = require('./helpers/load')

const owner = as('OWNER')
const keeper = as('KEEPER') // 书籍管理员
const barista = as('BARISTA')
const alice = as('ALICE')
const bob = as('BOB')

const ok = (p) => unwrap(p)
const fails = async (p, code) => {
  const res = await p
  assert.equal(res.ok, false, '应该失败却成功了')
  if (code) assert.equal(res.code, code, res.msg)
  return res
}

let shelf
let menu

test('准备：店主、书籍管理员、咖啡师，导入示例菜单和书', async () => {
  db.reset()
  await ok(owner.common('bindOwner', { name: '坤总' }))
  for (const [who, role] of [[keeper, 'book_manager'], [barista, 'barista']]) {
    const invite = await ok(owner.common('createInvite', { role }))
    await ok(who.common('bindStaff', { name: role, code: invite.code }))
  }
  await ok(owner.coffee('seedDemo'))
  menu = await ok(alice.coffee('getMenu'))

  await fails(barista.book('seedDemo'), 'FORBIDDEN')
  await fails(keeper.coffee('listOrders'), 'FORBIDDEN')
  const seeded = await ok(keeper.book('seedDemo'))
  assert.deepEqual(seeded, { bookCount: 3, ruleCount: 2 })
  await fails(keeper.book('seedDemo'))
  shelf = await ok(alice.book('getShelf'))
  assert.equal(shelf.books.length, 3)
  assert.deepEqual(shelf.categories, ['文学', '国学'])
  assert.deepEqual(shelf.rules.map((r) => r.summary), ['¥8/小时', '¥39/天，送 1 杯饮品'])
})

const bookOf = (title) => shelf.books.find((b) => b.title === title)
const ruleOf = (type) => shelf.rules.find((r) => r.type === type)

test('按小时借书：先付款再交书，超时按小时补', async () => {
  const book = bookOf('瓦尔登湖') // 只有 1 本
  await fails(alice.book('createRental', { bookId: book._id, ruleId: ruleOf('hourly')._id, hours: 9 }))
  const { id } = await ok(alice.book('createRental', { bookId: book._id, ruleId: ruleOf('hourly')._id, hours: 2, remark: '靠窗' }))
  const rental = await ok(alice.book('getRental', { id }))
  assert.equal(rental.code, 'B001')
  assert.equal(rental.fee, 1600)
  assert.equal(rental.status, 'pending')
  assert.equal(rental._openid, undefined)

  // 唯一的一本被占住了，别人借不到
  await fails(bob.book('createRental', { bookId: book._id, ruleId: ruleOf('hourly')._id, hours: 1 }), 'SHELF_CHANGED')
  assert.equal((await ok(bob.book('getShelf'))).books.find((b) => b._id === book._id).available, 0)
  await fails(bob.book('getRental', { id }), 'FORBIDDEN')

  // 后台：没收款不能交书
  const list = await ok(keeper.book('listRentals', { status: 'pending' }))
  assert.equal(list.counts.pending, 1)
  assert.deepEqual(list.pendingIds, [id])
  await fails(keeper.book('handOut', { id }))
  await fails(barista.book('markRentalPaid', { id }), 'FORBIDDEN')
  await ok(keeper.book('markRentalPaid', { id }))
  await fails(keeper.book('markRentalPaid', { id }))
  await fails(alice.book('cancelRental', { id }), undefined)
  const out = await ok(keeper.book('handOut', { id }))
  const reading = await ok(alice.book('getRental', { id }))
  assert.equal(reading.status, 'reading')
  assert.ok(Math.abs(out.dueAtMs - (Date.now() + 2 * 3600 * 1000)) < 5000, '2 小时后到期')
  assert.equal(reading.overtimeNow.fee, 0)

  // 假装已经超时 75 分钟：补 2 小时
  await setDoc('book_rentals', id, { dueAt: new Date(Date.now() - 75 * 60000) })
  const staffView = await ok(keeper.book('listRentals', { status: 'reading' }))
  assert.equal(staffView.rentals[0].overtimeNow.hours, 2)
  const ret = await ok(keeper.book('returnBook', { id }))
  assert.equal(ret.overtimeFee, 1600)
  await fails(keeper.book('returnBook', { id }))
  const returned = await ok(alice.book('getRental', { id }))
  assert.equal(returned.status, 'returned')
  assert.equal(returned.overtimePayStatus, 'unpaid')
  await ok(keeper.book('markOvertimePaid', { id }))
  await fails(keeper.book('markOvertimePaid', { id }))
  assert.equal((await ok(bob.book('getShelf'))).books.find((b) => b._id === book._id).available, 1, '还书后放回书架')
})

test('顾客取消没付款的借阅，书放回去；同时最多借 3 本', async () => {
  const book = bookOf('小王子') // 2 本
  const hourly = ruleOf('hourly')._id
  const a = await ok(bob.book('createRental', { bookId: book._id, ruleId: hourly, hours: 1 }))
  await ok(bob.book('createRental', { bookId: book._id, ruleId: hourly, hours: 1 }))
  await fails(alice.book('createRental', { bookId: book._id, ruleId: hourly, hours: 1 }), 'SHELF_CHANGED')
  await ok(bob.book('createRental', { bookId: bookOf('人间词话')._id, ruleId: hourly, hours: 1 }))
  await fails(bob.book('createRental', { bookId: bookOf('瓦尔登湖')._id, ruleId: hourly, hours: 1 }))
  await fails(alice.book('cancelRental', { id: a.id }))
  await ok(bob.book('cancelRental', { id: a.id }))
  const mine = await ok(bob.book('myRentals', { page: 0 }))
  assert.equal(mine.rentals.length, 3)
  assert.equal(mine.rentals.filter((r) => r.status === 'cancelled').length, 1)
  await ok(alice.book('createRental', { bookId: book._id, ruleId: hourly, hours: 1 }))
})

test('册数不能改得比借出去的少；借出去的书不能删', async () => {
  const book = await ok(keeper.book('getBookAdmin', { id: bookOf('小王子')._id }))
  assert.equal(book.available, 0)
  await fails(keeper.book('saveBook', { book: Object.assign({}, book, { copies: 1 }) }))
  await fails(keeper.book('deleteBook', { id: book._id }))
  await ok(keeper.book('saveBook', { book: Object.assign({}, book, { copies: 5 }) }))
  const after = await ok(keeper.book('getBookAdmin', { id: book._id }))
  assert.equal(after.copies, 5)
  assert.equal(after.available, 3)
  await fails(keeper.book('saveBook', { book: { title: '新书', copies: 1, isbn: '123' } }))
  const added = await ok(keeper.book('saveBook', { book: { title: '新书', copies: 1, isbn: '978-7-02-000220-7' } }))
  await fails(keeper.book('saveBook', { book: { title: '同一本', copies: 1, isbn: '9787020002207' } }))
  await ok(keeper.book('setBookFlags', { id: added.id, onShelf: false }))
  assert.ok(!(await ok(alice.book('getShelf'))).books.some((b) => b._id === added.id), '下架的书顾客看不到')
  await fails(alice.book('getBook', { id: added.id }))
  await ok(keeper.book('deleteBook', { id: added.id }))
})

test('一本书最多 999 册', async () => {
  await fails(keeper.book('saveBook', { book: { title: '一千本', copies: 1000 } }))
  const big = await ok(keeper.book('saveBook', { book: { title: '九百九十九本', copies: 999 } }))
  const saved = await ok(keeper.book('getBookAdmin', { id: big.id }))
  assert.equal(saved.copies, 999)
  assert.equal(saved.available, 999)
  await fails(keeper.book('saveBook', { book: Object.assign({}, saved, { copies: 1000 }) }))
  const imported = await ok(keeper.book('importBooks', { books: [{ title: '导入 999 本', copies: 999 }, { title: '导入 1000 本', copies: 1000 }] }))
  assert.equal(imported.created, 1)
  assert.deepEqual(imported.skipped.map((s) => s.index), [1])
  const books = await ok(keeper.book('adminListBooks'))
  for (const b of books.filter((x) => x.title === '九百九十九本' || x.title === '导入 999 本')) {
    await ok(keeper.book('deleteBook', { id: b._id }))
  }
})

test('包天送咖啡：付款后发券，点单自动抵扣一杯，取消订单退券', async () => {
  // 把赠饮限定成拿铁和美式，每杯最多抵 25 元
  const rules = await ok(keeper.book('adminListRules'))
  const dayRule = rules.find((r) => r.type === 'day')
  const latte = menu.products.find((p) => p.name === '拿铁')
  const americano = menu.products.find((p) => p.name === '美式')
  await ok(keeper.book('saveRule', {
    rule: Object.assign({}, dayRule, { freeProducts: [{ id: latte._id, name: '拿铁' }, { id: americano._id, name: '美式' }] })
  }))

  const { id } = await ok(alice.book('createRental', { bookId: bookOf('小王子')._id, ruleId: dayRule._id }))
  const rental = await ok(alice.book('getRental', { id }))
  assert.equal(rental.fee, 3900)
  assert.equal((await ok(alice.coffee('myVouchers'))).usable.length, 0, '没付款不发券')
  const paid = await ok(keeper.book('markRentalPaid', { id }))
  assert.equal(paid.voucherCount, 1)
  const vouchers = await ok(alice.coffee('myVouchers'))
  assert.equal(vouchers.usable.length, 1)
  assert.deepEqual(vouchers.usable[0].productNames, ['拿铁', '美式'])

  const big = [{ name: '杯型', option: '大杯' }, { name: '温度', option: '热' }]
  const items = [
    { productId: latte._id, qty: 1, specs: big },
    { productId: menu.products.find((p) => p.name === '手冲')._id, qty: 1 }
  ]
  const quote = await ok(alice.coffee('quote', { items }))
  assert.equal(quote.total, 2500 + 3200)
  assert.equal(quote.discountFee, 2500, '手冲不在赠饮范围，抵扣大杯拿铁')
  assert.equal(quote.payFee, 3200)

  // 别人拿这张券下单不行
  await fails(bob.coffee('createOrder', { mode: 'takeaway', items, voucherIds: [quote.applied[0].id] }), 'VOUCHER_CHANGED')

  const order1 = await ok(alice.coffee('createOrder', { mode: 'takeaway', items, voucherIds: quote.applied.map((a) => a.id) }))
  const o1 = await ok(alice.coffee('getOrder', { id: order1.id }))
  assert.equal(o1.discountFee, 2500)
  assert.equal(o1.payFee, 3200)
  assert.equal(o1.vouchers[0].name, '拿铁')
  assert.equal((await ok(alice.coffee('myVouchers'))).usable.length, 0)
  // 同一张券不能用两次
  await fails(alice.coffee('createOrder', { mode: 'takeaway', items, voucherIds: quote.applied.map((a) => a.id) }), 'VOUCHER_CHANGED')

  await ok(alice.coffee('cancelOrder', { id: order1.id }))
  assert.equal((await ok(alice.coffee('myVouchers'))).usable.length, 1, '取消订单后券退回来')

  // 店员取消已制作的订单也退券
  const order2 = await ok(alice.coffee('createOrder', { mode: 'takeaway', items, voucherIds: quote.applied.map((a) => a.id) }))
  await ok(barista.coffee('setOrderStatus', { id: order2.id, status: 'making' }))
  await ok(barista.coffee('setOrderStatus', { id: order2.id, status: 'cancelled' }))
  assert.equal((await ok(alice.coffee('myVouchers'))).usable.length, 1)

  // 券只在发券当天有效
  const vid = quote.applied[0].id
  await setDoc('vouchers', vid, { day: '2000-01-01' })
  const expired = await ok(alice.coffee('myVouchers'))
  assert.equal(expired.usable.length, 0)
  assert.equal(expired.others[0].status, 'expired')
  assert.equal((await ok(alice.coffee('quote', { items }))).discountFee, 0)
  await setDoc('vouchers', vid, { day: (await getDoc('book_rentals', id)).day })

  // 包天到当天结束，不收超时费
  await ok(keeper.book('handOut', { id }))
  await setDoc('book_rentals', id, { dueAt: new Date(Date.now() - 5 * 3600 * 1000) })
  const ret = await ok(keeper.book('returnBook', { id }))
  assert.equal(ret.overtimeFee, 0)
})

test('店员取消已付款的包天：书放回去，没用的券作废', async () => {
  const dayRule = (await ok(keeper.book('adminListRules'))).find((r) => r.type === 'day')
  const book = bookOf('瓦尔登湖')
  const { id } = await ok(bob.book('createRental', { bookId: book._id, ruleId: dayRule._id }))
  await fails(bob.book('createRental', { bookId: book._id, ruleId: dayRule._id }))
  await ok(keeper.book('markRentalPaid', { id }))
  assert.equal((await ok(bob.coffee('myVouchers'))).usable.length, 1)
  const res = await ok(keeper.book('adminCancelRental', { id }))
  assert.deepEqual(res, { paid: true, refunded: false, voidedVouchers: 1 })
  assert.equal((await ok(bob.coffee('myVouchers'))).usable.length, 0)
  assert.equal((await ok(bob.book('getShelf'))).books.find((b) => b._id === book._id).available, 1)
  const cancelled = await ok(keeper.book('listRentals', { status: 'cancelled' }))
  assert.ok(cancelled.rentals.some((r) => r._id === id))
})

test('规则管理：下架后顾客看不到也不能用；按小时价格不能为 0', async () => {
  const rules = await ok(keeper.book('adminListRules'))
  const hourly = rules.find((r) => r.type === 'hourly')
  await fails(keeper.book('saveRule', { rule: Object.assign({}, hourly, { price: 0 }) }))
  await ok(keeper.book('setRuleFlags', { id: hourly._id, onShelf: false }))
  const s = await ok(alice.book('getShelf'))
  assert.deepEqual(s.rules.map((r) => r.type), ['day'])
  await fails(alice.book('createRental', { bookId: bookOf('小王子')._id, ruleId: hourly._id, hours: 1 }), 'SHELF_CHANGED')
  await ok(keeper.book('deleteRule', { id: hourly._id }))
  assert.equal((await ok(keeper.book('adminListRules'))).length, 1)
})

test('新版本加的集合不存在时自动建好', async () => {
  db.dropCollection('vouchers')
  const res = await ok(alice.coffee('myVouchers'))
  assert.deepEqual(res, { usable: [], others: [] })
  db.dropCollection('book_rules')
  const s = await ok(alice.book('getShelf'))
  assert.deepEqual(s.rules, [])
  await ok(keeper.book('saveRule', { rule: { type: 'hourly', name: '新规则', price: 600 } }))
  assert.ok(db.hasCollection('book_rules'), '写入时自动建集合')
})
