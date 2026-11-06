// 书籍模块：书架、借书、微信支付、余额支付、会员免费看、借阅处理、书目和计费规则管理。
// 读写 book_ 开头的集合；包天送咖啡时往 vouchers 里发赠饮券，咖啡下单时核销；读 settings 里的支付设置和会员设置；
// 用会员余额付款时通过 wallet.js 扣、退余额。
const cloud = require('../platform')
const {
  BOOK_ROLES,
  BizError,
  isMissingCollection,
  cleanText,
  cnDay,
  cnStamp,
  requireRole,
  nextSeq,
  dayRange,
  fetchAll,
  createMain
} = require('./base')
const { sanitizeRule, quoteRental, dueAt, overtime, ruleSummary } = require('./billing')
const DEMO = require('./book-demo')
const pay = require('./pay')
const wallet = require('./wallet')
const notify = require('./notify')
const shipping = require('./shipping')

const db = cloud.database()
const _ = db.command

const STATUSES = ['pending', 'reading', 'returned', 'cancelled']
// 每位顾客同时最多借几本（含还没取书的）
const MAX_ACTIVE = 3
const ISBN_RE = /^(97[89]\d{10}|\d{9}[\dX])$/
const MAX_COPIES = 99
// 会员免费看：当天打烊前还，不计时、不收钱
const MEMBER_RULE = { _id: 'member', name: '会员畅读', type: 'day', price: 0, graceMinutes: 0, freeCups: 0, freeProducts: [], freeMaxFee: 0 }

const col = (name) => db.collection(name)

async function findOne(name, where) {
  const res = await col(name).where(where).limit(1).get()
  return res.data[0] || null
}

function makeRentalNo() {
  return 'JB' + cnStamp() + String(Math.floor(Math.random() * 10000)).padStart(4, '0')
}

function ms(value) {
  if (!value) return 0
  return value instanceof Date ? value.getTime() : new Date(value).getTime()
}

// 返回给前端的借阅记录：去掉 openid，在读的带上到期时间和当前超时情况
function formatRental(rental, now) {
  const out = Object.assign({}, rental)
  delete out._openid
  out.dueAtMs = ms(rental.dueAt)
  if (rental.status === 'reading') out.overtimeNow = overtime(rental, now)
  return out
}

function publicBook(b) {
  return {
    _id: b._id,
    title: b.title,
    author: b.author || '',
    cover: b.cover || '',
    category: b.category || '',
    desc: b.desc || '',
    copies: b.copies,
    available: Math.max(0, b.available)
  }
}

function publicRule(r) {
  return {
    _id: r._id,
    name: r.name,
    type: r.type,
    price: r.price,
    desc: r.desc || '',
    minHours: r.minHours,
    maxHours: r.maxHours,
    graceMinutes: r.graceMinutes,
    freeCups: r.freeCups,
    freeProducts: r.freeProducts || [],
    freeMaxFee: r.freeMaxFee,
    summary: ruleSummary(r)
  }
}

function toSort(value) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : 0
}

async function shelfRules() {
  const res = await col('book_rules').where({ onShelf: true }).orderBy('sort', 'asc').limit(50).get()
  return res.data.map(publicRule)
}

async function restoreStock(bookId) {
  await col('book_books').where({ _id: bookId }).update({ data: { available: _.inc(1), updatedAt: db.serverDate() } })
}

// 包天付款后发赠饮券，当天有效；券的 _id 跟借阅记录挂钩，重复调用不会多发
async function issueVouchers(rental, openid) {
  for (let i = 0; i < (rental.freeCups || 0); i++) {
    try {
      await col('vouchers').add({
        data: {
          _id: rental._id + '-' + (i + 1),
          _openid: rental._openid,
          source: 'book_rental',
          sourceId: rental._id,
          title: rental.ruleName + '赠饮',
          productIds: (rental.freeProducts || []).map((p) => p.id),
          productNames: (rental.freeProducts || []).map((p) => p.name),
          maxFee: rental.freeMaxFee || 0,
          day: cnDay(),
          status: 'unused',
          orderNo: '',
          orderId: '',
          issuedBy: openid,
          createdAt: db.serverDate()
        }
      })
    } catch (e) {
      if (isMissingCollection(e)) throw e
      // 已经发过
    }
  }
  if (rental.freeCups) {
    await col('book_rentals').doc(rental._id).update({ data: { voucherCount: rental.freeCups } })
  }
}

function overtimeTradeNo(rental) {
  return 'JO' + rental.rentalNo.slice(2)
}

// 会员能不能免费看这本书：会员没过期，书的分类在免费分类里
function memberFree(book, settings, member) {
  return !!(book.category && settings.freeCategories.indexOf(book.category) !== -1 && wallet.isMember(member))
}

// 余额付的租金在取消时退回余额；同一条只退一次
function refundRentalToBalance(rental) {
  return wallet.refund(db, rental._openid, rental.fee, {
    title: '借书取消退回《' + rental.bookTitle + '》',
    refType: 'book',
    refId: rental._id,
    refNo: rental.rentalNo
  }, async () => {
    const res = await col('book_rentals')
      .where({ _id: rental._id, payStatus: 'paid', payMethod: 'balance' })
      .update({ data: { payStatus: 'refunded', refundedAt: db.serverDate(), updatedAt: db.serverDate() } })
    return res.stats.updated > 0
  })
}

// 已经用余额付过，微信那边又付了一次（租金或超时费）：把微信这笔原路退回
async function refundDuplicate(rental, outTradeNo, paid, flag) {
  if (!paid || rental[flag]) return
  await pay.refund({ outTradeNo, outRefundNo: 'RD' + outTradeNo, totalFee: paid.totalFee })
  const data = { updatedAt: db.serverDate() }
  data[flag] = true
  await col('book_rentals').doc(rental._id).update({ data })
}

async function refundRental(rental) {
  await pay.refund({
    outTradeNo: rental.payOutTradeNo || rental.rentalNo,
    outRefundNo: 'R' + rental.rentalNo,
    totalFee: rental.fee
  })
  await col('book_rentals').doc(rental._id).update({ data: { payStatus: 'refunded', refundedAt: db.serverDate(), updatedAt: db.serverDate() } })
}

// 微信支付成功：核对金额，标记已付、发赠饮券；借阅已经取消的直接原路退回
async function markRentalWechatPaid(rental, paid) {
  if (!paid || paid.totalFee !== rental.fee) {
    if (paid) console.error('pay amount mismatch', rental.rentalNo, paid.totalFee, rental.fee)
    return false
  }
  const res = await col('book_rentals')
    .where({ _id: rental._id, payStatus: 'unpaid' })
    .update({ data: { payStatus: 'paid', payMethod: 'wechat', transactionId: paid.transactionId, paidAt: db.serverDate(), updatedAt: db.serverDate() } })
  if (!res.stats.updated) {
    const now = await findOne('book_rentals', { _id: rental._id })
    if (now && now.payMethod === 'balance') await refundDuplicate(now, rental.payOutTradeNo || rental.rentalNo, paid, 'dupRefunded')
    return true
  }
  if (rental.status === 'cancelled') await refundRental(Object.assign({}, rental, { payStatus: 'paid' }))
  else {
    await issueVouchers(rental, '')
    // 告诉微信这单给出去了：到吧台取书，算到店自提
    await shipping.record({ type: 'pickup', paid, desc: '进山书屋-借阅《' + rental.bookTitle + '》' })
  }
  return true
}

async function markOvertimeWechatPaid(rental, paid) {
  if (!paid || paid.totalFee !== rental.overtimeFee) {
    if (paid) console.error('overtime amount mismatch', rental.rentalNo, paid.totalFee, rental.overtimeFee)
    return false
  }
  const res = await col('book_rentals')
    .where({ _id: rental._id, overtimePayStatus: 'unpaid' })
    .update({ data: { overtimePayStatus: 'paid', overtimePayMethod: 'wechat', overtimeTransactionId: paid.transactionId, overtimePaidAt: db.serverDate(), updatedAt: db.serverDate() } })
  if (!res.stats.updated) {
    const now = await findOne('book_rentals', { _id: rental._id })
    if (now && now.overtimePayMethod === 'balance') await refundDuplicate(now, overtimeTradeNo(rental), paid, 'overtimeDupRefunded')
    return true
  }
  await shipping.record({ type: 'virtual', paid, desc: '进山书屋-超时费《' + rental.bookTitle + '》' })
  return true
}

// 微信支付通知（服务器收到 /pay/notify/book 后调用）：JB 开头是租金，JO 开头是超时费
// 服务器每分钟跑一次：按小时借的书到期前 10 分钟提醒顾客（顾客借书时允许了才发）。先标记再发，不会重复提醒
async function remindDue() {
  const soon = new Date(Date.now() + notify.DUE_REMIND_MINUTES * 60000)
  const list = (await col('book_rentals')
    .where({ status: 'reading', notifyDue: true, dueReminded: _.neq(true), dueAt: _.lte(soon) })
    .limit(50).get()).data
  let count = 0
  for (const rental of list) {
    if (new Date(rental.dueAt).getTime() <= Date.now()) {
      // 已经过了到期时间（比如服务器停过一阵），不再提醒
      await col('book_rentals').where({ _id: rental._id }).update({ data: { dueReminded: true } })
      continue
    }
    const res = await col('book_rentals')
      .where({ _id: rental._id, status: 'reading', dueReminded: _.neq(true) })
      .update({ data: { dueReminded: true } })
    if (res.stats.updated && (await notify.rentalDue(db, rental))) count++
  }
  return count
}

async function onPayNotify({ outTradeNo }) {
  const no = typeof outTradeNo === 'string' ? outTradeNo : ''
  if (no.indexOf('JB') === 0) {
    const rental = await findOne('book_rentals', { rentalNo: no })
    if (rental && rental.payStatus === 'unpaid') await markRentalWechatPaid(rental, await pay.queryPaid(no))
    else if (rental && rental.payMethod === 'balance' && rental.payOutTradeNo) await refundDuplicate(rental, no, await pay.queryPaid(no), 'dupRefunded')
  } else if (no.indexOf('JO') === 0) {
    const rental = await findOne('book_rentals', { rentalNo: 'JB' + no.slice(2) })
    if (rental && rental.overtimePayStatus === 'unpaid') await markOvertimeWechatPaid(rental, await pay.queryPaid(no))
    else if (rental && rental.overtimePayMethod === 'balance' && rental.overtimePayStarted) await refundDuplicate(rental, no, await pay.queryPaid(no), 'overtimeDupRefunded')
  }
}

async function deleteFiles(fileIds) {
  const list = fileIds.filter((id) => typeof id === 'string' && id.indexOf('/uploads/') === 0)
  if (!list.length) return
  try {
    await cloud.deleteFile({ fileList: list })
  } catch (e) {
    console.warn('deleteFile failed', e)
  }
}

async function getRentalForStaff(id) {
  const rental = await findOne('book_rentals', { _id: String(id || '') })
  if (!rental) throw new BizError('借阅记录不存在')
  return rental
}

const handlers = {
  // ---------- 顾客端 ----------

  async getShelf() {
    try {
      const [books, rules] = await Promise.all([
        col('book_books').where({ onShelf: true }).orderBy('sort', 'asc').limit(1000).get(),
        shelfRules()
      ])
      const list = books.data.map(publicBook).map((b) => {
        delete b.desc
        return b
      })
      const categories = []
      list.forEach((b) => {
        if (b.category && categories.indexOf(b.category) === -1) categories.push(b.category)
      })
      // 会员免费看的分类，书架上打个标
      const settings = await wallet.readSettings(db)
      return { books: list, rules, categories, memberFree: settings.enabled ? settings.freeCategories : [] }
    } catch (e) {
      if (isMissingCollection(e)) return { books: [], rules: [], categories: [] }
      throw e
    }
  },

  // member：会员免费看的情况（free 这本书在免费分类里，canFree 现在就能免费借）和余额
  async getBook({ id }, openid) {
    const book = await findOne('book_books', { _id: String(id || '') })
    if (!book || !book.onShelf) throw new BizError('这本书暂时不在书架上了')
    const [settings, memberSettings, member, templates] = await Promise.all([
      pay.getSettings(db), wallet.readSettings(db), wallet.findMember(db, openid), notify.templateIds(db)
    ])
    const free = !!book.category && memberSettings.freeCategories.indexOf(book.category) !== -1
    return {
      book: publicBook(book),
      rules: await shelfRules(),
      pay: pay.publicPay(settings),
      // 到期提醒的订阅消息模板：按小时借的，下单时请顾客允许
      notifyTemplate: templates.rentalDue,
      member: {
        enabled: memberSettings.enabled,
        free: free && (memberSettings.enabled || wallet.isMember(member)),
        canFree: memberFree(book, memberSettings, member),
        isMember: wallet.isMember(member),
        memberUntil: member ? member.memberUntil || '' : '',
        balance: member ? member.balance || 0 : 0
      }
    }
  },

  // ruleId 传 'member' 是会员免费看；payBy 传 'balance' 用会员余额付租金；subscribed 为 true 表示顾客允许了到期提醒
  async createRental({ bookId, ruleId, hours, remark, payBy, subscribed }, openid) {
    const byMember = ruleId === MEMBER_RULE._id
    const [book, found] = await Promise.all([
      findOne('book_books', { _id: String(bookId || '') }),
      byMember ? null : findOne('book_rules', { _id: String(ruleId || '') })
    ])
    if (!book || !book.onShelf) throw new BizError('这本书暂时不能借了', 'SHELF_CHANGED')
    let rule = found
    if (byMember) {
      const [memberSettings, member] = await Promise.all([wallet.readSettings(db), wallet.findMember(db, openid)])
      if (!memberFree(book, memberSettings, member)) {
        throw new BizError(wallet.isMember(member) ? '这本书不在会员免费看的范围里，请选别的计费方式' : '会员已经到期了，请选别的计费方式', 'SHELF_CHANGED')
      }
      rule = MEMBER_RULE
    } else if (!rule || !rule.onShelf) throw new BizError('这个计费方式已经停用，请重新选择', 'SHELF_CHANGED')
    const quote = quoteRental(rule, hours)
    const byBalance = payBy === 'balance' && quote.fee > 0
    if (byBalance) {
      const member = await wallet.findMember(db, openid)
      if (!member || member.balance < quote.fee) throw new BizError('余额不够了，换个付款方式，或者先充值', 'BALANCE_LOW')
    }
    const active = await col('book_rentals').where({ _openid: openid, status: _.in(['pending', 'reading']) }).count()
    if (active.total >= MAX_ACTIVE) throw new BizError('你已经借了 ' + MAX_ACTIVE + ' 本，先还一本再借吧')

    // 先占一本，防止最后一本被两个人同时借走；后面出错再还回去
    const taken = await col('book_books')
      .where({ _id: book._id, available: _.gt(0) })
      .update({ data: { available: _.inc(-1), updatedAt: db.serverDate() } })
    if (!taken.stats.updated) throw new BizError('这本书刚好被借完了', 'SHELF_CHANGED')
    const rentalNo = makeRentalNo()
    let charged = false
    try {
      if (byBalance) {
        await wallet.pay(db, openid, quote.fee, { title: '借书《' + book.title + '》', refType: 'book', refNo: rentalNo })
        charged = true
      }
      const day = cnDay()
      const seq = await nextSeq(db, 'book-rental-' + day)
      const rental = {
        _openid: openid,
        rentalNo,
        code: 'B' + String(seq).padStart(3, '0'), // 到吧台报这个号取书
        seq,
        day,
        bookId: book._id,
        bookTitle: book.title,
        bookAuthor: book.author || '',
        bookCover: book.cover || '',
        // 规则存一份快照，后台改价不影响已经下的单
        ruleId: rule._id,
        ruleName: rule.name,
        ruleType: rule.type,
        unitPrice: rule.price,
        hours: quote.hours,
        graceMinutes: rule.graceMinutes || 0,
        freeCups: rule.freeCups || 0,
        freeProducts: rule.freeProducts || [],
        freeMaxFee: rule.freeMaxFee || 0,
        fee: quote.fee,
        voucherCount: 0,
        remark: cleanText(remark, 50),
        member: byMember,
        status: 'pending',
        // 0 元的规则、会员免费看不用付钱；余额付的下单时就扣了
        payStatus: quote.fee === 0 || byBalance ? 'paid' : 'unpaid',
        payMethod: byMember ? 'member' : (quote.fee === 0 ? 'free' : (byBalance ? 'balance' : 'counter')), // 微信付款后改成 wechat
        startAt: null,
        dueAt: null,
        returnedAt: null,
        overtimeMinutes: 0,
        overtimeFee: 0,
        overtimePayStatus: 'none', // none 没超时；unpaid 待收；paid 已收
        createdAt: db.serverDate(),
        updatedAt: db.serverDate()
      }
      if (byBalance) rental.paidAt = db.serverDate()
      if (subscribed === true && rule.type === 'hourly') rental.notifyDue = true
      const added = await col('book_rentals').add({ data: rental })
      if (rental.payStatus === 'paid') await issueVouchers(Object.assign({ _id: added._id }, rental), '')
      return { id: added._id }
    } catch (e) {
      await restoreStock(book._id)
      if (charged) await wallet.refund(db, openid, quote.fee, { title: '借书没成功，退回', refType: 'book', refNo: rentalNo })
      throw e
    }
  },

  async getRental({ id }, openid) {
    const rental = await findOne('book_rentals', { _id: String(id || '') })
    if (!rental) throw new BizError('借阅记录不存在')
    if (rental._openid !== openid) await requireRole(db, openid, BOOK_ROLES)
    const now = Date.now()
    const settings = await pay.getSettings(db)
    const out = Object.assign(formatRental(rental, now), { serverNow: now, pay: pay.publicPay(settings) })
    // 自己还有没付的租金或超时费：带上余额，可以直接用余额付
    if (rental._openid === openid && (rental.payStatus === 'unpaid' || rental.overtimePayStatus === 'unpaid')) {
      const w = await wallet.walletInfo(db, openid)
      out.wallet = { enabled: w.enabled, balance: w.balance }
    }
    return out
  },

  // 顾客用会员余额付租金（kind 不传）或超时费（kind: 'overtime'）
  async payRentalWithBalance({ id, kind }, openid) {
    const rental = await findOne('book_rentals', { _id: String(id || ''), _openid: openid })
    if (!rental) throw new BizError('借阅记录不存在')
    const log = { refType: 'book', refId: rental._id, refNo: rental.rentalNo }
    if (kind === 'overtime') {
      if (rental.overtimePayStatus !== 'unpaid') throw new BizError('没有要付的超时费')
      if (rental.overtimePayStarted && (await markOvertimeWechatPaid(rental, await pay.queryPaid(overtimeTradeNo(rental))))) return { overtimePayStatus: 'paid' }
      await wallet.pay(db, openid, rental.overtimeFee, Object.assign({ title: '超时费《' + rental.bookTitle + '》' }, log))
      const res = await col('book_rentals')
        .where({ _id: rental._id, overtimePayStatus: 'unpaid' })
        .update({ data: { overtimePayStatus: 'paid', overtimePayMethod: 'balance', overtimePaidAt: db.serverDate(), updatedAt: db.serverDate() } })
      if (!res.stats.updated) {
        await wallet.refund(db, openid, rental.overtimeFee, Object.assign({ title: '超时费已经付过了，退回' }, log))
        throw new BizError('超时费刚刚已经付过了，这次的钱退回余额了')
      }
      return { overtimePayStatus: 'paid' }
    }
    if (rental.status !== 'pending') throw new BizError('这条借阅已经不能付款了')
    if (rental.payStatus !== 'unpaid') throw new BizError('已经付过了')
    if (rental.payOutTradeNo && (await markRentalWechatPaid(rental, await pay.queryPaid(rental.payOutTradeNo)))) return { payStatus: 'paid' }
    await wallet.pay(db, openid, rental.fee, Object.assign({ title: '借书《' + rental.bookTitle + '》' }, log))
    const res = await col('book_rentals')
      .where({ _id: rental._id, payStatus: 'unpaid', status: 'pending' })
      .update({ data: { payStatus: 'paid', payMethod: 'balance', paidAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) {
      await wallet.refund(db, openid, rental.fee, Object.assign({ title: '借阅状态变了，退回' }, log))
      throw new BizError('借阅状态刚刚变了，钱已经退回余额，请刷新看看')
    }
    await issueVouchers(rental, '')
    return { payStatus: 'paid' }
  },

  // 顾客用微信付租金（kind 不传）或超时费（kind: 'overtime'）
  async payRental({ id, kind }, openid) {
    const rental = await findOne('book_rentals', { _id: String(id || ''), _openid: openid })
    if (!rental) throw new BizError('借阅记录不存在')
    const settings = await pay.getSettings(db)
    if (kind === 'overtime') {
      if (rental.overtimePayStatus !== 'unpaid') throw new BizError('没有要付的超时费')
      const payment = await pay.unifiedOrder(settings, {
        body: '进山书屋-超时费',
        outTradeNo: overtimeTradeNo(rental),
        totalFee: rental.overtimeFee,
        openid,
        notify: 'book'
      })
      await col('book_rentals').doc(rental._id).update({ data: { overtimePayStarted: true, updatedAt: db.serverDate() } })
      return { payment }
    }
    if (rental.status !== 'pending') throw new BizError('这条借阅已经不能付款了')
    if (rental.payStatus !== 'unpaid') throw new BizError('已经付过了')
    const payment = await pay.unifiedOrder(settings, {
      body: '进山书屋-《' + rental.bookTitle + '》',
      outTradeNo: rental.rentalNo,
      totalFee: rental.fee,
      openid,
      notify: 'book'
    })
    await col('book_rentals').doc(rental._id).update({ data: { payOutTradeNo: rental.rentalNo, updatedAt: db.serverDate() } })
    return { payment }
  },

  // 付完款后顾客端调一下，向微信查单确认
  async confirmPay({ id, kind }, openid) {
    const rental = await findOne('book_rentals', { _id: String(id || '') })
    if (!rental) throw new BizError('借阅记录不存在')
    if (rental._openid !== openid) await requireRole(db, openid, BOOK_ROLES)
    if (kind === 'overtime') {
      if (rental.overtimePayStatus === 'unpaid' && await markOvertimeWechatPaid(rental, await pay.queryPaid(overtimeTradeNo(rental)))) {
        return { overtimePayStatus: 'paid' }
      }
      return { overtimePayStatus: rental.overtimePayStatus }
    }
    if (rental.payStatus === 'unpaid' && rental.payOutTradeNo && await markRentalWechatPaid(rental, await pay.queryPaid(rental.payOutTradeNo))) {
      return { payStatus: 'paid' }
    }
    return { payStatus: rental.payStatus }
  },

  async myRentals({ page }, openid) {
    const size = 20
    const p = Math.max(0, Math.floor(Number(page) || 0))
    const now = Date.now()
    try {
      const res = await col('book_rentals')
        .where({ _openid: openid })
        .orderBy('createdAt', 'desc')
        .skip(p * size)
        .limit(size)
        .get()
      return { rentals: res.data.map((r) => formatRental(r, now)), hasMore: res.data.length === size, serverNow: now }
    } catch (e) {
      if (isMissingCollection(e)) return { rentals: [], hasMore: false, serverNow: now }
      throw e
    }
  },

  async cancelRental({ id }, openid) {
    const rental = await findOne('book_rentals', { _id: String(id || ''), _openid: openid })
    if (!rental) throw new BizError('借阅记录不存在')
    const res = await col('book_rentals')
      .where({ _id: rental._id, _openid: openid, status: 'pending', payStatus: 'unpaid' })
      .update({ data: { status: 'cancelled', cancelledAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('已经付款或取书了，不能取消，请联系店员')
    await restoreStock(rental.bookId)
    return true
  },

  // ---------- 书籍后台：借阅处理 ----------

  // 待取书、在读不分日期全部列出；已归还、已取消看某一天（默认今天）
  async listRentals({ status, day }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const d = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : cnDay()
    const st = STATUSES.indexOf(status) === -1 ? 'pending' : status
    const whereOf = (s) => (s === 'pending' || s === 'reading' ? { status: s } : { day: d, status: s })
    const active = st === 'pending' || st === 'reading'
    const now = Date.now()
    const [list, counts, pending] = await Promise.all([
      col('book_rentals').where(whereOf(st)).orderBy('day', active ? 'asc' : 'desc').orderBy('seq', active ? 'asc' : 'desc').limit(100).get(),
      Promise.all(STATUSES.map((s) => col('book_rentals').where(whereOf(s)).count())),
      col('book_rentals').where({ status: 'pending' }).field({ _id: true }).limit(100).get()
    ])
    const countMap = {}
    STATUSES.forEach((s, i) => { countMap[s] = counts[i].total })
    return {
      day: d,
      rentals: list.data.map((r) => formatRental(r, now)),
      counts: countMap,
      pendingIds: pending.data.map((r) => r._id),
      serverNow: now
    }
  },

  async markRentalPaid({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rental = await getRentalForStaff(id)
    const res = await col('book_rentals')
      .where({ _id: rental._id, payStatus: 'unpaid', status: 'pending' })
      .update({ data: { payStatus: 'paid', payMethod: 'counter', paidAt: db.serverDate(), paidBy: openid, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('已经收过款或已取消')
    await issueVouchers(rental, openid)
    return { voucherCount: rental.freeCups || 0 }
  },

  // 交书给顾客，开始计时
  async handOut({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rental = await getRentalForStaff(id)
    if (rental.status !== 'pending') throw new BizError('这本书已经交给顾客或已取消')
    if (rental.payStatus !== 'paid') throw new BizError('还没收款，先收款再交书')
    const now = Date.now()
    const res = await col('book_rentals')
      .where({ _id: rental._id, status: 'pending', payStatus: 'paid' })
      .update({ data: { status: 'reading', startAt: new Date(now), dueAt: new Date(dueAt(rental, now)), handedBy: openid, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('状态已经变了，请刷新')
    return { dueAtMs: dueAt(rental, now) }
  },

  // 还书：按小时的超时了就记下超时费，书放回书架
  async returnBook({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rental = await getRentalForStaff(id)
    if (rental.status !== 'reading') throw new BizError('这本书不在借阅中')
    const now = Date.now()
    const ot = overtime(rental, now)
    const res = await col('book_rentals')
      .where({ _id: rental._id, status: 'reading' })
      .update({
        data: {
          status: 'returned',
          returnedAt: new Date(now),
          returnedBy: openid,
          overtimeMinutes: ot.minutes,
          overtimeFee: ot.fee,
          overtimePayStatus: ot.fee ? 'unpaid' : 'none',
          updatedAt: db.serverDate()
        }
      })
    if (!res.stats.updated) throw new BizError('状态已经变了，请刷新')
    await restoreStock(rental.bookId)
    return { overtimeMinutes: ot.minutes, overtimeHours: ot.hours, overtimeFee: ot.fee }
  },

  async markOvertimePaid({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const res = await col('book_rentals')
      .where({ _id: String(id || ''), overtimePayStatus: 'unpaid' })
      .update({ data: { overtimePayStatus: 'paid', overtimePayMethod: 'counter', overtimePaidAt: db.serverDate(), updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('没有待收的超时费')
    return true
  },

  // 店员取消：书放回书架，没用的赠饮券作废；已收款的要线下退款
  async adminCancelRental({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rental = await getRentalForStaff(id)
    if (rental.status !== 'pending' && rental.status !== 'reading') throw new BizError('这条借阅已经结束了')
    // 微信付过款的先原路退款，退款成功才取消；余额付的退回余额
    const refunded = rental.payStatus === 'paid' && (rental.payMethod === 'wechat' || rental.payMethod === 'balance')
    if (refunded && rental.payMethod === 'wechat') await refundRental(rental)
    if (refunded && rental.payMethod === 'balance') await refundRentalToBalance(rental)
    const res = await col('book_rentals')
      .where({ _id: rental._id, status: rental.status })
      .update({ data: { status: 'cancelled', cancelledAt: db.serverDate(), cancelledBy: openid, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('状态已经变了，请刷新')
    await restoreStock(rental.bookId)
    let voided = 0
    if (rental.voucherCount) {
      const v = await col('vouchers').where({ sourceId: rental._id, status: 'unused' }).update({ data: { status: 'void' } })
      voided = v.stats.updated
    }
    return { paid: rental.payStatus === 'paid' && !refunded && rental.fee > 0, refunded, voidedVouchers: voided }
  },

  // 店主看账：每天借了几本、租金和超时费，以及各计费规则的情况
  async daySummary({ from, to }, openid) {
    await requireRole(db, openid, ['owner'])
    const days = dayRange(from, to)
    const list = await fetchAll(col('book_rentals').where({ day: _.in(days) }).orderBy('createdAt', 'asc'))
    const rows = {}
    days.forEach((d) => {
      rows[d] = { day: d, rentals: 0, memberRentals: 0, cancelled: 0, fee: 0, paidFee: 0, unpaidFee: 0, wechatFee: 0, counterFee: 0, balanceFee: 0, overtimePaid: 0, overtimeBalance: 0, overtimeUnpaid: 0, vouchersIssued: 0, cancelledPaidFee: 0 }
    })
    const rules = {}
    list.forEach((r) => {
      const row = rows[r.day]
      if (!row) return
      if (r.status === 'cancelled') {
        row.cancelled++
        if (r.payStatus === 'paid') row.cancelledPaidFee += r.fee // 收了钱、还没在线退款的
        return
      }
      row.rentals++
      if (r.member) row.memberRentals++
      row.fee += r.fee
      row.vouchersIssued += r.voucherCount || 0
      if (r.payStatus === 'paid') {
        row.paidFee += r.fee
        if (r.payMethod === 'wechat') row.wechatFee += r.fee
        else if (r.payMethod === 'balance') row.balanceFee += r.fee // 充值时已经收过钱了
        else row.counterFee += r.fee
      } else {
        row.unpaidFee += r.fee
      }
      if (r.overtimePayStatus === 'paid') row.overtimePaid += r.overtimeFee
      if (r.overtimePayStatus === 'paid' && r.overtimePayMethod === 'balance') row.overtimeBalance += r.overtimeFee
      if (r.overtimePayStatus === 'unpaid') row.overtimeUnpaid += r.overtimeFee
      const rule = rules[r.ruleId] || (rules[r.ruleId] = { ruleId: r.ruleId, name: r.ruleName, count: 0, amount: 0 })
      rule.count++
      rule.amount += r.fee
    })
    const out = days.map((d) => rows[d])
    const totals = out.reduce((acc, r) => {
      Object.keys(r).forEach((k) => { if (k !== 'day') acc[k] = (acc[k] || 0) + r[k] })
      return acc
    }, {})
    const byRule = Object.keys(rules).map((k) => rules[k]).sort((a, b) => b.amount - a.amount)
    return { days: out, totals, rules: byRule }
  },

  // ---------- 书籍后台：书目 ----------

  async adminListBooks(event, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const res = await col('book_books').orderBy('sort', 'asc').limit(1000).get()
    return res.data
  },

  async getBookAdmin({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const book = await findOne('book_books', { _id: String(id || '') })
    if (!book) throw new BizError('书不存在')
    return book
  },

  async saveBook({ book }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const b = book || {}
    const title = cleanText(b.title, 40)
    if (!title) throw new BizError('请填写书名')
    const copies = Number(b.copies)
    if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) throw new BizError('册数请填 1 到 ' + MAX_COPIES)
    const isbn = String(b.isbn || '').replace(/[\s-]/g, '').toUpperCase()
    if (isbn && !ISBN_RE.test(isbn)) throw new BizError('ISBN 格式不对，应该是 10 位或 13 位')
    if (isbn) {
      const dup = await findOne('book_books', { isbn })
      if (dup && dup._id !== b._id) throw new BizError('《' + dup.title + '》已经录入过这个 ISBN 了，改册数就行')
    }
    const data = {
      title,
      author: cleanText(b.author, 30),
      isbn,
      cover: typeof b.cover === 'string' ? b.cover.slice(0, 500) : '',
      category: cleanText(b.category, 10),
      desc: cleanText(b.desc, 300),
      onShelf: b.onShelf !== false,
      sort: toSort(b.sort),
      updatedAt: db.serverDate()
    }
    if (b._id) {
      const old = await findOne('book_books', { _id: String(b._id) })
      if (!old) throw new BizError('书不存在')
      const delta = copies - old.copies
      const out = old.copies - old.available // 借出去的
      if (delta < 0 && copies < out) throw new BizError('现在有 ' + out + ' 本借出去了，册数不能少于 ' + out)
      data.copies = copies
      data.available = _.inc(delta)
      // 带上原册数做条件，防止同时有人借书时算错可借数量
      const res = await col('book_books').where({ _id: old._id, copies: old.copies, available: _.gte(-delta) }).update({ data })
      if (!res.stats.updated) throw new BizError('刚好有人借还书，请重新保存')
      if (old.cover && old.cover !== data.cover) await deleteFiles([old.cover])
      return { id: old._id }
    }
    data.copies = copies
    data.available = copies
    data.createdAt = db.serverDate()
    const added = await col('book_books').add({ data })
    return { id: added._id }
  },

  // 网页后台从 Excel 批量导入：同一个 ISBN 已经有的跳过，其余新建
  async importBooks({ books }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    if (!Array.isArray(books) || !books.length) throw new BizError('没有要导入的书')
    if (books.length > 200) throw new BizError('一次最多导入 200 本')
    const existing = await fetchAll(col('book_books').field({ isbn: true }).orderBy('createdAt', 'asc'))
    const seen = {}
    existing.forEach((b) => { if (b.isbn) seen[b.isbn] = true })
    const count = await col('book_books').count()
    let created = 0
    const skipped = []
    for (let i = 0; i < books.length; i++) {
      const b = books[i] || {}
      const title = cleanText(b.title, 40)
      const isbn = String(b.isbn || '').replace(/[\s-]/g, '').toUpperCase()
      const copies = b.copies === undefined || b.copies === '' || b.copies === null ? 1 : Number(b.copies)
      let reason = ''
      if (!title) reason = '没有书名'
      else if (!Number.isInteger(copies) || copies < 1 || copies > MAX_COPIES) reason = '册数要是 1 到 ' + MAX_COPIES + ' 的整数'
      else if (isbn && !ISBN_RE.test(isbn)) reason = 'ISBN 格式不对'
      else if (isbn && seen[isbn]) reason = '这个 ISBN 已经有了'
      if (reason) {
        skipped.push({ index: i, title, reason })
        continue
      }
      if (isbn) seen[isbn] = true
      await col('book_books').add({
        data: {
          title,
          author: cleanText(b.author, 30),
          isbn,
          cover: '',
          category: cleanText(b.category, 10),
          desc: cleanText(b.desc, 300),
          copies,
          available: copies,
          onShelf: true,
          sort: count.total + created,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
      created++
    }
    return { created, skipped }
  },

  async setBookFlags({ id, onShelf }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    if (typeof onShelf !== 'boolean') throw new BizError('参数不对')
    const res = await col('book_books').where({ _id: String(id || '') }).update({ data: { onShelf, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('书不存在')
    return true
  },

  async deleteBook({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const book = await findOne('book_books', { _id: String(id || '') })
    if (!book) return true
    const out = book.copies - book.available
    if (out > 0) throw new BizError('还有 ' + out + ' 本没还，还回来以后再删除')
    await col('book_books').doc(book._id).remove()
    await deleteFiles([book.cover])
    return true
  },

  // ---------- 书籍后台：计费规则 ----------

  async adminListRules(event, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const res = await col('book_rules').orderBy('sort', 'asc').limit(100).get()
    return res.data.map((r) => Object.assign({}, r, { summary: ruleSummary(r) }))
  },

  async getRule({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const rule = await findOne('book_rules', { _id: String(id || '') })
    if (!rule) throw new BizError('规则不存在')
    return rule
  },

  async saveRule({ rule }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const r = rule || {}
    const data = sanitizeRule(r)
    data.freeProducts = r._id ? _.set(data.freeProducts) : data.freeProducts
    data.updatedAt = db.serverDate()
    if (r._id) {
      const res = await col('book_rules').where({ _id: String(r._id) }).update({ data })
      if (!res.stats.updated) throw new BizError('规则不存在')
      return { id: r._id }
    }
    data.createdAt = db.serverDate()
    const added = await col('book_rules').add({ data })
    return { id: added._id }
  },

  async setRuleFlags({ id, onShelf }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    if (typeof onShelf !== 'boolean') throw new BizError('参数不对')
    const res = await col('book_rules').where({ _id: String(id || '') }).update({ data: { onShelf, updatedAt: db.serverDate() } })
    if (!res.stats.updated) throw new BizError('规则不存在')
    return true
  },

  // 已经下的单存了规则快照，删规则不影响
  async deleteRule({ id }, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    await col('book_rules').where({ _id: String(id || '') }).remove()
    return true
  },

  // 第一次试用：一本书、一条规则都没有时导入示例
  async seedDemo(event, openid) {
    await requireRole(db, openid, BOOK_ROLES)
    const [books, rules] = await Promise.all([col('book_books').count(), col('book_rules').count()])
    if (books.total || rules.total) throw new BizError('已经有书或计费规则了，不再导入示例')
    for (let i = 0; i < DEMO.rules.length; i++) {
      const data = sanitizeRule(Object.assign({ sort: i }, DEMO.rules[i]))
      data.createdAt = db.serverDate()
      data.updatedAt = db.serverDate()
      await col('book_rules').add({ data })
    }
    for (let i = 0; i < DEMO.books.length; i++) {
      const b = DEMO.books[i]
      await col('book_books').add({
        data: {
          title: b.title,
          author: b.author,
          isbn: '',
          cover: '',
          category: b.category,
          desc: '示例书目，请在后台改成店里的真实书籍',
          copies: b.copies,
          available: b.copies,
          onShelf: true,
          sort: i,
          createdAt: db.serverDate(),
          updatedAt: db.serverDate()
        }
      })
    }
    return { bookCount: DEMO.books.length, ruleCount: DEMO.rules.length }
  }
}

exports.main = createMain(cloud, handlers)
exports.onPayNotify = onPayNotify
exports.remindDue = remindDue
