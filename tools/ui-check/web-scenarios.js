// 电脑网页后台要截的页面：登录页 + 菜单里每一页，电脑宽度和手机宽度各一遍（run.js 负责换宽度）
// 页面从 admin-web/src/router.js 的菜单里读，以后加页面不用改这里
const fs = require('fs')
const path = require('path')

function menuPaths(repo) {
  const src = fs.readFileSync(path.join(repo, 'admin-web/src/router.js'), 'utf8')
  const paths = []
  const re = /\{\s*path:\s*'([^']+)',\s*title:\s*'([^']+)'/g
  let m
  while ((m = re.exec(src))) paths.push({ path: m[1], title: m[2] })
  return paths
}

// 打开一些常用弹窗（编辑商品、录入书目……），弹窗里的表单也要查
const DIALOGS = [
  { path: '/products', click: '新增商品', name: 'products-new' },
  { path: '/books', click: '录入新书', name: 'books-new' },
  { path: '/coupons', click: '新增代金券', name: 'coupons-new' },
  // 第一个档位送了券：编辑弹窗里有送券那几行
  { path: '/member-settings', click: '编辑', name: 'member-plan-edit' },
  { path: '/members', click: '详情', name: 'members-detail' }
]

module.exports = (repo) => {
  const S = [{ name: 'login', path: '/login', public: true }]
  menuPaths(repo).forEach((p) => S.push({ name: p.path.replace(/^\//, '').replace(/\//g, '-'), path: p.path, title: p.title }))
  DIALOGS.forEach((d) => S.push({ name: 'x-' + d.name, path: d.path, click: d.click }))
  return S
}
