# 界面规范（小程序 + 网页后台）

进山咖啡小程序（`miniprogram/`，含小程序里的管理后台）、黑镜洗车小程序（`miniprogram-carwash/`）和电脑网页后台（`admin-web/`）改界面时都按这份来。

为什么有这份：2026-11-21 正式版「店内书架」顶部分类栏在真机上出了问题：每个标签被撑得很高、文字贴在上半截，最右边的分类在页边距处被切掉一半，也看不出能横着滑。开发者工具和预览里看都是好的，到了微信真机才变样。下面每条规则都尽量配了自动检查，违反了提交时就会报出来。

## 0. 怎么检查

| 命令 | 查什么 | 什么时候跑 |
| --- | --- | --- |
| `npm test` | 代码里的写法（`tests/ui-rules.test.js`）：真机才会出问题的写法、字号、省略号、安全区、图片宽高等 | 每次改完都跑，几秒钟 |
| `npm run ui:check` | 把小程序每一页（390 宽标准屏 + 320 宽小屏）和网页后台每一页（1366 电脑 + 390 手机）都渲染出来截图，查超宽、文字不居中、被切、被底部按钮挡、字太小（`tools/ui-check/`） | 改了界面就跑，几分钟 |

- 两个检查在 GitHub 上每次推送和每个 PR 都会自动跑（Actions 里的「检查」），没过会显示红叉。截图和报告在那次运行的 Artifacts 里下载（`ui-check`），打开 `report.md` 看。
- `ui:check` 需要 playwright：`npm i --no-save playwright && npx playwright install chromium`。
- 确实不算问题的个例，写进 `tools/ui-check/allow.json`，每条写清 `why`。不要为了让检查通过去放宽检查本身。
- 预览是用浏览器模拟微信，字体和真机不完全一样，所以有两层：渲染检查抓排版，静态检查专门拦「预览里正常、真机才出问题」的写法。

## 1. 基础

**1.1 颜色**只用变量：小程序 `app.wxss` 顶部的 `--bg --card --card-2 --line --gold --gold-soft --text --text-2 --text-3 --danger --ok`；网页后台 `admin-web/src/style.css` 里的变量和 Element Plus 变量。黑底金色，不加新颜色。

**1.2 字号**：小程序最小 20rpx，网页后台最小 12px。常用档位（小程序）：

| 用途 | 字号 |
| --- | --- |
| 状态标签 `.tag` | 22rpx |
| 辅助说明、时间 | 24rpx |
| 选项、小按钮 | 26rpx |
| 正文 | 28rpx |
| 主按钮 | 30rpx |
| 卡片标题 | 32–34rpx |
| 金额、取餐号 | 40rpx 以上 |

**1.3 页面不能横着拖**：任何内容都不能比屏幕宽。长的订单号、网址加 `word-break: break-all`；一行放不下的用省略号（3.1）。

**1.4 间距和圆角**：页面左右 24rpx（`.page`）；卡片 `.card` 内边距 28rpx、间距 24rpx、圆角 20rpx；选项圆角 12rpx；按钮和胶囊全圆角。

## 2. 控件

**2.1 按钮、选项、胶囊、标签：高度写死，用 line-height（或 flex 居中）让文字居中，不用上下 padding 撑高度。**
上下 padding 撑出来的框，一旦被放进 flex 容器就可能被拉高，文字就贴在上半截（书架页就是这样）。带 1rpx 边框的，line-height = 高度 − 2rpx。统一用 `app.wxss` 里现成的 class，不要在页面里另造：

| 控件 | class | 高度 | 字号 | 圆角 |
| --- | --- | --- | --- | --- |
| 主按钮 | `.btn-gold` `.btn-ghost` `.btn-danger`（整行加 `.btn-block`） | 80rpx | 30rpx | 全圆 |
| 小按钮 | 再加 `.btn-small` | 60rpx | 26rpx | 全圆 |
| 选项 | `.chip`（放在 `.chips` 里自动换行） | 64rpx | 26rpx | 12rpx |
| 小选项 | `.chip.mini` | 52rpx | 24rpx | 12rpx |
| 分类胶囊 | `.chip-bar` 里的 `.chip`（见 2.3） | 60rpx | 26rpx | 全圆 |
| 状态标签 | `.tag`（`.gold` `.ok` `.danger`） | 36rpx | 22rpx | 8rpx |
| 加减 | `.stepper-btn` | 52rpx | 34rpx | 圆 |

检查：`npm test` 会拦「`.chip/.tag/.btn*/.pill/.badge` 有上下 padding 却没写 height」；`ui:check` 会量每个按钮、标签里的文字是不是上下居中（off-center）。

**2.2 选项文字不换行**：`.chip`、`.tag` 都是 `white-space: nowrap`，选项太多就自动换到下一行（`.chips`），不要让一个选项里的字折成两行。

**2.3 横向滑动的分类栏只用这一种写法**（书架页、小程序管理端商品页）：

```html
<view class="chip-bar bleed {{barFade ? 'fade' : ''}}">
  <scroll-view class="chip-scroll" scroll-x enhanced show-scrollbar="{{false}}" bindscroll="onBarScroll">
    <view class="chip-track">
      <view class="chip {{current === 'all' ? 'on' : ''}}" data-cat="all" bindtap="pickCat">全部</view>
      <view wx:for="{{categories}}" wx:key="*this" class="chip {{current === item ? 'on' : ''}}" data-cat="{{item}}" bindtap="pickCat">{{item}}</view>
    </view>
  </scroll-view>
</view>
```

```js
const chipBar = require('../../utils/chip-bar')
// 拿到分类后：this.setData({ barFade: chipBar.overflows(['全部'].concat(names)) })
onBarScroll(e) { chipBar.onScroll(this, e) }
```

- `scroll-view` **不加 `enable-flex`**，里面套一层 `.chip-track`。`enable-flex` 在真机上会把胶囊撑高、文字贴顶。（静态检查拦）
- 横向 `scroll-view` 都加 `enhanced show-scrollbar="{{false}}"`，安卓上不出滚动条。（静态检查拦）
- 放在 `.page` 里时加 `bleed`，滑动区通到屏幕两边，不会在页边距处切掉半个字。（渲染检查 inset）
- 右边的渐隐（`.fade`）提示还能往右滑：内容比屏幕宽、还没滑到最右时才显示，由 `utils/chip-bar.js` 算。
- 分类名是店主自己在后台填的，按 6 个字以上的长名字测。

**2.4 页内切换（tab）**：如「咖啡订单 / 借书记录」「待制作 / 制作中 / 已完成」，用等分的 `.tabs`（`flex: 1`，不滑动），最多 4 个；更多就改用 2.3 的分类栏。

**2.5 开关**用微信 `switch`，`color="#d6b25e"`，不改尺寸。

## 3. 文字

**3.1 一行放不下就省略号**：`white-space: nowrap; overflow: hidden; text-overflow: ellipsis` 三个一起写，flex 子项再加 `min-width: 0`（`.flex-1` 已经带了）。不允许把字硬切掉一截。（静态检查 + 渲染检查 clipped）

**3.2 短文字不能被挤成两行**：标签、按钮、名字、表头这类 8 个字以内的文字，给它 `flex-shrink: 0` 或 `white-space: nowrap`，让旁边长的那段去省略或换行。（渲染检查 wrap）

**3.3 多行截断**用 `display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden`。

**3.4 按最长的数据设计**：商品名、书名、分类名、备注、地址都是店主或顾客自己填的。预览数据（`admin-web/mock/seed.js`、`tools/ui-check/mp-scenarios.js`）里要有长名字，界面要么省略、要么换行，不能溢出。

## 4. 固定在底部的东西

**4.1 滑到底不能被挡**：有底部固定按钮条（去结算、提交并付款）或悬浮按钮（+ 新增商品）的页面，最下面留出至少同样高的空白（`.safe-bottom` 或 `padding-bottom`），滑到底时最后一行内容在按钮上面。（渲染检查 covered）

**4.2 让出 iPhone 底部安全区**：不是 tabBar 页的底部固定条，`padding-bottom` 或 `bottom` 里带 `env(safe-area-inset-bottom)`。tabBar 页下面是微信底栏，不用加。（静态检查）

**4.3 层级**：遮罩 `.mask` 90，底部弹层 `.sheet` 100，点单页购物车条 110（打开规格弹层时隐藏购物车条）。新东西放在这几档里，不要随手写 9999。

## 5. 微信组件的坑（预览里不一定看得出来）

**5.1 `<image>` 一定写宽和高**（class 或 style）。不写时微信默认 320×240。`mode="widthFix"` 只写宽，`heightFix` 只写高。（静态检查）

**5.2 `<textarea>` 一定写宽度**，不写时微信默认 300px 宽；不加 `auto-height` 时默认 150px 高。（静态检查）

**5.3 `scroll-view`**：不用 `enable-flex`（见 2.3）；竖向滚动的要给确定的高度。

**5.4 不用 `<button>`**：自带边框（`::after`）、行高和内边距，各机型不一样。点击用 `view` + `bindtap` + `hover-class="btn-hover"`。真要用 `open-type`（分享、客服）时，把 `::after` 的边框、`line-height`、`padding` 全部重写。

## 6. 电脑网页后台

**6.1** 用 Element Plus 组件，不自己画按钮；设置类页面用 `.narrow`（最宽 960px），各页不要另写宽度；表格列给 `min-width`，按钮文字不换行。

**6.2 手机宽度（≤ 760px）**：弹窗 94vw、抽屉铺满、表单标签放到输入框上面、左侧菜单变成顶上横着滑。都写在 `style.css` 的手机样式里，新页面自动生效。（静态检查）

**6.3** 字号最小 12px，颜色用 `style.css` 的变量。

**6.4** 新加的页面放进 `router.js` 的菜单后，`ui:check` 会自动在电脑和手机宽度各截一张检查，不用另外登记。

## 7. 改界面的步骤

1. 先看这份规范和 `app.wxss` 里有没有现成的 class，能复用就复用。
2. 改完跑 `npm test` 和 `npm run ui:check`，看 `tools/ui-check/out/report.md` 和截图（小程序 390 / 320 宽，网页 1366 / 390 宽）。
3. 碰到新的一类问题：把规则补进这份文件，并在 `tests/ui-rules.test.js`（写法）或 `tools/ui-check/checks.js`（渲染）里加上检查，以后就不会再犯。
4. PR 里附改前改后截图。
