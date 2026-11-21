// 在页面里跑的排版检查（小程序预览和网页后台共用）。每条对应 docs/UI规范.md 里的一条规则。
// 用法：const issues = await frame.evaluate(checks.inPage, { kind: 'mp' | 'web' })
// 返回 [{ rule, text, detail }]，rule 是下面这些：
//   overflow    内容超出屏幕宽，页面能被横着拖动（规范 1.3）
//   wrap        8 个字以内的短文字被挤成两行，比如标签一字一行（规范 3.2）
//   off-center  按钮、标签、胶囊里的文字没有上下居中（规范 2.1）
//   clipped     文字被硬切掉一截，又没有省略号（规范 3.1）
//   inset       横向滑动区没通到屏幕边，滑到一半的内容在页边距处被切一刀（规范 2.3）
//   covered     滑到底以后，内容还被底部固定的按钮条/悬浮按钮挡着（规范 4.1）
//   tiny        字太小（小程序小于 20rpx，网页小于 12px）（规范 1.2）

function inPage(opts) {
  const kind = opts.kind
  const W = document.documentElement.clientWidth
  const H = window.innerHeight
  const out = []
  const seen = new Set()
  const label = (el) => {
    const t = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ')
    return t.slice(0, 24) || ((el.className && el.className.baseVal === undefined ? el.className : '') || el.tagName.toLowerCase())
  }
  const add = (rule, el, detail) => {
    const key = rule + '|' + label(el)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ rule, text: label(el), detail: detail || '' })
  }
  const visible = (el) => {
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  }
  // 往上找第一个会裁剪/滚动的祖先
  const clipper = (el) => {
    let p = el.parentElement
    while (p && p !== document.body && p !== document.documentElement) {
      const cs = getComputedStyle(p)
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') return p
      p = p.parentElement
    }
    return null
  }
  const textLines = (el) => {
    const range = document.createRange()
    range.selectNodeContents(el)
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0.5 && r.height > 0.5)
    return rects
  }
  const all = Array.from(document.querySelectorAll('body *')).filter((el) => !el.closest('[data-ui-check-skip]'))

  // overflow：超出屏幕宽，且不在会裁剪的容器里
  all.forEach((el) => {
    const r = el.getBoundingClientRect()
    if (!r.width || (r.right <= W + 1 && r.left >= -1)) return
    const cs = getComputedStyle(el)
    if (cs.position === 'fixed' || !visible(el)) return
    if (!clipper(el)) add('overflow', el, Math.round(r.left) + '..' + Math.round(r.right) + 'px，屏幕宽 ' + W)
  })

  // wrap：短文字被挤成多行
  all.forEach((el) => {
    if (el.children.length) return
    const t = (el.textContent || '').trim()
    if (!t || t.length > 8 || !visible(el)) return
    const tops = new Set(textLines(el).map((x) => Math.round(x.top)))
    if (tops.size > 1) add('wrap', el, tops.size + ' 行')
  })

  // off-center：控件里的单行文字上下不居中
  const CONTROL = kind === 'web'
    ? '.el-button, .el-tag, .el-radio-button__inner, .el-checkbox-button__inner, .el-menu-item, .el-tabs__item, .el-segmented__item'
    : '.chip, .tag, [class*="btn"], .tab, .pill, .badge, button, wx-button'
  document.querySelectorAll(CONTROL).forEach((el) => {
    if (el.closest('[data-ui-check-skip]') || !visible(el)) return
    const lines = textLines(el)
    if (!lines.length) return
    const tops = new Set(lines.map((x) => Math.round(x.top)))
    if (tops.size > 1) return
    const r = el.getBoundingClientRect()
    if (r.height < 14) return
    const cs = getComputedStyle(el)
    const top = r.top + parseFloat(cs.borderTopWidth)
    const bottom = r.bottom - parseFloat(cs.borderBottomWidth)
    const box = (top + bottom) / 2
    const tTop = Math.min(...lines.map((x) => x.top))
    const tBottom = Math.max(...lines.map((x) => x.bottom))
    const text = (tTop + tBottom) / 2
    const off = text - box
    if (Math.abs(off) > Math.max(3, (bottom - top) * 0.12)) add('off-center', el, '文字比框中心' + (off < 0 ? '偏上 ' : '偏下 ') + Math.abs(Math.round(off)) + 'px，框高 ' + Math.round(r.height) + 'px')
  })

  // clipped：单行文字被裁掉又没有省略号
  all.forEach((el) => {
    if (!visible(el)) return
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())
    if (!own) return
    const cs = getComputedStyle(el)
    if (cs.overflowX === 'visible' || cs.overflowX === 'auto' || cs.overflowX === 'scroll') return
    if (el.scrollWidth > el.clientWidth + 1 && cs.textOverflow !== 'ellipsis' && cs.whiteSpace.indexOf('nowrap') !== -1) {
      add('clipped', el, '文字宽 ' + el.scrollWidth + 'px，框只有 ' + el.clientWidth + 'px')
    }
  })

  // inset：横向滑动区没贴到屏幕边（只查小程序；网页后台的表格横滑在卡片里是正常的）
  if (kind === 'mp') {
    all.forEach((el) => {
      const cs = getComputedStyle(el)
      if (!(cs.overflowX === 'auto' || cs.overflowX === 'scroll') || !visible(el)) return
      if (el.scrollWidth <= el.clientWidth + 1) return
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) return
      const r = el.getBoundingClientRect()
      if (r.left > 1 || r.right < W - 1) add('inset', el, '滑动区 ' + Math.round(r.left) + '..' + Math.round(r.right) + 'px，屏幕宽 ' + W + '，右边的内容会在页边距处被切断')
    })
  }

  // tiny：字太小
  const MIN = kind === 'web' ? 12 : 20 * W / 750 - 0.05
  all.forEach((el) => {
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())
    if (!own || !visible(el)) return
    const fs = parseFloat(getComputedStyle(el).fontSize)
    if (fs < MIN) add('tiny', el, '字号 ' + fs.toFixed(1) + 'px，最小 ' + MIN.toFixed(1) + 'px')
  })

  return out
}

// covered：把页面和所有竖向滚动区都滑到底，看底部固定的东西有没有压住内容。弹层打开（有全屏遮罩）时不查
function coveredInPage() {
  const W = document.documentElement.clientWidth
  const H = window.innerHeight
  const out = []
  const fixed = Array.from(document.querySelectorAll('body *')).filter((el) => {
    const cs = getComputedStyle(el)
    if (cs.position !== 'fixed' || cs.display === 'none' || cs.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0
  })
  if (fixed.some((el) => { const r = el.getBoundingClientRect(); return r.width >= W * 0.9 && r.height >= H * 0.9 })) return out
  document.scrollingElement.scrollTop = 1e7
  document.querySelectorAll('body *').forEach((el) => {
    const cs = getComputedStyle(el)
    if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 1) el.scrollTop = 1e7
  })
  const bars = fixed.filter((el) => { const r = el.getBoundingClientRect(); return r.top > H * 0.5 && r.height < H * 0.4 })
  if (!bars.length) return out
  const texts = Array.from(document.querySelectorAll('body *')).filter((el) => {
    if (bars.some((b) => b.contains(el))) return false
    if (el.closest('[data-ui-check-skip]')) return false
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent.trim())
    if (!own && !/^(IMG|WX-IMAGE|INPUT|WX-SWITCH)$/.test(el.tagName)) return false
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || cs.visibility === 'hidden') return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < H
  })
  bars.forEach((b) => {
    const br = b.getBoundingClientRect()
    texts.forEach((el) => {
      const r = el.getBoundingClientRect()
      const overlap = Math.min(r.bottom, br.bottom) - Math.max(r.top, br.top)
      const overlapX = Math.min(r.right, br.right) - Math.max(r.left, br.left)
      if (overlap > 2 && overlapX > 2) {
        const t = (el.textContent || el.tagName).trim().slice(0, 24)
        if (!out.some((o) => o.text === t)) out.push({ rule: 'covered', text: t, detail: '滑到底还被「' + (b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 16) + '」挡住 ' + Math.round(overlap) + 'px' })
      }
    })
  })
  return out
}

module.exports = { inPage, coveredInPage }
