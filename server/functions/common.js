// 公共模块：登录、店主绑定、员工邀请和权限管理、店铺设置、消息通知设置、电脑网页后台登录、顾客首页（轮播、营业时间、可领的券、会员、集星）。
// 首页轮播存在 banners 集合；首页要展示商品、书、代金券和会员储值（含充值送的券），所以这里会只读 coffee_products、book_books、coffee_coupons、
// member_plans 和自己的 members 记录。
const crypto = require('crypto')
const { promisify } = require('util')
const cloud = require('../platform')
const {
  ROLES,
  WEB_SESSION_TTL,
  BizError,
  isMissingCollection,
  cleanText,
  ensureCollections,
  getStaff,
  requireRole,
  hashToken,
  publicStaff,
  createMain
} = require('./base')
const { readShop, hoursOf, checkHours } = require('./shop')
const wallet = require('./wallet')
const stars = require('./stars')
const notify = require('./notify')
const delivery = require('./delivery')
const coupons = require('./coupons')

const db = cloud.database()
const _ = db.command

const INVITE_TTL = 24 * 3600 * 1000
const scrypt = promisify(crypto.scrypt)
const USERNAME_RE = /^[a-z0-9_]{3,20}$/
// 网页后台连续输错 5 次密码锁 15 分钟
const MAX_FAILS = 5
const LOCK_MS = 15 * 60 * 1000
// 网页后台扫码登录：二维码 3 分钟有效，手机上确认后网页 1 分钟内要来取
const LOGIN_TICKET_TTL = 3 * 60 * 1000
const LOGIN_CONFIRM_TTL = 60 * 1000
const LOGIN_PAGE = 'admin/pages/web-login/web-login'
const TICKET_RE = /^[A-Za-z0-9]{20}$/
const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
// 首页轮播：跳到商品、跳到书、跳到领券中心，或者只放一张图
const BANNER_KINDS = ['product', 'book', 'coupons', 'none']
const MAX_BANNERS = 10
// 后台没配轮播时，自动放最近上架的几样商品和书
const AUTO_BANNERS = 3

async function hashPassword(password, salt) {
  const key = await scrypt(String(password), salt, 32)
  return key.toString('hex')
}

async function countOwners() {
  const res = await db.collection('staff').where({ role: 'owner' }).count()
  return res.total
}

function randomCode() {
  return String(100000 + (crypto.randomBytes(4).readUInt32BE(0) % 900000))
}

function randomId(len) {
  const bytes = crypto.randomBytes(len)
  let id = ''
  for (let i = 0; i < len; i++) id += BASE62[bytes[i] % 62]
  return id
}

async function createSession(staff) {
  const token = crypto.randomBytes(32).toString('hex')
  const expiresAt = Date.now() + WEB_SESSION_TTL
  await db.collection('web_sessions').add({
    data: { _id: hashToken(token), staffId: staff._id, expiresAt, createdAt: db.serverDate() }
  })
  return { token, expiresAt, staff: publicStaff(staff) }
}

// 扫码登录用的小程序码。小程序还没发布（或者发布的版本里还没有确认页）时，正式版会报 41030，改用体验版。
// 测试版直接用体验版（体验版默认连测试服务器），scene 里加 s=t，体验版切到正式服务器时扫到了会提示切回来
async function loginCode(id) {
  if (cloud.isTest()) {
    const params = { scene: 'w=' + id + '&s=t', page: LOGIN_PAGE, width: 430, checkPath: false, envVersion: 'trial' }
    return { envVersion: 'trial', result: await cloud.openapi.wxacode.getUnlimited(params) }
  }
  const base = { scene: 'w=' + id, page: LOGIN_PAGE, width: 430 }
  try {
    const result = await cloud.openapi.wxacode.getUnlimited(Object.assign({ checkPath: true, envVersion: 'release' }, base))
    return { envVersion: 'release', result }
  } catch (e) {
    if (e.errCode !== 41030) throw e
  }
  const result = await cloud.openapi.wxacode.getUnlimited(Object.assign({ checkPath: false, envVersion: 'trial' }, base))
  return { envVersion: 'trial', result }
}

async function findTicket(id) {
  const key = String(id || '')
  const res = TICKET_RE.test(key) ? await db.collection('web_login_tickets').where({ _id: key }).limit(1).get() : { data: [] }
  if (!res.data[0]) throw new BizError('登录码不存在，请在电脑上刷新二维码', 'TICKET_GONE')
  return res.data[0]
}

// waiting 等手机确认、confirmed 已确认等网页来取、used 已登录、cancelled 手机上取消了、expired 过期
function ticketStatus(ticket) {
  if ((ticket.status === 'waiting' || ticket.status === 'confirmed') && ticket.expiresAt <= Date.now()) return 'expired'
  return ticket.status
}

// payReady：服务器配置文件里有没有填好微信支付；没填好时开关打开也不生效
function shopSettings(s) {
  const ready = cloud.pay.ready()
  return {
    payEnabled: !!s.payEnabled && ready,
    payReady: ready,
    mchId: cloud.pay.mchId || '',
    allowCounter: s.allowCounter !== false,
    hours: hoursOf(s)
  }
}

async function safeGet(query) {
  try {
    return (await query.get()).data
  } catch (e) {
    if (isMissingCollection(e)) return []
    throw e
  }
}

function toSort(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

async function deleteUploads(list) {
  const files = list.filter((id) => typeof id === 'string' && id.indexOf('/uploads/') === 0)
  if (!files.length) return
  try {
    await cloud.deleteFile({ fileList: files })
  } catch (e) {
    console.warn('deleteFile failed', e)
  }
}

// 首页的会员卡：没开储值又没余额就不显示；promo 是第一个充值档位，比如「充 300 送 50，送基础饮品券 1 张」
async function homeMember(settings, member) {
  const info = wallet.publicMember(member)
  if (!settings.enabled && !(info && (info.balance || info.isMember))) return null
  const plans = settings.enabled ? await safeGet(db.collection('member_plans').where({ enabled: true }).orderBy('sort', 'asc').limit(1)) : []
  const gifts = plans[0] && (plans[0].gifts || []).length ? coupons.giftText(coupons.giftList(plans[0].gifts, (await coupons.templateMap(db)).byId)) : ''
  return {
    enabled: settings.enabled,
    balance: info ? info.balance : 0,
    isMember: info ? info.isMember : false,
    memberUntil: info ? info.memberUntil : '',
    freeCategories: settings.freeCategories,
    promo: plans[0] ? plans[0].title + (plans[0].memberDays ? '，送 ' + plans[0].memberDays + ' 天会员' : '') + (gifts ? '，' + gifts : '') : ''
  }
}

// 轮播指向的商品或书：查出来按 _id 放好
async function bannerTargets(banners) {
  const ids = (kind) => banners.filter((b) => b.kind === kind && b.targetId).map((b) => b.targetId)
  const productIds = ids('product')
  const bookIds = ids('book')
  const [products, books] = await Promise.all([
    productIds.length ? safeGet(db.collection('coffee_products').where({ _id: _.in(productIds) }).limit(100)) : [],
    bookIds.length ? safeGet(db.collection('book_books').where({ _id: _.in(bookIds) }).limit(100)) : []
  ])
  const byId = {}
  products.forEach((p) => { byId['product:' + p._id] = p })
  books.forEach((b) => { byId['book:' + b._id] = b })
  return byId
}

// 顾客看到的一张轮播：商品下架、书下架或者删掉了就不显示（返回 null）
function publicBanner(b, target) {
  const out = { _id: b._id, kind: b.kind, targetId: b.targetId || '', title: b.title || '', subtitle: b.subtitle || '', image: b.image || '' }
  if (b.kind === 'product') {
    if (!target || !target.onShelf) return null
    return Object.assign(out, { title: out.title || target.name, subtitle: out.subtitle || '新品上市', image: out.image || target.image || '' })
  }
  if (b.kind === 'book') {
    if (!target || !target.onShelf) return null
    return Object.assign(out, { title: out.title || '《' + target.title + '》', subtitle: out.subtitle || '新书上架', image: out.image || target.cover || '' })
  }
  if (b.kind === 'coupons') return Object.assign(out, { title: out.title || '领券中心', subtitle: out.subtitle || '代金券限时领取' })
  return out.image ? out : null
}

async function autoBanners() {
  const [products, books] = await Promise.all([
    safeGet(db.collection('coffee_products').where({ onShelf: true }).orderBy('createdAt', 'desc').limit(AUTO_BANNERS)),
    safeGet(db.collection('book_books').where({ onShelf: true }).orderBy('createdAt', 'desc').limit(AUTO_BANNERS))
  ])
  const out = []
  for (let i = 0; i < AUTO_BANNERS; i++) {
    if (products[i]) out.push(publicBanner({ _id: 'auto-p' + i, kind: 'product', targetId: products[i]._id }, products[i]))
    if (books[i]) out.push(publicBanner({ _id: 'auto-b' + i, kind: 'book', targetId: books[i]._id }, books[i]))
  }
  return out
}

// 顾客还能领几种券：在领取中、没领完、自己还没领到上限的（只在充值时送的券不算，充值送到手的也不算已领）
async function claimableCoupons(openid) {
  const [coupons, mine] = await Promise.all([
    safeGet(db.collection('coffee_coupons').where({ enabled: true }).limit(100)),
    openid ? safeGet(db.collection('vouchers').where({ _openid: openid, type: 'cash', source: 'coupon' }).limit(500)) : []
  ])
  const claimed = {}
  mine.forEach((v) => { claimed[v.couponId] = (claimed[v.couponId] || 0) + 1 })
  return coupons.filter((c) => !c.giftOnly && (!c.total || (c.claimed || 0) < c.total) && (claimed[c._id] || 0) < (c.perUser || 1)).length
}

async function requireAnyStaff(openid) {
  const staff = await getStaff(db, openid)
  if (!staff) throw new BizError('只有店主和员工能登录网页后台', 'FORBIDDEN')
  return staff
}

const handlers = {
  // 每次打开小程序调用：返回当前用户是不是员工、店里有没有绑定店主
  async login(event, openid) {
    let staff = null
    let hasOwner = false
    try {
      staff = await getStaff(db, openid)
      hasOwner = (await countOwners()) > 0
    } catch (e) {
      if (!isMissingCollection(e)) throw e
      // 第一次运行，数据库还没有集合
      await ensureCollections(db)
    }
    return {
      staff: publicStaff(staff),
      hasOwner,
      ownerCodeRequired: !!process.env.OWNER_CODE
    }
  },

  // 店主绑定：店里还没有店主时，第一个绑定的人成为店主。
  // 如果服务器配置文件里设置了 ownerCode（绑定码），还要输入这个绑定码。
  async bindOwner({ name, code }, openid) {
    await ensureCollections(db)
    if ((await countOwners()) > 0) throw new BizError('店主已经绑定过了')
    if (process.env.OWNER_CODE && String(code || '').trim() !== process.env.OWNER_CODE) {
      throw new BizError('绑定码不对')
    }
    const staffName = cleanText(name, 12) || '店主'
    await db.collection('staff').doc(openid).set({
      data: { name: staffName, role: 'owner', createdAt: db.serverDate(), updatedAt: db.serverDate() }
    })
    return publicStaff({ name: staffName, role: 'owner' })
  },

  // 员工用店主给的 6 位邀请码绑定
  async bindStaff({ name, code }, openid) {
    const inviteCode = String(code || '').trim()
    if (!/^\d{6}$/.test(inviteCode)) throw new BizError('请输入 6 位邀请码')
    const res = await db.collection('staff_invites')
      .where({ code: inviteCode, used: false, expiresAt: _.gt(Date.now()) })
      .limit(1)
      .get()
    const invite = res.data[0]
    if (!invite) throw new BizError('邀请码无效或已过期，请让店主重新生成')

    const existing = await getStaff(db, openid)
    if (existing && existing.role === 'owner' && invite.role !== 'owner') {
      throw new BizError('你已经是店主了，不用再绑定')
    }

    // 带条件更新，防止同一个邀请码被两个人同时用掉
    const claimed = await db.collection('staff_invites')
      .where({ _id: invite._id, used: false })
      .update({ data: { used: true, usedBy: openid, usedAt: db.serverDate() } })
    if (!claimed.stats.updated) throw new BizError('邀请码已经被用过了')

    const staffName = cleanText(name, 12) || (existing && existing.name) || ROLES[invite.role]
    await db.collection('staff').doc(openid).set({
      data: {
        name: staffName,
        role: invite.role,
        createdAt: existing && existing.createdAt ? existing.createdAt : db.serverDate(),
        updatedAt: db.serverDate()
      }
    })
    return publicStaff({ name: staffName, role: invite.role })
  },

  async listStaff(event, openid) {
    await requireRole(db, openid, ['owner'])
    const res = await db.collection('staff').orderBy('createdAt', 'asc').limit(100).get()
    return res.data.map((s) => Object.assign({ id: s._id, isMe: s._id === openid, webUsername: s.webUsername || '' }, publicStaff(s)))
  },

  // ---------- 店铺设置：微信支付 ----------
  // 商户号、API 证书、APIv3 密钥填在服务器的配置文件里；这里只显示配好没有，店主管开关

  async getShopSettings(event, openid) {
    await requireRole(db, openid, ['owner'])
    const res = await db.collection('settings').where({ _id: 'shop' }).limit(1).get()
    return shopSettings(res.data[0] || {})
  },

  async saveShopSettings({ payEnabled, allowCounter, hours }, openid) {
    await requireRole(db, openid, ['owner'])
    if (payEnabled && !cloud.pay.ready()) {
      throw new BizError('服务器上还没配置微信支付（商户号、API 证书和 APIv3 密钥），按说明配好后再打开')
    }
    if (!payEnabled && allowCounter === false) throw new BizError('没开微信支付时，顾客只能到吧台付款')
    const saved = await readShop(db)
    const data = {
      payEnabled: !!payEnabled,
      allowCounter: allowCounter !== false,
      hours: hours ? checkHours(hours) : hoursOf(saved),
      updatedBy: openid,
      updatedAt: db.serverDate()
    }
    await db.collection('settings').doc('shop').set({ data })
    return shopSettings(data)
  },

  // ---------- 消息通知（订阅消息模板，店主） ----------

  async getNotifySettings(event, openid) {
    await requireRole(db, openid, ['owner'])
    return notify.getSettings(db)
  },

  async saveNotifySettings({ orderReady, rentalDue, state }, openid) {
    await requireRole(db, openid, ['owner'])
    return notify.saveSettings(db, { orderReady, rentalDue, state }, openid)
  },

  // ---------- 顾客首页 ----------

  async getHome(event, openid) {
    const [saved, memberSettings, member, starSettings, deliveryState] = await Promise.all([
      readShop(db),
      wallet.readSettings(db),
      wallet.findMember(db, openid),
      stars.readSettings(db),
      delivery.readState(db)
    ])
    const configured = await safeGet(db.collection('banners').where({ enabled: true }).orderBy('sort', 'asc').limit(MAX_BANNERS))
    let banners
    if (configured.length) {
      const targets = await bannerTargets(configured)
      banners = configured.map((b) => publicBanner(b, targets[b.kind + ':' + b.targetId])).filter(Boolean)
    } else {
      banners = await autoBanners()
    }
    return {
      banners,
      hours: hoursOf(saved),
      // 预约必须先在线付款：开通微信支付，或者开了会员储值（用余额付）才能用
      reserveEnabled: (!!saved.payEnabled && cloud.pay.ready()) || memberSettings.enabled,
      claimableCoupons: await claimableCoupons(openid),
      member: await homeMember(memberSettings, member),
      // 集星卡：没开集星时是 null
      stars: starSettings.enabled ? { stars: stars.liveStars(member, starSettings).stars, need: starSettings.need } : null,
      // 外送：enabled 店里开没开，inHours 现在在不在外送时间
      delivery: {
        enabled: deliveryState.open,
        inHours: deliveryState.inHours,
        hours: deliveryState.hours,
        minOrder: deliveryState.settings.minOrder || 0
      }
    }
  },

  // ---------- 首页轮播（店主） ----------

  async listBanners(event, openid) {
    await requireRole(db, openid, ['owner'])
    const banners = await safeGet(db.collection('banners').orderBy('sort', 'asc').limit(MAX_BANNERS * 2))
    const targets = await bannerTargets(banners)
    return banners.map((b) => {
      const target = targets[b.kind + ':' + b.targetId]
      const shown = publicBanner(b, target)
      return Object.assign({}, b, {
        targetName: target ? (target.name || target.title) : '',
        preview: shown,
        // 指向的商品或书已经下架、删掉了，顾客那边不会显示
        broken: (b.kind === 'product' || b.kind === 'book') && !shown
      })
    })
  },

  // 选轮播指向哪个商品、哪本书
  async bannerOptions(event, openid) {
    await requireRole(db, openid, ['owner'])
    const [products, books] = await Promise.all([
      safeGet(db.collection('coffee_products').where({ onShelf: true }).orderBy('createdAt', 'desc').limit(500)),
      safeGet(db.collection('book_books').where({ onShelf: true }).orderBy('createdAt', 'desc').limit(1000))
    ])
    return {
      products: products.map((p) => ({ _id: p._id, name: p.name, image: p.image || '' })),
      books: books.map((b) => ({ _id: b._id, name: b.title, image: b.cover || '' }))
    }
  },

  async saveBanner({ banner }, openid) {
    await requireRole(db, openid, ['owner'])
    const b = banner || {}
    if (BANNER_KINDS.indexOf(b.kind) === -1) throw new BizError('请选择轮播点开后去哪里')
    const targetId = b.kind === 'product' || b.kind === 'book' ? String(b.targetId || '') : ''
    if (b.kind === 'product' && !(await safeGet(db.collection('coffee_products').where({ _id: targetId }).limit(1))).length) {
      throw new BizError('请选择一个商品')
    }
    if (b.kind === 'book' && !(await safeGet(db.collection('book_books').where({ _id: targetId }).limit(1))).length) {
      throw new BizError('请选择一本书')
    }
    const image = typeof b.image === 'string' && b.image.indexOf('/uploads/') === 0 ? b.image.slice(0, 500) : ''
    if (b.kind === 'none' && !image) throw new BizError('只放图片的轮播要上传一张图')
    const data = {
      kind: b.kind,
      targetId,
      title: cleanText(b.title, 16),
      subtitle: cleanText(b.subtitle, 24),
      image,
      enabled: b.enabled !== false,
      updatedAt: db.serverDate()
    }
    if (b._id) {
      const old = (await safeGet(db.collection('banners').where({ _id: String(b._id) }).limit(1)))[0]
      if (!old) throw new BizError('这张轮播不存在了')
      await db.collection('banners').doc(old._id).update({ data })
      if (old.image && old.image !== image) await deleteUploads([old.image])
      return { id: old._id }
    }
    const count = (await db.collection('banners').count()).total
    if (count >= MAX_BANNERS * 2) throw new BizError('轮播最多 ' + MAX_BANNERS * 2 + ' 张，先删掉一些旧的')
    data.sort = b.sort === undefined ? count : toSort(b.sort)
    data.createdAt = db.serverDate()
    const added = await db.collection('banners').add({ data })
    return { id: added._id }
  },

  async setBannerFlags({ id, enabled }, openid) {
    await requireRole(db, openid, ['owner'])
    if (typeof enabled !== 'boolean') throw new BizError('参数不对')
    const res = await db.collection('banners').where({ _id: String(id || '') }).update({ data: { enabled, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('这张轮播不存在了')
    return true
  },

  // ids 按新的顺序排好传进来
  async sortBanners({ ids }, openid) {
    await requireRole(db, openid, ['owner'])
    if (!Array.isArray(ids) || ids.length > MAX_BANNERS * 2) throw new BizError('排序数据不对')
    await Promise.all(ids.map((id, index) =>
      db.collection('banners').where({ _id: String(id) }).update({ data: { sort: index, updatedAt: db.serverDate() } })
    ))
    return true
  },

  async deleteBanner({ id }, openid) {
    await requireRole(db, openid, ['owner'])
    const old = (await safeGet(db.collection('banners').where({ _id: String(id || '') }).limit(1)))[0]
    if (!old) return true
    await db.collection('banners').doc(old._id).remove()
    await deleteUploads([old.image])
    return true
  },

  // ---------- 电脑网页后台账号 ----------

  // 员工在小程序里给自己设网页后台的账号和密码
  async getWebAccount(event, openid) {
    const staff = await getStaff(db, openid)
    if (!staff) throw new BizError('只有店主和员工能开通网页后台', 'FORBIDDEN')
    return { username: staff.webUsername || '' }
  },

  async setWebAccount({ username, password }, openid) {
    const staff = await getStaff(db, openid)
    if (!staff) throw new BizError('只有店主和员工能开通网页后台', 'FORBIDDEN')
    const name = String(username || '').trim().toLowerCase()
    if (!USERNAME_RE.test(name)) throw new BizError('账号用 3 到 20 位小写字母、数字或下划线')
    const pwd = String(password || '')
    if (pwd.length < 8 || pwd.length > 64) throw new BizError('密码 8 到 64 位')
    if (!/[a-zA-Z]/.test(pwd) || !/\d/.test(pwd)) throw new BizError('密码要同时有字母和数字')
    const dup = await db.collection('staff').where({ webUsername: name }).limit(1).get()
    if (dup.data[0] && dup.data[0]._id !== openid) throw new BizError('这个账号已经有人用了，换一个')
    const salt = crypto.randomBytes(16).toString('hex')
    await db.collection('staff').doc(openid).update({
      data: {
        webUsername: name,
        web: { salt, hash: await hashPassword(pwd, salt), fails: 0, lockUntil: 0, updatedAt: Date.now() },
        updatedAt: db.serverDate()
      }
    })
    // 改密码后，之前在电脑上的登录全部失效
    await db.collection('web_sessions').where({ staffId: openid }).remove()
    return { username: name }
  },

  // 店主停用某位员工的网页后台，或者员工停用自己的
  async clearWebAccount({ id }, openid) {
    const target = id || openid
    if (target !== openid) await requireRole(db, openid, ['owner'])
    await db.collection('staff').doc(target).update({ data: { webUsername: '', web: _.set(null), updatedAt: db.serverDate() } })
    await db.collection('web_sessions').where({ staffId: target }).remove()
    return true
  },

  async webLogin({ username, password }) {
    const name = String(username || '').trim().toLowerCase()
    const wrong = new BizError('账号或密码不对')
    if (!USERNAME_RE.test(name) || typeof password !== 'string' || !password) throw wrong
    const res = await db.collection('staff').where({ webUsername: name }).limit(1).get()
    const staff = res.data[0]
    if (!staff || !staff.web || !staff.web.hash) throw wrong
    const now = Date.now()
    if (staff.web.lockUntil && staff.web.lockUntil > now) {
      throw new BizError('密码错太多次了，' + Math.ceil((staff.web.lockUntil - now) / 60000) + ' 分钟后再试')
    }
    const hash = await hashPassword(password.slice(0, 64), staff.web.salt)
    const same = crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(staff.web.hash, 'hex'))
    if (!same) {
      const fails = (staff.web.fails || 0) + 1
      await db.collection('staff').doc(staff._id).update({
        data: { web: { fails: fails >= MAX_FAILS ? 0 : fails, lockUntil: fails >= MAX_FAILS ? now + LOCK_MS : 0 } }
      })
      throw wrong
    }
    if (staff.web.fails) await db.collection('staff').doc(staff._id).update({ data: { web: { fails: 0, lockUntil: 0 } } })
    return createSession(staff)
  },

  // ---------- 网页后台扫码登录 ----------
  // 网页拿到登录码 id（印在小程序码里）和只有这个网页知道的 key；员工用微信扫码在小程序里确认，网页再凭 key 换登录状态

  async createWebLogin() {
    const now = Date.now()
    // 顺手清掉一小时前的旧登录码
    await db.collection('web_login_tickets').where({ expiresAt: _.lt(now - 3600 * 1000) }).remove()
    const id = randomId(20)
    const key = crypto.randomBytes(32).toString('hex')
    let code
    try {
      code = await loginCode(id)
    } catch (e) {
      console.error('getUnlimited failed', e)
      throw new BizError('生成登录二维码失败：' + (e.errMsg || e.message || '未知错误'))
    }
    const expiresAt = now + LOGIN_TICKET_TTL
    await db.collection('web_login_tickets').add({
      data: { _id: id, keyHash: hashToken(key), status: 'waiting', staffId: '', envVersion: code.envVersion, expiresAt, createdAt: db.serverDate() }
    })
    const type = code.result.contentType || 'image/png'
    return { id, key, expiresAt, envVersion: code.envVersion, image: 'data:' + type + ';base64,' + Buffer.from(code.result.buffer).toString('base64') }
  },

  // 小程序确认页：看看这个登录码还能不能用
  async getWebLogin({ id }, openid) {
    const staff = await requireAnyStaff(openid)
    const ticket = await findTicket(id)
    return { status: ticketStatus(ticket), staff: publicStaff(staff) }
  },

  async confirmWebLogin({ id }, openid) {
    await requireAnyStaff(openid)
    const ticket = await findTicket(id)
    const gone = new BizError('二维码已经失效，请在电脑上刷新后再扫', 'TICKET_GONE')
    if (ticketStatus(ticket) !== 'waiting') throw gone
    const res = await db.collection('web_login_tickets')
      .where({ _id: ticket._id, status: 'waiting', expiresAt: _.gt(Date.now()) })
      .update({ data: { status: 'confirmed', staffId: openid, expiresAt: Date.now() + LOGIN_CONFIRM_TTL, confirmedAt: db.serverDate() } })
    if (!res.stats.updated) throw gone
    return true
  },

  async cancelWebLogin({ id }, openid) {
    await requireAnyStaff(openid)
    const ticket = await findTicket(id)
    await db.collection('web_login_tickets').where({ _id: ticket._id, status: 'waiting' }).update({ data: { status: 'cancelled' } })
    return true
  },

  // 网页每两秒问一次；确认过了就发登录状态，一个登录码只能换一次
  async pollWebLogin({ id, key }) {
    const ticket = await findTicket(id)
    const wrong = new BizError('登录码不对，请刷新二维码', 'TICKET_GONE')
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw wrong
    if (!crypto.timingSafeEqual(Buffer.from(hashToken(key), 'hex'), Buffer.from(ticket.keyHash, 'hex'))) throw wrong
    const status = ticketStatus(ticket)
    if (status !== 'confirmed') return { status }
    const res = await db.collection('web_login_tickets')
      .where({ _id: ticket._id, status: 'confirmed' })
      .update({ data: { status: 'used', usedAt: db.serverDate() } })
    if (!res.stats.updated) return { status: 'used' }
    const staff = await getStaff(db, ticket.staffId)
    if (!staff) return { status: 'cancelled' }
    return Object.assign({ status: 'ok' }, await createSession(staff))
  },

  async webLogout({ webToken }) {
    if (typeof webToken === 'string') await db.collection('web_sessions').where({ _id: hashToken(webToken) }).remove()
    return true
  },

  async createInvite({ role }, openid) {
    await requireRole(db, openid, ['owner'])
    if (!ROLES[role]) throw new BizError('请选择员工角色')
    let code = randomCode()
    for (let i = 0; i < 5; i++) {
      const dup = await db.collection('staff_invites')
        .where({ code, used: false, expiresAt: _.gt(Date.now()) })
        .count()
      if (!dup.total) break
      code = randomCode()
    }
    const expiresAt = Date.now() + INVITE_TTL
    await db.collection('staff_invites').add({
      data: { code, role, used: false, expiresAt, createdBy: openid, createdAt: db.serverDate() }
    })
    return { code, role, roleName: ROLES[role], expiresAt }
  },

  async updateStaff({ id, role }, openid) {
    await requireRole(db, openid, ['owner'])
    if (!ROLES[role]) throw new BizError('请选择员工角色')
    const target = await getStaff(db, id)
    if (!target) throw new BizError('找不到这位员工')
    if (target.role === 'owner' && role !== 'owner' && (await countOwners()) <= 1) {
      throw new BizError('至少要保留一位店主')
    }
    await db.collection('staff').doc(id).update({ data: { role, updatedAt: db.serverDate() } })
    return true
  },

  async removeStaff({ id }, openid) {
    await requireRole(db, openid, ['owner'])
    if (id === openid) throw new BizError('不能移除自己')
    await db.collection('staff').doc(id).remove()
    await db.collection('web_sessions').where({ staffId: id }).remove()
    return true
  }
}

exports.main = createMain(cloud, handlers, { anonymous: ['login', 'webLogin', 'webLogout', 'createWebLogin', 'pollWebLogin'] })
