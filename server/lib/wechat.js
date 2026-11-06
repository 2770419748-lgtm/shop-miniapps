// 调微信服务器的接口：小程序登录换 openid、拿 access_token、生成小程序码、订阅消息、上传发货信息。
// 需要小程序的 AppID 和 AppSecret（公众平台「开发管理 → 开发设置」里拿），填在服务器配置文件里。
const API = 'https://api.weixin.qq.com'
// access_token 失效时微信返回的错误码，遇到就刷新一次再试
const TOKEN_ERRORS = [40001, 40014, 42001]

function wxError(errcode, errmsg) {
  const e = new Error('errCode: ' + errcode + ' | errMsg: ' + (errmsg || ''))
  e.errCode = errcode
  e.errMsg = errmsg || ''
  return e
}

function createWechat({ appId, appSecret, fetch = globalThis.fetch }) {
  let token = null

  function ready() {
    return !!(appId && appSecret)
  }

  function check() {
    if (!ready()) throw new Error('服务器配置文件里还没填 appId 和 appSecret')
  }

  async function json(res) {
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch (e) {
      throw new Error('微信接口返回的不是 JSON：' + res.status + ' ' + text.slice(0, 200))
    }
  }

  // 稳定版 access_token：多处同时取也不会互相顶掉；提前 5 分钟换新的
  async function accessToken(force) {
    check()
    if (!force && token && token.expiresAt > Date.now()) return token.value
    const res = await fetch(API + '/cgi-bin/stable_token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credential', appid: appId, secret: appSecret, force_refresh: !!force })
    })
    const data = await json(res)
    if (!data.access_token) throw wxError(data.errcode, data.errmsg)
    token = { value: data.access_token, expiresAt: Date.now() + (Number(data.expires_in || 7200) - 300) * 1000 }
    return token.value
  }

  // 小程序 wx.login 拿到的 code 换成 openid
  async function code2session(code) {
    check()
    const qs = new URLSearchParams({ appid: appId, secret: appSecret, js_code: String(code || ''), grant_type: 'authorization_code' })
    const data = await json(await fetch(API + '/sns/jscode2session?' + qs.toString()))
    if (!data.openid) throw wxError(data.errcode, data.errmsg)
    return { openid: data.openid, unionid: data.unionid || '' }
  }

  // 生成小程序码（不限数量的那种），参数写法和原来云开发的一样：scene、page、checkPath、envVersion、width
  async function getUnlimited(params, retried) {
    const body = {
      scene: params.scene,
      page: params.page,
      check_path: params.checkPath !== false,
      env_version: params.envVersion || 'release',
      width: params.width || 430
    }
    const res = await fetch(API + '/wxa/getwxacodeunlimit?access_token=' + encodeURIComponent(await accessToken(!!retried)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const type = res.headers.get('content-type') || ''
    if (/json|text/.test(type)) {
      const data = await json(res)
      if (!retried && TOKEN_ERRORS.indexOf(data.errcode) !== -1) return getUnlimited(params, true)
      throw wxError(data.errcode, data.errmsg)
    }
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType: type || 'image/jpeg' }
  }

  // 带 access_token 调一个返回 JSON 的接口；token 失效时刷新一次再试
  async function call(method, path, body, retried) {
    const url = API + path + (path.indexOf('?') === -1 ? '?' : '&') + 'access_token=' + encodeURIComponent(await accessToken(!!retried))
    const res = await fetch(url, body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const data = await json(res)
    if (data.errcode && TOKEN_ERRORS.indexOf(data.errcode) !== -1 && !retried) return call(method, path, body, true)
    if (data.errcode) throw wxError(data.errcode, data.errmsg)
    return data
  }

  // 公众平台「订阅消息 → 我的模板」里已经选好的模板：[{ priTmplId, title, content, example, type }]
  async function getTemplateList() {
    const data = await call('GET', '/wxaapi/newtmpl/gettemplate')
    return data.data || []
  }

  // 发一条订阅消息。miniprogramState：formal 正式版、trial 体验版、developer 开发版（点消息打开哪个版本）
  async function sendSubscribe({ touser, templateId, page, data, miniprogramState }) {
    await call('POST', '/cgi-bin/message/subscribe/send', {
      touser,
      template_id: templateId,
      page,
      data,
      miniprogram_state: miniprogramState || 'formal',
      lang: 'zh_CN'
    })
    return true
  }

  // 小程序发货信息管理（见 functions/shipping.js）：公众平台给这个小程序开没开这项服务
  async function isTradeManaged() {
    const data = await call('POST', '/wxa/sec/order/is_trade_managed', { appid: appId })
    return !!data.is_trade_managed
  }

  // 上传一笔微信支付的发货信息
  async function uploadShipping(body) {
    await call('POST', '/wxa/sec/order/upload_shipping_info', body)
    return true
  }

  return { ready, accessToken, code2session, getUnlimited, getTemplateList, sendSubscribe, isTradeManaged, uploadShipping }
}

module.exports = { createWechat, wxError }
