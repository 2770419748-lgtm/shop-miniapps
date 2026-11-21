// 界面自动检查：把小程序每一页和电脑网页后台每一页都截图，并按 docs/UI规范.md 查排版问题。
// 用法（在仓库根目录）：
//   npm run ui:check                     小程序 + 网页后台全部查
//   npm run ui:check -- --only=mp        只查小程序（--only=web 只查网页后台）
//   npm run ui:check -- --filter=books   只查名字里带 books 的画面
//   npm run ui:check -- --out=/tmp/ui    截图和报告放哪（默认 tools/ui-check/out，不进 git）
// 有问题时退出码是 1，报告在 <out>/report.md。确实没问题的个例写进 allow.json 并写清原因。
// 需要 playwright（npm i --no-save playwright && npx playwright install chromium）。
const { spawn, execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { chromium } = require('playwright')
const checks = require('./checks')

const REPO = path.resolve(__dirname, '../..')
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a)
  return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true]
}))
const OUT = path.resolve(args.out || path.join(__dirname, 'out'))
const ONLY = args.only || ''
const FILTER = args.filter || ''
const MP_PORT = Number(process.env.MP_PORT || 8790)
const WEB_PORT = Number(process.env.WEB_PORT || 8787)
const ALLOW = JSON.parse(fs.readFileSync(path.join(__dirname, 'allow.json'), 'utf8'))

const RULES = {
  error: '页面报错',
  overflow: '内容超出屏幕宽',
  wrap: '短文字被挤成多行',
  'off-center': '文字没有上下居中',
  clipped: '文字被切掉、没有省略号',
  inset: '横向滑动区没通到屏幕边',
  covered: '滑到底还被底部按钮挡住',
  tiny: '字太小'
}

function startServer(cmd, argv, env, ready) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: REPO, env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    const timer = setTimeout(() => reject(new Error('服务没起来：' + log.slice(-800))), 60000)
    const on = (d) => {
      log += d
      if (log.indexOf(ready) !== -1) {
        clearTimeout(timer)
        resolve(p)
      }
    }
    p.stdout.on('data', on)
    p.stderr.on('data', on)
    p.on('exit', (code) => reject(new Error('服务退出了 ' + code + '：' + log.slice(-800))))
  })
}

// ---------- 小程序 ----------
async function idle(page) {
  let calm = 0
  for (let i = 0; i < 100 && calm < 3; i++) {
    const s = await page.evaluate(() => window.__state && { ready: window.__state.ready, pending: window.__state.pending, dirty: window.__state.dirty, fatal: window.__state.fatal })
    if (s && s.fatal) throw new Error(s.fatal)
    if (s && s.ready && !s.pending && !s.dirty) calm++
    else calm = 0
    await page.waitForTimeout(80)
  }
}

async function loadMp(page, sc, user, pageName, q) {
  const qs = new URLSearchParams({ page: pageName, user, w: sc.w, h: sc.h })
  if (q) qs.set('q', typeof q === 'string' ? q : new URLSearchParams(q).toString())
  if (sc.safe !== undefined) qs.set('safe', sc.safe)
  await page.goto('http://localhost:' + MP_PORT + '/?' + qs.toString())
  await idle(page)
  return page.frames()[1]
}

async function shootMp(browser, sc, dir) {
  const ctx = await browser.newContext({ viewport: { width: sc.w, height: sc.h }, deviceScaleFactor: 2 })
  const page = await ctx.newPage()
  const issues = []
  try {
    if (sc.storage) {
      await page.goto('http://localhost:' + MP_PORT + '/bundle.json')
      await page.evaluate(({ user, storage }) => { Object.keys(storage).forEach((k) => localStorage.setItem('mp:' + user + ':' + k, JSON.stringify(storage[k]))) }, { user: sc.user || 'C1', storage: sc.storage })
    }
    for (const pr of sc.prep || []) {
      const f = await loadMp(page, sc, pr.user || sc.user || 'C1', pr.page, pr.q)
      if (pr.act) { await pr.act({ page, frame: f, idle: () => idle(page) }); await idle(page) }
    }
    let frame = await loadMp(page, sc, sc.user || 'C1', sc.page, sc.q)
    if (sc.full) {
      const extra = await frame.evaluate(() => document.documentElement.scrollHeight - window.innerHeight)
      if (extra > 0) {
        sc = Object.assign({}, sc, { h: sc.h + extra })
        await page.setViewportSize({ width: sc.w, height: sc.h })
        frame = await loadMp(page, sc, sc.user || 'C1', sc.page, sc.q)
      }
    }
    if (sc.act) {
      await sc.act({ page, frame, idle: () => idle(page) })
      await idle(page)
    }
    await page.waitForTimeout(150)
    await page.locator('#phone').screenshot({ path: path.join(dir, sc.name + '.png') })
    const st = await page.evaluate(() => ({ errors: window.__state.errors }))
    st.errors.forEach((e) => issues.push({ rule: 'error', text: String(e).slice(0, 60), detail: String(e).slice(0, 300) }))
    issues.push(...await frame.evaluate(checks.inPage, { kind: 'mp' }))
    issues.push(...await frame.evaluate(checks.coveredInPage))
  } catch (e) {
    issues.push({ rule: 'error', text: '截图失败', detail: e.message.slice(0, 300) })
  }
  await ctx.close()
  return issues
}

async function runMp(browser, report) {
  const server = await startServer(process.execPath, [path.join(__dirname, 'mp/server.js'), REPO, String(MP_PORT)], {}, 'preview on')
  try {
    const list = await require('./mp-scenarios')(MP_PORT)
    // 标准屏（390 宽，iPhone 14）全部截；小屏（320 宽，iPhone SE）截整页的，最容易挤
    const sizes = [
      { tag: 'mp', w: 390, h: 844, pick: () => true },
      { tag: 'mp-320', w: 320, h: 568, safe: 0, pick: (s) => !/-view$/.test(s.name) }
    ]
    for (const size of sizes) {
      const dir = path.join(OUT, size.tag)
      fs.mkdirSync(dir, { recursive: true })
      for (const s of list) {
        if (!size.pick(s) || (FILTER && s.name.indexOf(FILTER) === -1)) continue
        const sc = Object.assign({}, s, { w: size.w, h: size.h }, size.safe !== undefined ? { safe: size.safe } : {})
        const issues = await shootMp(browser, sc, dir)
        report.push({ group: size.tag, name: s.name, shot: path.relative(OUT, path.join(dir, s.name + '.png')), issues })
        console.log(size.tag, s.name, issues.length ? issues.length + ' 个问题' : 'ok')
      }
    }
  } finally {
    server.kill()
  }
}

// ---------- 网页后台 ----------
function ensureWebBuild() {
  const dist = path.join(REPO, 'admin-web/dist-mock')
  if (!fs.existsSync(path.join(REPO, 'admin-web/node_modules'))) execSync('npm ci --no-audit --no-fund', { cwd: path.join(REPO, 'admin-web'), stdio: 'inherit' })
  if (!args.nobuild || !fs.existsSync(dist)) execSync('npm run build:mock', { cwd: path.join(REPO, 'admin-web'), stdio: 'inherit' })
}

async function webLogin(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } })
  const page = await ctx.newPage()
  await page.goto('http://localhost:' + WEB_PORT + '/admin/#/login')
  await page.getByText('账号密码', { exact: true }).click()
  await page.getByPlaceholder('在小程序里设置的账号').fill('boss')
  await page.locator('input[type=password]').fill('jinshan2026')
  await page.getByRole('button', { name: '登录' }).click()
  await page.waitForURL(/#\/(?!login)/, { timeout: 15000 })
  const state = await ctx.storageState()
  await ctx.close()
  return state
}

async function shootWeb(browser, state, sc, size, dir) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: size.w < 500 ? 2 : 1 }, sc.public ? {} : { storageState: state }))
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const issues = []
  try {
    await page.goto('http://localhost:' + WEB_PORT + '/admin/#' + sc.path)
    await page.waitForLoadState('networkidle')
    await page.waitForTimeout(400)
    if (sc.click) {
      await page.getByRole('button', { name: sc.click }).first().click()
      await page.waitForTimeout(600)
    }
    await page.screenshot({ path: path.join(dir, sc.name + '.png'), fullPage: !sc.click })
    errors.forEach((e) => issues.push({ rule: 'error', text: e.slice(0, 60), detail: e.slice(0, 300) }))
    issues.push(...await page.evaluate(checks.inPage, { kind: 'web' }))
  } catch (e) {
    issues.push({ rule: 'error', text: '截图失败', detail: e.message.slice(0, 300) })
  }
  await ctx.close()
  return issues
}

async function runWeb(browser, report) {
  ensureWebBuild()
  const server = await startServer(process.execPath, [path.join(REPO, 'admin-web/mock/server.js'), 'dist-mock'], { PORT: String(WEB_PORT) }, '网页后台预览')
  try {
    const state = await webLogin(browser)
    const list = require('./web-scenarios')(REPO)
    const sizes = [{ tag: 'web', w: 1366, h: 860 }, { tag: 'web-390', w: 390, h: 844 }]
    for (const size of sizes) {
      const dir = path.join(OUT, size.tag)
      fs.mkdirSync(dir, { recursive: true })
      for (const sc of list) {
        if (FILTER && sc.name.indexOf(FILTER) === -1) continue
        const issues = await shootWeb(browser, state, sc, size, dir)
        report.push({ group: size.tag, name: sc.name, shot: path.relative(OUT, path.join(dir, sc.name + '.png')), issues })
        console.log(size.tag, sc.name, issues.length ? issues.length + ' 个问题' : 'ok')
      }
    }
  } finally {
    server.kill()
  }
}

function allowed(group, name, issue) {
  return ALLOW.some((a) => (a.page === '*' || a.page === name || a.page === group + '/' + name) && a.rule === issue.rule && (!a.text || issue.text.indexOf(a.text) !== -1))
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const browser = await chromium.launch()
  const report = []
  try {
    if (!ONLY || ONLY === 'mp') await runMp(browser, report)
    if (!ONLY || ONLY === 'web') await runWeb(browser, report)
  } finally {
    await browser.close()
  }
  let bad = 0
  const lines = ['# 界面检查报告', '', '规则见 docs/UI规范.md。截图在同目录下。', '']
  report.forEach((r) => {
    r.issues = r.issues.filter((i) => !allowed(r.group, r.name, i))
    if (!r.issues.length) return
    bad += r.issues.length
    lines.push('## ' + r.group + ' / ' + r.name + '（' + r.shot + '）')
    r.issues.forEach((i) => lines.push('- ' + (RULES[i.rule] || i.rule) + '：「' + i.text + '」' + (i.detail ? ' ' + i.detail : '')))
    lines.push('')
  })
  lines.splice(3, 0, report.length + ' 个画面，' + (bad ? bad + ' 个问题。' : '没有问题。'), '')
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2))
  fs.writeFileSync(path.join(OUT, 'report.md'), lines.join('\n'))
  console.log('\n' + report.length + ' 个画面，' + (bad ? bad + ' 个问题，见 ' + path.join(OUT, 'report.md') : '没有问题'))
  process.exit(bad ? 1 : 0)
})().catch((e) => {
  console.error(e)
  process.exit(2)
})
