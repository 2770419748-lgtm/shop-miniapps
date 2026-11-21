// 小程序页面预览：真服务器代码 + 内存假数据（admin-web/mock/seed.js），再把 miniprogram/ 目录的文件发给浏览器里的 runtime 渲染
// 用法：node server.js <repo目录> [端口]
const fs = require('fs')
const os = require('os')
const path = require('path')

const REPO = path.resolve(process.argv[2] || path.join(__dirname, '../../..'))
const PORT = Number(process.argv[3] || 8790)
const MP = path.join(REPO, process.env.MP_DIR || 'miniprogram')
const HERE = __dirname

const { createApp } = require(path.join(REPO, 'server/app'))
const platform = require(path.join(REPO, 'server/platform'))
const { Database } = require(path.join(REPO, 'server/lib/db'))
const { createStorage } = require(path.join(REPO, 'server/lib/storage'))
const { sendJson } = require(path.join(REPO, 'server/lib/http'))
const seed = require(path.join(REPO, 'admin-web/mock/seed'))

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const wechat = {
  ready: () => true,
  // 登录用的 code 就当 openid：前端 wx.login 返回哪个用户名就以谁的身份进来（OWNER、C1…）
  code2session: async (code) => ({ openid: code }),
  getUnlimited: async () => ({ buffer: PNG, contentType: 'image/png' }),
  getTemplateList: async () => [],
  sendSubscribe: async () => true
}
const pay = { mchId: '', ready: () => false }
const carwash = { wechat: Object.assign({}, wechat), pay: { mchId: '', ready: () => false } }
const db = new Database(':memory:')
const storage = createStorage({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'mp-preview-')) })

const TYPES = { '.js': 'application/javascript', '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.css': 'text/css', '.json': 'application/json' }

function walk(dir, base, out) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    const rel = base ? base + '/' + name : name
    if (fs.statSync(full).isDirectory()) walk(full, rel, out)
    else if (/\.(js|json|wxml|wxss|wxs)$/.test(name)) out[rel] = fs.readFileSync(full, 'utf8')
  }
  return out
}

function sendStatic(res, file) {
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) return false
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
  res.end(fs.readFileSync(file))
  return true
}

async function extraRoutes(req, res, url) {
  const p = decodeURIComponent(url.pathname)
  if (req.method !== 'GET') return false
  if (p === '/bundle.json') {
    sendJson(res, 200, walk(MP, '', {}))
    return true
  }
  if (p.indexOf('/mp/') === 0) return sendStatic(res, path.join(MP, p.slice(4)))
  if (p === '/' || p.indexOf('/h/') === 0) return sendStatic(res, path.join(HERE, p === '/' ? 'index.html' : p.slice(3)))
  return false
}

const { server, modules } = createApp({
  config: { adminDir: path.join(REPO, 'admin-web/dist'), ownerCode: '' },
  db, wechat, pay, storage, carwash, extraRoutes
})

function as(openid) {
  const call = (fn) => (action, data) => platform.runAs(openid, () => fn.main(Object.assign({ action }, data || {})))
  return { common: call(modules.common), coffee: call(modules.coffee), book: call(modules.book), member: call(modules.member), carwash: call(modules.carwash) }
}

seed(as, db).then(() => {
  server.listen(PORT, () => console.log('preview on http://localhost:' + PORT + '/  mp=' + MP))
}).catch((e) => {
  console.error(e)
  process.exit(1)
})
