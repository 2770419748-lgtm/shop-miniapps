# 给在这个仓库里干活的 Claude

- 改任何界面（`miniprogram/`、`miniprogram-carwash/`、`admin-web/`）之前先读 `docs/UI规范.md`，按里面的写法和现成 class 来，不要另造。
- 改完跑 `npm test`；改了界面再跑 `npm run ui:check`（第一次要 `npm i --no-save playwright && npx playwright install chromium`），看 `tools/ui-check/out/report.md` 和截图。GitHub 上每次推送、每个 PR 也会自动跑这两项（Actions「检查」）。
- 碰到规范里没写到的新问题，把规则补进 `docs/UI规范.md`，并在 `tests/ui-rules.test.js` 或 `tools/ui-check/checks.js` 加上检查。
- 改了 `admin-web/src` 要 `cd admin-web && npm run build`，把 `admin-web/dist` 一起提交（服务器直接用 dist）。
- 部署：合进 main 会自动上测试版；正式版要店主说「上正式」才在 Actions 里手动部署。小程序端要店主在微信开发者工具上传。详见 `README.md` 和 `deploy/README.md`。
