const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const chipBar = require('../../../utils/chip-bar')

Page({
  data: {
    ready: false,
    isOwner: false,
    loading: true,
    categories: [],
    current: 'all',
    barFade: false,
    all: [],
    list: []
  },

  onShow() {
    guard.loadStaff(guard.COFFEE_ROLES).then((staff) => {
      if (!staff) return
      this.setData({ ready: true, isOwner: staff.role === 'owner' })
      this.load()
    })
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh())
  },

  load() {
    return api.coffee('adminListProducts').then(({ categories, products }) => {
      const names = {}
      categories.forEach((c) => { names[c._id] = c.name })
      const all = products.map((p) => Object.assign({}, p, { categoryName: names[p.categoryId] || '未分类' }))
      const current = this.data.current === 'all' || names[this.data.current] ? this.data.current : 'all'
      this.setData({ categories, all, current, barFade: chipBar.overflows(['全部'].concat(categories.map((c) => c.name))), loading: false })
      this.filter()
    }).catch((err) => {
      this.setData({ loading: false })
      api.toastError(err)
    })
  },

  filter() {
    const { all, current } = this.data
    this.setData({ list: current === 'all' ? all : all.filter((p) => p.categoryId === current) })
  },

  onBarScroll(e) {
    chipBar.onScroll(this, e)
  },

  pickCat(e) {
    this.setData({ current: e.currentTarget.dataset.id })
    this.filter()
  },

  updateLocal(id, patch) {
    const all = this.data.all.map((p) => (p._id === id ? Object.assign({}, p, patch) : p))
    this.setData({ all })
    this.filter()
  },

  toggleShelf(e) {
    const id = e.currentTarget.dataset.id
    const onShelf = e.detail.value
    this.updateLocal(id, { onShelf })
    api.coffee('setProductFlags', { id, onShelf }).catch((err) => {
      api.toastError(err)
      this.updateLocal(id, { onShelf: !onShelf })
    })
  },

  toggleSoldOut(e) {
    const id = e.currentTarget.dataset.id
    const product = this.data.all.find((p) => p._id === id)
    const soldOut = !product.soldOut
    this.updateLocal(id, { soldOut })
    api.coffee('setProductFlags', { id, soldOut }).catch((err) => {
      api.toastError(err)
      this.updateLocal(id, { soldOut: !soldOut })
    })
  },

  edit(e) {
    wx.navigateTo({ url: '/admin/pages/product-edit/product-edit?id=' + e.currentTarget.dataset.id })
  },

  add() {
    if (!this.data.categories.length) {
      wx.showModal({
        title: '先建分类',
        content: '商品要放在分类下面，先去建一个分类（比如“咖啡”）。',
        confirmText: '去建分类',
        success: (res) => { if (res.confirm) wx.navigateTo({ url: '/admin/pages/categories/categories' }) }
      })
      return
    }
    const cat = this.data.current === 'all' ? '' : this.data.current
    wx.navigateTo({ url: '/admin/pages/product-edit/product-edit?categoryId=' + cat })
  },

  seedDemo() {
    wx.showModal({
      title: '导入示例菜单',
      content: '会导入 6 个示例商品和 3 个分类，价格只是占位，导入后请改成店里的真实菜单。',
      success: (res) => {
        if (!res.confirm) return
        wx.showLoading({ title: '导入中', mask: true })
        api.coffee('seedDemo').then(({ productCount }) => {
          wx.hideLoading()
          wx.showToast({ title: '已导入 ' + productCount + ' 个', icon: 'success' })
          this.load()
        }).catch((err) => {
          wx.hideLoading()
          api.toastError(err)
        })
      }
    })
  },

  noop() {}
})
