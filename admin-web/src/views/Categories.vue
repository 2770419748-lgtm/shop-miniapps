<template>
  <div class="narrow">
    <div class="toolbar">
      <el-input v-model="newName" placeholder="新分类名称，比如 咖啡" maxlength="10" style="width: 240px" @keyup.enter="add" />
      <el-button type="primary" @click="add">添加分类</el-button>
    </div>
    <el-table :data="categories" v-loading="loading" empty-text="还没有分类">
      <el-table-column label="顺序" width="70" type="index" />
      <el-table-column label="名称">
        <template #default="{ row }"><div class="name-cell"><span>{{ row.name }}</span><span class="muted small">{{ counts[row._id] || 0 }} 个商品</span></div></template>
      </el-table-column>
      <el-table-column label="操作" width="280">
        <template #default="{ row, $index }">
          <el-button size="small" :disabled="$index === 0" @click="move($index, -1)">上移</el-button>
          <el-button size="small" :disabled="$index === categories.length - 1" @click="move($index, 1)">下移</el-button>
          <el-button size="small" link type="primary" @click="rename(row)">改名</el-button>
          <el-button size="small" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="tip">顾客菜单按这里的顺序显示分类；没有上架商品的分类顾客看不到。</div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import { api } from '../api'

const categories = ref([])
const counts = ref({})
const newName = ref('')
const loading = ref(false)

async function load() {
  loading.value = true
  try {
    const res = await api.coffee('adminListProducts')
    categories.value = res.categories
    const c = {}
    res.products.forEach((p) => { c[p.categoryId] = (c[p.categoryId] || 0) + 1 })
    counts.value = c
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

async function run(fn) {
  try {
    await fn()
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

function add() {
  if (!newName.value.trim()) return
  run(async () => {
    await api.coffee('saveCategory', { name: newName.value })
    newName.value = ''
  })
}

async function rename(row) {
  let value
  try {
    const res = await ElMessageBox.prompt('新的分类名称', '改名', { inputValue: row.name, confirmButtonText: '保存', cancelButtonText: '取消' })
    value = res.value
  } catch (e) {
    return
  }
  run(() => api.coffee('saveCategory', { id: row._id, name: value }))
}

function move(index, delta) {
  const ids = categories.value.map((c) => c._id)
  const [id] = ids.splice(index, 1)
  ids.splice(index + delta, 0, id)
  run(() => api.coffee('sortCategories', { ids }))
}

async function remove(row) {
  try {
    await ElMessageBox.confirm('删除分类「' + row.name + '」？', '删除分类', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  run(() => api.coffee('deleteCategory', { id: row._id }))
}

onMounted(load)
</script>

<style scoped>
.small { font-size: 12px; white-space: nowrap; }
/* 名称和商品数：放不下时数量整体换到下一行、靠左，不拆成「3 / 个商品」 */
.name-cell { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; }
.tip { margin-top: 12px; }
</style>
