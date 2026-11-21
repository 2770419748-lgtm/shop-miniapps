// 在浏览器里跑小程序页面：执行页面 JS（假的 wx），把 WXML 渲染成 DOM，WXSS 的 rpx 换成 px。只为看排版，不求完全一样。
(async function () {
  const Q = new URLSearchParams(location.search)
  const PAGE = Q.get('page') || 'pages/index/index'
  const USER = Q.get('user') || 'C1'
  const W = +Q.get('w') || 390
  const H = +Q.get('h') || 844
  const SAFE = Q.has('safe') ? +Q.get('safe') : 34
  const STATUS = Q.has('status') ? +Q.get('status') : (SAFE ? 47 : 20)
  const NAV = 44
  const query = Object.fromEntries(new URLSearchParams(Q.get('q') || ''))
  const RPX = W / 750
  const state = (window.__state = { pending: 0, dirty: false, errors: [], nav: [], toasts: [], ready: false })
  window.addEventListener('error', (e) => state.errors.push(String(e.message)))
  window.addEventListener('unhandledrejection', (e) => state.errors.push('unhandled: ' + (e.reason && (e.reason.message || e.reason.errMsg) || e.reason)))

  const files = await (await fetch('/bundle.json')).json()
  const appJson = JSON.parse(files['app.json'])
  const pageJson = files[PAGE + '.json'] ? JSON.parse(files[PAGE + '.json']) : {}
  const win = Object.assign({}, appJson.window, pageJson)
  const tabBar = appJson.tabBar || { list: [] }
  const isTab = tabBar.list.some((t) => t.pagePath === PAGE)
  const TAB_H = isTab ? 49 + SAFE : 0
  const custom = win.navigationStyle === 'custom'
  const TOP = custom ? 0 : STATUS + NAV
  const CONTENT_H = H - TOP - TAB_H

  // ---------- 手机外壳 ----------
  const $ = (id) => document.getElementById(id)
  const phone = $('phone')
  phone.style.width = W + 'px'
  phone.style.height = H + 'px'
  const fg = win.navigationBarTextStyle === 'black' ? '#000' : '#fff'
  const status = $('status')
  status.style.height = STATUS + 'px'
  status.style.color = fg
  status.style.background = custom ? 'transparent' : win.navigationBarBackgroundColor
  status.style.zIndex = 5
  const nav = $('nav')
  nav.style.top = STATUS + 'px'
  nav.style.height = NAV + 'px'
  nav.style.color = fg
  nav.style.background = win.navigationBarBackgroundColor
  if (custom) nav.style.background = 'transparent'
  nav.style.zIndex = 5
  $('title').textContent = custom ? '' : (win.navigationBarTitleText || '')
  if (!isTab && !custom) nav.querySelector('.back').style.display = ''
  if (!SAFE) $('home-ind').style.display = 'none'
  const frame = $('frame')
  frame.style.top = TOP + 'px'
  frame.style.width = W + 'px'
  frame.style.height = CONTENT_H + 'px'
  if (isTab) {
    const tb = $('tabbar')
    tb.style.display = 'flex'
    tb.style.height = TAB_H + 'px'
    tb.style.paddingBottom = SAFE + 'px'
    tb.style.background = tabBar.backgroundColor || '#fff'
    tb.style.borderTopColor = tabBar.borderStyle === 'white' ? 'rgba(255,255,255,0.33)' : 'rgba(0,0,0,0.33)'
    tabBar.list.forEach((t) => {
      const on = t.pagePath === PAGE
      const d = document.createElement('div')
      d.className = 'tab'
      d.style.color = on ? tabBar.selectedColor : tabBar.color
      d.innerHTML = '<img src="/mp/' + (on ? t.selectedIconPath : t.iconPath) + '"><span>' + t.text + '</span>'
      tb.appendChild(d)
    })
  }

  // ---------- 弹窗（模拟原生 toast / modal / actionSheet） ----------
  const overlay = $('overlay')
  let toastEl = null
  let toastTimer = null
  function showToast(text, ms) {
    hideToast()
    toastEl = document.createElement('div')
    toastEl.className = 'toast'
    toastEl.textContent = text
    overlay.appendChild(toastEl)
    state.toasts.push(text)
    if (ms) toastTimer = setTimeout(hideToast, ms)
  }
  function hideToast() {
    clearTimeout(toastTimer)
    if (toastEl) toastEl.remove()
    toastEl = null
  }

  // ---------- 回调工具 ----------
  function done(opts, ok, res) {
    opts = opts || {}
    setTimeout(() => {
      try {
        if (ok && opts.success) opts.success(res)
        if (!ok && opts.fail) opts.fail(res)
        if (opts.complete) opts.complete(res)
      } catch (e) {
        state.errors.push(String(e && e.stack || e))
        console.error(e)
      }
    }, 0)
    if (!opts.success && !opts.fail && !opts.complete) return ok ? Promise.resolve(res) : Promise.reject(res)
  }
  const storeKey = (k) => 'mp:' + USER + ':' + k

  const wxImpl = {
    request(o) {
      state.pending++
      fetch(o.url, { method: o.method || 'GET', headers: o.header || {}, body: o.method === 'POST' ? JSON.stringify(o.data || {}) : undefined })
        .then(async (r) => {
          const text = await r.text()
          let data = text
          try { data = JSON.parse(text) } catch (e) {}
          done(o, true, { statusCode: r.status, data })
        })
        .catch((e) => done(o, false, { errMsg: 'request:fail ' + e.message }))
        .finally(() => setTimeout(() => state.pending--, 0))
    },
    login: (o) => done(o, true, { code: USER, errMsg: 'login:ok' }),
    getStorageSync(k) {
      const v = localStorage.getItem(storeKey(k))
      return v === null ? '' : JSON.parse(v)
    },
    setStorageSync: (k, v) => localStorage.setItem(storeKey(k), JSON.stringify(v)),
    removeStorageSync: (k) => localStorage.removeItem(storeKey(k)),
    clearStorageSync: () => {},
    showToast(o) {
      showToast(o.title, o.duration || 1500)
      return done(o, true, {})
    },
    hideToast: () => hideToast(),
    showLoading(o) {
      showToast('⟳ ' + (o.title || ''), 0)
      return done(o, true, {})
    },
    hideLoading: () => hideToast(),
    showModal(o) {
      const mask = document.createElement('div')
      mask.className = 'modal-mask'
      mask.innerHTML = '<div class="modal">' + (o.title ? '<div class="t"></div>' : '') + '<div class="c"></div>' +
        (o.editable ? '<input style="margin:0 20px 20px;width:calc(100% - 40px);box-sizing:border-box">' : '') +
        '<div class="b">' + (o.showCancel === false ? '' : '<div class="cancel"></div>') + '<div class="ok" style="color:#d6b25e"></div></div></div>'
      if (o.title) mask.querySelector('.t').textContent = o.title
      mask.querySelector('.c').textContent = o.content || ''
      if (o.showCancel !== false) mask.querySelector('.cancel').textContent = o.cancelText || '取消'
      mask.querySelector('.ok').textContent = o.confirmText || '确定'
      overlay.appendChild(mask)
      state.toasts.push('modal: ' + (o.title || '') + ' / ' + (o.content || ''))
      return new Promise((resolve) => {
        const finish = (confirm) => {
          const input = mask.querySelector('input')
          mask.remove()
          const res = { confirm, cancel: !confirm, content: input ? input.value : '' }
          if (o.success) o.success(res)
          if (o.complete) o.complete(res)
          resolve(res)
        }
        mask.querySelector('.ok').onclick = () => finish(true)
        if (o.showCancel !== false) mask.querySelector('.cancel').onclick = () => finish(false)
      })
    },
    showActionSheet(o) {
      const mask = document.createElement('div')
      mask.className = 'modal-mask'
      mask.style.alignItems = 'flex-end'
      const sheet = document.createElement('div')
      sheet.className = 'sheet'
      ;(o.itemList || []).concat(['取消']).forEach((t, i, all) => {
        const d = document.createElement('div')
        d.textContent = t
        d.onclick = () => {
          mask.remove()
          if (i === all.length - 1) done(o, false, { errMsg: 'showActionSheet:fail cancel' })
          else done(o, true, { tapIndex: i })
        }
        sheet.appendChild(d)
      })
      mask.appendChild(sheet)
      overlay.appendChild(mask)
    },
    navigateTo: (o) => { state.nav.push(['navigateTo', o.url]); return done(o, true, {}) },
    redirectTo: (o) => { state.nav.push(['redirectTo', o.url]); return done(o, true, {}) },
    switchTab: (o) => { state.nav.push(['switchTab', o.url]); return done(o, true, {}) },
    reLaunch: (o) => { state.nav.push(['reLaunch', o.url]); return done(o, true, {}) },
    navigateBack: (o) => { state.nav.push(['navigateBack', '']); return done(o, true, {}) },
    setNavigationBarTitle: (o) => { $('title').textContent = o.title; return done(o, true, {}) },
    stopPullDownRefresh: () => {},
    startPullDownRefresh: () => {},
    getAccountInfoSync: () => ({ miniProgram: { appId: 'wx8310059ba8f45927', envVersion: 'develop', version: '' } }),
    getSystemInfoSync: () => sysInfo(),
    getWindowInfo: () => sysInfo(),
    getDeviceInfo: () => sysInfo(),
    getAppBaseInfo: () => sysInfo(),
    getMenuButtonBoundingClientRect: () => ({ width: 87, height: 32, top: STATUS + 6, bottom: STATUS + 38, left: W - 94, right: W - 7 }),
    nextTick: (fn) => setTimeout(fn, 0),
    createInnerAudioContext: () => ({ play() {}, stop() {}, pause() {}, destroy() {}, onError() {}, onEnded() {}, src: '' }),
    setClipboardData: (o) => done(o, true, {}),
    makePhoneCall: (o) => done(o, true, {}),
    vibrateLong: (o) => done(o, true, {}),
    vibrateShort: (o) => done(o, true, {}),
    setKeepScreenOn: (o) => done(o, true, {}),
    requestSubscribeMessage: (o) => done(o, true, {}),
    pageScrollTo: (o) => { if (doc) doc.scrollingElement.scrollTop = o.scrollTop || 0; return done(o, true, {}) }
  }
  function sysInfo() {
    return { windowWidth: W, windowHeight: CONTENT_H, screenWidth: W, screenHeight: H, statusBarHeight: STATUS, pixelRatio: 3, platform: 'ios', system: 'iOS 17', SDKVersion: '3.6.0', safeArea: { top: STATUS, bottom: H - SAFE, left: 0, right: W, width: W, height: H - SAFE - STATUS } }
  }
  const wx = new Proxy(wxImpl, {
    get(t, k) {
      if (k in t) return t[k]
      return (o) => {
        console.log('wx.' + String(k) + ' (stub)')
        state.nav.push(['stub', String(k)])
        return done(o, false, { errMsg: String(k) + ':fail cancel' })
      }
    }
  })
  window.wx = wx

  // ---------- 模块 ----------
  const modCache = {}
  function resolvePath(fromDir, rel) {
    const parts = rel.startsWith('/') ? [] : fromDir.split('/').filter(Boolean)
    rel.split('/').forEach((seg) => {
      if (seg === '..') parts.pop()
      else if (seg && seg !== '.') parts.push(seg)
    })
    return parts.join('/')
  }
  let appInst = null
  let pageDef = null
  const App = (def) => { appInst = def }
  const Page = (def) => { pageDef = def }
  const Component = (def) => { pageDef = def }
  const Behavior = (d) => d
  const getApp = () => appInst
  let inst = null
  const getCurrentPages = () => [inst]
  function req(fromDir, rel) {
    let p = resolvePath(fromDir, rel)
    if (files[p] === undefined && files[p + '.js'] !== undefined) p += '.js'
    if (modCache[p]) return modCache[p].exports
    if (p === 'config.js') {
      modCache[p] = { exports: { apiBase: location.origin, testApiBase: location.origin, shopName: '进山咖啡', webAdminUrl: '' } }
      return modCache[p].exports
    }
    if (files[p] === undefined) throw new Error('module not found: ' + p + ' (from ' + fromDir + ')')
    if (p.endsWith('.json')) return JSON.parse(files[p])
    const module = { exports: {} }
    modCache[p] = module
    const dir = p.split('/').slice(0, -1).join('/')
    const fn = new Function('module', 'exports', 'require', 'wx', 'getApp', 'Page', 'App', 'Component', 'Behavior', 'getCurrentPages', files[p] + '\n//# sourceURL=mp/' + p)
    fn(module, module.exports, (r) => req(dir, r), wx, getApp, Page, App, Component, Behavior, getCurrentPages)
    return module.exports
  }
  const wxsCache = {}
  function loadWxs(path, code) {
    if (wxsCache[path]) return wxsCache[path].exports
    const module = { exports: {} }
    wxsCache[path] = module
    const dir = path.split('/').slice(0, -1).join('/')
    const getDate = (...a) => (a.length ? new Date(...a) : new Date())
    const getRegExp = (p, f) => new RegExp(p, f)
    new Function('module', 'exports', 'require', 'getDate', 'getRegExp', code)(module, module.exports, (r) => loadWxs(resolvePath(dir, r), files[resolvePath(dir, r)]), getDate, getRegExp)
    return module.exports
  }

  // ---------- WXSS ----------
  const TAGS = ['scroll-view', 'swiper-item', 'swiper', 'view', 'text', 'image', 'input', 'textarea', 'button', 'picker-view', 'picker', 'switch', 'navigator', 'icon', 'progress', 'checkbox-group', 'checkbox', 'radio-group', 'radio', 'label', 'form', 'slider', 'rich-text']
  const tagRes = TAGS.map((t) => [new RegExp('(^|[\\s>+~(])' + t + '(?=$|[\\s.:#\\[>+~)])', 'g'), '$1wx-' + t])
  function sel(s) {
    s = s.replace(/(^|[\s>+~(])page(?=$|[\s.:#[>+~)])/g, '$1body')
    tagRes.forEach(([re, to]) => { s = s.replace(re, to) })
    return s
  }
  function blocks(css) {
    let out = ''
    let i = 0
    while (i < css.length) {
      const open = css.indexOf('{', i)
      if (open < 0) break
      const head = css.slice(i, open).trim()
      let depth = 1
      let j = open + 1
      while (j < css.length && depth) {
        if (css[j] === '{') depth++
        else if (css[j] === '}') depth--
        j++
      }
      const body = css.slice(open + 1, j - 1)
      if (/^@(media|supports)/.test(head)) out += head + '{' + blocks(body) + '}\n'
      else if (head.startsWith('@')) out += head + '{' + body + '}\n'
      else out += head.split(',').map(sel).join(',') + '{' + body + '}\n'
      i = j
    }
    return out
  }
  function px(n) {
    let v = n * RPX
    if (v > 0 && v < 1) v = 1
    if (v < 0 && v > -1) v = -1
    return +v.toFixed(3) + 'px'
  }
  function convertCss(css) {
    css = css.replace(/\/\*[\s\S]*?\*\//g, '')
    css = css.replace(/@import\s+["']([^"']+)["'];?/g, '')
    css = css.replace(/(-?\d*\.?\d+)rpx/g, (m, n) => px(+n))
    css = css.replace(/(?:env|constant)\(\s*safe-area-inset-bottom\s*\)/g, (isTab ? SAFE : SAFE) + 'px')
    css = css.replace(/(?:env|constant)\(\s*safe-area-inset-top\s*\)/g, (custom ? STATUS : 0) + 'px')
    return blocks(css)
  }
  const convertStyle = (s) => String(s).replace(/(-?\d*\.?\d+)rpx/g, (m, n) => px(+n)).replace(/(?:env|constant)\(\s*safe-area-inset-bottom\s*\)/g, SAFE + 'px')

  // 小程序写的字体（-apple-system / PingFang SC / Helvetica Neue）在 Linux 上都没有，各台机器会落到不同的字体上，
  // 同一页面本机和 GitHub 上量出来的宽高就不一样。这里统一指到文泉驿正黑（playwright install --with-deps 会装）。
  const BASE = `
@font-face { font-family: "-apple-system"; src: local("WenQuanYi Zen Hei"), local("WenQuanYiZenHei"); }
@font-face { font-family: "PingFang SC"; src: local("WenQuanYi Zen Hei"), local("WenQuanYiZenHei"); }
@font-face { font-family: "Helvetica Neue"; src: local("WenQuanYi Zen Hei"), local("WenQuanYiZenHei"); }
html { height: 100%; -webkit-text-size-adjust: 100%; }
body { margin: 0; font-size: 16px; font-family: -apple-system, "PingFang SC", "WenQuanYi Zen Hei", sans-serif; -webkit-font-smoothing: antialiased; }
::-webkit-scrollbar { display: none; width: 0; height: 0; }
wx-view, wx-swiper-item, wx-picker, wx-navigator, wx-label, wx-form { display: block; }
wx-text { display: inline; white-space: pre-line; }
wx-image { display: inline-block; overflow: hidden; position: relative; width: 320px; height: 240px; }
wx-image > img { display: block; width: 100%; height: 100%; }
wx-input { display: block; height: 1.4rem; min-height: 1.4rem; overflow: hidden; text-overflow: clip; white-space: nowrap; cursor: auto; }
wx-input > input { all: unset; display: block; width: 100%; height: 100%; font: inherit; color: inherit; text-align: inherit; letter-spacing: inherit; }
wx-input > input::placeholder, wx-textarea > textarea::placeholder { color: var(--ph, #808080); }
wx-textarea { display: block; width: 300px; height: 150px; position: relative; }
wx-textarea > textarea { all: unset; display: block; width: 100%; height: 100%; font: inherit; color: inherit; white-space: pre-wrap; word-break: break-all; }
wx-textarea[auto-height] { height: auto; }
wx-textarea[auto-height] > textarea { field-sizing: content; height: auto; min-height: 1.5em; }
wx-scroll-view { display: block; }
wx-scroll-view > .svi { display: block; }
wx-scroll-view[enable-flex] > .svi { display: contents; }
wx-swiper { display: block; height: 150px; position: relative; overflow: hidden; }
wx-swiper > wx-swiper-item { position: absolute; left: 0; top: 0; width: 100%; height: 100%; overflow: hidden; }
wx-swiper > .dots { position: absolute; left: 0; right: 0; bottom: 10px; display: flex; justify-content: center; z-index: 2; }
wx-swiper > .dots i { width: 8px; height: 8px; border-radius: 4px; margin: 0 4px; }
wx-switch { display: inline-block; vertical-align: middle; }
wx-switch .sw { display: block; position: relative; width: 52px; height: 32px; border-radius: 16px; background: #dfdfdf; }
wx-switch .sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 28px; height: 28px; border-radius: 14px; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
wx-switch .sw.on::after { left: 22px; }
wx-switch[disabled] { opacity: 0.6; }
[wx-hidden] { display: none !important; }
`
  // ---------- WXML 解析 ----------
  function parseWxml(src) {
    const root = { tag: '#root', attrs: {}, children: [] }
    const stack = [root]
    const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w-]*)\s*>|<([a-zA-Z][\w-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'))?)*)\s*(\/?)>/g
    let last = 0
    let m
    const text = (t) => {
      if (!t) return
      if (/^\s*$/.test(t)) return
      const cur = stack[stack.length - 1]
      if (cur.tag === 'wxs') { cur.code = (cur.code || '') + t; return }
      cur.children.push({ text: t.replace(/\s*\n\s*/g, '') })
    }
    while ((m = re.exec(src))) {
      text(src.slice(last, m.index))
      last = re.lastIndex
      if (m[0].startsWith('<!--')) continue
      if (m[1]) {
        const name = m[1]
        for (let k = stack.length - 1; k > 0; k--) {
          if (stack[k].tag === name) { stack.length = k; break }
        }
        continue
      }
      const node = { tag: m[2], attrs: {}, children: [] }
      const ar = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g
      let a
      while ((a = ar.exec(m[3] || ''))) node.attrs[a[1]] = a[2] !== undefined ? a[2] : (a[3] !== undefined ? a[3] : true)
      stack[stack.length - 1].children.push(node)
      if (!m[4]) stack.push(node)
    }
    text(src.slice(last))
    return root
  }

  // ---------- 表达式 ----------
  const exprCache = new Map()
  function evalExpr(expr, scope) {
    let fn = exprCache.get(expr)
    if (!fn) {
      try {
        fn = new Function('__s', 'with(__s){return (' + expr + ')}')
      } catch (e) {
        console.warn('bad expr', expr)
        state.errors.push('bad expr: ' + expr)
        fn = () => undefined
      }
      exprCache.set(expr, fn)
    }
    try {
      return fn(new Proxy(scope, { has: (t, k) => typeof k === 'string', get: (t, k) => (k === Symbol.unscopables ? undefined : t[k]) }))
    } catch (e) {
      return undefined
    }
  }
  const str = (v) => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v))
  function interp(s, scope) {
    if (typeof s !== 'string') return s
    const n = s.split('{{').length - 1
    if (n === 0) return s
    const m = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(s)
    if (n === 1 && m) return evalExpr(m[1], scope)
    return s.replace(/\{\{([\s\S]*?)\}\}/g, (_, e) => str(evalExpr(e, scope)))
  }
  const decode = (t) => t.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  const child = (vars, parent) => Object.assign(Object.create(parent), vars)

  // ---------- 渲染 ----------
  let doc = null
  let tree = null
  let pageDir = ''
  const phColors = {}
  function phColor(cls) {
    if (phColors[cls] !== undefined) return phColors[cls]
    let c = ''
    for (const sh of doc.styleSheets) {
      for (const r of sh.cssRules) if (r.selectorText && r.selectorText.split(',').map((x) => x.trim()).indexOf('.' + cls) !== -1 && r.style.color) c = r.style.color
    }
    phColors[cls] = c
    return c
  }
  function mapSrc(src) {
    if (!src) return ''
    if (/^(https?:|data:|blob:)/.test(src)) return src
    if (src.startsWith('/')) return '/mp' + src
    return '/mp/' + resolvePath(pageDir, src)
  }
  function wxEl(el) {
    while (el && !(el.tagName && el.tagName.toLowerCase().startsWith('wx-'))) el = el.parentNode
    return el
  }
  function fire(el, name, detail, type, domEvent) {
    const handler = inst[name]
    if (typeof handler !== 'function') {
      if (name) state.errors.push('no handler ' + name)
      return
    }
    const target = wxEl(domEvent && domEvent.target) || el
    const ev = {
      type,
      timeStamp: Date.now(),
      target: { id: target.id, dataset: target.__dataset || {} },
      currentTarget: { id: el.id, dataset: el.__dataset || {} },
      detail: detail || {},
      mark: {}
    }
    try {
      return handler.call(inst, ev)
    } catch (e) {
      state.errors.push('handler ' + name + ': ' + (e && e.stack || e))
      console.error(e)
    }
  }
  function renderNodes(nodes, scope, parent) {
    let chain = null // null 不在 if 链里；true 前面已经命中；false 还没命中
    for (const node of nodes) {
      if (node.text !== undefined) {
        chain = null
        const t = decode(interp(node.text, scope) + '')
        if (t) parent.appendChild(doc.createTextNode(t))
        continue
      }
      const a = node.attrs
      if (a['wx:for'] !== undefined || a['wx:for-items'] !== undefined) {
        chain = null
        let list = interp(a['wx:for'] !== undefined ? a['wx:for'] : a['wx:for-items'], scope)
        const itemName = a['wx:for-item'] || 'item'
        const indexName = a['wx:for-index'] || 'index'
        let entries = []
        if (Array.isArray(list)) entries = list.map((v, i) => [v, i])
        else if (typeof list === 'number') entries = Array.from({ length: list }, (_, i) => [i, i])
        else if (typeof list === 'string') entries = list.split('').map((v, i) => [v, i])
        else if (list && typeof list === 'object') entries = Object.keys(list).map((k) => [list[k], k])
        entries.forEach(([v, i]) => {
          const s = child({ [itemName]: v, [indexName]: i }, scope)
          if (a['wx:if'] !== undefined && !interp(a['wx:if'], s)) return
          renderOne(node, s, parent)
        })
        continue
      }
      if (a['wx:if'] !== undefined) {
        chain = !!interp(a['wx:if'], scope)
        if (!chain) continue
      } else if (a['wx:elif'] !== undefined) {
        if (chain !== false) continue
        chain = !!interp(a['wx:elif'], scope)
        if (!chain) continue
      } else if (a['wx:else'] !== undefined) {
        const skip = chain !== false
        chain = null
        if (skip) continue
      } else {
        chain = null
      }
      renderOne(node, scope, parent)
    }
  }
  function renderOne(node, scope, parent) {
    const tag = node.tag
    if (tag === 'block') return renderNodes(node.children, scope, parent)
    if (tag === 'wxs' || tag === 'import' || tag === 'include' || tag === 'template') return
    const el = doc.createElement('wx-' + tag)
    const a = node.attrs
    const ds = {}
    const props = {}
    Object.keys(a).forEach((k) => {
      if (k.startsWith('wx:')) return
      const v = interp(a[k], scope)
      if (k.startsWith('data-')) {
        const key = k.slice(5).toLowerCase().replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        ds[key] = v === true && a[k] === true ? true : v
        return
      }
      const ev = /^(bind|catch|capture-bind|capture-catch|mut-bind):?(.+)$/.exec(k)
      if (ev) {
        props['on:' + ev[2]] = { name: str(v), stop: ev[1].indexOf('catch') !== -1 }
        return
      }
      props[k] = v
    })
    el.__dataset = ds
    if (props.class !== undefined && props.class !== true) el.className = str(props.class)
    if (props.style) el.setAttribute('style', convertStyle(str(props.style)))
    if (props.id) el.id = str(props.id)
    if (props.hidden !== undefined && props.hidden !== false && props.hidden !== '' && props.hidden !== 'false') el.setAttribute('wx-hidden', '')
    const on = (type, domType, detailFn) => {
      const h = props['on:' + type]
      if (!h) return
      el.addEventListener(domType, (e) => {
        if (h.stop) e.stopPropagation()
        fire(el, h.name, detailFn ? detailFn(e) : {}, type, e)
      })
    }
    on('tap', 'click', (e) => ({ x: e.clientX, y: e.clientY }))
    on('longpress', 'contextmenu')
    on('longtap', 'contextmenu')

    if (tag === 'image') {
      const img = doc.createElement('img')
      const src = mapSrc(str(props.src || ''))
      if (src) img.src = src
      else img.style.visibility = 'hidden'
      const mode = props.mode || 'scaleToFill'
      img.style.objectFit = { scaleToFill: 'fill', aspectFit: 'contain', aspectFill: 'cover' }[mode] || 'fill'
      if (mode === 'widthFix') { el.style.height = 'auto'; img.style.height = 'auto' }
      if (mode === 'heightFix') { el.style.width = 'auto'; img.style.width = 'auto' }
      on('load', 'load')
      on('error', 'error')
      el.appendChild(img)
    } else if (tag === 'input' || tag === 'textarea') {
      const inp = doc.createElement(tag === 'input' ? 'input' : 'textarea')
      if (props.value !== undefined && props.value !== true) inp.value = str(props.value)
      if (props.placeholder) inp.placeholder = str(props.placeholder)
      if (props.password || props.type === 'safe-password') inp.type = 'password'
      if (props.disabled && props.disabled !== 'false') inp.disabled = true
      if (props['auto-height']) el.setAttribute('auto-height', '')
      const phc = props['placeholder-class'] && phColor(str(props['placeholder-class']).split(' ')[0])
      const phs = props['placeholder-style'] && /color\s*:\s*([^;]+)/.exec(str(props['placeholder-style']))
      if (phs) el.style.setProperty('--ph', phs[1])
      else if (phc) el.style.setProperty('--ph', phc)
      el.appendChild(inp)
      const h = (type, domType, detailFn) => {
        const hh = props['on:' + type]
        if (!hh) return
        inp.addEventListener(domType, (e) => {
          if (domType === 'keydown' && e.key !== 'Enter') return
          const r = fire(el, hh.name, detailFn(e), type, e)
          if (type === 'input' && typeof r === 'string') inp.value = r
        })
      }
      const val = () => ({ value: inp.value })
      h('input', 'input', val)
      h('blur', 'blur', val)
      h('focus', 'focus', val)
      h('confirm', 'keydown', val)
      h('change', 'change', val)
    } else if (tag === 'switch') {
      const sw = doc.createElement('span')
      let checked = !!props.checked && props.checked !== 'false'
      sw.className = 'sw' + (checked ? ' on' : '')
      const color = str(props.color || '#04BE02')
      if (checked) sw.style.background = color
      if (props.disabled) el.setAttribute('disabled', '')
      el.appendChild(sw)
      const hc = props['on:change']
      el.addEventListener('click', (e) => {
        if (props.disabled) return
        checked = !checked
        sw.className = 'sw' + (checked ? ' on' : '')
        sw.style.background = checked ? color : ''
        if (hc) fire(el, hc.name, { value: checked }, 'change', e)
      })
    } else if (tag === 'scroll-view') {
      if (props['scroll-x']) { el.style.overflowX = 'auto'; el.style.overflowY = props['scroll-y'] ? 'auto' : 'hidden' }
      else if (props['scroll-y']) { el.style.overflowY = 'auto'; el.style.overflowX = 'hidden' }
      if (props['enable-flex']) el.setAttribute('enable-flex', '')
      const hs = props['on:scroll']
      if (hs) el.addEventListener('scroll', (e) => fire(el, hs.name, { scrollLeft: el.scrollLeft, scrollTop: el.scrollTop, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight }, 'scroll', e))
      const inner = doc.createElement('div')
      inner.className = 'svi'
      el.appendChild(inner)
      renderNodes(node.children, scope, inner)
      if (props['scroll-into-view']) el.__into = str(props['scroll-into-view'])
      return parent.appendChild(el)
    } else if (tag === 'picker') {
      const hc = props['on:change']
      el.__picker = { mode: props.mode || 'selector', range: props.range, key: props['range-key'] }
      if (hc) el.addEventListener('click', () => state.nav.push(['picker', hc.name]))
    }
    renderNodes(node.children, scope, el)
    if (tag === 'swiper') {
      const items = Array.from(el.children).filter((c) => c.tagName.toLowerCase() === 'wx-swiper-item')
      const cur = +props.current || 0
      items.forEach((it, i) => { if (i !== cur) it.style.display = 'none' })
      if (props['indicator-dots']) {
        const dots = doc.createElement('div')
        dots.className = 'dots'
        items.forEach((it, i) => {
          const d = doc.createElement('i')
          d.style.background = i === cur ? str(props['indicator-active-color'] || '#000') : str(props['indicator-color'] || 'rgba(0,0,0,.3)')
          dots.appendChild(d)
        })
        el.appendChild(dots)
      }
    }
    parent.appendChild(el)
  }
  let wxsScope = {}
  function render() {
    state.dirty = false
    const body = doc.body
    const sc = doc.scrollingElement.scrollTop
    const svs = Array.from(body.querySelectorAll('wx-scroll-view')).map((s) => [s.scrollTop, s.scrollLeft])
    const frag = doc.createDocumentFragment()
    renderNodes(tree.children, child(inst.data, wxsScope), frag)
    body.innerHTML = ''
    body.appendChild(frag)
    const nsv = Array.from(body.querySelectorAll('wx-scroll-view'))
    if (nsv.length === svs.length) nsv.forEach((s, i) => { s.scrollTop = svs[i][0]; s.scrollLeft = svs[i][1] })
    nsv.forEach((s) => {
      if (!s.__into) return
      const t = doc.getElementById(s.__into)
      if (t && s.__lastInto !== s.__into) s.scrollTop += t.getBoundingClientRect().top - s.getBoundingClientRect().top
    })
    doc.scrollingElement.scrollTop = sc
  }
  function schedule() {
    if (state.dirty) return
    state.dirty = true
    setTimeout(render, 0)
  }
  function setPath(obj, path, val) {
    const keys = []
    path.replace(/[^.[\]]+|\[(\d+)\]/g, (m, idx) => { keys.push(idx !== undefined ? +idx : m) })
    let o = obj
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i]
      if (o[k] == null || typeof o[k] !== 'object') o[k] = typeof keys[i + 1] === 'number' ? [] : {}
      o = o[k]
    }
    o[keys[keys.length - 1]] = val
  }
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)))

  // ---------- 启动 ----------
  req('', 'app.js')
  if (appInst) {
    try {
      if (appInst.onLaunch) appInst.onLaunch({ path: PAGE, query, scene: 1001 })
      if (appInst.onShow) appInst.onShow({ path: PAGE, query, scene: 1001 })
    } catch (e) { state.errors.push('app: ' + e) }
  }
  pageDir = PAGE.split('/').slice(0, -1).join('/')
  req('', PAGE + '.js')
  tree = parseWxml(files[PAGE + '.wxml'] || '')
  ;(function collect(n) {
    if (n.tag === 'wxs' && n.attrs.module) {
      const p = n.attrs.src ? resolvePath(pageDir, n.attrs.src) : PAGE + '#' + n.attrs.module
      wxsScope[n.attrs.module] = loadWxs(p, n.attrs.src ? files[p] : n.code || '')
    }
    ;(n.children || []).forEach(collect)
  })(tree)

  doc = frame.contentDocument
  doc.open()
  doc.write('<!doctype html><html><head><meta charset="utf-8"><style>' + BASE + '</style><style>' + convertCss(files['app.wxss'] || '') + '</style><style>' + convertCss(files[PAGE + '.wxss'] || '') + '</style></head><body></body></html>')
  doc.close()

  inst = {}
  Object.keys(pageDef).forEach((k) => {
    if (k !== 'data') inst[k] = pageDef[k]
  })
  if (pageDef.methods) Object.assign(inst, pageDef.methods)
  inst.data = clone(pageDef.data || {})
  inst.route = PAGE
  inst.options = query
  inst.setData = function (obj, cb) {
    Object.keys(obj || {}).forEach((k) => {
      if (obj[k] === undefined) return
      setPath(this.data, k, clone(obj[k]))
    })
    schedule()
    if (cb) setTimeout(cb, 0)
  }
  window.__page = inst
  try {
    if (inst.onLoad) inst.onLoad(query)
    if (inst.onShow) inst.onShow()
  } catch (e) {
    state.errors.push('lifecycle: ' + (e && e.stack || e))
  }
  render()
  try {
    if (inst.onReady) inst.onReady()
  } catch (e) {
    state.errors.push('onReady: ' + e)
  }
  state.ready = true
})().catch((e) => {
  window.__state = window.__state || {}
  window.__state.fatal = String(e && e.stack || e)
  console.error(e)
})
