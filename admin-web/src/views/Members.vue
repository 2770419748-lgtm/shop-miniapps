<template>
  <div>
    <div class="cards" v-if="stats">
      <div class="stat primary">
        <div class="label">今天充值</div>
        <div class="value">¥{{ yuan(stats.totals.onlineFee + stats.totals.counterFee) }}</div>
        <div class="sub">{{ stats.totals.recharges }} 笔 · 送出 ¥{{ yuan(stats.totals.bonusFee) }}</div>
      </div>
      <div class="stat">
        <div class="label">今天余额消费</div>
        <div class="value">¥{{ yuan(stats.totals.spentFee - stats.totals.refundFee) }}</div>
        <div class="sub">退回 ¥{{ yuan(stats.totals.refundFee) }}</div>
      </div>
      <div class="stat">
        <div class="label">顾客余额合计</div>
        <div class="value">¥{{ yuan(stats.balanceTotal) }}</div>
        <div class="sub">还没花掉的储值（含赠送）</div>
      </div>
      <div class="stat">
        <div class="label">会员人数</div>
        <div class="value">{{ stats.memberCount }} 人</div>
        <div class="sub">会员期还没过的</div>
      </div>
    </div>

    <div class="toolbar">
      <el-input v-model="keyword" placeholder="会员号，或备注里的名字、手机尾号" clearable style="width: 300px; flex-grow: 0" @keyup.enter="reload" @clear="reload" />
      <el-button type="primary" @click="reload">查找</el-button>
      <span class="tip">顾客到吧台充值时，让他打开小程序「我的 → 会员中心」报会员号。</span>
    </div>

    <el-table :data="members" v-loading="loading" row-key="memberNo" empty-text="还没有会员。顾客打开会员中心就会有会员号" @row-click="open">
      <el-table-column label="会员号" width="110">
        <template #default="{ row }"><b class="no">{{ row.memberNo }}</b></template>
      </el-table-column>
      <el-table-column label="备注" min-width="160">
        <template #default="{ row }"><span :class="{ muted: !row.remark }">{{ row.remark || '没有备注' }}</span></template>
      </el-table-column>
      <el-table-column label="余额" width="120">
        <template #default="{ row }"><span class="gold">¥{{ yuan(row.balance) }}</span></template>
      </el-table-column>
      <el-table-column label="星星" width="80">
        <template #default="{ row }"><span v-if="row.stars">★ {{ row.stars }}</span><span v-else class="muted">0</span></template>
      </el-table-column>
      <el-table-column label="会员" width="170">
        <template #default="{ row }">
          <el-tag v-if="row.isMember" size="small">至 {{ row.memberUntil }}</el-tag>
          <span v-else-if="row.memberUntil" class="muted">{{ row.memberUntil }} 已到期</span>
          <span v-else class="muted">不是会员</span>
        </template>
      </el-table-column>
      <el-table-column label="累计充值" width="120">
        <template #default="{ row }">¥{{ yuan(row.totalRecharge) }}</template>
      </el-table-column>
      <el-table-column label="最近变动" width="120">
        <template #default="{ row }">{{ time(row.updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="" width="80">
        <template #default><el-button size="small" link type="primary">详情</el-button></template>
      </el-table-column>
    </el-table>
    <div class="more" v-if="hasMore"><el-button @click="load(false)" :loading="loading">加载更多</el-button></div>

    <el-drawer v-model="drawer" :title="detail ? '会员 ' + detail.member.memberNo : '会员'" size="520px">
      <template v-if="detail">
        <div class="card">
          <div class="row">
            <div>
              <div class="muted small">余额</div>
              <div class="big gold">¥{{ yuan(detail.member.balance) }}</div>
            </div>
            <div class="right">
              <el-tag v-if="detail.member.isMember">会员至 {{ detail.member.memberUntil }}</el-tag>
              <span v-else class="muted">{{ detail.member.memberUntil ? detail.member.memberUntil + ' 已到期' : '不是会员' }}</span>
            </div>
          </div>
          <div class="muted small">累计充值 ¥{{ yuan(detail.member.totalRecharge) }} · 送 ¥{{ yuan(detail.member.totalBonus) }} · 消费 ¥{{ yuan(detail.member.totalSpent) }}</div>
          <div class="stars" v-if="detail.starSettings.enabled || detail.member.stars">
            集星 <b class="gold">★ {{ detail.member.stars }}</b> 颗
            <span class="muted small" v-if="detail.starSettings.enabled">（{{ detail.starSettings.need }} 颗换一杯；累计得 {{ detail.member.starsEarned }} 颗、换掉 {{ detail.member.starsUsed }} 颗）</span>
          </div>
          <div class="remark">
            <el-input v-model="remark" placeholder="备注：名字、手机尾号，方便找" maxlength="30" size="small" />
            <el-button size="small" @click="saveRemark" :disabled="remark === detail.member.remark">保存备注</el-button>
          </div>
        </div>

        <div class="actions">
          <el-button type="primary" @click="rechargeDialog = true" :disabled="!detail.plans.length">吧台充值</el-button>
          <el-button v-if="isOwner" @click="openAdjust">调整余额 / 会员</el-button>
          <el-button v-if="isOwner && (detail.starSettings.enabled || detail.member.stars)" @click="openStars">加减星</el-button>
          <span v-if="!detail.plans.length" class="muted small">还没有上架的充值档位</span>
        </div>

        <div class="section">最近 50 笔</div>
        <el-table :data="detail.logs" size="small" empty-text="还没有余额变动">
          <el-table-column label="时间" width="95"><template #default="{ row }">{{ time(row.createdAt) }}</template></el-table-column>
          <el-table-column label="内容" min-width="150">
            <template #default="{ row }">
              <div>{{ row.title || row.typeName }}</div>
              <div class="muted small">{{ row.typeName }}<span v-if="row.operatorName"> · {{ row.operatorName }}</span></div>
              <div v-if="row.reason" class="muted small">原因：{{ row.reason }}</div>
            </template>
          </el-table-column>
          <el-table-column label="变动" width="80">
            <template #default="{ row }"><span :class="{ gold: row.amount > 0 }">{{ signed(row.amount) }}</span></template>
          </el-table-column>
          <el-table-column label="余额" width="80"><template #default="{ row }">{{ yuan(row.balance) }}</template></el-table-column>
        </el-table>

        <template v-if="detail.starLogs.length">
          <div class="section star-section">集星记录（最近 50 笔）</div>
          <el-table :data="detail.starLogs" size="small">
            <el-table-column label="时间" width="95"><template #default="{ row }">{{ time(row.createdAt) }}</template></el-table-column>
            <el-table-column label="内容" min-width="150">
              <template #default="{ row }">
                <div>{{ row.title || row.typeName }}</div>
                <div class="muted small">{{ row.typeName }}<span v-if="row.operatorName"> · {{ row.operatorName }}</span></div>
                <div v-if="row.reason" class="muted small">原因：{{ row.reason }}</div>
              </template>
            </el-table-column>
            <el-table-column label="变动" width="80">
              <template #default="{ row }"><span :class="{ gold: row.amount > 0 }">{{ row.amount > 0 ? '+' : '' }}{{ row.amount }}</span></template>
            </el-table-column>
            <el-table-column label="剩" width="80"><template #default="{ row }">{{ row.stars }} 颗</template></el-table-column>
          </el-table>
        </template>
      </template>
    </el-drawer>

    <el-dialog v-model="rechargeDialog" title="吧台充值" width="460px">
      <div class="tip">先收顾客的钱（现金或收款码），再点对应的档位。</div>
      <div v-for="p in (detail ? detail.plans : [])" :key="p._id" class="plan" @click="recharge(p)">
        <div>
          <div class="gold plan-title">{{ p.title }}</div>
          <div class="muted small">收 ¥{{ yuan(p.price) }}，到账 ¥{{ yuan(p.price + p.bonus) }}<span v-if="p.memberDays">，送 {{ p.memberDays }} 天会员</span></div>
          <div class="gold small" v-if="p.giftText">{{ p.giftText }}</div>
        </div>
        <el-button size="small" type="primary" plain :loading="busy">充这档</el-button>
      </div>
    </el-dialog>

    <el-dialog v-model="adjustDialog" title="调整余额 / 会员" width="480px" :close-on-click-modal="false">
      <div class="tip">线下退款后扣掉余额、补偿顾客、改会员到期日都在这里，会记在流水里。</div>
      <el-form label-width="90px">
        <el-form-item label="余额">
          <el-radio-group v-model="adjust.sign" size="small">
            <el-radio-button :value="-1">扣</el-radio-button>
            <el-radio-button :value="1">加</el-radio-button>
          </el-radio-group>
          <el-input-number v-model="adjust.yuan" :min="0" :max="10000" :precision="2" :step="10" class="sep" />
          <span class="muted small sep">元</span>
        </el-form-item>
        <el-form-item label="会员到期">
          <el-radio-group v-model="adjust.untilMode" size="small">
            <el-radio-button value="keep">不改</el-radio-button>
            <el-radio-button value="set">改日期</el-radio-button>
            <el-radio-button value="clear">取消会员</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="改到" v-if="adjust.untilMode === 'set'">
          <el-date-picker v-model="adjust.until" type="date" value-format="YYYY-MM-DD" :clearable="false" />
        </el-form-item>
        <el-form-item label="原因" required>
          <el-input v-model="adjust.reason" maxlength="40" placeholder="比如：线下退款、活动补偿" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="adjustDialog = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitAdjust">确认调整</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="starDialog" title="加减星" width="440px" :close-on-click-modal="false">
      <div class="tip">在店里买了没用小程序的补上、补偿顾客、扣掉多给的都在这里，会记在集星记录里。现在 {{ detail ? detail.member.stars : 0 }} 颗。</div>
      <el-form label-width="70px">
        <el-form-item label="星星">
          <el-radio-group v-model="starAdjust.sign" size="small">
            <el-radio-button :value="1">加</el-radio-button>
            <el-radio-button :value="-1">扣</el-radio-button>
          </el-radio-group>
          <el-input-number v-model="starAdjust.count" :min="1" :max="1000" class="sep" />
          <span class="muted small sep">颗</span>
        </el-form-item>
        <el-form-item label="原因" required>
          <el-input v-model="starAdjust.reason" maxlength="40" placeholder="比如：在店里买了没用小程序" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="starDialog = false">取消</el-button>
        <el-button type="primary" :loading="busy" @click="submitStars">确认</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, session } from '../api'
import { yuan, time, cnDay } from '../format'

const members = ref([])
const keyword = ref('')
const loading = ref(false)
const hasMore = ref(false)
const stats = ref(null)
const drawer = ref(false)
const detail = ref(null)
const remark = ref('')
const rechargeDialog = ref(false)
const adjustDialog = ref(false)
const adjust = ref({})
const starDialog = ref(false)
const starAdjust = ref({})
const busy = ref(false)
let page = 0

const isOwner = computed(() => session.staff && session.staff.role === 'owner')
const signed = (fen) => (fen > 0 ? '+' : fen < 0 ? '-' : '') + yuan(Math.abs(fen || 0))

async function load(reset) {
  if (reset) page = 0
  loading.value = true
  try {
    const res = await api.member('listMembers', { keyword: keyword.value, page })
    page++
    members.value = reset ? res.members : members.value.concat(res.members)
    hasMore.value = res.hasMore
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function reload() {
  load(true)
}

async function loadStats() {
  if (!isOwner.value) return
  try {
    stats.value = await api.member('memberSummary', {})
  } catch (e) {
    // 汇总没出来不影响找会员
  }
}

async function loadDetail(no) {
  try {
    detail.value = await api.member('getMemberDetail', { memberNo: no })
    remark.value = detail.value.member.remark
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function open(row) {
  detail.value = null
  drawer.value = true
  await loadDetail(row.memberNo)
}

// 充值、调整以后刷新详情、列表和汇总
async function refresh() {
  await loadDetail(detail.value.member.memberNo)
  load(true)
  loadStats()
}

async function saveRemark() {
  try {
    await api.member('setMemberRemark', { memberNo: detail.value.member.memberNo, remark: remark.value })
    ElMessage.success('备注已保存')
    refresh()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function recharge(plan) {
  const no = detail.value.member.memberNo
  const gift = (plan.memberDays ? '，送 ' + plan.memberDays + ' 天会员' : '') + (plan.giftText ? '，' + plan.giftText : '')
  try {
    await ElMessageBox.confirm('已经收到顾客 ¥' + yuan(plan.price) + '（现金或收款码）。给会员 ' + no + ' 充 ¥' + yuan(plan.price + plan.bonus) + gift + '。', '确认收到钱了吗', { confirmButtonText: '确认充值', cancelButtonText: '再想想' })
  } catch (e) {
    return
  }
  busy.value = true
  try {
    const res = await api.member('counterRecharge', { memberNo: no, planId: plan._id })
    const sent = (res.gifts || []).map((g) => g.title + ' ' + g.count + ' 张').join('、')
    ElMessage.success('已充值，余额 ¥' + yuan(res.balance) + (sent ? '，已送' + sent : ''))
    if (res.giftError) ElMessage.warning(res.giftError)
    rechargeDialog.value = false
    refresh()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}

function openAdjust() {
  const m = detail.value.member
  adjust.value = { sign: -1, yuan: 0, untilMode: 'keep', until: m.memberUntil || cnDay(), reason: '' }
  adjustDialog.value = true
}

async function submitAdjust() {
  const a = adjust.value
  const m = detail.value.member
  const amount = a.sign * Math.round(Number(a.yuan || 0) * 100)
  const params = { memberNo: m.memberNo, amount, reason: a.reason.trim() }
  if (a.untilMode === 'set') params.memberUntil = a.until
  if (a.untilMode === 'clear') params.memberUntil = ''
  if (!amount && params.memberUntil === undefined) return ElMessage.warning('金额和会员到期日都没改')
  if (!params.reason) return ElMessage.warning('请写上原因，比如「线下退款」')
  if (amount < 0 && -amount > m.balance) return ElMessage.warning('余额只有 ¥' + yuan(m.balance))
  busy.value = true
  try {
    await api.member('adjustMember', params)
    ElMessage.success('已调整')
    adjustDialog.value = false
    refresh()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}

function openStars() {
  starAdjust.value = { sign: 1, count: 1, reason: '' }
  starDialog.value = true
}

async function submitStars() {
  const a = starAdjust.value
  const m = detail.value.member
  const reason = a.reason.trim()
  if (!reason) return ElMessage.warning('请写上原因，比如「在店里买了没用小程序」')
  if (a.sign < 0 && a.count > m.stars) return ElMessage.warning('只有 ' + m.stars + ' 颗星')
  busy.value = true
  try {
    const res = await api.member('adjustStars', { memberNo: m.memberNo, amount: a.sign * a.count, reason })
    ElMessage.success('现在 ' + res.stars + ' 颗星')
    starDialog.value = false
    refresh()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  load(true)
  loadStats()
})
</script>

<style scoped>
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 12px;
  margin-bottom: 16px;
}
.stat {
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color);
  border-radius: 12px;
  padding: 16px;
}
.stat.primary {
  border-color: var(--el-color-primary);
  background: linear-gradient(135deg, #2a2316, #141312);
}
.label {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.value {
  font-size: 26px;
  font-weight: 700;
  margin: 6px 0;
  color: var(--el-color-primary);
}
.sub {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.no { letter-spacing: 1px; }
.small { font-size: 12px; }
.more { text-align: center; margin-top: 12px; }
.card {
  border: 1px solid var(--el-color-primary-light-5);
  border-radius: 12px;
  padding: 16px;
  background: linear-gradient(135deg, #2a2316, #141312);
  margin-bottom: 16px;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 8px;
}
.right { text-align: right; }
.big {
  font-size: 30px;
  font-weight: 700;
}
.remark {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 16px;
}
.section {
  font-size: 13px;
  color: var(--el-text-color-secondary);
  margin-bottom: 8px;
}
.star-section { margin-top: 20px; }
.stars {
  margin-top: 8px;
  font-size: 14px;
}
.plan {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  margin-top: 10px;
  border: 1px solid var(--el-border-color);
  border-radius: 10px;
  cursor: pointer;
}
.plan:hover { border-color: var(--el-color-primary); }
.plan-title { font-weight: 600; }
.sep { margin-left: 8px; }
</style>
