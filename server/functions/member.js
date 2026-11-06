// 会员模块：会员中心、充值档位、在线充值（微信支付）、吧台代充、店主调整余额和星星、会员和流水查询。
// 余额怎么加减见 wallet.js，星星见 stars.js；member_plans 是充值档位（增删改见 plans.js），member_recharges 是在线充值单。
// 设置页要列出书的分类（会员免费看哪些），所以会只读 book_books。
const cloud = require('../platform')
const {
  COFFEE_ROLES,
  BizError,
  isMissingCollection,
  cleanText,
  cnDay,
  cnStamp,
  requireRole,
  dayRange,
  fetchAll,
  createMain
} = require('./base')
const wallet = require('./wallet')
const stars = require('./stars')
const pay = require('./pay')
const shipping = require('./shipping')
const { yuan, publicPlan, createPlanStore } = require('./plans')

const db = cloud.database()
const _ = db.command

// 店主手动调整一次最多 1 万元、1000 颗星
const MAX_ADJUST = 1000000
const MAX_ADJUST_STARS = 1000
// 在线充值单 15 分钟内付款
const RECHARGE_PAY_MINUTES = 15
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

const col = (name) => db.collection(name)
const plans = createPlanStore(db, 'member_plans')

async function findOne(name, where) {
  const res = await col(name).where(where).limit(1).get()
  return res.data[0] || null
}

async function safeList(query) {
  try {
    return (await query.get()).data
  } catch (e) {
    if (isMissingCollection(e)) return []
    throw e
  }
}

function enabledPlans() {
  return plans.enabled()
}

function makeRechargeNo() {
  return 'JC' + cnStamp() + String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

function staffName(staff) {
  return (staff && staff.name) || ''
}

// 微信支付成功：核对金额，把钱和会员天数加到账上；同一张充值单只会加一次
async function markRechargePaid(recharge, paid) {
  if (!paid || paid.totalFee !== recharge.price) {
    if (paid) console.error('recharge amount mismatch', recharge.rechargeNo, paid.totalFee, recharge.price)
    return false
  }
  await wallet.change(db, recharge._openid, recharge.price + recharge.bonus, {
    type: 'recharge',
    title: recharge.title,
    refType: 'recharge',
    refId: recharge._id,
    refNo: recharge.rechargeNo
  }, {
    principal: recharge.price,
    bonus: recharge.bonus,
    memberDays: recharge.memberDays,
    guard: async () => {
      const res = await col('member_recharges')
        .where({ _id: recharge._id, payStatus: 'unpaid' })
        .update({ data: { payStatus: 'paid', transactionId: paid.transactionId, paidAt: new Date(), updatedAt: new Date() } })
      return res.stats.updated > 0
    }
  })
  // 告诉微信这单给出去了：储值是虚拟商品（同一笔记过就不会再记）
  await shipping.record({ type: 'virtual', paid, desc: '进山会员-' + recharge.title })
  return true
}

// 微信支付通知（服务器收到 /pay/notify/member 后调用）
async function onPayNotify({ outTradeNo }) {
  if (typeof outTradeNo !== 'string' || outTradeNo.indexOf('JC') !== 0) return
  const recharge = await findOne('member_recharges', { rechargeNo: outTradeNo })
  if (!recharge || recharge.payStatus !== 'unpaid') return
  await markRechargePaid(recharge, await pay.queryPaid(outTradeNo))
}

async function bookCategories() {
  const books = await safeList(col('book_books').field({ category: true }).limit(1000))
  const list = []
  books.forEach((b) => {
    if (b.category && list.indexOf(b.category) === -1) list.push(b.category)
  })
  return list
}

function cleanCategories(value) {
  const list = []
  ;(Array.isArray(value) ? value : []).forEach((c) => {
    const name = cleanText(c, 10)
    if (name && list.indexOf(name) === -1) list.push(name)
  })
  if (list.length > 30) throw new BizError('免费分类最多选 30 个')
  return list
}

function intOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return Number(value)
}

const handlers = {
  // ---------- 顾客端 ----------

  // 会员中心：第一次打开时发会员号
  async getMember(event, openid) {
    const [settings, member, plans, paySettings] = await Promise.all([
      wallet.readSettings(db),
      wallet.ensureMember(db, openid),
      enabledPlans(),
      pay.getSettings(db)
    ])
    return {
      member: wallet.publicMember(member),
      settings,
      plans: settings.enabled ? plans.map(publicPlan) : [],
      pay: pay.publicPay(paySettings)
    }
  },

  async myMemberLogs({ page }, openid) {
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    const list = await safeList(col('member_logs').where({ _openid: openid }).orderBy('createdAt', 'desc').skip(p * size).limit(size))
    return { logs: list.map((l) => wallet.publicLog(l)), hasMore: list.length === size }
  },

  // 在线充值：返回充值单 id 和 wx.requestPayment 要的参数
  async createRecharge({ planId }, openid) {
    const settings = await wallet.readSettings(db)
    if (!settings.enabled) throw new BizError('店里暂时没开放充值', 'MEMBER_DISABLED')
    const plan = await plans.usable(planId)
    const paySettings = await pay.getSettings(db)
    if (!paySettings.payEnabled) throw new BizError('店里还没开通微信支付，请到吧台找店员充值', 'PAY_DISABLED')
    const member = await wallet.ensureMember(db, openid)
    const recharge = {
      _openid: openid,
      memberNo: member.memberNo,
      rechargeNo: makeRechargeNo(),
      planId: plan._id,
      title: plan.title,
      price: plan.price,
      bonus: plan.bonus || 0,
      memberDays: plan.memberDays || 0,
      payStatus: 'unpaid',
      day: cnDay(),
      createdAt: new Date(),
      updatedAt: new Date()
    }
    const added = await col('member_recharges').add({ data: recharge })
    const payment = await pay.unifiedOrder(paySettings, {
      body: '进山会员-' + plan.title,
      outTradeNo: recharge.rechargeNo,
      totalFee: recharge.price,
      openid,
      notify: 'member',
      timeExpire: Date.now() + RECHARGE_PAY_MINUTES * 60000
    })
    return { id: added._id, payment }
  },

  // 付完款后顾客端调一下，向微信查单确认
  async confirmPay({ id }, openid) {
    const recharge = await findOne('member_recharges', { _id: String(id || ''), _openid: openid })
    if (!recharge) throw new BizError('充值记录不存在')
    if (recharge.payStatus === 'unpaid' && (await markRechargePaid(recharge, await pay.queryPaid(recharge.rechargeNo)))) {
      return { payStatus: 'paid' }
    }
    return { payStatus: recharge.payStatus }
  },

  // ---------- 后台：会员（店主和咖啡师） ----------

  // keyword：会员号，或者备注里的字（名字、手机尾号）；不填按最近变动排
  async listMembers({ keyword, page }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    const kw = cleanText(keyword, 20)
    const starSettings = await stars.readSettings(db)
    const adminMember = (m) => adminView(m, starSettings)
    let list
    if (!kw) {
      list = await safeList(col('members').orderBy('updatedAt', 'desc').skip(p * size).limit(size))
      return { members: list.map(adminMember), hasMore: list.length === size }
    }
    if (wallet.MEMBER_NO_RE.test(kw)) {
      list = await safeList(col('members').where({ memberNo: kw }).limit(1))
      if (list.length) return { members: list.map(adminMember), hasMore: false }
    }
    let all = []
    try {
      all = await fetchAll(col('members').orderBy('updatedAt', 'desc'), 5000)
    } catch (e) {
      if (!isMissingCollection(e)) throw e
    }
    const matched = all.filter((m) => (m.remark || '').indexOf(kw) !== -1 || m.memberNo.indexOf(kw) !== -1)
    return { members: matched.slice(p * size, (p + 1) * size).map(adminMember), hasMore: matched.length > (p + 1) * size }
  },

  async getMemberDetail({ memberNo }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const m = await wallet.findByNo(db, memberNo)
    const [logs, plans, starLogs, starSettings] = await Promise.all([
      safeList(col('member_logs').where({ memberNo: m.memberNo }).orderBy('createdAt', 'desc').limit(50)),
      enabledPlans(),
      safeList(col('star_logs').where({ memberNo: m.memberNo }).orderBy('createdAt', 'desc').limit(50)),
      stars.readSettings(db)
    ])
    // plans：吧台代充时能选的档位；starLogs：星星的变动
    return {
      member: adminView(m, starSettings),
      logs: logs.map((l) => wallet.publicLog(l, true)),
      plans: plans.map(publicPlan),
      starLogs: starLogs.map((l) => stars.publicLog(l, true)),
      starSettings: { enabled: starSettings.enabled, need: starSettings.need }
    }
  },

  // 吧台代充：顾客当面付钱（现金、收款码）后，按档位给他充上
  async counterRecharge({ memberNo, planId }, openid) {
    const staff = await requireRole(db, openid, COFFEE_ROLES)
    const m = await wallet.findByNo(db, memberNo)
    const plan = await plans.usable(planId)
    const res = await wallet.change(db, m._id, plan.price + (plan.bonus || 0), {
      type: 'counter',
      title: plan.title,
      refType: 'plan',
      refId: plan._id,
      operator: openid,
      operatorName: staffName(staff)
    }, { principal: plan.price, bonus: plan.bonus || 0, memberDays: plan.memberDays || 0 })
    return { balance: res.balance, memberUntil: res.memberUntil, memberNo: m.memberNo }
  },

  async setMemberRemark({ memberNo, remark }, openid) {
    await requireRole(db, openid, COFFEE_ROLES)
    const m = await wallet.findByNo(db, memberNo)
    await col('members').doc(m._id).update({ data: { remark: cleanText(remark, 30) } })
    return true
  },

  // 店主手动调整：退款后扣掉余额、补偿、改会员到期日都在这里，必须写原因
  // amount：分，正数加、负数扣；memberUntil：不传不改，'' 取消会员，或者 YYYY-MM-DD
  async adjustMember({ memberNo, amount, memberUntil, reason }, openid) {
    const staff = await requireRole(db, openid, ['owner'])
    const m = await wallet.findByNo(db, memberNo)
    const fee = intOr(amount, 0)
    if (!Number.isInteger(fee) || Math.abs(fee) > MAX_ADJUST) throw new BizError('调整金额不对，一次最多 ' + yuan(MAX_ADJUST) + ' 元')
    const opts = {}
    if (memberUntil !== undefined && memberUntil !== null && memberUntil !== (m.memberUntil || '')) {
      if (memberUntil !== '' && !DAY_RE.test(memberUntil)) throw new BizError('会员到期日格式不对')
      opts.memberUntil = memberUntil
    }
    if (!fee && opts.memberUntil === undefined) throw new BizError('金额和会员到期日都没有变')
    const why = cleanText(reason, 40)
    if (!why) throw new BizError('请写上调整原因，比如「线下退款」')
    let title = fee ? (fee > 0 ? '店主加余额' : '店主扣余额') : ''
    if (opts.memberUntil !== undefined) title += (title ? '，' : '') + (opts.memberUntil ? '会员改到 ' + opts.memberUntil : '取消会员')
    const res = await wallet.change(db, m._id, fee, {
      type: 'adjust',
      title,
      reason: why,
      operator: openid,
      operatorName: staffName(staff)
    }, opts)
    if (!res) throw new BizError('余额只有 ¥' + yuan(m.balance) + '，扣不了这么多', 'BALANCE_LOW')
    return { balance: res.balance, memberUntil: res.memberUntil }
  },

  // 店主手动加减星星：在店里买了没用小程序的补上、补偿、扣掉多给的，必须写原因。amount：颗数，正数加、负数扣
  async adjustStars({ memberNo, amount, reason }, openid) {
    const staff = await requireRole(db, openid, ['owner'])
    const m = await wallet.findByNo(db, memberNo)
    const n = intOr(amount, 0)
    if (!Number.isInteger(n) || !n || Math.abs(n) > MAX_ADJUST_STARS) throw new BizError('加减几颗星请填 1 到 ' + MAX_ADJUST_STARS)
    const why = cleanText(reason, 40)
    if (!why) throw new BizError('请写上调整原因，比如「在店里买了没用小程序」')
    const res = await stars.change(db, m._id, n, {
      type: 'adjust',
      title: n > 0 ? '店主加星' : '店主扣星',
      reason: why,
      operator: openid,
      operatorName: staffName(staff)
    })
    if (!res) throw new BizError('只有 ' + stars.liveStars(m, await stars.readSettings(db)).stars + ' 颗星，扣不了这么多', 'STARS_LOW')
    return { stars: res.stars }
  },

  // 店主看账：每天充了多少（本金、赠送）、余额花了多少，以及现在大家手里一共还有多少余额
  async memberSummary({ from, to }, openid) {
    await requireRole(db, openid, ['owner'])
    const days = dayRange(from, to)
    let logs = []
    let members = []
    try {
      ;[logs, members] = await Promise.all([
        fetchAll(col('member_logs').where({ day: _.in(days) }).orderBy('createdAt', 'asc')),
        fetchAll(col('members').field({ balance: true, memberUntil: true }))
      ])
    } catch (e) {
      if (!isMissingCollection(e)) throw e
    }
    const rows = {}
    days.forEach((d) => {
      rows[d] = { day: d, recharges: 0, onlineFee: 0, counterFee: 0, bonusFee: 0, spentFee: 0, refundFee: 0, adjustFee: 0 }
    })
    logs.forEach((l) => {
      const r = rows[l.day]
      if (!r) return
      if (l.type === 'recharge' || l.type === 'counter') {
        r.recharges++
        if (l.type === 'recharge') r.onlineFee += l.principal
        else r.counterFee += l.principal
        r.bonusFee += l.bonus
      } else if (l.type === 'pay') r.spentFee -= l.amount
      else if (l.type === 'refund') r.refundFee += l.amount
      else if (l.type === 'adjust') r.adjustFee += l.amount
    })
    const list = days.map((d) => rows[d])
    const totals = list.reduce((acc, r) => {
      Object.keys(r).forEach((k) => { if (k !== 'day') acc[k] = (acc[k] || 0) + r[k] })
      return acc
    }, {})
    const today = cnDay()
    return {
      days: list,
      totals,
      balanceTotal: members.reduce((s, m) => s + (m.balance || 0), 0),
      memberCount: members.filter((m) => wallet.isMember(m, today)).length
    }
  },

  // ---------- 后台：储值设置和充值档位（店主） ----------

  async getMemberSettings(event, openid) {
    await requireRole(db, openid, ['owner'])
    const [settings, list, categories, paySettings] = await Promise.all([
      wallet.readSettings(db),
      plans.list(),
      bookCategories(),
      pay.getSettings(db)
    ])
    return { settings, plans: list, categories, payEnabled: paySettings.payEnabled }
  },

  async saveMemberSettings({ enabled, freeCategories, notice }, openid) {
    await requireRole(db, openid, ['owner'])
    const data = {
      enabled: !!enabled,
      freeCategories: cleanCategories(freeCategories),
      notice: cleanText(notice, 120),
      updatedBy: openid,
      updatedAt: db.serverDate()
    }
    await col('settings').doc('member').set({ data })
    return wallet.readSettings(db)
  },

  async savePlan({ plan }, openid) {
    await requireRole(db, openid, ['owner'])
    return plans.save(plan)
  },

  async setPlanFlags({ id, enabled }, openid) {
    await requireRole(db, openid, ['owner'])
    return plans.setEnabled(id, enabled)
  },

  async sortPlans({ ids }, openid) {
    await requireRole(db, openid, ['owner'])
    return plans.sort(ids)
  },

  // 删掉档位不影响已经充进去的钱
  async deletePlan({ id }, openid) {
    await requireRole(db, openid, ['owner'])
    return plans.remove(id)
  }
}

// 后台看的会员：余额、会员到期日，加上备注和星星（过期的不算）
function adminView(m, starSettings) {
  return Object.assign(wallet.publicMember(m), {
    remark: m.remark || '',
    stars: stars.liveStars(m, starSettings).stars,
    starsEarned: m.starsEarned || 0,
    starsUsed: m.starsUsed || 0,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt
  })
}

exports.main = createMain(cloud, handlers)
exports.onPayNotify = onPayNotify
