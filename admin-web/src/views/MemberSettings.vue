<template>
  <div>
    <el-card shadow="never" class="block">
      <template #header>储值设置</template>
      <el-form label-width="120px" v-loading="loading">
        <el-form-item label="会员储值">
          <el-switch v-model="form.enabled" />
          <span class="muted small sep">{{ form.enabled ? '顾客能看到会员中心和充值档位，能用余额点单、借书、预约' : '没打开，顾客看不到充值' }}</span>
        </el-form-item>
        <el-form-item label="会员免费看">
          <el-checkbox-group v-model="form.freeCategories" v-if="categories.length">
            <el-checkbox v-for="c in categories" :key="c" :value="c">{{ c }}</el-checkbox>
          </el-checkbox-group>
          <span v-else class="muted small">书目里还没有分类，录书时填上分类（比如「漫画」）就能选了。</span>
          <div class="muted small full">会员期内借这些分类的书不收钱、不计时，当天打烊前还。</div>
        </el-form-item>
        <el-form-item label="储值说明">
          <el-input v-model="form.notice" type="textarea" :rows="2" maxlength="120" show-word-limit placeholder="显示在会员中心最下面，比如：储值金额不能提现" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" :loading="saving" @click="saveSettings">保存设置</el-button>
          <span class="muted small sep">{{ payEnabled ? '微信支付已开通，顾客可以在小程序里自己充。' : '微信支付还没开通，顾客到吧台付钱，店员在「会员储值」里按会员号给他充。' }}</span>
        </el-form-item>
      </el-form>
    </el-card>

    <div class="toolbar">
      <span class="tip">充值档位：顾客付多少、送多少、送几天会员、送哪些代金券。会员天数从充值当天算第 1 天，已经是会员的从原来的到期日往后加。送的券在充值成功（在线付款或吧台代充）时自动发到顾客的「我的券」。</span>
      <span class="spacer"></span>
      <el-button type="primary" @click="openEdit(null)">新增档位</el-button>
    </div>
    <el-table :data="plans" row-key="_id" empty-text="还没有充值档位，新增一个，比如「充 300 送 100，送 365 天会员」">
      <el-table-column label="顺序" width="90">
        <template #default="{ $index }">
          <el-button size="small" link :disabled="$index === 0" @click="move($index, -1)">↑</el-button>
          <el-button size="small" link :disabled="$index === plans.length - 1" @click="move($index, 1)">↓</el-button>
        </template>
      </el-table-column>
      <el-table-column label="名称" min-width="140">
        <template #default="{ row }">
          <div class="gold">{{ row.title }}</div>
          <div class="muted small" v-if="row.desc">{{ row.desc }}</div>
        </template>
      </el-table-column>
      <el-table-column label="收" width="100"><template #default="{ row }">¥{{ yuan(row.price) }}</template></el-table-column>
      <el-table-column label="送" width="100"><template #default="{ row }">¥{{ yuan(row.bonus) }}</template></el-table-column>
      <el-table-column label="到账" width="100"><template #default="{ row }">¥{{ yuan(row.price + row.bonus) }}</template></el-table-column>
      <el-table-column label="送会员" width="100"><template #default="{ row }">{{ row.memberDays ? row.memberDays + ' 天' : '不送' }}</template></el-table-column>
      <el-table-column label="送券" min-width="200">
        <template #default="{ row }">
          <div v-for="g in row.gifts" :key="g.couponId" class="gift-line">{{ g.title }} × {{ g.count }}</div>
          <span v-if="!row.gifts.length" class="muted">不送</span>
        </template>
      </el-table-column>
      <el-table-column label="上架" width="80">
        <template #default="{ row }"><el-switch :model-value="row.enabled" @change="(v) => setEnabled(row, v)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="120">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="plan._id ? '编辑充值档位' : '新增充值档位'" width="560px" :close-on-click-modal="false">
      <el-form label-width="110px">
        <el-form-item label="充多少（元）" required>
          <el-input-number v-model="plan.priceYuan" :min="0.01" :max="10000" :precision="2" :step="50" />
        </el-form-item>
        <el-form-item label="送多少（元）">
          <el-input-number v-model="plan.bonusYuan" :min="0" :max="10000" :precision="2" :step="50" />
          <span class="muted small sep">0 就是不送</span>
        </el-form-item>
        <el-form-item label="送会员天数">
          <el-input-number v-model="plan.memberDays" :min="0" :max="3650" :step="30" />
          <span class="muted small sep">一年填 365，0 就是不送</span>
        </el-form-item>
        <el-form-item label="送代金券">
          <div class="full">
            <div v-for="(g, i) in plan.gifts" :key="i" class="gift-row">
              <el-select v-model="g.couponId" placeholder="选一张券" class="gift-pick">
                <el-option v-for="c in coupons" :key="c._id" :label="couponLabel(c)" :value="c._id" />
              </el-select>
              <el-input-number v-model="g.count" :min="1" :max="20" size="small" />
              <span class="muted small">张</span>
              <el-button link @click="plan.gifts.splice(i, 1)">去掉</el-button>
            </div>
            <el-button size="small" :disabled="!coupons.length || plan.gifts.length >= 5" @click="plan.gifts.push({ couponId: '', count: 1 })">+ 加一种券</el-button>
            <div class="muted small" v-if="!coupons.length">还没有代金券。先到「代金券」里新增，比如「基础饮品券」，怎么发选「只在充值时送」。</div>
            <div class="muted small" v-else>券的金额、能用在哪些商品、有效天数在「代金券」里设。</div>
          </div>
        </el-form-item>
        <el-form-item label="名称">
          <el-input v-model="plan.title" maxlength="16" show-word-limit :placeholder="autoTitle" />
        </el-form-item>
        <el-form-item label="说明">
          <el-input v-model="plan.desc" maxlength="40" placeholder="选填，比如「最划算」" />
        </el-form-item>
        <el-form-item label="上架"><el-switch v-model="plan.enabled" /></el-form-item>
      </el-form>
      <div class="tip">改金额、送券只影响以后的充值，已经充进去的钱、送出去的券不变。</div>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="savePlan">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'
import { yuan } from '../format'

const loading = ref(false)
const saving = ref(false)
const form = ref({ enabled: false, freeCategories: [], notice: '' })
const categories = ref([])
const plans = ref([])
const payEnabled = ref(false)
const coupons = ref([])
const dialog = ref(false)
const plan = ref({})

function couponLabel(c) {
  return c.title + '（¥' + yuan(c.amount) + (c.scope ? '，' + c.scope : '') + (c.giftOnly ? '' : '，领券中心也能领') + '）'
}

const fen = (v) => Math.round(Number(v || 0) * 100)
const autoTitle = computed(() => {
  const p = plan.value
  return '不填自动叫「充 ' + yuan(fen(p.priceYuan)) + (p.bonusYuan ? ' 送 ' + yuan(fen(p.bonusYuan)) : '') + '」'
})

// first：第一次进来才把设置填进表单，之后只刷新档位，没保存的改动不丢
async function load(first) {
  loading.value = true
  try {
    const res = await api.member('getMemberSettings')
    if (first) form.value = { enabled: res.settings.enabled, freeCategories: res.settings.freeCategories.slice(), notice: res.settings.notice }
    const all = res.categories.slice()
    form.value.freeCategories.forEach((c) => { if (all.indexOf(c) === -1) all.push(c) })
    categories.value = all
    plans.value = res.plans
    payEnabled.value = res.payEnabled
    coupons.value = res.coupons || []
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function saveSettings() {
  saving.value = true
  try {
    await api.member('saveMemberSettings', form.value)
    ElMessage.success('已保存')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function setEnabled(row, value) {
  row.enabled = value
  try {
    await api.member('setPlanFlags', { id: row._id, enabled: value })
  } catch (e) {
    row.enabled = !value
    ElMessage.error(e.message)
  }
}

async function move(index, delta) {
  const list = plans.value.slice()
  const [item] = list.splice(index, 1)
  list.splice(index + delta, 0, item)
  plans.value = list
  try {
    await api.member('sortPlans', { ids: list.map((p) => p._id) })
  } catch (e) {
    ElMessage.error(e.message)
    load(false)
  }
}

function openEdit(row) {
  const p = row || { price: 30000, bonus: 10000, memberDays: 365, title: '', desc: '', enabled: true }
  plan.value = {
    _id: p._id,
    priceYuan: p.price / 100,
    bonusYuan: (p.bonus || 0) / 100,
    memberDays: p.memberDays || 0,
    title: row ? p.title : '',
    desc: p.desc || '',
    enabled: p.enabled !== false,
    gifts: (p.gifts || []).map((g) => ({ couponId: g.couponId, count: g.count }))
  }
  dialog.value = true
}

async function savePlan() {
  const p = plan.value
  const gifts = p.gifts.filter((g) => g.couponId).map((g) => ({ couponId: g.couponId, count: g.count || 1 }))
  const data = { price: fen(p.priceYuan), bonus: fen(p.bonusYuan), memberDays: p.memberDays || 0, title: p.title.trim(), desc: p.desc.trim(), enabled: p.enabled, gifts }
  if (!data.price) return ElMessage.warning('请填写充值金额')
  if (new Set(gifts.map((g) => g.couponId)).size !== gifts.length) return ElMessage.warning('同一张券选了两次，合成一行改张数就好')
  if (p._id) data._id = p._id
  saving.value = true
  try {
    await api.member('savePlan', { plan: data })
    ElMessage.success('已保存')
    dialog.value = false
    load(false)
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('删除「' + row.title + '」？删除后顾客不能再充这一档，已经充进去的钱不受影响。只是暂停的话，关掉「上架」就好。', '删除档位', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.member('deletePlan', { id: row._id })
    load(false)
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(() => load(true))
</script>

<style scoped>
.block { margin-bottom: 16px; }
.small { font-size: 12px; }
.sep { margin-left: 10px; }
.full { width: 100%; }
.tip { margin-top: 4px; }
.gift-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
.gift-pick { flex: 1; min-width: 200px; }
.gift-line { line-height: 1.6; }
</style>
