// 进山咖啡的服务器：咖啡小程序、洗车小程序和电脑网页后台都调这里。
// 启动：node app.js（读同目录的 config.json，照着 config.example.json 填；也可以用环境变量 JINSHAN_CONFIG 指定别的路径）
// config.json 里 env 填 test 就是测试版：不收真钱、只给店员发订阅消息、网页后台顶上标「测试版」
//
//   POST /api/login                 小程序 wx.login 的 code 换登录状态；body 里 app 是 coffee（默认）或 carwash
//   POST /api/common|coffee|book|member|carwash  调业务模块，body 是 { action, ...参数 }
//   POST /api/upload                员工上传图片
//   POST /pay/notify/coffee|book|member  微信支付通知（咖啡的商户号）
//   POST /pay/notify/carwash        微信支付通知（洗车的商户号）
//   POST /delivery/notify/wechat    微信同城配送的骑手状态回调（外送单）
//   GET  /uploads/...               图片
//   GET  /admin/                    电脑网页后台
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const platform = require('./platform')
const { Database } = require('./lib/db')
const { createWechat } = require('./lib/wechat')
const { createWxpay } = require('./lib/wxpay')
const { createIntracity } = require('./lib/intracity')
const { createStorage } = require('./lib/storage')
const { HttpError, readBody, readJson, firstFile, sendJson, sendFile } = require('./lib/http')
const { APPS, resolveUser } = require('./lib/identity')

const MAX_JSON = 5 * 1024 * 1024
const MAX_IMAGE = 5 * 1024 * 1024
const MAX_NOTIFY = 64 * 1024
// 小程序登录状态 30 天，过期了小程序会自动重新登录
const MP_SESSION_TTL = 30 * 24 * 3600 * 1000
const MODULES = ['common', 'coffee', 'book', 'member', 'carwash']
const PAY_MODULES = ['coffee', 'book', 'member', 'carwash']
// 走洗车商户号的模块，其余走咖啡的
const CARWASH_MODULES = ['carwash']
const BACKUP_KEEP_DAYS = 14

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

function loadConfig(file) {
  let raw = {}
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('找不到配置文件 ' + file + '：把 config.example.json 复制一份改名为 config.json，再填上内容')
    throw new Error('配置文件 ' + file + ' 格式不对：' + e.message)
  }
  const dir = path.dirname(path.resolve(file))
  const abs = (p, fallback) => path.resolve(dir, p || fallback)
  const payOf = (pay) => ({
    mchId: String(pay.mchId || ''),
    serialNo: String(pay.serialNo || ''),
    privateKeyFile: pay.privateKeyFile ? abs(pay.privateKeyFile) : '',
    apiV3Key: String(pay.apiV3Key || ''),
    publicKeyFile: pay.publicKeyFile ? abs(pay.publicKeyFile) : '',
    publicKeyId: String(pay.publicKeyId || '')
  })
  const carwash = raw.carwash || {}
  const dw = (raw.delivery && raw.delivery.wechat) || {}
  return {
    env: raw.env === 'test' ? 'test' : 'prod',
    port: Number(raw.port || 3000),
    host: raw.host || '127.0.0.1',
    publicUrl: String(raw.publicUrl || '').replace(/\/+$/, ''),
    appId: String(raw.appId || ''),
    appSecret: String(raw.appSecret || ''),
    ownerCode: String(raw.ownerCode || ''),
    dataDir: abs(raw.dataDir, 'data'),
    uploadDir: abs(raw.uploadDir, path.join(raw.dataDir || 'data', 'uploads')),
    adminDir: abs(raw.adminDir, '../admin-web/dist'),
    pay: payOf(raw.pay || {}),
    // 洗车小程序：自己的 AppID 和商户号（和咖啡不是同一个执照）
    carwash: {
      appId: String(carwash.appId || ''),
      appSecret: String(carwash.appSecret || ''),
      pay: payOf(carwash.pay || {})
    },
    // 外送配送：微信同城配送的「API 安全」密钥（公众平台「开发管理 → 开发设置 → API 安全」），
    // notifyToken 是「消息推送」的 Token，用来验配送状态回调；sandbox 为 true 时只叫测试单（不派真骑手）
    delivery: {
      wechat: {
        aesKeySn: String(dw.aesKeySn || ''),
        aesKey: String(dw.aesKey || ''),
        rsaKeySn: String(dw.rsaKeySn || ''),
        rsaPrivateKeyFile: dw.rsaPrivateKeyFile ? abs(dw.rsaPrivateKeyFile) : '',
        notifyToken: String(dw.notifyToken || ''),
        sandbox: dw.sandbox === true
      }
    }
  }
}

function readKey(file) {
  if (!file) return ''
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    console.error('读不到密钥文件 ' + file + '：' + e.message)
    return ''
  }
}

// 装好各部分，返回 http 服务器。extraRoutes(req, res, url) 返回 true 表示已经处理（本地预览用）
// wechat、pay 是咖啡小程序的；carwash: { wechat, pay } 是洗车小程序的，不传就是还没配置；
// couriers: { wechat } 是外送用的第三方配送（微信同城配送），不传就是还没配置
function createApp({ config, db, wechat, pay, storage, carwash, couriers, extraRoutes }) {
  const isTest = config.env === 'test'
  platform.configure({ db, wechat, pay, storage, carwash: carwash || null, couriers: couriers || null, env: isTest ? 'test' : 'prod' })
  if (config.ownerCode) process.env.OWNER_CODE = config.ownerCode
  const modules = {}
  MODULES.forEach((name) => { modules[name] = require('./functions/' + name) })
  const { getStaff, resolveWebToken } = require('./functions/base')

  // 小程序的登录状态：openid 是用户 id，app 和 appOpenid 是从哪个小程序登录的
  async function sessionOf(token) {
    if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return null
    const res = await db.collection('mp_sessions').where({ _id: hash(token) }).limit(1).get()
    const s = res.data[0]
    return s && s.expiresAt > Date.now() ? s : null
  }

  async function login(req, res) {
    const { code, app } = await readJson(req, 4096)
    if (typeof code !== 'string' || !code || code.length > 128) return sendJson(res, 400, { ok: false, msg: '登录参数不对', code: 'BAD_REQUEST' })
    const appName = app === undefined ? 'coffee' : app
    if (APPS.indexOf(appName) === -1) return sendJson(res, 400, { ok: false, msg: '登录参数不对', code: 'BAD_REQUEST' })
    const wx = platform.wechatOf(appName)
    if (!wx.ready()) return sendJson(res, 200, { ok: false, msg: '服务器上还没配置' + (appName === 'carwash' ? '洗车' : '咖啡') + '小程序的 AppID', code: 'WX_LOGIN_FAILED' })
    let who
    try {
      who = await wx.code2session(code)
    } catch (e) {
      console.error('code2session failed', appName, e.message)
      return sendJson(res, 200, { ok: false, msg: '微信登录失败，请稍后再试', code: 'WX_LOGIN_FAILED' })
    }
    const unionid = who.unionid || ''
    const openid = await resolveUser(db, appName, who.openid, unionid)
    const now = Date.now()
    await db.collection('mp_sessions').where({ expiresAt: db.command.lt(now) }).remove()
    const token = crypto.randomBytes(32).toString('hex')
    const expiresAt = now + MP_SESSION_TTL
    await db.collection('mp_sessions').add({
      data: { _id: hash(token), openid, app: appName, appOpenid: who.openid, unionid, expiresAt, createdAt: db.serverDate() }
    })
    sendJson(res, 200, { ok: true, data: { token, expiresAt } })
  }

  async function callModule(name, req, res) {
    const body = await readJson(req, MAX_JSON)
    if (typeof body.action !== 'string' || !body.action) return sendJson(res, 400, { ok: false, msg: '未知操作', code: 'UNKNOWN_ACTION' })
    let s = null
    if (req.headers['x-session']) {
      s = await sessionOf(req.headers['x-session'])
      if (!s) return sendJson(res, 200, { ok: false, msg: '登录过期了', code: 'NEED_WX_LOGIN' })
    }
    // 老的登录状态没有记 app，都是咖啡小程序的
    const extra = s ? { app: s.app || 'coffee', appOpenid: s.appOpenid || s.openid, unionid: s.unionid || '' } : null
    const result = await platform.runAs(s ? s.openid : '', () => modules[name].main(body), extra)
    sendJson(res, 200, result)
  }

  // 只有员工能传图：小程序里靠登录状态，网页后台靠 webToken
  async function upload(req, res, url) {
    let openid = ''
    if (req.headers['x-session']) openid = ((await sessionOf(req.headers['x-session'])) || {}).openid || ''
    else if (req.headers['x-web-token']) openid = await resolveWebToken(db, String(req.headers['x-web-token'])).catch(() => '')
    if (!openid || !(await getStaff(db, openid))) return sendJson(res, 200, { ok: false, msg: '只有店主和员工能上传图片', code: 'FORBIDDEN' })
    let buf
    try {
      buf = await readBody(req, MAX_IMAGE + 64 * 1024)
    } catch (e) {
      if (e.status === 413) return sendJson(res, 200, { ok: false, msg: '图片太大了，换一张 5MB 以内的', code: 'TOO_LARGE' })
      throw e
    }
    const type = String(req.headers['content-type'] || '')
    const file = /multipart\/form-data/i.test(type) ? firstFile(buf, type) : buf
    if (!file || !file.length) return sendJson(res, 200, { ok: false, msg: '没收到图片', code: 'BAD_REQUEST' })
    if (file.length > MAX_IMAGE) return sendJson(res, 200, { ok: false, msg: '图片太大了，换一张 5MB 以内的', code: 'TOO_LARGE' })
    let fileID
    try {
      fileID = storage.saveImage(file, url.searchParams.get('folder') || '')
    } catch (e) {
      return sendJson(res, 200, { ok: false, msg: '只能上传 jpg、png、gif、webp 图片', code: 'BAD_IMAGE' })
    }
    sendJson(res, 200, { ok: true, data: { fileID } })
  }

  // 微信支付通知：解密后交给对应模块；处理失败回 500，微信会过一会儿再通知
  async function payNotify(name, req, res) {
    const raw = await readBody(req, MAX_NOTIFY)
    let note
    try {
      note = platform.payOf(CARWASH_MODULES.indexOf(name) !== -1 ? 'carwash' : 'coffee').parseNotify(req.headers, raw)
    } catch (e) {
      console.error('pay notify rejected', e.message)
      return sendJson(res, 400, { code: 'FAIL', message: 'bad notify' })
    }
    try {
      if (note.eventType === 'TRANSACTION.SUCCESS' && note.tradeState === 'SUCCESS') {
        await modules[name].onPayNotify({ outTradeNo: note.outTradeNo })
      }
    } catch (e) {
      console.error('pay notify failed', note.outTradeNo, e)
      return sendJson(res, 500, { code: 'FAIL', message: 'retry' })
    }
    res.writeHead(204)
    res.end()
  }

  // 微信同城配送的状态回调：验签名后更新外送单的配送进度；签名不对回 400（服务器每分钟也会自己查一次进度）
  async function courierNotify(req, res) {
    let body
    try {
      body = await readJson(req, MAX_NOTIFY)
    } catch (e) {
      return sendJson(res, 400, { return_code: -1, return_msg: 'bad request' })
    }
    let ok
    try {
      ok = await modules.coffee.onCourierNotify(body)
    } catch (e) {
      console.error('delivery notify failed', body && body.store_order_id, e)
      return sendJson(res, 500, { return_code: -1, return_msg: 'retry' })
    }
    if (!ok) return sendJson(res, 400, { return_code: -1, return_msg: 'bad sign' })
    sendJson(res, 200, { return_code: 0, return_msg: 'OK' })
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost')
    const p = url.pathname
    res.setHeader('x-content-type-options', 'nosniff')
    if (extraRoutes && (await extraRoutes(req, res, url))) return
    if (req.method === 'POST') {
      if (p === '/api/login') return login(req, res)
      if (p === '/api/upload') return upload(req, res, url)
      const m = /^\/api\/([a-z]+)$/.exec(p)
      if (m && MODULES.indexOf(m[1]) !== -1) return callModule(m[1], req, res)
      const n = /^\/pay\/notify\/([a-z]+)$/.exec(p)
      if (n && PAY_MODULES.indexOf(n[1]) !== -1) return payNotify(n[1], req, res)
      if (p === '/delivery/notify/wechat') return courierNotify(req, res)
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (p === '/healthz') return sendJson(res, 200, { ok: true, env: isTest ? 'test' : 'prod' })
      if (p === '/' || p === '/admin') {
        res.writeHead(302, { location: '/admin/' })
        return res.end()
      }
      if (p.indexOf('/uploads/') === 0) {
        const file = storage.resolve(decodeURIComponent(p))
        if (file && sendFile(req, res, storage.root, path.relative(storage.root, file), 'public, max-age=31536000, immutable')) return
      }
      if (p.indexOf('/admin/') === 0) {
        const rel = decodeURIComponent(p.slice('/admin/'.length)) || 'index.html'
        if (isTest && rel === 'index.html' && sendTestIndex(req, res, config.adminDir)) return
        // 打包出来的文件名带哈希，可以长期缓存；index.html 和 config.js 每次都要新的
        const cache = /^assets\//.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache'
        if (sendFile(req, res, config.adminDir, rel, cache)) return
      }
    }
    sendJson(res, 404, { ok: false, msg: 'not found', code: 'NOT_FOUND' })
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof HttpError) return sendJson(res, e.status, { ok: false, msg: e.message, code: 'BAD_REQUEST' })
      console.error('[' + req.method + ' ' + req.url + ']', e)
      if (!res.headersSent) sendJson(res, 500, { ok: false, msg: '服务器开小差了，请稍后再试', code: 'SERVER_ERROR' })
      else res.end()
    })
  })
  return { server, modules }
}

// 测试版的网页后台：页面顶上一条红色的「测试版」，标题前面也加上（网页自己改标题时也补上），免得和正式后台搞混
const TEST_BANNER = '<div style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#d03050;color:#fff;' +
  'text-align:center;font-size:13px;line-height:22px;pointer-events:none">测试版 · 数据和正式版分开，随便试</div>' +
  '<style>body{padding-top:22px;box-sizing:border-box}</style>' +
  '<script>(function(){var p="【测试版】",t=document.querySelector("title");function fix(){if(document.title.indexOf(p)!==0)document.title=p+document.title}' +
  'fix();if(t)new MutationObserver(fix).observe(t,{childList:true,characterData:true,subtree:true})})()</script>'

function sendTestIndex(req, res, adminDir) {
  let html
  try {
    html = fs.readFileSync(path.join(adminDir, 'index.html'), 'utf8')
  } catch (e) {
    return false
  }
  html = html.replace(/<title>/i, '<title>【测试版】').replace(/<body([^>]*)>/i, (m) => m + TEST_BANNER)
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
  res.end(req.method === 'HEAD' ? undefined : html)
  return true
}

// 每天凌晨 4 点以后备份一次数据库到 data/backups，保留 14 天
function scheduleBackups(db, dataDir) {
  const dir = path.join(dataDir, 'backups')
  const run = () => {
    try {
      const cn = new Date(Date.now() + 8 * 3600 * 1000)
      if (cn.getUTCHours() < 4) return
      const day = cn.toISOString().slice(0, 10)
      const file = path.join(dir, 'jinshan-' + day + '.db')
      fs.mkdirSync(dir, { recursive: true })
      if (!fs.existsSync(file)) {
        db.backupTo(file)
        console.log('数据库已备份：' + file)
      }
      const cutoff = new Date(cn.getTime() - BACKUP_KEEP_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10)
      fs.readdirSync(dir).forEach((f) => {
        const m = /^jinshan-(\d{4}-\d{2}-\d{2})\.db$/.exec(f)
        if (m && m[1] < cutoff) fs.unlinkSync(path.join(dir, f))
      })
    } catch (e) {
      console.error('数据库备份失败', e)
    }
  }
  setTimeout(run, 60 * 1000).unref()
  setInterval(run, 3600 * 1000).unref()
}

function main() {
  const config = loadConfig(process.env.JINSHAN_CONFIG || path.join(__dirname, 'config.json'))
  fs.mkdirSync(config.dataDir, { recursive: true })
  const db = new Database(path.join(config.dataDir, 'jinshan.db'))
  const wechat = createWechat({ appId: config.appId, appSecret: config.appSecret })
  // 还没填商户号时不去读证书，免得日志里报找不到文件
  const makePay = (appId, p) => {
    const key = (file) => (p.mchId ? readKey(file) : '')
    return createWxpay({
      appId,
      mchId: p.mchId,
      serialNo: p.serialNo,
      privateKey: key(p.privateKeyFile),
      apiV3Key: p.apiV3Key,
      publicKey: key(p.publicKeyFile),
      publicKeyId: p.publicKeyId,
      notifyBase: config.publicUrl
    })
  }
  // 测试版不收真钱：就算配置里填了商户号也不用
  const noPay = (p) => (config.env === 'test' ? {} : p)
  const pay = makePay(config.appId, noPay(config.pay))
  const carwash = {
    wechat: createWechat({ appId: config.carwash.appId, appSecret: config.carwash.appSecret }),
    pay: makePay(config.carwash.appId, noPay(config.carwash.pay))
  }
  // 外送的第三方配送：微信同城配送。测试版只叫沙箱测试单，不派真骑手、不扣运费
  const dw = config.delivery.wechat
  const intracity = createIntracity({
    appId: config.appId,
    accessToken: (force) => wechat.accessToken(force),
    aesKeySn: dw.aesKeySn,
    aesKey: dw.aesKey,
    rsaKeySn: dw.rsaKeySn,
    rsaPrivateKey: dw.aesKey ? readKey(dw.rsaPrivateKeyFile) : ''
  })
  // 回调要 HTTPS 地址，还要配了「消息推送」的 Token 才验得了签名；没有的话只靠每分钟查一次
  const notifyUrl = /^https:\/\//.test(config.publicUrl) && dw.notifyToken ? config.publicUrl + '/delivery/notify/wechat' : ''
  const couriers = {
    wechat: Object.assign(intracity, { sandbox: config.env === 'test' || dw.sandbox, notifyToken: dw.notifyToken, notifyUrl })
  }
  const storage = createStorage({ dir: config.uploadDir })
  const { server, modules } = createApp({ config, db, wechat, pay, storage, carwash, couriers })
  if (config.env === 'test') console.log('这是测试版：微信支付关闭，订阅消息只发给店员')
  if (!wechat.ready()) console.warn('注意：配置文件里还没填 appId / appSecret，小程序登录和小程序码用不了')
  console.log(pay.ready() ? '微信支付已配置，商户号 ' + config.pay.mchId : '微信支付没配置（商户号下来以后按 README 填配置）')
  if (!carwash.wechat.ready()) console.warn('注意：配置文件里还没填洗车小程序的 carwash.appId / appSecret，洗车小程序登录不了')
  console.log(carwash.pay.ready() ? '洗车微信支付已配置，商户号 ' + config.carwash.pay.mchId : '洗车微信支付没配置')
  console.log(intracity.ready() ? '微信同城配送已配置' + (couriers.wechat.sandbox ? '（沙箱，只叫测试单）' : '') : '微信同城配送没配置（外送只能店员自己送）')
  scheduleBackups(db, config.dataDir)
  // 每分钟：取消超时没付款的预约单、外送单，查一次第三方配送的进度，上传微信支付的发货信息，提醒一次快到期的借书；
  // 洗车单超时没付款的取消、没确认完成的自动完成；集星设了有效期时每小时清一次过期的星星
  setInterval(() => {
    modules.coffee.expireReservations().catch((e) => console.error('取消超时预约单失败', e))
    modules.coffee.syncDeliveries().catch((e) => console.error('查配送进度失败', e))
    modules.coffee.syncShipping().catch((e) => console.error('上传发货信息失败', e))
    modules.coffee.expireStars().catch((e) => console.error('清过期星星失败', e))
    modules.book.remindDue().catch((e) => console.error('借书到期提醒失败', e))
    modules.carwash.runTimers().catch((e) => console.error('洗车定时任务失败', e))
  }, 60 * 1000).unref()
  server.listen(config.port, config.host, () => {
    console.log('进山服务器已启动：http://' + config.host + ':' + config.port + '  数据目录 ' + config.dataDir)
  })
  const stop = () => server.close(() => {
    db.close()
    process.exit(0)
  })
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

if (require.main === module) main()

module.exports = { createApp, loadConfig, scheduleBackups }
