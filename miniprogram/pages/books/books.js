const api = require('../../utils/api')
const chipBar = require('../../utils/chip-bar')

Page({
  data: {
    loading: true,
    rules: [],
    categories: [],
    current: 'all',
    barFade: false, // 分类栏右侧渐隐，提示还能往右滑
    memberFree: [], // 会员免费看的分类
    memberText: '',
    list: [],
    active: null // 正在借的书
  },

  onLoad() {
    this.books = []
  },

  onShow() {
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    const shelf = api.book('getShelf').then(({ books, rules, categories, memberFree }) => {
      const free = memberFree || []
      this.books = books.map((b) => Object.assign({ memberFree: free.indexOf(b.category) !== -1 }, b))
      const current = this.data.current === 'all' || categories.indexOf(this.data.current) !== -1 ? this.data.current : 'all'
      this.setData({ rules, categories, current, barFade: chipBar.overflows(['全部'].concat(categories)), memberFree: free, memberText: free.join('、'), loading: false })
      this.filter()
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
    const mine = api.book('myRentals', { page: 0 }).then(({ rentals }) => {
      const active = rentals.find((r) => r.status === 'reading') || rentals.find((r) => r.status === 'pending')
      this.setData({ active: active || null })
    }).catch(() => {})
    return Promise.all([shelf, mine])
  },

  filter() {
    const { current } = this.data
    this.setData({ list: current === 'all' ? this.books : this.books.filter((b) => b.category === current) })
  },

  onBarScroll(e) {
    chipBar.onScroll(this, e)
  },

  pickCat(e) {
    this.setData({ current: e.currentTarget.dataset.cat })
    this.filter()
  },

  open(e) {
    wx.navigateTo({ url: '/pages/book-detail/book-detail?id=' + e.currentTarget.dataset.id })
  },

  goMember() {
    wx.navigateTo({ url: '/pages/member/member' })
  },

  openActive() {
    wx.navigateTo({ url: '/pages/rental-detail/rental-detail?id=' + this.data.active._id })
  },

  onShareAppMessage() {
    return { title: '进山咖啡 · 店内书架', path: '/pages/books/books' }
  }
})
