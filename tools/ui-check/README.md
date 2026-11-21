# 界面自动检查

按 [docs/UI规范.md](../../docs/UI规范.md) 查排版。在仓库根目录：

```bash
npm i --no-save playwright && npx playwright install chromium   # 第一次
npm run ui:check                       # 小程序 + 网页后台全部
npm run ui:check -- --only=mp          # 只查小程序（--only=web 只查网页后台）
npm run ui:check -- --filter=books     # 只查名字里带 books 的画面
```

结果在 `out/`（不进 git）：`report.md` 是问题清单，`mp/`、`mp-320/`、`web/`、`web-390/` 是截图。有问题时退出码是 1，GitHub Actions「检查」就会显示红叉。

| 文件 | 作用 |
| --- | --- |
| `run.js` | 起两个预览服务、逐页截图、跑检查、写报告 |
| `checks.js` | 在页面里跑的检查：超宽、短字折行、文字不居中、文字被切、横滑区没通到屏幕边、滑到底被挡、字太小 |
| `mp/` | 小程序预览：真服务器代码 + `admin-web/mock/seed.js` 的假数据，把 WXML/WXSS 渲染成网页（rpx 换算成 px，安全区按 34px） |
| `mp-scenarios.js` | 小程序要截的画面：每个页面、几种顾客身份、几个弹层 |
| `web-scenarios.js` | 网页后台要截的画面：自动读 `admin-web/src/router.js` 的菜单，再加几个常用弹窗 |
| `allow.json` | 确认没问题的个例，每条写清 `why` |

小程序预览是在浏览器里模拟微信，字体是文泉驿、`wx.*` 是假的，和真机不完全一样。真机才会出的问题（比如 `scroll-view` 的 `enable-flex`）靠 `tests/ui-rules.test.js` 在代码层面拦。

单页手动看：`node tools/ui-check/mp/server.js . 8790`，打开 `http://localhost:8790/?page=pages/books/books&user=C1&w=390&h=844`（`user`：OWNER 店主、C1 有余额和订单的顾客、C9 新顾客；`q=id%3Dxxx` 传页面参数）。
