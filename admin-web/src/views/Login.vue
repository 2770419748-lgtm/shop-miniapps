<template>
  <div class="login">
    <div class="box">
      <img class="logo" :src="logo" alt="进山咖啡" />
      <div class="title">管理后台</div>
      <el-alert v-if="notice" :title="notice" type="warning" :closable="false" show-icon class="notice" />
      <el-tabs v-model="tab" stretch @tab-change="onTab">
        <el-tab-pane label="微信扫码" name="scan">
          <div class="qr" v-loading="qr.loading" element-loading-background="transparent">
            <img v-if="qr.image" :src="qr.image" alt="登录二维码" :class="{ dim: qr.status !== 'waiting' }" />
            <div v-if="maskText" class="mask" @click="newTicket">
              <div>{{ maskText }}</div>
              <el-button size="small" type="primary">刷新二维码</el-button>
            </div>
          </div>
          <div class="scan-tip">用微信扫一扫，在手机上点「确认登录」</div>
          <div class="tip center" v-if="qr.envVersion === 'trial'">小程序还没发布，这是体验版二维码，扫码的人要先加为体验成员。</div>
          <div class="center" v-if="isMock && qr.status === 'waiting'">
            <el-button link type="primary" @click="mockConfirm">预览模式：模拟手机确认</el-button>
          </div>
        </el-tab-pane>
        <el-tab-pane label="账号密码" name="password">
          <el-form @submit.prevent="submit" label-position="top">
            <el-form-item label="账号">
              <el-input v-model="username" autocomplete="username" placeholder="在小程序里设置的账号" size="large" />
            </el-form-item>
            <el-form-item label="密码">
              <el-input v-model="password" type="password" autocomplete="current-password" show-password size="large" @keyup.enter="submit" />
            </el-form-item>
            <el-button type="primary" size="large" class="submit" :loading="loading" native-type="submit">登录</el-button>
          </el-form>
          <div class="tip center demo-account" v-if="isMock">预览账号 boss，密码 jinshan2026</div>
        </el-tab-pane>
      </el-tabs>
      <div class="tip help">只有店主和员工能登录。第一次用先在小程序里绑定身份；账号密码在小程序「我的 → 管理后台 → 电脑网页后台」里设置。洗车店的员工在洗车小程序「我的 → 员工 → 电脑网页后台」里设置，或者用账号密码登录。</div>
    </div>
    <a v-if="icp" class="icp" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener">{{ icp }}</a>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { api, session, setToken, isMock, mockConfirmLogin, config } from '../api'
import { firstPage } from '../router'
import logo from '../assets/logo.jpg'

const POLL_MS = 2000
const MASK = { expired: '二维码过期了', cancelled: '手机上取消了登录', used: '这个二维码已经用过了', error: '二维码没加载出来' }

const route = useRoute()
const router = useRouter()
const tab = ref('scan')
const username = ref('')
const password = ref('')
const loading = ref(false)
const qr = reactive({ id: '', key: '', image: '', envVersion: '', expiresAt: 0, status: '', loading: false })
let timer = null
let alive = true

const notice = computed(() => {
  if (route.query.error) return String(route.query.error)
  if (route.query.expired) return '登录已过期，请重新登录'
  return ''
})

// 网站备案号（public/config.js 里的 icp），管局要求挂在网站首页底部并链到工信部备案网站
const icp = String(config().icp || '').trim()

const maskText = computed(() => (qr.loading ? '' : MASK[qr.status] || ''))

function done(res) {
  setToken(res.token)
  session.staff = res.staff
  const next = typeof route.query.next === 'string' && route.query.next !== '/login' ? route.query.next : firstPage()
  router.replace(next)
}

function stopPoll() {
  if (timer) clearTimeout(timer)
  timer = null
}

function schedule(ms) {
  stopPoll()
  if (alive && tab.value === 'scan' && qr.status === 'waiting') timer = setTimeout(poll, ms)
}

async function newTicket() {
  if (qr.loading) return
  stopPoll()
  qr.loading = true
  try {
    const t = await api.common('createWebLogin')
    Object.assign(qr, { id: t.id, key: t.key, image: t.image, envVersion: t.envVersion, expiresAt: t.expiresAt, status: 'waiting' })
  } catch (e) {
    qr.status = 'error'
    ElMessage.error(e.message)
  } finally {
    qr.loading = false
  }
  schedule(POLL_MS)
}

async function poll() {
  const id = qr.id
  try {
    const res = await api.common('pollWebLogin', { id: qr.id, key: qr.key })
    if (id !== qr.id) return
    if (res.status === 'ok') return done(res)
    qr.status = res.status
  } catch (e) {
    if (id !== qr.id) return
    if (e.code === 'TICKET_GONE') qr.status = 'expired'
    // 网络抖动：过一会儿再问，二维码过期了就停
    else if (Date.now() > qr.expiresAt) qr.status = 'expired'
  }
  schedule(POLL_MS)
}

function onTab(name) {
  if (name !== 'scan') return stopPoll()
  if (!qr.id || qr.status !== 'waiting' || Date.now() > qr.expiresAt) newTicket()
  else schedule(0)
}

async function mockConfirm() {
  try {
    await mockConfirmLogin(qr.id)
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function submit() {
  if (loading.value) return
  if (!username.value.trim() || !password.value) {
    ElMessage.warning('请填写账号和密码')
    return
  }
  loading.value = true
  try {
    done(await api.common('webLogin', { username: username.value, password: password.value }))
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

onMounted(newTicket)
onBeforeUnmount(() => {
  alive = false
  stopPoll()
})
</script>

<style scoped>
.login {
  min-height: 100%;
  box-sizing: border-box;
  padding: 16px max(16px, env(safe-area-inset-right, 0px)) 16px max(16px, env(safe-area-inset-left, 0px));
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  background: radial-gradient(circle at 50% 20%, #221d13, #0b0b0b 60%);
}
.box {
  width: 360px;
  max-width: 100%;
  box-sizing: border-box;
  padding: 32px 24px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 16px;
}
.logo {
  display: block;
  width: 120px;
  height: 120px;
  margin: 0 auto;
  object-fit: cover;
}
.title {
  text-align: center;
  color: var(--el-color-primary);
  letter-spacing: 6px;
  margin: 4px 0 12px;
}
.notice { margin-bottom: 16px; }
.qr {
  position: relative;
  width: 200px;
  height: 200px;
  margin: 8px auto 12px;
  padding: 8px;
  box-sizing: border-box;
  background: #fff;
  border-radius: 12px;
  overflow: hidden;
}
.qr img {
  width: 100%;
  height: 100%;
  display: block;
}
.qr img.dim { opacity: 0.08; }
.mask {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: #333;
  font-size: 14px;
  cursor: pointer;
}
.scan-tip {
  text-align: center;
  color: var(--el-text-color-regular);
  margin-bottom: 6px;
}
.center { text-align: center; }
.submit { width: 100%; margin-top: 8px; }
.demo-account { margin-top: 10px; }
.help { margin-top: 16px; }
.icp {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-decoration: none;
}
.icp:hover { color: var(--el-color-primary); }
</style>
