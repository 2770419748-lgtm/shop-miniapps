// 充值档位：充多少、送多少、送几天会员，能上下架、排序。咖啡（member_plans）和洗车（cw_plans）共用这套写法。
// 咖啡的档位还能送代金券（gifts，见 coupons.js），由 member.js 整理好后通过 save 的 extra 存进来。
const { BizError, isMissingCollection, cleanText } = require('./base')

// 单笔最多 1 万元，最多 20 档，会员最多送 10 年
const MAX_PLAN_PRICE = 1000000
const MAX_PLANS = 20
const MAX_MEMBER_DAYS = 3650

function yuan(fen) {
  return (fen / 100).toFixed(2).replace(/\.?0+$/, '')
}

function toSort(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

function intOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  return Number(value)
}

function planTitle(price, bonus) {
  return '充 ' + yuan(price) + (bonus ? ' 送 ' + yuan(bonus) : '')
}

function publicPlan(p) {
  return {
    _id: p._id,
    title: p.title,
    price: p.price,
    bonus: p.bonus || 0,
    memberDays: p.memberDays || 0,
    desc: p.desc || ''
  }
}

function createPlanStore(db, name) {
  const col = () => db.collection(name)

  async function safeList(query) {
    try {
      return (await query.get()).data
    } catch (e) {
      if (isMissingCollection(e)) return []
      throw e
    }
  }

  async function find(id) {
    return (await safeList(col().where({ _id: String(id || '') }).limit(1)))[0] || null
  }

  return {
    find,
    list: () => safeList(col().orderBy('sort', 'asc').limit(MAX_PLANS)),
    enabled: () => safeList(col().where({ enabled: true }).orderBy('sort', 'asc').limit(MAX_PLANS)),

    // 上架中的档位；下架或删掉了就报错
    async usable(id) {
      const plan = await find(id)
      if (!plan || !plan.enabled) throw new BizError('这个充值档位已经下架了，请重新选择', 'PLAN_GONE')
      return plan
    },

    // extra：这家店自己的字段（咖啡的送券），已经检查过，原样存进去
    async save(plan, extra) {
      const p = plan || {}
      const price = Number(p.price)
      if (!Number.isInteger(price) || price <= 0 || price > MAX_PLAN_PRICE) throw new BizError('充值金额请填 0.01 到 ' + yuan(MAX_PLAN_PRICE) + ' 元')
      const bonus = intOr(p.bonus, 0)
      if (!Number.isInteger(bonus) || bonus < 0 || bonus > MAX_PLAN_PRICE) throw new BizError('赠送金额不对，不送填 0')
      const memberDays = intOr(p.memberDays, 0)
      if (!Number.isInteger(memberDays) || memberDays < 0 || memberDays > MAX_MEMBER_DAYS) throw new BizError('会员天数请填 0 到 ' + MAX_MEMBER_DAYS + '，不送会员填 0')
      const data = {
        title: cleanText(p.title, 16) || planTitle(price, bonus),
        price,
        bonus,
        memberDays,
        desc: cleanText(p.desc, 40),
        enabled: p.enabled !== false,
        updatedAt: db.serverDate()
      }
      if (p.sort !== undefined) data.sort = toSort(p.sort)
      if (extra) Object.assign(data, extra)
      if (p._id) {
        const old = await find(p._id)
        if (!old) throw new BizError('这个档位不存在了')
        await col().doc(old._id).update({ data })
        return { id: old._id }
      }
      const count = await col().count()
      if (count.total >= MAX_PLANS) throw new BizError('充值档位最多 ' + MAX_PLANS + ' 个，先删掉一些不用的')
      if (data.sort === undefined) data.sort = count.total
      data.createdAt = db.serverDate()
      const added = await col().add({ data })
      return { id: added._id }
    },

    async setEnabled(id, enabled) {
      if (typeof enabled !== 'boolean') throw new BizError('参数不对')
      const res = await col().where({ _id: String(id || '') }).update({ data: { enabled, updatedAt: db.serverDate() } })
      if (!res.stats.updated) throw new BizError('这个档位不存在了')
      return true
    },

    async sort(ids) {
      if (!Array.isArray(ids) || ids.length > MAX_PLANS) throw new BizError('排序数据不对')
      await Promise.all(ids.map((id, index) =>
        col().where({ _id: String(id) }).update({ data: { sort: index, updatedAt: db.serverDate() } })
      ))
      return true
    },

    // 删掉档位不影响已经充进去的钱
    async remove(id) {
      await col().where({ _id: String(id || '') }).remove()
      return true
    }
  }
}

module.exports = { MAX_PLANS, yuan, planTitle, publicPlan, createPlanStore }
