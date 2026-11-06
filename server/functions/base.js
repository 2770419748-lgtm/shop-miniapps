// 各模块共用的东西：角色、集合名、出错格式、统一入口。
const crypto = require('crypto')

const ROLES = {
  owner: '店主',
  barista: '咖啡师',
  book_manager: '书籍管理员',
  carwash_manager: '洗车店长',
  technician: '洗车技师'
}

// 能进咖啡后台、书籍后台的角色
const COFFEE_ROLES = ['owner', 'barista']
const BOOK_ROLES = ['owner', 'book_manager']
// 洗车：店长管设置、价格、派单；技师接单、上门、收款
const CARWASH_ROLES = ['owner', 'carwash_manager']
const CARWASH_STAFF = ['owner', 'carwash_manager', 'technician']

// 咖啡模块用 coffee_ 开头的集合，书籍模块用 book_ 开头的集合；
// vouchers 是顾客手里的券：包天送的赠饮券（书籍模块发放）和领到的代金券（type 为 cash，模板在 coffee_coupons），咖啡下单时核销；
// members、member_logs 是会员的余额和流水（见 wallet.js），咖啡和书籍模块付款时也会改；
// wx_users 记同一个人在两个小程序里的 openid（见 lib/identity.js）；cw_ 开头的是洗车的（见 carwash.js）；
// 集星的星星也记在 members 上，star_logs 是星星的变动（见 stars.js）
const COLLECTIONS = [
  'staff',
  'staff_invites',
  'counters',
  'coffee_categories',
  'coffee_products',
  'coffee_orders',
  'coffee_tables',
  'book_books',
  'book_rules',
  'book_rentals',
  'vouchers',
  'web_sessions',
  'web_login_tickets',
  'mp_sessions',
  'settings',
  'banners',
  'coffee_coupons',
  'members',
  'member_logs',
  'member_plans',
  'member_recharges',
  'wx_users',
  'cw_services',
  'cw_orders',
  'cw_addresses',
  'cw_members',
  'cw_member_logs',
  'cw_plans',
  'cw_recharges',
  'cw_card_types',
  'cw_cards',
  'cw_card_logs',
  'cw_card_orders',
  'cw_link_rules',
  'star_logs',
  'ship_queue'
]

// 电脑网页后台的登录有效期
const WEB_SESSION_TTL = 7 * 24 * 3600 * 1000

class BizError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code || 'BAD_REQUEST'
  }
}

function isMissingCollection(err) {
  const text = String((err && (err.errMsg || err.message)) || '')
  return (err && err.errCode === -502005) || /DATABASE_COLLECTION_NOT_EXIST|collection not exists?/i.test(text)
}

// 去掉首尾空白和换行，按字符截断
function cleanText(value, max) {
  if (value === undefined || value === null) return ''
  const s = String(value).replace(/[\r\n\t]+/g, ' ').trim()
  return Array.from(s).slice(0, max).join('')
}

// 中国时间（UTC+8）的日期，例如 2026-10-24；不管服务器设的是哪个时区都一样
function cnDay(now) {
  const t = (now === undefined ? Date.now() : now) + 8 * 3600 * 1000
  return new Date(t).toISOString().slice(0, 10)
}

function cnStamp(now) {
  const t = (now === undefined ? Date.now() : now) + 8 * 3600 * 1000
  return new Date(t).toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

async function ensureCollections(db) {
  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name)
    } catch (e) {
      // 已存在就跳过
    }
  }
}

async function getStaff(db, openid) {
  if (!openid) return null
  try {
    const res = await db.collection('staff').where({ _id: openid }).limit(1).get()
    return res.data[0] || null
  } catch (e) {
    if (isMissingCollection(e)) return null
    throw e
  }
}

async function requireRole(db, openid, roles) {
  const staff = await getStaff(db, openid)
  if (!staff || roles.indexOf(staff.role) === -1) {
    throw new BizError('没有权限，请让店主在「员工管理」里给你开通', 'FORBIDDEN')
  }
  return staff
}

// 每天的流水号从 1 开始（取餐号、借书号）
async function nextSeq(db, counterId) {
  try {
    await db.collection('counters').add({ data: { _id: counterId, seq: 0 } })
  } catch (e) {
    // 计数器已存在
  }
  return db.runTransaction(async (t) => {
    const res = await t.collection('counters').doc(counterId).get()
    const seq = (res.data.seq || 0) + 1
    await t.collection('counters').doc(counterId).update({ data: { seq } })
    return seq
  })
}

// 汇总用的日期范围：from 到 to（含），最多 62 天，返回每天的日期
function dayRange(from, to) {
  const re = /^\d{4}-\d{2}-\d{2}$/
  const today = cnDay()
  const start = re.test(from || '') ? from : today
  const end = re.test(to || '') ? to : start
  const a = Date.parse(start + 'T00:00:00Z')
  const b = Date.parse(end + 'T00:00:00Z')
  if (!Number.isFinite(a) || !Number.isFinite(b) || a > b) throw new BizError('日期范围不对')
  const days = []
  for (let t = a; t <= b; t += 24 * 3600 * 1000) {
    days.push(new Date(t).toISOString().slice(0, 10))
    if (days.length > 62) throw new BizError('一次最多看 62 天')
  }
  return days
}

// 按条件取出全部记录（数据库一次最多取 1000 条）
async function fetchAll(query, max) {
  const out = []
  const limit = 1000
  for (let skip = 0; skip < (max || 20000); skip += limit) {
    const res = await query.skip(skip).limit(limit).get()
    out.push.apply(out, res.data)
    if (res.data.length < limit) break
  }
  return out
}

function publicStaff(staff) {
  if (!staff) return null
  return { name: staff.name, role: staff.role, roleName: ROLES[staff.role] || staff.role }
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex')
}

// 电脑网页后台没有微信身份，登录后每次调用带上 webToken，换成对应员工的 openid
async function resolveWebToken(db, token) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 128) {
    throw new BizError('请先登录', 'NEED_LOGIN')
  }
  const res = await db.collection('web_sessions').where({ _id: hashToken(token) }).limit(1).get()
  const session = res.data[0]
  if (!session || session.expiresAt < Date.now()) throw new BizError('登录已过期，请重新登录', 'NEED_LOGIN')
  return session.staffId
}

// 统一的模块入口：handlers[action](event, openid)，返回 { ok, data } 或 { ok: false, msg, code }
// 小程序里调用时用微信身份；网页后台调用时用 webToken。都没有时只能调 options.anonymous 里列出的操作。
// 新版本加了集合、数据库里还没有时，自动建好再试一次。
function createMain(cloud, handlers, options) {
  const anonymous = (options && options.anonymous) || []
  return async (event) => {
    const action = event && event.action
    const handler = handlers[action]
    if (!handler) return { ok: false, msg: '未知操作', code: 'UNKNOWN_ACTION' }
    for (let attempt = 0; ; attempt++) {
      try {
        let openid = cloud.getWXContext().OPENID || ''
        if (!openid && event.webToken) openid = await resolveWebToken(cloud.database(), event.webToken)
        if (!openid && anonymous.indexOf(action) === -1) throw new BizError('请先登录', 'NEED_LOGIN')
        const data = await handler(event, openid)
        return { ok: true, data: data === undefined ? null : data }
      } catch (e) {
        if (e instanceof BizError) return { ok: false, msg: e.message, code: e.code }
        if (attempt === 0 && isMissingCollection(e)) {
          await ensureCollections(cloud.database())
          continue
        }
        console.error('[' + event.action + ']', e)
        return { ok: false, msg: '服务器开小差了，请稍后再试', code: 'SERVER_ERROR' }
      }
    }
  }
}

module.exports = {
  ROLES,
  COFFEE_ROLES,
  BOOK_ROLES,
  CARWASH_ROLES,
  CARWASH_STAFF,
  COLLECTIONS,
  WEB_SESSION_TTL,
  BizError,
  isMissingCollection,
  cleanText,
  cnDay,
  cnStamp,
  ensureCollections,
  getStaff,
  requireRole,
  nextSeq,
  dayRange,
  fetchAll,
  hashToken,
  resolveWebToken,
  publicStaff,
  createMain
}
