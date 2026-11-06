// 测试用的替身：微信接口（小程序码、登录、订阅消息）、微信支付、图片存储、微信同城配送。数据库用真的 SQLite（内存里）。
// 洗车小程序有自己的一套（carwashWechat、carwashPay），状态在 state.cw 里，和咖啡的分开记
const state = {
  files: [],
  deleted: [],
  envVersion: null,
  lastCodeParams: null,
  unreleased: false,
  payReady: true,
  payFail: false,
  payOrders: {},
  refunds: [],
  // 订阅消息：公众平台「我的模板」里的模板，发出去的消息，sendError 不为空时发送报这个错误码
  templates: [],
  sent: [],
  sendError: 0,
  cw: { payReady: true, payOrders: {}, refunds: [] },
  // 发货信息管理：managed 是小程序开没开这项服务，uploads 是传上去的发货信息，uploadError 不为空时上传报这个错误码
  shipping: { managed: true, managedError: false, uploads: [], uploadError: 0 },
  // 微信同城配送：orders 按门店订单号记叫过的骑手单；calls 是调过的接口；fail 不为空时下一个接口报这个错误码
  courier: { ready: true, sandbox: false, orders: {}, calls: [], stores: [], fail: 0, fee: 850, deductFee: 0, balance: [] }
}

const wechat = {
  ready: () => true,
  // code 直接当 openid 用，测试里方便
  async code2session(code) {
    if (code === 'bad') {
      const e = new Error('errCode: 40029 | errMsg: invalid code')
      e.errCode = 40029
      throw e
    }
    return { openid: 'OPENID_' + code }
  },
  async getUnlimited(params) {
    // 小程序没发布时，正式版又要检查页面，微信会报 41030
    if (state.unreleased && params.envVersion === 'release' && params.checkPath !== false) {
      const e = new Error('errCode: 41030 | errMsg: invalid page')
      e.errCode = 41030
      throw e
    }
    state.envVersion = params.envVersion
    state.lastCodeParams = params
    return { buffer: Buffer.from('png'), contentType: 'image/png' }
  },
  async getTemplateList() {
    return state.templates
  },
  async sendSubscribe(params) {
    if (state.sendError) {
      const e = new Error('errCode: ' + state.sendError + ' | errMsg: fail')
      e.errCode = state.sendError
      throw e
    }
    state.sent.push(params)
    return true
  },
  async isTradeManaged() {
    if (state.shipping.managedError) throw new Error('errCode: -1 | errMsg: system error')
    return state.shipping.managed
  },
  async uploadShipping(body) {
    if (state.shipping.uploadError) {
      const e = new Error('errCode: ' + state.shipping.uploadError + ' | errMsg: fail')
      e.errCode = state.shipping.uploadError
      throw e
    }
    state.shipping.uploads.push(body)
    return true
  }
}

// 测试里用 state.payOrders[outTradeNo].paid = true 假装顾客付了款（洗车的是 state.cw.payOrders）
function makePay(s, mchId) {
  return {
    get mchId() { return s.payReady ? mchId : '' },
    ready: () => s.payReady,
    async jsapi(params) {
      if (s.payFail) {
        const e = new Error('wxpay 400 PARAM_ERROR 商户号未开通 JSAPI 支付')
        e.wxMessage = '商户号未开通 JSAPI 支付'
        throw e
      }
      const prev = s.payOrders[params.outTradeNo]
      s.payOrders[params.outTradeNo] = { params, paid: prev ? prev.paid : false }
      return { timeStamp: '1', nonceStr: 'n', package: 'prepay_id=wx' + params.outTradeNo, signType: 'RSA', paySign: 'sign' }
    },
    async query(outTradeNo) {
      const o = s.payOrders[outTradeNo]
      if (!o) return null
      return { tradeState: o.paid ? 'SUCCESS' : 'NOTPAY', transactionId: 'tx' + outTradeNo, total: o.params.total, payerOpenid: o.params.openid }
    },
    async refund(params) {
      s.refunds.push(params)
      return { status: 'PROCESSING', refundId: 'rf' + params.outRefundNo }
    }
  }
}

const pay = makePay(state, '1900000109')
const carwashPay = makePay(state.cw, '1900000209')

// 洗车小程序的登录：code 'U1-xxx' 表示带 unionid U1 的用户，openid 是 'CW_xxx'
const carwashWechat = {
  ready: () => true,
  async code2session(code) {
    const m = /^(U\w+)-(\w+)$/.exec(code)
    if (m) return { openid: 'CW_' + m[2], unionid: m[1] }
    return { openid: 'CW_' + code }
  }
}

const storage = {
  root: '/nonexistent',
  resolve: () => null,
  saveImage: (buf, folder) => {
    const id = '/uploads/' + (folder || 'misc') + '/test-' + state.files.length + '.jpg'
    state.files.push(id)
    return id
  },
  async upload({ cloudPath }) {
    const fileID = '/uploads/' + cloudPath
    state.files.push(fileID)
    return { fileID }
  },
  async remove({ fileList }) {
    state.deleted.push.apply(state.deleted, fileList)
    return { fileList: fileList.map((fileID) => ({ fileID, status: 0 })) }
  }
}

// 微信同城配送：和 lib/intracity.js 一样的方法，测试里用 courierStatus(门店订单号, 状态码, 骑手) 假装骑手动了
const courier = {
  get sandbox() { return state.courier.sandbox },
  notifyToken: 'TOKEN',
  notifyUrl: '',
  ready: () => state.courier.ready,
  verifyNotify: require('../../server/lib/intracity').createIntracity({}).verifyNotify
}
const c = state.courier
function courierCall(name, fn) {
  return async (body) => {
    c.calls.push({ name, body })
    if (c.fail) {
      const e = new Error('intracity errCode: ' + c.fail)
      e.errCode = c.fail
      e.errMsg = 'mock fail'
      c.fail = 0
      throw e
    }
    return fn(body || {})
  }
}
Object.assign(courier, {
  apply: courierCall('apply', () => ({ errcode: 0 })),
  queryStore: courierCall('querystore', (b) => ({ total: 0, store_list: c.stores.filter((x) => x.out_store_id === b.out_store_id) })),
  createStore: courierCall('createstore', (b) => {
    const store = Object.assign({ wx_store_id: 'WXSTORE' + (c.stores.length + 1) }, b)
    c.stores.push(store)
    return { wx_store_id: store.wx_store_id }
  }),
  updateStore: courierCall('updatestore', (b) => {
    const store = c.stores.find((x) => x.wx_store_id === b.keys.wx_store_id)
    Object.assign(store, b.content)
    return {}
  }),
  balance: courierCall('balancequery', () => ({ balance_list: c.balance })),
  charge: courierCall('storecharge', (b) => ({ payurl: 'https://pay.example/charge?amount=' + b.amount })),
  preAddOrder: courierCall('preaddorder', () => ({ service_trans_id: 'DADA', est_fee: c.fee, distance: 1800 })),
  addOrder: courierCall('addorder', (b) => {
    const prev = c.orders[b.store_order_id]
    if (prev) return prev.created // 同一个门店订单号会「重入」，原样返回
    const created = { wx_order_id: 'WX' + b.store_order_id, store_order_id: b.store_order_id, service_trans_id: 'DADA', fee: c.fee, distance: 1800, fetch_code: '' }
    c.orders[b.store_order_id] = { body: b, created, status: 10000, rider: null }
    return created
  }),
  queryOrder: courierCall('queryorder', (b) => {
    const o = Object.values(c.orders).find((x) => x.created.wx_order_id === b.wx_order_id || x.created.store_order_id === b.store_order_id)
    if (!o) {
      const e = new Error('no order')
      e.errCode = 9300507
      throw e
    }
    const out = { wx_order_id: o.created.wx_order_id, order_status: o.status, service_trans_id: 'DADA', actualfee: c.fee }
    if (o.rider) out.transporter_info = { transporter_name: o.rider.name, transporter_phone: o.rider.phone }
    return out
  }),
  cancelOrder: courierCall('cancelorder', (b) => {
    const o = Object.values(c.orders).find((x) => x.created.wx_order_id === b.wx_order_id)
    o.status = 20000
    return { deductfee: c.deductFee }
  }),
  mockNotify: courierCall('mocknotify', (b) => {
    c.orders[b.store_order_id].status = b.order_status
    return {}
  })
})

function courierStatus(storeOrderId, status, rider) {
  const o = c.orders[storeOrderId]
  o.status = status
  if (rider) o.rider = rider
}

module.exports = { state, wechat, pay, storage, carwashPay, carwashWechat, courier, courierStatus }
