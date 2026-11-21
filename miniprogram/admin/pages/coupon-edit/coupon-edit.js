const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const { fenToText, textToFen } = require('../../../utils/money')

// 商品按分类分组，选「指定商品」时用
function groupProducts(categories, products) {
  const groups = categories.map((c) => ({ id: c._id, name: c.name, products: [] }))
  const other = { id: '', name: '未分类', products: [] }
  products.forEach((p) => {
    const g = groups.find((x) => x.id === p.categoryId) || other
    g.products.push({ _id: p._id, name: p.name })
  })
  return groups.concat(other).filter((g) => g.products.length)
}

Page({
  data: {
    ready: false,
    id: '',
    claimed: 0,
    titleHint: '不填自动起名，比如「满30减5」',
    categories: [],
    productGroups: [],
    // giftOnly：只在充值时送；scope：all 全部商品、category 指定分类、product 指定商品
    form: { amountText: '', minText: '', title: '', validDays: '7', total: '', perUser: 1, enabled: true, giftOnly: false, scope: 'all', categoryIds: [], productIds: [] },
    saving: false
  },

  onLoad(options) {
    this.options = options
    guard.loadStaff(['owner']).then((staff) => {
      if (!staff) return
      this.init()
    })
  },

  init() {
    const { id } = this.options
    wx.setNavigationBarTitle({ title: id ? '编辑代金券' : '新增代金券' })
    Promise.all([api.coffee('adminListProducts'), id ? api.coffee('adminListCoupons') : Promise.resolve([])]).then(([menu, coupons]) => {
      const data = { categories: menu.categories, productGroups: groupProducts(menu.categories, menu.products) }
      if (!id) {
        this.setData(Object.assign(data, { ready: true }))
        return
      }
      const c = coupons.find((x) => x._id === id)
      if (!c) {
        wx.showToast({ title: '这张券不存在了', icon: 'none' })
        return
      }
      const categoryIds = c.categoryIds || []
      const productIds = c.productIds || []
      this.setData(Object.assign(data, {
        ready: true,
        id: c._id,
        claimed: c.claimed || 0,
        form: {
          amountText: fenToText(c.amount),
          minText: c.minSpend ? fenToText(c.minSpend) : '',
          title: c.title,
          validDays: String(c.validDays),
          total: c.total ? String(c.total) : '',
          perUser: c.perUser || 1,
          enabled: c.enabled !== false,
          giftOnly: !!c.giftOnly,
          scope: categoryIds.length ? 'category' : productIds.length ? 'product' : 'all',
          categoryIds: categoryIds.slice(),
          productIds: productIds.slice()
        }
      }))
    }).catch(api.toastError)
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value })
  },

  pickGiftOnly(e) {
    this.setData({ 'form.giftOnly': String(e.currentTarget.dataset.gift) === '1' })
  },

  pickScope(e) {
    this.setData({ 'form.scope': e.currentTarget.dataset.scope })
  },

  toggle(field, id) {
    const list = this.data.form[field].slice()
    const i = list.indexOf(id)
    if (i === -1) list.push(id)
    else list.splice(i, 1)
    this.setData({ ['form.' + field]: list })
  },

  toggleCategory(e) {
    this.toggle('categoryIds', e.currentTarget.dataset.id)
  },

  toggleProduct(e) {
    this.toggle('productIds', e.currentTarget.dataset.id)
  },

  changePerUser(e) {
    const perUser = Math.max(1, Math.min(10, this.data.form.perUser + Number(e.currentTarget.dataset.delta)))
    this.setData({ 'form.perUser': perUser })
  },

  buildCoupon() {
    const { form, id } = this.data
    const amount = textToFen(form.amountText)
    if (!amount) return '请填写减多少钱，比如 5'
    const minSpend = textToFen(form.minText)
    if (minSpend === null) return '「满多少可用」填错了'
    if (minSpend && minSpend < amount) return '门槛不能低于减免金额'
    const validDays = Number(form.validDays)
    if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) return '有效天数请填 1 到 365'
    const total = form.total === '' || form.giftOnly ? 0 : Number(form.total)
    if (!Number.isInteger(total) || total < 0) return '发放总数填错了，不限量就空着'
    if (form.scope === 'category' && !form.categoryIds.length) return '请选能用在哪些分类'
    if (form.scope === 'product' && !form.productIds.length) return '请选能用在哪些商品'
    const coupon = {
      amount,
      minSpend,
      title: form.title.trim(),
      validDays,
      total,
      perUser: form.perUser,
      enabled: form.enabled,
      giftOnly: form.giftOnly,
      categoryIds: form.scope === 'category' ? form.categoryIds : [],
      productIds: form.scope === 'product' ? form.productIds : []
    }
    if (id) coupon._id = id
    return coupon
  },

  save() {
    if (this.data.saving) return
    const coupon = this.buildCoupon()
    if (typeof coupon === 'string') {
      wx.showToast({ title: coupon, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.coffee('saveCoupon', { coupon }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  remove() {
    wx.showModal({
      title: '删除代金券',
      content: '删除后顾客领不到了，已经领的照样能用。' + (this.data.form.giftOnly ? '' : '只是暂停的话，关掉「发放」就好。'),
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.coffee('deleteCoupon', { id: this.data.id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        }).catch((err) => {
          // 还有充值档位在送这张券：话比较长，用弹窗说清楚
          if (err && err.code === 'COUPON_IN_PLAN') wx.showModal({ title: '先别删', content: err.message, showCancel: false })
          else api.toastError(err)
        })
      }
    })
  }
})
