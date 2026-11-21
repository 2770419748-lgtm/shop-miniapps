// 界面规范的静态检查（docs/UI规范.md）。只看代码，不用开浏览器，npm test 就会跑。
// 这里专门拦「预览里看着正常、到了微信真机才出问题」的写法；渲染出来的排版问题由 npm run ui:check 查。
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const PROGRAMS = ['miniprogram', 'miniprogram-carwash']

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (e.name !== 'node_modules' && e.name !== 'dist' && e.name !== 'dist-mock') walk(p, out)
    } else out.push(p)
  })
  return out
}
const rel = (f) => path.relative(root, f)
const read = (f) => fs.readFileSync(f, 'utf8')

// 把样式拆成一条条规则：{ selector, decls: { 属性: 值 }, line }
function parseCss(src) {
  const clean = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  const rules = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m
  while ((m = re.exec(clean))) {
    const selector = m[1].trim().replace(/^@[^{]*$/, '')
    if (!selector || selector.startsWith('@')) continue
    const decls = {}
    m[2].split(';').forEach((d) => {
      const i = d.indexOf(':')
      if (i > 0) decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim()
    })
    rules.push({ selector, decls, line: clean.slice(0, m.index + m[1].length).split('\n').length })
  }
  return rules
}

function vueStyles(file) {
  const out = []
  const re = /<style[^>]*>([\s\S]*?)<\/style>/g
  let m
  const src = read(file)
  while ((m = re.exec(src))) out.push(m[1])
  return out.join('\n')
}

// 标签：<tag attrs>，返回 { tag, attrs, line }
function tags(src, name) {
  const out = []
  const re = new RegExp('<' + name + '((?:\\s+[^\\s=/>]+(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'))?)*)\\s*/?>', 'g')
  let m
  while ((m = re.exec(src))) {
    const attrs = {}
    const ar = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g
    let a
    while ((a = ar.exec(m[1]))) attrs[a[1]] = a[2] !== undefined ? a[2] : a[3] !== undefined ? a[3] : true
    out.push({ attrs, line: src.slice(0, m.index).split('\n').length })
  }
  return out
}

const staticClasses = (cls) => String(cls || '').replace(/\{\{[\s\S]*?\}\}/g, ' ').split(/\s+/).filter(Boolean)
// 选择器最后一段里带这个 class 吗（.a .img、.img.big 都算）
const targets = (selector, cls) => selector.split(',').some((s) => {
  const last = s.trim().split(/[\s>+~]+/).pop() || ''
  return new RegExp('\\.' + cls.replace(/[-]/g, '\\-') + '(?![\\w-])').test(last)
})

PROGRAMS.forEach((name) => {
  const mp = path.join(root, name)
  if (!fs.existsSync(mp)) return
  const files = walk(mp)
  const wxml = files.filter((f) => f.endsWith('.wxml'))
  const wxss = files.filter((f) => f.endsWith('.wxss'))
  const appRules = parseCss(read(path.join(mp, 'app.wxss')))
  const app = JSON.parse(read(path.join(mp, 'app.json')))
  const tabPages = new Set(((app.tabBar && app.tabBar.list) || []).map((t) => path.join(mp, t.pagePath + '.wxss')))

  test(name + '：横向 scroll-view 不加 enable-flex，要关掉滚动条（规范 2.3）', () => {
    const bad = []
    wxml.forEach((f) => tags(read(f), 'scroll-view').forEach((t) => {
      if (t.attrs['enable-flex'] !== undefined) bad.push(rel(f) + ':' + t.line + ' 有 enable-flex：真机上会把里面的胶囊撑高、文字贴顶，改用 app.wxss 的 .chip-bar 写法')
      if (t.attrs['scroll-x'] !== undefined && (t.attrs.enhanced === undefined || t.attrs['show-scrollbar'] !== '{{false}}')) bad.push(rel(f) + ':' + t.line + ' 横向 scroll-view 要加 enhanced show-scrollbar="{{false}}"')
    }))
    assert.deepEqual(bad, [])
  })

  test(name + '：字号不小于 20rpx（规范 1.2）', () => {
    const bad = []
    wxss.forEach((f) => parseCss(read(f)).forEach((r) => {
      const v = r.decls['font-size']
      if (!v) return
      const rpx = /^(\d+(?:\.\d+)?)rpx$/.exec(v)
      const px = /^(\d+(?:\.\d+)?)px$/.exec(v)
      if ((rpx && +rpx[1] < 20) || (px && +px[1] < 10)) bad.push(rel(f) + ':' + r.line + ' ' + r.selector + ' font-size: ' + v)
    }))
    assert.deepEqual(bad, [])
  })

  test(name + '：不换行又裁掉的文字要有省略号（规范 3.1）', () => {
    const bad = []
    wxss.forEach((f) => parseCss(read(f)).forEach((r) => {
      const d = r.decls
      if (/nowrap/.test(d['white-space'] || '') && /hidden/.test(d.overflow || d['overflow-x'] || '') && !/ellipsis/.test(d['text-overflow'] || '')) {
        bad.push(rel(f) + ':' + r.line + ' ' + r.selector + ' 加 text-overflow: ellipsis')
      }
    }))
    assert.deepEqual(bad, [])
  })

  test(name + '：胶囊、标签、按钮用固定高度，不用上下 padding 撑（规范 2.1）', () => {
    const bad = []
    wxss.forEach((f) => parseCss(read(f)).forEach((r) => {
      if (!/\.(chip|tag|pill|badge|btn[\w-]*)(?![\w-])/.test(r.selector.split(',').map((s) => s.trim().split(/\s+/).pop()).join(' '))) return
      const p = r.decls.padding
      const vertical = p ? p.split(/\s+/)[0] : ''
      const top = r.decls['padding-top'] || ''
      const bottom = r.decls['padding-bottom'] || ''
      const pads = [vertical, top, bottom].some((v) => v && !/^0(rpx|px)?$/.test(v))
      if (pads && !r.decls.height) bad.push(rel(f) + ':' + r.line + ' ' + r.selector + ' 有上下 padding 没写 height（padding: ' + (p || top + ' ' + bottom) + '）')
    }))
    assert.deepEqual(bad, [])
  })

  test(name + '：底部固定的条要让出 iPhone 底部安全区（规范 4.2）', () => {
    const bad = []
    // tabBar 页面下面是微信的底栏，底栏自己让出了安全区
    wxss.filter((f) => !tabPages.has(f)).forEach((f) => parseCss(read(f)).forEach((r) => {
      const d = r.decls
      if (d.position !== 'fixed' || d.bottom === undefined) return
      if (d.top !== undefined) return // 全屏遮罩
      const all = Object.values(d).join(' ')
      if (!/safe-area-inset-bottom/.test(all) && !/^(\d{3,}|[2-9]\d\d)rpx/.test(d.bottom)) bad.push(rel(f) + ':' + r.line + ' ' + r.selector + ' 是底部固定的，padding-bottom 或 bottom 里要带 env(safe-area-inset-bottom)')
    }))
    assert.deepEqual(bad, [])
  })

  test(name + '：<image> 都写了宽和高（规范 5.1，不写时微信默认 320×240）', () => {
    const bad = []
    wxml.forEach((f) => {
      const page = f.replace(/\.wxml$/, '.wxss')
      const rules = appRules.concat(fs.existsSync(page) ? parseCss(read(page)) : [])
      tags(read(f), 'image').forEach((t) => {
        const cls = staticClasses(t.attrs.class)
        const style = String(t.attrs.style || '')
        const has = (prop) => new RegExp('(^|;|\\s)' + prop + '\\s*:').test(style) || rules.some((r) => r.decls[prop] && cls.some((c) => targets(r.selector, c)))
        const mode = String(t.attrs.mode || '')
        const needW = mode !== 'heightFix'
        const needH = mode !== 'widthFix'
        if ((needW && !has('width')) || (needH && !has('height'))) bad.push(rel(f) + ':' + t.line + ' <image class="' + (t.attrs.class || '') + '"> 没写' + (needW && !has('width') ? '宽' : '') + (needH && !has('height') ? '高' : ''))
      })
    })
    assert.deepEqual(bad, [])
  })

  test(name + '：<textarea> 写了宽度（规范 5.2，不写时微信默认 300px 宽）', () => {
    const bad = []
    const globalTextarea = appRules.some((r) => /(^|[\s,])textarea(?![\w-])/.test(r.selector) && r.decls.width)
    wxml.forEach((f) => {
      const page = f.replace(/\.wxml$/, '.wxss')
      const rules = appRules.concat(fs.existsSync(page) ? parseCss(read(page)) : [])
      tags(read(f), 'textarea').forEach((t) => {
        const cls = staticClasses(t.attrs.class)
        const ok = globalTextarea || /width\s*:/.test(String(t.attrs.style || '')) || rules.some((r) => r.decls.width && cls.some((c) => targets(r.selector, c)))
        if (!ok) bad.push(rel(f) + ':' + t.line + ' <textarea class="' + (t.attrs.class || '') + '"> 没写宽度')
      })
    })
    assert.deepEqual(bad, [])
  })
})

// 电脑网页后台
const web = path.join(root, 'admin-web/src')
const webFiles = walk(web).filter((f) => f.endsWith('.vue') || f.endsWith('.css'))
const webCss = (f) => (f.endsWith('.vue') ? vueStyles(f) : read(f))

test('网页后台：字号不小于 12px（规范 1.2）', () => {
  const bad = []
  webFiles.forEach((f) => parseCss(webCss(f)).forEach((r) => {
    const px = /^(\d+(?:\.\d+)?)px$/.exec(r.decls['font-size'] || '')
    if (px && +px[1] < 12) bad.push(rel(f) + ' ' + r.selector + ' font-size: ' + r.decls['font-size'])
  }))
  assert.deepEqual(bad, [])
})

test('网页后台：不换行又裁掉的文字要有省略号（规范 3.1）', () => {
  const bad = []
  webFiles.forEach((f) => parseCss(webCss(f)).forEach((r) => {
    const d = r.decls
    if (/nowrap/.test(d['white-space'] || '') && /hidden/.test(d.overflow || d['overflow-x'] || '') && !/ellipsis/.test(d['text-overflow'] || '')) {
      bad.push(rel(f) + ' ' + r.selector + ' 加 text-overflow: ellipsis')
    }
  }))
  assert.deepEqual(bad, [])
})

test('网页后台：弹窗、抽屉在手机上不超出屏幕（规范 6.2）', () => {
  const css = read(path.join(web, 'style.css'))
  assert.match(css, /\.el-dialog\s*\{[^}]*width:\s*9\dvw/, 'style.css 的手机样式里要把 .el-dialog 宽度限制在屏幕内')
  assert.match(css, /\.el-drawer[^{]*\{[^}]*(width|max-width):\s*(100|9\d)vw/, 'style.css 的手机样式里要把 .el-drawer 宽度限制在屏幕内')
})

test('UI 规范文档存在，CLAUDE.md 指向它', () => {
  assert.ok(fs.existsSync(path.join(root, 'docs/UI规范.md')))
  assert.match(read(path.join(root, 'CLAUDE.md')), /docs\/UI规范\.md/)
})
