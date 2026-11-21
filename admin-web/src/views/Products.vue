<template>
  <div>
    <div class="toolbar">
      <el-select v-model="category" style="width: 160px">
        <el-option label="全部分类" value="all" />
        <el-option v-for="c in categories" :key="c._id" :label="c.name" :value="c._id" />
      </el-select>
      <el-input v-model="keyword" placeholder="搜商品名" clearable style="width: 200px" />
      <span class="spacer"></span>
      <el-button v-if="!products.length && isOwner" @click="seedDemo">导入示例菜单</el-button>
      <el-button type="primary" @click="openEdit(null)">新增商品</el-button>
    </div>

    <el-table :data="list" v-loading="loading" empty-text="还没有商品" row-key="_id">
      <el-table-column label="图片" width="80">
        <template #default="{ row }"><div class="thumb"><CloudImage :src="row.image" :text="row.name" /></div></template>
      </el-table-column>
      <el-table-column label="名称" min-width="160">
        <template #default="{ row }">
          <div>{{ row.name }}</div>
          <div class="muted small" v-if="row.desc">{{ row.desc }}</div>
        </template>
      </el-table-column>
      <el-table-column label="分类" width="110">
        <template #default="{ row }">{{ catName(row.categoryId) }}</template>
      </el-table-column>
      <el-table-column label="价格" width="90">
        <template #default="{ row }"><span class="gold">¥{{ yuan(row.price) }}</span></template>
      </el-table-column>
      <el-table-column label="规格" min-width="160">
        <template #default="{ row }">
          <div v-for="g in row.specs" :key="g.name" class="small">
            {{ g.name }}：<span v-for="(o, i) in g.options" :key="o.name" class="opt">{{ i ? '、' : '' }}{{ o.name }}<span v-if="o.price" class="muted">+{{ yuan(o.price) }}</span></span>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="上架" width="80">
        <template #default="{ row }"><el-switch :model-value="row.onShelf" @change="(v) => setFlag(row, 'onShelf', v)" /></template>
      </el-table-column>
      <el-table-column label="售罄" width="80">
        <template #default="{ row }"><el-switch :model-value="row.soldOut" @change="(v) => setFlag(row, 'soldOut', v)" style="--el-switch-on-color: var(--el-color-danger)" /></template>
      </el-table-column>
      <el-table-column label="排序" prop="sort" width="70" />
      <el-table-column label="操作" width="130">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialog" :title="form._id ? '编辑商品' : '新增商品'" width="640px" :close-on-click-modal="false">
      <el-form label-width="100px">
        <el-form-item label="图片"><ImageUpload v-model="form.image" dir="products" /></el-form-item>
        <el-form-item label="名称" required><el-input v-model="form.name" maxlength="30" show-word-limit /></el-form-item>
        <el-form-item label="分类" required>
          <el-select v-model="form.categoryId" placeholder="请选择">
            <el-option v-for="c in categories" :key="c._id" :label="c.name" :value="c._id" />
          </el-select>
        </el-form-item>
        <el-form-item label="价格（元）" required>
          <el-input-number v-model="form.priceYuan" :min="0" :max="1000" :precision="2" :step="1" />
        </el-form-item>
        <el-form-item label="简介"><el-input v-model="form.desc" maxlength="60" placeholder="选填" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="form.sort" :step="1" /> <span class="muted small" style="margin-left: 8px">数字越小越靠前</span></el-form-item>
        <el-form-item label="状态">
          <el-checkbox v-model="form.onShelf">上架</el-checkbox>
          <el-checkbox v-model="form.soldOut">售罄</el-checkbox>
        </el-form-item>
        <el-form-item label="规格">
          <div class="specs">
            <div v-for="(g, gi) in form.specs" :key="gi" class="spec">
              <div class="spec-head">
                <el-input v-model="g.name" placeholder="规格名，比如 杯型" maxlength="10" style="width: 180px" />
                <el-button link @click="form.specs.splice(gi, 1)">删除这组</el-button>
              </div>
              <div v-for="(o, oi) in g.options" :key="oi" class="option">
                <el-input v-model="o.name" placeholder="选项" maxlength="10" style="width: 140px" />
                <span class="muted">加价</span>
                <el-input-number v-model="o.priceYuan" :min="0" :max="100" :precision="2" size="small" controls-position="right" style="width: 110px" />
                <span class="muted">元</span>
                <el-button link @click="g.options.splice(oi, 1)">×</el-button>
              </div>
              <el-button link type="primary" size="small" @click="g.options.push({ name: '', priceYuan: 0 })">+ 加选项</el-button>
            </div>
            <div>
              <el-button size="small" v-for="p in PRESETS" :key="p.name" @click="addPreset(p)">+ {{ p.name }}</el-button>
              <el-button size="small" @click="form.specs.push({ name: '', options: [{ name: '', priceYuan: 0 }] })">+ 自定义</el-button>
            </div>
          </div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api, session } from '../api'
import { yuan } from '../format'
import CloudImage from '../components/CloudImage.vue'
import ImageUpload from '../components/ImageUpload.vue'

const PRESETS = [
  { name: '杯型', options: [['中杯', 0], ['大杯', 3]] },
  { name: '温度', options: [['热', 0], ['冰', 0]] },
  { name: '糖度', options: [['标准糖', 0], ['少糖', 0], ['无糖', 0]] }
]

const isOwner = computed(() => session.staff && session.staff.role === 'owner')
const categories = ref([])
const products = ref([])
const category = ref('all')
const keyword = ref('')
const loading = ref(false)
const dialog = ref(false)
const saving = ref(false)
const form = ref({})

const list = computed(() => products.value.filter((p) =>
  (category.value === 'all' || p.categoryId === category.value) &&
  (!keyword.value || p.name.indexOf(keyword.value.trim()) !== -1)))

function catName(id) {
  const c = categories.value.find((x) => x._id === id)
  return c ? c.name : '未分类'
}

async function load() {
  loading.value = true
  try {
    const res = await api.coffee('adminListProducts')
    categories.value = res.categories
    products.value = res.products
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function setFlag(row, key, value) {
  const old = row[key]
  row[key] = value
  try {
    await api.coffee('setProductFlags', { id: row._id, [key]: value })
  } catch (e) {
    row[key] = old
    ElMessage.error(e.message)
  }
}

function openEdit(row) {
  if (!categories.value.length) {
    ElMessage.warning('先到「分类管理」建一个分类')
    return
  }
  const p = row || { name: '', desc: '', price: 0, image: '', onShelf: true, soldOut: false, sort: 0, specs: [], categoryId: category.value === 'all' ? '' : category.value }
  form.value = {
    _id: p._id,
    name: p.name,
    desc: p.desc || '',
    categoryId: p.categoryId,
    priceYuan: p.price / 100,
    image: p.image || '',
    onShelf: p.onShelf !== false,
    soldOut: !!p.soldOut,
    sort: p.sort || 0,
    specs: (p.specs || []).map((g) => ({ name: g.name, options: g.options.map((o) => ({ name: o.name, priceYuan: (o.price || 0) / 100 })) }))
  }
  dialog.value = true
}

function addPreset(p) {
  if (form.value.specs.some((g) => g.name === p.name)) {
    ElMessage.warning('已经有' + p.name + '了')
    return
  }
  form.value.specs.push({ name: p.name, options: p.options.map(([name, price]) => ({ name, priceYuan: price })) })
}

const fen = (v) => Math.round(Number(v || 0) * 100)

async function save() {
  const f = form.value
  if (!f.name.trim()) return ElMessage.warning('请填写商品名称')
  if (!f.categoryId) return ElMessage.warning('请选择分类')
  const product = {
    name: f.name.trim(),
    desc: f.desc.trim(),
    categoryId: f.categoryId,
    price: fen(f.priceYuan),
    image: f.image,
    onShelf: f.onShelf,
    soldOut: f.soldOut,
    sort: f.sort || 0,
    specs: f.specs.map((g) => ({ name: g.name.trim(), options: g.options.map((o) => ({ name: o.name.trim(), price: fen(o.priceYuan) })) }))
  }
  if (f._id) product._id = f._id
  saving.value = true
  try {
    await api.coffee('saveProduct', { product })
    ElMessage.success('已保存')
    dialog.value = false
    load()
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    saving.value = false
  }
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('删除「' + row.name + '」后不能恢复。只是暂时不卖的话，关掉上架就好。', '删除商品', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.coffee('deleteProduct', { id: row._id })
    ElMessage.success('已删除')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function seedDemo() {
  try {
    const res = await api.coffee('seedDemo')
    ElMessage.success('已导入 ' + res.productCount + ' 个示例商品')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

onMounted(load)
</script>

<style scoped>
.thumb {
  width: 52px;
  height: 52px;
}
.small { font-size: 12px; }
/* 一个选项（「、无糖」）不拆开，换行只发生在选项之间 */
.opt { white-space: nowrap; }
.specs { width: 100%; }
.spec {
  border: 1px solid var(--el-border-color);
  border-radius: 8px;
  padding: 10px;
  margin-bottom: 10px;
}
.spec-head {
  display: flex;
  justify-content: space-between;
  margin-bottom: 6px;
}
.option {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
</style>
