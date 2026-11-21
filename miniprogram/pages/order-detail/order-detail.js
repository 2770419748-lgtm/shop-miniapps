const api = require('../../utils/api')
const pay = require('../../utils/pay')

const POLL_MS = 10000
const STEP = { pending: 1, making: 2, done: 3 }
// 外送单：已下单 → 制作中（等骑手）→ 配送中 → 已送达
const DELIVERY_STEP = { calling: 2, accepted: 2, arrived: 2, delivering: 3, delivered: 4 }
// 骑手还在路上的配送状态，要接着刷新
const DELIVERY_LIVE = ['calling', 'accepted', 'arrived', 'delivering', 'abnormal']

function stepOf(order) {
  if (!order.delivery) return STEP[order.status] || 0
  return Math.max(STEP[order.status] === 3 ? 3 : STEP[order.status] || 0, DELIVERY_STEP[order.delivery.status] || 0)
}

// 外送单大字下面的状态
function deliveryText(order) {
  const d = order.delivery
  if (order.status === 'cancelled') return '已取消'
  if (d.status === 'waiting' || d.status === 'cancelled') return order.status === 'making' ? '制作中' : (order.status === 'done' ? '已出餐' : '待制作')
  return d.statusText
}

Page({
  data: {
    order: null,
    step: 0,
    statusText: '',
    loading: true
  },

  onLoad(options) {
    this.id = options.id
    this.load()
  },

  onShow() {
    this.startPolling()
  },

  onHide() {
    this.stopPolling()
  },

  onUnload() {
    this.stopPolling()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  // 订单还没做好、外送还没送到时每 10 秒刷新一次进度
  startPolling() {
    this.stopPolling()
    this.timer = setInterval(() => {
      const order = this.data.order
      if (!order) return
      if (order.status === 'pending' || order.status === 'making') this.load()
      else if (order.delivery && order.status !== 'cancelled' && DELIVERY_LIVE.indexOf(order.delivery.status) !== -1) this.load()
    }, POLL_MS)
  },

  stopPolling() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  },

  load() {
    return api.coffee('getOrder', { id: this.id }).then((order) => {
      // 一单可以用几张代金券；服务器还是旧版时只有 coupon 一张
      if (!order.coupons) order.coupons = order.coupon ? [order.coupon] : []
      this.setData({ order, step: stepOf(order), statusText: order.delivery ? deliveryText(order) : '', loading: false })
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  cancel() {
    wx.showModal({
      title: '取消订单',
      content: '确定不要这单了吗？',
      confirmText: '取消订单',
      cancelText: '再想想',
      success: (res) => {
        if (!res.confirm) return
        api.coffee('cancelOrder', { id: this.id })
          .then(() => this.load())
          .catch(api.toastError)
      }
    })
  },

  payNow() {
    pay.payOrder(this.id).then((paid) => {
      if (paid) wx.showToast({ title: '付款成功', icon: 'success' })
      this.load()
    })
  },

  payByBalance() {
    pay.orderByBalance(this.id, this.data.order.payFee).then((paid) => {
      if (paid) wx.showToast({ title: '付款成功', icon: 'success' })
      this.load()
    })
  },

  callRider() {
    wx.makePhoneCall({ phoneNumber: this.data.order.delivery.rider.phone, fail: () => {} })
  },

  callShop() {
    wx.makePhoneCall({ phoneNumber: this.data.order.shopPhone, fail: () => {} })
  },

  goStars() {
    wx.navigateTo({ url: '/pages/stars/stars' })
  },

  backToMenu() {
    wx.switchTab({ url: '/pages/menu/menu' })
  }
})
