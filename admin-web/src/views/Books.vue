<template>
  <div>
    <div class="toolbar">
      <el-input v-model="keyword" placeholder="搜书名、作者、ISBN、分类" clearable style="width: 260px" />
      <el-select v-model="shelf" style="width: 120px">
        <el-option label="全部" value="all" />
        <el-option label="已上架" value="on" />
        <el-option label="已下架" value="off" />
      </el-select>
      <span class="spacer"></span>
      <el-button v-if="!books.length" @click="seedDemo">导入示例</el-button>
      <el-button @click="openImport">从 Excel 导入</el-button>
      <el-button @click="exportCsv" :disabled="!books.length">导出表格</el-button>
      <el-button type="primary" @click="openEdit(null)">录入新书</el-button>
    </div>

    <el-table :data="paged" v-loading="loading" empty-text="还没有书" row-key="_id">
      <el-table-column label="封面" width="70">
        <template #default="{ row }"><div class="cover"><CloudImage :src="row.cover" :text="row.title" /></div></template>
      </el-table-column>
      <el-table-column label="书名" min-width="180">
        <template #default="{ row }">
          <div>{{ row.title }}</div>
          <div class="muted small">{{ row.author }}</div>
        </template>
      </el-table-column>
      <el-table-column label="ISBN" prop="isbn" width="140" />
      <el-table-column label="分类" prop="category" width="100" />
      <el-table-column label="在架 / 总数" width="110">
        <template #default="{ row }"><span :class="row.available ? 'gold' : 'danger'">{{ row.available }} / {{ row.copies }}</span></template>
      </el-table-column>
      <el-table-column label="上架" width="80">
        <template #default="{ row }"><el-switch :model-value="row.onShelf" @change="(v) => setShelf(row, v)" /></template>
      </el-table-column>
      <el-table-column label="操作" width="130">
        <template #default="{ row }">
          <el-button size="small" link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button size="small" link @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
    <el-pagination
      v-if="filtered.length > pageSize"
      class="pager"
      layout="total, prev, pager, next"
      :total="filtered.length"
      :page-size="pageSize"
      v-model:current-page="page"
    />

    <el-dialog v-model="dialog" :title="form._id ? '编辑书目' : '录入新书'" width="560px" :close-on-click-modal="false">
      <el-form label-width="80px">
        <el-form-item label="封面"><ImageUpload v-model="form.cover" dir="covers" :width="100" :height="136" /></el-form-item>
        <el-form-item label="书名" required><el-input v-model="form.title" maxlength="40" /></el-form-item>
        <el-form-item label="作者"><el-input v-model="form.author" maxlength="30" /></el-form-item>
        <el-form-item label="ISBN"><el-input v-model="form.isbn" maxlength="17" placeholder="10 位或 13 位，选填" /></el-form-item>
        <el-form-item label="分类">
          <el-autocomplete v-model="form.category" :fetch-suggestions="suggestCategory" maxlength="10" placeholder="比如 文学、绘本" />
        </el-form-item>
        <el-form-item label="册数" required>
          <el-input-number v-model="form.copies" :min="Math.max(1, form.out || 0)" :max="999" />
          <span class="muted small" v-if="form.out" style="margin-left: 8px">借出 {{ form.out }} 本</span>
        </el-form-item>
        <el-form-item label="简介"><el-input v-model="form.desc" type="textarea" :rows="3" maxlength="300" show-word-limit /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="form.sort" /></el-form-item>
        <el-form-item label="上架"><el-switch v-model="form.onShelf" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="importDialog" title="从 Excel 导入书目" width="720px" :close-on-click-modal="false">
      <div class="tip">
        表格第一行写表头：<b>书名、作者、ISBN、分类、册数、简介</b>，只有书名必填，册数不填算 1 本。支持 .xlsx 和 .csv。
        <el-button link type="primary" @click="downloadTemplate">下载模板</el-button>
      </div>
      <div class="import-pick">
        <el-button @click="fileInput.click()">选择文件</el-button>
        <span class="muted">{{ fileName }}</span>
        <input ref="fileInput" type="file" accept=".xlsx,.csv" hidden @change="onFile" />
      </div>
      <template v-if="rows.length">
        <div class="muted small">共 {{ rows.length }} 行，下面是前 10 行：</div>
        <el-table :data="rows.slice(0, 10)" size="small" max-height="260">
          <el-table-column prop="title" label="书名" />
          <el-table-column prop="author" label="作者" />
          <el-table-column prop="isbn" label="ISBN" width="140" />
          <el-table-column prop="category" label="分类" width="90" />
          <el-table-column prop="copies" label="册数" width="60" />
        </el-table>
      </template>
      <el-alert v-if="result" :type="result.skipped.length ? 'warning' : 'success'" :closable="false" class="result"
        :title="'导入了 ' + result.created + ' 本' + (result.skipped.length ? '，跳过 ' + result.skipped.length + ' 行' : '')">
        <div v-for="s in result.skipped.slice(0, 20)" :key="s.row">第 {{ s.row }} 行 {{ s.title }}：{{ s.reason }}</div>
        <div v-if="result.skipped.length > 20">……</div>
      </el-alert>
      <template #footer>
        <el-button @click="importDialog = false">关闭</el-button>
        <el-button type="primary" :disabled="!rows.length || importing" :loading="importing" @click="doImport">导入{{ rows.length ? ' ' + rows.length + ' 本' : '' }}</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import readXlsxFile from 'read-excel-file'
import { api } from '../api'
import { downloadCsv, parseCsv } from '../format'
import CloudImage from '../components/CloudImage.vue'
import ImageUpload from '../components/ImageUpload.vue'

const books = ref([])
const keyword = ref('')
const shelf = ref('all')
const loading = ref(false)
const page = ref(1)
const pageSize = 50
const dialog = ref(false)
const saving = ref(false)
const form = ref({})

const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return books.value.filter((b) => {
    if (shelf.value === 'on' && !b.onShelf) return false
    if (shelf.value === 'off' && b.onShelf) return false
    if (!kw) return true
    return [b.title, b.author, b.isbn, b.category].some((v) => String(v || '').toLowerCase().indexOf(kw) !== -1)
  })
})
const paged = computed(() => filtered.value.slice((page.value - 1) * pageSize, page.value * pageSize))
watch([keyword, shelf], () => { page.value = 1 })

async function load() {
  loading.value = true
  try {
    books.value = await api.book('adminListBooks')
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    loading.value = false
  }
}

function suggestCategory(q, cb) {
  const all = []
  books.value.forEach((b) => { if (b.category && all.indexOf(b.category) === -1) all.push(b.category) })
  cb(all.filter((c) => !q || c.indexOf(q) !== -1).map((value) => ({ value })))
}

async function setShelf(row, value) {
  row.onShelf = value
  try {
    await api.book('setBookFlags', { id: row._id, onShelf: value })
  } catch (e) {
    row.onShelf = !value
    ElMessage.error(e.message)
  }
}

function openEdit(row) {
  const b = row || { title: '', author: '', isbn: '', category: '', desc: '', cover: '', copies: 1, sort: 0, onShelf: true, available: 1 }
  form.value = Object.assign({}, b, { out: row ? row.copies - row.available : 0 })
  dialog.value = true
}

async function save() {
  const f = form.value
  if (!f.title.trim()) return ElMessage.warning('请填写书名')
  const book = { title: f.title, author: f.author, isbn: f.isbn, category: f.category, desc: f.desc, cover: f.cover, copies: f.copies, sort: f.sort || 0, onShelf: f.onShelf }
  if (f._id) book._id = f._id
  saving.value = true
  try {
    await api.book('saveBook', { book })
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
    await ElMessageBox.confirm('删除《' + row.title + '》后不能恢复。只是暂时不借的话，关掉上架就好。', '删除书目', { confirmButtonText: '删除', cancelButtonText: '取消', type: 'warning' })
  } catch (e) {
    return
  }
  try {
    await api.book('deleteBook', { id: row._id })
    ElMessage.success('已删除')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

async function seedDemo() {
  try {
    await api.book('seedDemo')
    ElMessage.success('已导入示例书目和计费规则')
    load()
  } catch (e) {
    ElMessage.error(e.message)
  }
}

function exportCsv() {
  const rows = [['书名', '作者', 'ISBN', '分类', '册数', '在架', '上架', '简介']]
  books.value.forEach((b) => rows.push([b.title, b.author, b.isbn, b.category, b.copies, b.available, b.onShelf ? '是' : '否', b.desc]))
  downloadCsv('进山书目.csv', rows)
}

// ---------- Excel 导入 ----------

const HEADERS = {
  title: ['书名', 'title', '名称'],
  author: ['作者', 'author'],
  isbn: ['isbn', '书号'],
  category: ['分类', 'category', '类别'],
  copies: ['册数', 'copies', '数量', '本数'],
  desc: ['简介', 'desc', '介绍', '备注']
}
const importDialog = ref(false)
const fileInput = ref(null)
const fileName = ref('')
const rows = ref([])
const importing = ref(false)
const result = ref(null)

function openImport() {
  rows.value = []
  fileName.value = ''
  result.value = null
  importDialog.value = true
}

function downloadTemplate() {
  downloadCsv('书目导入模板.csv', [['书名', '作者', 'ISBN', '分类', '册数', '简介'], ['小王子', '圣埃克苏佩里', '9787020042494', '文学', '2', '']])
}

function toRows(table) {
  if (!table.length) return []
  const head = table[0].map((h) => String(h === null || h === undefined ? '' : h).trim().toLowerCase())
  const col = {}
  Object.keys(HEADERS).forEach((key) => { col[key] = head.findIndex((h) => HEADERS[key].indexOf(h) !== -1) })
  if (col.title === -1) throw new Error('第一行没找到「书名」这一列')
  return table.slice(1).map((r, i) => {
    const get = (key) => (col[key] === -1 || r[col[key]] === null || r[col[key]] === undefined ? '' : String(r[col[key]]).trim())
    return { row: i + 2, title: get('title'), author: get('author'), isbn: get('isbn'), category: get('category'), copies: get('copies'), desc: get('desc') }
  }).filter((r) => r.title || r.author || r.isbn)
}

async function onFile(e) {
  const file = e.target.files[0]
  e.target.value = ''
  if (!file) return
  fileName.value = file.name
  result.value = null
  try {
    const table = /\.csv$/i.test(file.name) ? parseCsv(await file.text()) : await readXlsxFile(file)
    rows.value = toRows(table)
    if (!rows.value.length) ElMessage.warning('表格里没有书')
  } catch (err) {
    rows.value = []
    ElMessage.error('读不了这个文件：' + err.message)
  }
}

async function doImport() {
  importing.value = true
  const out = { created: 0, skipped: [] }
  try {
    for (let i = 0; i < rows.value.length; i += 200) {
      const chunk = rows.value.slice(i, i + 200)
      const res = await api.book('importBooks', {
        books: chunk.map((r) => ({ title: r.title, author: r.author, isbn: r.isbn, category: r.category, copies: r.copies, desc: r.desc }))
      })
      out.created += res.created
      res.skipped.forEach((s) => out.skipped.push({ row: chunk[s.index].row, title: s.title, reason: s.reason }))
    }
    rows.value = []
  } catch (e) {
    ElMessage.error(e.message)
  } finally {
    result.value = out
    importing.value = false
    load()
  }
}

onMounted(load)
</script>

<style scoped>
.cover {
  width: 40px;
  height: 54px;
}
.small { font-size: 12px; }
.pager {
  margin-top: 12px;
  justify-content: flex-end;
}
.import-pick {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0;
}
.result { margin-top: 12px; }
</style>
