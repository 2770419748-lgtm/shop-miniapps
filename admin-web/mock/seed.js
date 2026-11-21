// 预览用的假数据：店主、员工、示例菜单和书、轮播、代金券、会员储值、集星、外送、几张订单和借书单；洗车店的设置、项目、次卡、送券规则、技师和几张预约单。
// 这些数字只是预览用的，真店里的营业时间、名额、价格都由店长在后台自己填
module.exports = async function seed(as, db) {
  const ok = async (p) => {
    const res = await p
    if (!res.ok) throw new Error(res.msg)
    return res.data
  }
  const owner = as('OWNER')
  await ok(owner.common('bindOwner', { name: '坤总' }))
  await ok(owner.common('setWebAccount', { username: 'boss', password: 'jinshan2026' }))
  for (const [id, role, name] of [['BARISTA', 'barista', '小王'], ['KEEPER', 'book_manager', '小李']]) {
    const invite = await ok(owner.common('createInvite', { role }))
    await ok(as(id).common('bindStaff', { name, code: invite.code }))
  }
  await ok(owner.coffee('seedDemo'))
  await ok(owner.book('seedDemo'))
  for (const no of ['1', '2', '3', '5', 'A1']) await ok(owner.coffee('saveTable', { tableNo: no }))
  const menu = await ok(owner.coffee('getMenu'))
  const byName = (n) => menu.products.find((p) => p.name === n)
  const cup = [{ name: '杯型', option: '大杯' }, { name: '温度', option: '冰' }]
  const customers = ['C1', 'C2', 'C3', 'C4'].map(as)
  await ok(owner.common('saveBanner', { banner: { kind: 'product', targetId: byName('拿铁')._id, title: '秋季新品 桂花拿铁' } }))
  await ok(owner.common('saveBanner', { banner: { kind: 'coupons', subtitle: '满 30 减 5，先到先得' } }))
  const c30 = await ok(owner.coffee('saveCoupon', { coupon: { amount: 500, minSpend: 3000, validDays: 7, total: 100, perUser: 1 } }))
  const newbie = await ok(owner.coffee('saveCoupon', { coupon: { title: '新人券', amount: 300, validDays: 3, perUser: 1 } }))
  // 限品类的券：小食券只能买甜点；基础饮品券只在充值时送，只能抵美式、拿铁、柠檬茶
  const catOf = (n) => menu.categories.find((c) => c.name === n)._id
  const snackCoupon = await ok(owner.coffee('saveCoupon', { coupon: { title: '小食立减4元券（薯条/鸡米花', amount: 400, minSpend: 1200, validDays: 60, perUser: 1, categoryIds: [catOf('甜点')] } }))
  const drinkCoupon = await ok(owner.coffee('saveCoupon', { coupon: { title: '基础饮品券', amount: 1800, validDays: 90, giftOnly: true, productIds: [byName('美式')._id, byName('拿铁')._id, byName('柠檬茶')._id] } }))
  await ok(customers[0].coffee('claimCoupon', { id: snackCoupon.id }))
  await ok(customers[0].coffee('claimCoupon', { id: newbie.id }))
  await ok(customers[1].coffee('claimCoupon', { id: c30.id }))
  await ok(customers[2].coffee('claimCoupon', { id: c30.id }))
  const o1 = await ok(customers[0].coffee('createOrder', { mode: 'dine_in', tableNo: '5', remark: '少冰', items: [{ productId: byName('拿铁')._id, qty: 2, specs: cup }, { productId: byName('芝士蛋糕')._id, qty: 1 }] }))
  const q2 = await ok(customers[1].coffee('quote', { items: [{ productId: byName('手冲')._id, qty: 1 }] }))
  const o2 = await ok(customers[1].coffee('createOrder', { mode: 'takeaway', items: [{ productId: byName('手冲')._id, qty: 1 }], couponId: q2.coupon.id }))
  // 预览里没有微信支付下不了预约单，直接把这单改成两小时后取的预约单
  await db.collection('coffee_orders').doc(o2.id).update({ data: { reserveAt: new Date(Date.now() + 2 * 3600000) } })
  const o3 = await ok(customers[2].coffee('createOrder', { mode: 'dine_in', tableNo: 'A1', items: [{ productId: byName('美式')._id, qty: 1, specs: [{ name: '杯型', option: '中杯' }, { name: '温度', option: '热' }] }] }))
  await ok(owner.coffee('markPaid', { id: o1.id }))
  await ok(owner.coffee('markPaid', { id: o3.id }))
  await ok(owner.coffee('setOrderStatus', { id: o3.id, status: 'making' }))
  const shelf = await ok(owner.book('getShelf'))
  const hourly = shelf.rules.find((r) => r.type === 'hourly')
  const day = shelf.rules.find((r) => r.type === 'day')
  const r1 = await ok(customers[0].book('createRental', { bookId: shelf.books[0]._id, ruleId: hourly._id, hours: 2 }))
  await ok(owner.book('markRentalPaid', { id: r1.id }))
  await ok(owner.book('handOut', { id: r1.id }))
  // 让这本书已经超时 25 分钟
  await db.collection('book_rentals').doc(r1.id).update({ data: { dueAt: new Date(Date.now() - 25 * 60000) } })
  const r2 = await ok(customers[3].book('createRental', { bookId: shelf.books[2]._id, ruleId: day._id }))
  await ok(owner.book('markRentalPaid', { id: r2.id }))
  await ok(customers[1].book('createRental', { bookId: shelf.books[0]._id, ruleId: hourly._id, hours: 1, remark: '靠窗位' }))

  // 会员储值：两个档位（都送券），C1 在吧台充了 300 送 100（送了一张基础饮品券），用余额点了一单；C4 是没充过钱的
  const p300 = await ok(owner.member('savePlan', { plan: { price: 30000, bonus: 10000, memberDays: 365, desc: '送一年会员', gifts: [{ couponId: drinkCoupon.id, count: 1 }] } }))
  await ok(owner.member('savePlan', { plan: { price: 50000, bonus: 20000, memberDays: 365, desc: '最划算', gifts: [{ couponId: drinkCoupon.id, count: 2 }, { couponId: snackCoupon.id, count: 1 }] } }))
  await ok(owner.member('saveMemberSettings', { enabled: true, freeCategories: ['漫画'], notice: '储值金额（含赠送）只能在店里点单、借书时使用，不能提现。' }))
  await ok(owner.book('saveBook', { book: { title: '海贼王 1', author: '尾田荣一郎', category: '漫画', copies: 2 } }))
  const m1 = await ok(customers[0].member('getMember'))
  await ok(customers[3].member('getMember'))
  await ok(as('BARISTA').member('counterRecharge', { memberNo: m1.member.memberNo, planId: p300.id }))
  await ok(as('BARISTA').member('setMemberRemark', { memberNo: m1.member.memberNo, remark: '张女士 尾号 6688' }))
  await ok(customers[0].coffee('createOrder', { mode: 'takeaway', payBy: 'balance', items: [{ productId: byName('美式')._id, qty: 1, specs: [{ name: '杯型', option: '中杯' }, { name: '温度', option: '冰' }] }] }))
  // C3 也在吧台充了 300（送基础饮品券），领了小食券，一单里两张一起用：美式用饮品券、蛋糕用小食券
  const m3 = await ok(customers[2].member('getMember'))
  await ok(as('BARISTA').member('counterRecharge', { memberNo: m3.member.memberNo, planId: p300.id }))
  await ok(customers[2].coffee('claimCoupon', { id: snackCoupon.id }))
  const twoItems = [{ productId: byName('美式')._id, qty: 1, specs: [{ name: '杯型', option: '大杯' }, { name: '温度', option: '冰' }] }, { productId: byName('芝士蛋糕')._id, qty: 1 }]
  const q3 = await ok(customers[2].coffee('quote', { items: twoItems, couponIds: 'auto' }))
  await ok(customers[2].coffee('createOrder', { mode: 'takeaway', payBy: 'balance', items: twoItems, couponIds: q3.usedCoupons.map((c) => c.id) }))

  // 外送：店员自己送，3 公里内 5 元、超出每公里加 2 元、满 100 免配送费；C1 用余额下了一张外送单
  await ok(owner.coffee('saveDeliverySettings', {
    settings: {
      enabled: true, location: { lat: 29.58, lng: 105.07 }, hours: { open: '00:00', close: '23:59' },
      store: { name: '进山咖啡', province: '四川省', city: '内江市', area: '东兴区', street: '', house: '预览地址 1 号', phone: '13800000000' },
      radiusKm: 5, minOrder: 2000, baseFee: 500, baseKm: 3, perKmFee: 200, freeAbove: 10000, etaMinutes: 40, notice: '超出范围可以到店自取', provider: 'self'
    }
  }))
  const home = await ok(customers[0].coffee('saveAddress', { address: { name: '张女士', phone: '13800000001', place: '东兴小区', detail: '3 栋 2 单元 501', location: { lat: 29.6, lng: 105.07 } } }))
  await ok(customers[0].coffee('createOrder', { mode: 'delivery', addressId: home.id, payBy: 'balance', remark: '放门口就行', items: [{ productId: byName('拿铁')._id, qty: 2, specs: cup }] }))

  // 集星：咖啡一杯一颗星，10 颗换一杯；C1 把纸质集点卡上的 10 颗转进来，下单时用星换了一杯拿铁
  const coffeeCat = menu.categories.find((c) => c.name === '咖啡')._id
  await ok(owner.coffee('saveStarSettings', { settings: { enabled: true, need: 10, earnAll: false, earnCategories: [coffeeCat], redeemAll: false, redeemCategories: [coffeeCat] } }))
  await ok(owner.member('adjustStars', { memberNo: m1.member.memberNo, amount: 10, reason: '纸质集点卡转过来' }))
  await ok(customers[0].coffee('createOrder', { mode: 'dine_in', tableNo: '2', useStars: true, items: [{ productId: byName('拿铁')._id, qty: 1, specs: cup }, { productId: byName('美式')._id, qty: 1, specs: [{ name: '杯型', option: '中杯' }, { name: '温度', option: '热' }] }] }))

  // 洗车：设置都填上、开放预约；三个项目、一档充值、一种次卡、充满 500 送咖啡券；一位技师；C1 充值办卡后约了到店，C2 约了上门
  await ok(owner.carwash('saveSettings', {
    settings: {
      shopName: '黑镜车体护理车房', address: '预览地址', phone: '028-12345678', location: { lat: 30.657, lng: 104.066 },
      notice: '请提前清空车内贵重物品。', bookingEnabled: true, payLater: true,
      hours: { open: '09:00', close: '19:00' }, slotMinutes: 60, storeCapacity: 2, doorCapacity: 1, bookDays: 7, leadMinutes: 30,
      doorRadiusKm: 10, doorFee: 2000, outOfRange: 'reject', freeCancelMinutes: 120, lateCancel: 'fee', lateCancelFee: 1000, autoConfirmHours: 24
    }
  }))
  const wash = await ok(owner.carwash('saveService', { service: { name: '标准洗车', desc: '外观泡沫洗 + 轮毂 + 内饰吸尘', price: 4000, memberPrice: 3500, minutes: 40, modes: ['store', 'door'] } }))
  await ok(owner.carwash('saveService', { service: { name: '精洗', desc: '标准洗车 + 内饰清洁 + 轮胎上光', price: 8800, memberPrice: 7800, minutes: 90, modes: ['store'] } }))
  await ok(owner.carwash('saveService', { service: { name: '镀晶', price: 68000, minutes: 240, modes: ['store'] } }))
  await ok(owner.carwash('saveMemberSettings', { enabled: true, notice: '洗车储值只能在本店使用，不能提现，和进山咖啡的余额分开。', refundNotice: '次卡按已用次数原价扣除后退还剩余金额。' }))
  const cw500 = await ok(owner.carwash('savePlan', { plan: { price: 50000, bonus: 10000, memberDays: 365, desc: '送一年会员价' } }))
  const card10 = await ok(owner.carwash('saveCardType', { cardType: { name: '标准洗车 10 次卡', price: 35000, times: 10, validDays: 365, serviceIds: [wash.id] } }))
  await ok(owner.carwash('saveLinkRule', { rule: { trigger: 'recharge', minAmount: 50000, count: 2, amount: 1000, minSpend: 3000, validDays: 30 } }))
  await ok(owner.carwash('saveLinkRule', { rule: { trigger: 'card', cardTypeId: card10.id, count: 1, amount: 1500, minSpend: 0, validDays: 60 } }))
  const techInvite = await ok(owner.carwash('createTechInvite', { role: 'technician' }))
  await ok(as('TECH').common('bindStaff', { name: '小张', code: techInvite.code }))
  await ok(as('TECH').common('setWebAccount', { username: 'tech', password: 'carwash2026' }))
  await ok(customers[0].carwash('getMember'))
  await ok(owner.carwash('counterRecharge', { memberNo: m1.member.memberNo, planId: cw500.id }))
  const sold = await ok(owner.carwash('counterSellCard', { memberNo: m1.member.memberNo, typeId: card10.id }))
  await ok(owner.carwash('setMemberRemark', { memberNo: m1.member.memberNo, remark: '张女士 川A·12345' }))
  const info = await ok(customers[0].carwash('getBookingInfo', { serviceId: wash.id }))
  const slots = [].concat(...info.days.map((d) => d.slots))
  await ok(customers[0].carwash('createOrder', { serviceId: wash.id, mode: 'store', slotStart: slots[0].start, cardId: sold.card._id, plate: '川A12345', carModel: '白色 Model 3', contactName: '张女士', contactPhone: '13800000001' }))
  const addr = await ok(customers[1].carwash('saveAddress', { address: { name: '李先生', phone: '13800000002', place: '预览小区', detail: '3 栋地下车库 B2-018', location: { lat: 30.67, lng: 104.08 } } }))
  const door = await ok(customers[1].carwash('createOrder', { serviceId: wash.id, mode: 'door', slotStart: slots[1].start, addressId: addr.id, payBy: 'later', plate: '川A88888', carModel: '黑色途观' }))
  await ok(as('TECH').carwash('acceptOrder', { id: door.id }))
  await ok(customers[2].carwash('createOrder', { serviceId: wash.id, mode: 'store', slotStart: slots[2].start, payBy: 'later', plate: '川B66666', contactPhone: '13800000003' }))
}
