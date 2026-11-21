const api = require('../../../utils/api')
const guard = require('../../../utils/guard')
const { fenToText, textToFen } = require('../../../utils/money')

// 送券的一行：带上券的名字、金额、适用范围，页面上显示用
function giftRow(c, count) {
  return { couponId: c._id, title: c.title, amount: c.amount, scope: c.scope || '', count }
}

Page({
  data: {
    ready: false,
    id: '',
    form: { priceText: '', bonusText: '', memberDays: '365', title: '', desc: '', enabled: true },
    coupons: [], // 能选来送的代金券
    gifts: [], // 这一档送的券 [{ couponId, title, amount, scope, count }]
    choices: [], // 还没选的券，「+ 加一种券」里列出来
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
    wx.setNavigationBarTitle({ title: id ? '编辑充值档位' : '新增充值档位' })
    api.member('getMemberSettings').then(({ plans, coupons }) => {
      const list = coupons || []
      if (!id) {
        this.setData({ ready: true, coupons: list })
        this.refreshChoices()
        return
      }
      const p = plans.find((x) => x._id === id)
      if (!p) {
        wx.showToast({ title: '这个档位不存在了', icon: 'none' })
        return
      }
      const gifts = []
      ;(p.gifts || []).forEach((g) => {
        const c = list.find((x) => x._id === g.couponId)
        if (c) gifts.push(giftRow(c, g.count))
      })
      this.setData({
        ready: true,
        id: p._id,
        coupons: list,
        gifts,
        form: {
          priceText: fenToText(p.price),
          bonusText: p.bonus ? fenToText(p.bonus) : '',
          memberDays: p.memberDays ? String(p.memberDays) : '',
          title: p.title,
          desc: p.desc || '',
          enabled: p.enabled !== false
        }
      })
      this.refreshChoices()
    }).catch(api.toastError)
  },

  refreshChoices() {
    const picked = this.data.gifts.map((g) => g.couponId)
    const choices = this.data.coupons
      .filter((c) => picked.indexOf(c._id) === -1)
      .map((c) => ({ _id: c._id, label: c.title + '（¥' + fenToText(c.amount) + (c.scope ? '，' + c.scope : '') + '）' }))
    this.setData({ choices })
  },

  addGift(e) {
    const choice = this.data.choices[Number(e.detail.value)]
    const c = choice && this.data.coupons.find((x) => x._id === choice._id)
    if (!c) return
    this.setData({ gifts: this.data.gifts.concat([giftRow(c, 1)]) })
    this.refreshChoices()
  },

  // 减到 0 就是不送这种券
  changeGift(e) {
    const index = Number(e.currentTarget.dataset.index)
    const gifts = this.data.gifts.slice()
    const g = gifts[index]
    if (!g) return
    const count = Math.min(20, g.count + Number(e.currentTarget.dataset.delta))
    if (count < 1) gifts.splice(index, 1)
    else gifts[index] = Object.assign({}, g, { count })
    this.setData({ gifts })
    this.refreshChoices()
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value })
  },

  onEnabled(e) {
    this.setData({ 'form.enabled': e.detail.value })
  },

  buildPlan() {
    const { form, id } = this.data
    const price = textToFen(form.priceText)
    if (!price) return '请填写充值金额，比如 300'
    const bonus = textToFen(form.bonusText)
    if (bonus === null) return '赠送金额填错了，不送就空着'
    const memberDays = form.memberDays === '' ? 0 : Number(form.memberDays)
    if (!Number.isInteger(memberDays) || memberDays < 0 || memberDays > 3650) return '会员天数请填 0 到 3650，不送就空着'
    const gifts = this.data.gifts.map((g) => ({ couponId: g.couponId, count: g.count }))
    const plan = { price, bonus, memberDays, title: form.title.trim(), desc: form.desc.trim(), enabled: form.enabled, gifts }
    if (id) plan._id = id
    return plan
  },

  save() {
    if (this.data.saving) return
    const plan = this.buildPlan()
    if (typeof plan === 'string') {
      wx.showToast({ title: plan, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    api.member('savePlan', { plan }).then(() => {
      wx.showToast({ title: '已保存', icon: 'success' })
      setTimeout(() => wx.navigateBack(), 600)
    }).catch((err) => {
      this.setData({ saving: false })
      api.toastError(err)
    })
  },

  remove() {
    wx.showModal({
      title: '删除档位',
      content: '删除后顾客不能再充这一档，已经充进去的钱不受影响。只是暂停的话，关掉「上架」就好。',
      confirmText: '删除',
      confirmColor: '#e0715c',
      success: (res) => {
        if (!res.confirm) return
        api.member('deletePlan', { id: this.data.id }).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' })
          setTimeout(() => wx.navigateBack(), 600)
        }).catch(api.toastError)
      }
    })
  }
})
