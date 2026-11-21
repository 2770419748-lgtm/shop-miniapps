// 小程序要截的画面（run.js 用）。顾客 C1 有余额和订单、C9 是新顾客、OWNER 是店主，数据来自 admin-web/mock/seed.js
const http = require('http')
function post(port, path, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({ host: 'localhost', port, path, method: 'POST', headers: { 'content-type': 'application/json', 'x-session': token || '' } }, (res) => {
      let s = ''
      res.on('data', (c) => (s += c))
      res.on('end', () => resolve(JSON.parse(s)))
    })
    req.on('error', reject)
    req.end(data)
  })
}
async function as(port, user) {
  const t = (await post(port, '/api/login', { code: user })).data.token
  return async (mod, action, data) => {
    const r = await post(port, '/api/' + mod, Object.assign({ action }, data || {}), t)
    if (!r.ok) throw new Error(mod + '.' + action + ': ' + r.msg)
    return r.data
  }
}

const addTwo = async ({ frame, idle }) => {
  await frame.click('text=选规格'); await idle()
  await frame.click('text=加入购物车'); await idle()
  await frame.locator('.add-btn').first().click(); await idle()
}

module.exports = async (port) => {
  const c1 = await as(port, 'C1')
  const owner = await as(port, 'OWNER')
  // 书架分类按店里真实的样子多建几个（2026-11 书架分类栏出过问题：分类多了要能横着滑）
  for (const [title, author, category] of [['排球少年', '古馆春一', '运动热血'], ['NANA', '矢泽爱', '恋爱'], ['爆漫王', '大场鸫', '青春励志'], ['灌篮高手', '井上雄彦', '热血励志']]) {
    await owner('book', 'saveBook', { book: { title, author, category, copies: 3 } })
  }
  const orders = await c1('coffee', 'myOrders')
  const list = orders.list || orders.orders || orders
  const shelf = await c1('book', 'getShelf')
  const rentals = await c1('book', 'myRentals')
  const rlist = rentals.list || rentals.rentals || rentals
  const addrs = await c1('coffee', 'listAddresses')
  const alist = addrs.list || addrs
  const prods = await owner('coffee', 'adminListProducts')
  const books = await owner('book', 'adminListBooks')
  const rules = await owner('book', 'adminListRules')
  const coupons = await owner('coffee', 'adminListCoupons')
  const ms = await owner('member', 'getMemberSettings')
  const banners = await owner('common', 'listBanners')
  const members = await owner('member', 'listMembers', {})
  const mlist = members.list || members.members || members
  const find = (arr, fn) => (Array.isArray(arr) ? arr.find(fn) : null)
  const deliveryOrder = find(list, (o) => o.mode === 'delivery')
  const dineOrder = find(list, (o) => o.mode === 'dine_in')
  const takeOrder = find(list, (o) => o.mode === 'takeaway')
  const S = []
  const add = (s) => S.push(s)
  // 顾客
  add({ name: 'c-index', page: 'pages/index/index', user: 'C1', full: true })
  add({ name: 'c-index-new', page: 'pages/index/index', user: 'C9', full: true })
  add({ name: 'c-menu', page: 'pages/menu/menu', user: 'C2' })
  add({ name: 'c-menu-spec', page: 'pages/menu/menu', user: 'C2', act: async (x) => { await addTwo(x); await x.frame.click('text=选规格') } })
  add({ name: 'c-menu-cart', page: 'pages/menu/menu', user: 'C2', act: async (x) => { await addTwo(x); await x.frame.click('.cart-info') } })
  add({ name: 'c-menu-table', page: 'pages/menu/menu', user: 'C2', storage: { jinshan_table: { tableNo: 'A1', at: Date.now() } }, act: addTwo })
  add({ name: 'c-menu-delivery', page: 'pages/menu/menu', user: 'C1', storage: { jinshan_delivery: { at: Date.now() } }, act: addTwo })
  add({ name: 'c-confirm', page: 'pages/confirm/confirm', user: 'C1', prep: [{ page: 'pages/menu/menu', act: addTwo }], full: true })
  add({ name: 'c-confirm-view', page: 'pages/confirm/confirm', user: 'C1', prep: [{ page: 'pages/menu/menu', act: addTwo }] })
  add({ name: 'c-confirm-delivery', page: 'pages/confirm/confirm', user: 'C1', storage: { jinshan_delivery: { at: Date.now() } }, prep: [{ page: 'pages/menu/menu', act: addTwo }], full: true })
  add({ name: 'c-confirm-reserve', page: 'pages/confirm/confirm', user: 'C1', storage: { jinshan_reserve: { at: Date.now() } }, prep: [{ page: 'pages/menu/menu', act: addTwo }], full: true })
  add({ name: 'c-orders', page: 'pages/orders/orders', user: 'C1', full: true })
  add({ name: 'c-orders-empty', page: 'pages/orders/orders', user: 'C9' })
  if (dineOrder) add({ name: 'c-order-dine', page: 'pages/order-detail/order-detail', user: 'C1', q: { id: dineOrder._id }, full: true })
  if (deliveryOrder) add({ name: 'c-order-delivery', page: 'pages/order-detail/order-detail', user: 'C1', q: { id: deliveryOrder._id }, full: true })
  if (takeOrder) add({ name: 'c-order-take', page: 'pages/order-detail/order-detail', user: 'C1', q: { id: takeOrder._id }, full: true })
  add({ name: 'c-mine', page: 'pages/mine/mine', user: 'C1', full: true })
  add({ name: 'c-mine-owner', page: 'pages/mine/mine', user: 'OWNER', full: true })
  add({ name: 'c-bind-owner', page: 'pages/bind/bind', user: 'C9', q: { type: 'owner' } })
  add({ name: 'c-bind-staff', page: 'pages/bind/bind', user: 'C9', q: { type: 'staff' } })
  add({ name: 'c-books', page: 'pages/books/books', user: 'C1', full: true })
  add({ name: 'c-books-view', page: 'pages/books/books', user: 'C1' })
  const bk = (shelf.books || [])[1] || (shelf.books || [])[0]
  if (bk) add({ name: 'c-book-detail', page: 'pages/book-detail/book-detail', user: 'C4', q: { id: bk._id } })
  if (bk) add({ name: 'c-book-detail-full', page: 'pages/book-detail/book-detail', user: 'C4', q: { id: bk._id }, full: true })
  ;(Array.isArray(rlist) ? rlist : []).slice(0, 2).forEach((r, i) => add({ name: 'c-rental-' + i, page: 'pages/rental-detail/rental-detail', user: 'C1', q: { id: r._id }, full: true }))
  add({ name: 'c-vouchers', page: 'pages/vouchers/vouchers', user: 'C2', full: true })
  // C1 手里有充值送的基础饮品券（限商品）和小食券（限分类）
  add({ name: 'c-vouchers-scoped', page: 'pages/vouchers/vouchers', user: 'C1', full: true })
  add({ name: 'c-coupons', page: 'pages/coupons/coupons', user: 'C1', full: true })
  add({ name: 'c-member', page: 'pages/member/member', user: 'C1', full: true })
  add({ name: 'c-member-view', page: 'pages/member/member', user: 'C4' })
  add({ name: 'c-member-logs', page: 'pages/member-logs/member-logs', user: 'C1', full: true })
  add({ name: 'c-stars', page: 'pages/stars/stars', user: 'C1', full: true })
  add({ name: 'c-addresses', page: 'pages/addresses/addresses', user: 'C1' })
  add({ name: 'c-addresses-empty', page: 'pages/addresses/addresses', user: 'C9' })
  if (alist && alist[0]) add({ name: 'c-address-edit', page: 'pages/address-edit/address-edit', user: 'C1', q: { id: alist[0]._id } })
  add({ name: 'c-address-new', page: 'pages/address-edit/address-edit', user: 'C1' })
  // 店员后台
  const A = (n, p, q, extra) => add(Object.assign({ name: 'a-' + n, page: 'admin/pages/' + p + '/' + p, user: 'OWNER', q, full: true }, extra || {}))
  A('home', 'home')
  A('orders', 'orders')
  A('products', 'products')
  A('products-view', 'products', null, { full: false })
  const prod = (prods.products || []).find((p) => (p.specs || []).length)
  if (prod) A('product-edit', 'product-edit', { id: prod._id })
  A('product-new', 'product-edit')
  A('categories', 'categories')
  A('tables', 'tables')
  A('staff', 'staff')
  A('rentals', 'rentals')
  A('books', 'books')
  A('books-view', 'books', null, { full: false })
  const b0 = (books.books || books)[0]
  if (b0) A('book-edit', 'book-edit', { id: b0._id })
  A('rules', 'rules')
  const r0 = (rules.rules || rules)[0]
  if (r0) A('rule-edit', 'rule-edit', { id: r0._id })
  A('web-account', 'web-account')
  A('shop-settings', 'shop-settings')
  A('web-login', 'web-login')
  A('banners', 'banners')
  A('banners-view', 'banners', null, { full: false })
  const bn = (banners.banners || banners)[0]
  if (bn) A('banner-edit', 'banner-edit', { id: bn._id })
  A('coupons', 'coupons')
  const cpList = coupons.coupons || coupons
  const cp = cpList[0]
  if (cp) A('coupon-edit', 'coupon-edit', { id: cp._id })
  // 限分类的券、只在充值时送且限商品的券
  const cpCat = cpList.find((c) => (c.categoryIds || []).length)
  if (cpCat) A('coupon-edit-category', 'coupon-edit', { id: cpCat._id })
  const cpGift = cpList.find((c) => c.giftOnly)
  if (cpGift) A('coupon-edit-gift', 'coupon-edit', { id: cpGift._id })
  A('members', 'members')
  const m0 = Array.isArray(mlist) ? mlist[0] : null
  if (m0) A('member-detail', 'member-detail', { no: m0.memberNo })
  A('member-settings', 'member-settings')
  const pl = (ms.plans || [])[0]
  if (pl) A('plan-edit', 'plan-edit', { id: pl._id })
  const plGifts = (ms.plans || []).find((p) => (p.gifts || []).length > 1)
  if (plGifts) A('plan-edit-gifts', 'plan-edit', { id: plGifts._id })
  A('plan-new', 'plan-edit')
  A('star-settings', 'star-settings')
  // 弹层
  add({ name: 'x-confirm-coupons', page: 'pages/confirm/confirm', user: 'C1', prep: [{ page: 'pages/menu/menu', act: addTwo }], act: async ({ frame }) => { await frame.click('text=代金券') } })
  add({ name: 'x-menu-spec3', page: 'pages/menu/menu', user: 'C2', act: async ({ frame, idle }) => { await addTwo({ frame, idle }); await frame.click('text=非咖啡'); await idle(); await frame.locator('text=选规格').first().click() } })
  add({ name: 'x-menu-spec3-se', w: 320, h: 568, safe: 0, page: 'pages/menu/menu', user: 'C2', act: async ({ frame, idle }) => { await frame.click('text=非咖啡'); await idle(); await frame.locator('text=选规格').first().click() } })
  add({ name: 'x-staff-invite', page: 'admin/pages/staff/staff', user: 'OWNER', act: async ({ frame, idle, page }) => { await frame.click('text=+ 邀请员工'); await idle(); const ok = page.locator('.sheet div').first(); if (await ok.count()) await ok.click() } })
  if (m0) {
    add({ name: 'x-member-recharge', page: 'admin/pages/member-detail/member-detail', user: 'OWNER', q: { no: m0.memberNo }, act: async ({ frame }) => { await frame.click('text=吧台充值') } })
    add({ name: 'x-member-adjust', page: 'admin/pages/member-detail/member-detail', user: 'OWNER', q: { no: m0.memberNo }, act: async ({ frame }) => { await frame.click('text=调整') } })
    add({ name: 'x-member-stars', page: 'admin/pages/member-detail/member-detail', user: 'OWNER', q: { no: m0.memberNo }, act: async ({ frame }) => { await frame.click('text=加减星') } })
  }
  return S
}
