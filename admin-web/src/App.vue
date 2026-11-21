<template>
  <router-view v-if="route.meta.public" />
  <el-container v-else class="layout">
    <el-aside width="200px" class="aside">
      <!-- 能管两家店的：点左上角头像弹出门店列表切换 -->
      <el-popover v-if="shops.length > 1" v-model:visible="shopsOpen" trigger="click" placement="bottom-start" :width="236" :show-arrow="false" :offset="6" popper-class="shop-pop">
        <template #reference>
          <div class="brand switchable" title="切换门店">
            <img :src="logoOf(shop.key)" alt="" />
            <div class="brand-text">
              <div class="brand-name" :class="{ mono: shop.key === 'carwash', long: isLong(shop.name) }" :title="shop.name">{{ shop.name }}</div>
              <div v-if="!isLong(shop.name)" class="brand-sub">管理后台</div>
            </div>
            <svg class="brand-caret" :class="{ open: shopsOpen }" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </div>
        </template>
        <div class="shop-pop-title">切换门店</div>
        <div v-for="s in shops" :key="s.key" class="shop-item" :class="{ on: s.key === current.shop }" @click="switchShop(s.key)">
          <img :src="logoOf(s.key)" alt="" />
          <span class="shop-item-name">{{ s.name }}</span>
          <span v-if="s.key === current.shop" class="shop-item-now">当前</span>
        </div>
      </el-popover>
      <div v-else class="brand">
        <img :src="logoOf(shop.key)" alt="" />
        <div class="brand-text">
          <div class="brand-name" :class="{ mono: shop.key === 'carwash', long: isLong(shop.name) }" :title="shop.name">{{ shop.name }}</div>
          <div v-if="!isLong(shop.name)" class="brand-sub">管理后台</div>
        </div>
      </div>
      <el-menu :default-active="route.path" router class="menu">
        <template v-for="g in visibleMenu" :key="g.group">
          <div v-if="g.group" class="menu-group">{{ g.group }}</div>
          <el-menu-item v-for="item in g.items" :key="item.path" :index="item.path">{{ item.title }}</el-menu-item>
        </template>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="title">{{ route.meta.title }}</span>
        <el-tag v-if="isMock" type="warning" size="small" class="preview">预览 · 假数据，重新运行预览会重置</el-tag>
        <span class="spacer"></span>
        <template v-if="session.staff">
          <span>{{ session.staff.name }}</span>
          <el-tag size="small" class="role">{{ session.staff.roleName }}</el-tag>
          <el-button link @click="logout">退出</el-button>
        </template>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, session, setToken, isMock } from './api'
import { MENU, allowed, current, myShops, shopOf, firstPage } from './router'
import logo from './assets/logo.jpg'
import carwashLogo from './assets/carwash-logo.jpg'

const route = useRoute()
const router = useRouter()

const shops = computed(() => (session.staff ? myShops() : []))
const shop = computed(() => shopOf(current.shop))

const visibleMenu = computed(() => MENU
  .filter((g) => g.shop === current.shop)
  .map((g) => ({ group: g.group, items: g.items.filter(allowed) }))
  .filter((g) => g.items.length))

// 菜单比屏幕长时（手机上横着一排、电脑上竖着一列），把当前页的菜单项滚到看得见的地方
watch(() => route.path, () => {
  nextTick(() => {
    const el = document.querySelector('.menu .el-menu-item.is-active')
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'center' })
  })
}, { immediate: true })

const shopsOpen = ref(false)

// 侧边栏一行放得下 6 个字的店名
function isLong(name) {
  return Array.from(name || '').length > 6
}

function logoOf(key) {
  return key === 'carwash' ? carwashLogo : logo
}

// 切到另一家店：打开那家能进的第一页
function switchShop(key) {
  shopsOpen.value = false
  if (key !== current.shop) router.push(firstPage(key))
}

async function logout() {
  try {
    await api.common('webLogout', { webToken: session.token })
  } catch (e) {
    // 退出失败也清掉本地登录
  }
  setToken('')
  session.staff = null
  router.replace('/login')
}
</script>

<style scoped>
.layout { height: 100%; }
.aside {
  background: #121110;
  border-right: 1px solid var(--el-border-color);
  display: flex;
  flex-direction: column;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px;
  border-bottom: 1px solid var(--el-border-color);
}
.brand img {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  object-fit: cover;
}
.brand-name {
  color: var(--el-color-primary);
  font-weight: 600;
  font-size: 16px;
}
.brand-name.mono { color: #fff; }
/* 店名超过 6 个字放不下一行：去掉「管理后台」，店名平均分两行（黑镜车体 / 护理车房），不会断在词中间 */
.brand-name.long {
  font-size: 15px;
  line-height: 1.3;
  text-wrap: balance;
}
.brand-text { flex: 1; min-width: 0; }
.brand.switchable {
  cursor: pointer;
  user-select: none;
  transition: background 0.15s;
}
.brand.switchable:hover { background: rgba(255, 255, 255, 0.04); }
.brand.switchable:hover img { box-shadow: 0 0 0 2px var(--el-color-primary); }
.brand-caret {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  color: var(--el-text-color-secondary);
  transition: transform 0.15s, color 0.15s;
}
.brand.switchable:hover .brand-caret { color: var(--el-color-primary); }
.brand-caret.open { transform: rotate(180deg); color: var(--el-color-primary); }
.brand-sub {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.menu {
  border-right: none;
  background: transparent;
  flex: 1;
  overflow-y: auto;
  padding-bottom: 16px;
}
/* 菜单项矮一点，一屏放得下；选中的项浅金底、左边一道金线，和小程序点单页的分类栏一样 */
.menu :deep(.el-menu-item) {
  position: relative;
  height: 38px;
  line-height: 38px;
  margin: 1px 10px;
  padding: 0 14px !important;
  border-radius: 8px;
  color: var(--el-text-color-regular);
}
.menu :deep(.el-menu-item:hover) { background: rgba(255, 255, 255, 0.04); }
.menu :deep(.el-menu-item.is-active) {
  background: var(--gold-soft);
  color: var(--el-color-primary);
  font-weight: 600;
}
.menu :deep(.el-menu-item.is-active)::before {
  content: '';
  position: absolute;
  left: 0;
  top: 10px;
  bottom: 10px;
  width: 3px;
  border-radius: 2px;
  background: var(--el-color-primary);
}
.menu-group {
  padding: 12px 24px 4px;
  font-size: 12px;
  letter-spacing: 1px;
  color: var(--el-text-color-placeholder);
}
.header {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 56px;
  padding: 0 24px;
  border-bottom: 1px solid var(--el-border-color);
  background: #121110;
}
.header .title {
  font-size: 18px;
  font-weight: 600;
}
.header .spacer { flex: 1; }
.header .preview { margin-left: 12px; }
.main { background: var(--el-bg-color-page); padding: 24px; }

/* 手机和窄屏：菜单放到顶上横着滑 */
@media (max-width: 760px) {
  .layout { flex-direction: column; height: auto; min-height: 100%; }
  .aside { width: auto !important; border-right: none; border-bottom: 1px solid var(--el-border-color); }
  .brand { padding: 10px 16px; border-bottom: none; }
  .brand img { width: 32px; height: 32px; }
  .menu { display: flex; overflow-x: auto; padding: 0 8px; }
  .menu-group { display: none; }
  .menu { padding-bottom: 6px; }
  .menu :deep(.el-menu-item) { height: 36px; line-height: 36px; margin: 0 2px; padding: 0 12px !important; white-space: nowrap; }
  .menu :deep(.el-menu-item.is-active)::before { left: 12px; right: 12px; top: auto; bottom: 2px; width: auto; height: 2px; }
  .header { flex-wrap: wrap; height: auto; padding: 10px max(16px, env(safe-area-inset-right, 0px)) 10px max(16px, env(safe-area-inset-left, 0px)); }
  .header .preview { margin-left: 0; order: 10; }
  .main { padding: 16px max(16px, env(safe-area-inset-right, 0px)) 16px max(16px, env(safe-area-inset-left, 0px)); }
}
</style>
