// 横向分类栏（app.wxss 的 .chip-bar，UI 规范 2.3）右侧渐隐：
// 胶囊加起来比屏幕宽、而且还没滑到最右时才显示，告诉顾客右边还有。
// 用法（完整例子见 docs/UI规范.md 2.3）：页面里引入本文件为 chipBar，
//   拿到分类后 this.setData({ barFade: chipBar.overflows(['全部'].concat(names)) })
//   scroll-view 上 bindscroll="onBarScroll"，onBarScroll(e) { chipBar.onScroll(this, e) }

// 按 .chip-track .chip 的尺寸估算总宽（单位 rpx，屏幕宽 750）：字号 26rpx，左右内边距各 28rpx，间隔 16rpx，两头留 24rpx
const FONT = 26
const PAD = 28
const GAP = 16
const EDGE = 24

function textWidth(text) {
  let w = 0
  for (const ch of String(text)) w += /[\u0000-ÿ]/.test(ch) ? FONT * 0.6 : FONT
  return w
}

function overflows(names) {
  const total = (names || []).reduce((sum, n) => sum + textWidth(n) + PAD * 2 + GAP, EDGE * 2 - GAP)
  return total > 750
}

let windowWidth = 0
function screenWidth() {
  if (!windowWidth) {
    try {
      windowWidth = (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()).windowWidth
    } catch (e) {
      windowWidth = 375
    }
  }
  return windowWidth
}

// 滑动时按真实宽度算：滑到最右就收起渐隐
function onScroll(page, e, key) {
  const name = key || 'barFade'
  const d = e.detail || {}
  if (!d.scrollWidth) return
  const fade = d.scrollLeft + screenWidth() < d.scrollWidth - 8
  if (fade !== page.data[name]) page.setData({ [name]: fade })
}

module.exports = { overflows, onScroll, textWidth }
