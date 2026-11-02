module.exports = {
  // 正式服务器：正式发布的版本连这里（末尾不要斜杠）。要加到公众平台「开发管理 → 开发设置 → 服务器域名」的
  // request、uploadFile、downloadFile 合法域名里
  apiBase: 'https://pigkun.com',
  // 测试服务器：开发者工具和体验版连这里，数据和正式版分开（见 utils/server.js）；也要加到上面三处合法域名里。
  // 留空就都连正式服务器
  testApiBase: 'https://test.pigkun.com',
  shopName: '进山咖啡',
  // 电脑网页后台的网址，不填就是 服务器地址/admin/，员工在小程序里能复制
  webAdminUrl: ''
}
