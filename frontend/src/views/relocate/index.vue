<template>
  <section class="page" data-module="relocate">
    <header class="page-head">
      <div>
        <h2>避险搬迁管理</h2>
        <p class="page-desc">维护搬迁安置单，围绕搬迁编号、所属隐患点、涉及户数、安置方式做登记、筛选与状态流转；导出按安置方式拆成分送材料。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记搬迁安置单</button>
        <button class="btn" type="button" :disabled="exporting" @click="exportRows">
          {{ exporting ? '正在生成材料…' : '导出分送材料' }}
        </button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }} 单 / {{ item.households }} 户
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '涉及户数'">{{ displayHouseholds(row) }}</template>
            <template v-else-if="column === '搬迁编号'">
              {{ row[column] }}
              <span v-if="snapshotCodes.has(String(row[column]))" class="tag tag-synced" title="已导出，结论已同步到险情上报待办">已导出</span>
            </template>
            <template v-else>{{ row[column] ?? '—' }}</template>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button class="link" type="button" @click="openDetail(row)">查看</button>
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无避险搬迁数据，可先登记搬迁安置单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条避险搬迁记录；已导出 {{ snapshots.length }} 单，重复导出沿用首次结果</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
      <span v-else-if="successMessage" class="success-text">{{ successMessage }}</span>
    </footer>

    <!-- 登记弹窗 -->
    <div v-if="creating" class="modal-mask" @click.self="closeCreate">
      <div class="modal">
        <h3 class="modal-title">登记搬迁安置单</h3>
        <p class="modal-tip">涉及户数只接受正整数；若户数和地点连写在地点栏（如「12户 青龙镇集中安置点」）会自动拆开，独立「涉及户数」栏优先级最高。</p>
        <div class="form-grid">
          <label class="form-item">
            <span>搬迁编号 *</span>
            <input v-model="form['搬迁编号']" placeholder="如 BQ-2026-005" />
            <em v-if="formErrors['搬迁编号']" class="field-error">{{ formErrors['搬迁编号'] }}</em>
          </label>
          <label class="form-item">
            <span>所属隐患点 *</span>
            <input v-model="form['所属隐患点']" placeholder="如 青龙镇鹰嘴崖滑坡" />
            <em v-if="formErrors['所属隐患点']" class="field-error">{{ formErrors['所属隐患点'] }}</em>
          </label>
          <label class="form-item">
            <span>涉及户数 *</span>
            <input v-model="form['涉及户数']" placeholder="正整数，如 12" />
            <em v-if="formErrors['涉及户数']" class="field-error">{{ formErrors['涉及户数'] }}</em>
          </label>
          <label class="form-item">
            <span>安置方式 *</span>
            <select v-model="form['安置方式']">
              <option value="">请选择</option>
              <option v-for="mode in settlementModes" :key="mode" :value="mode">{{ mode }}</option>
            </select>
            <em v-if="formErrors['安置方式']" class="field-error">{{ formErrors['安置方式'] }}</em>
          </label>
          <label class="form-item form-item-wide">
            <span>安置地点 *</span>
            <input v-model="form['安置地点']" placeholder="如 青龙镇集中安置点A区" />
            <em v-if="formErrors['安置地点']" class="field-error">{{ formErrors['安置地点'] }}</em>
          </label>
        </div>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="closeCreate">取消</button>
          <button class="btn primary" type="button" @click="submitCreate">提交登记</button>
        </div>
      </div>
    </div>

    <!-- 详情弹窗：导出过的单子以首次导出快照为准，保证与险情上报待办看到的户数一致 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal">
        <h3 class="modal-title">搬迁安置单详情 · {{ detail.row['搬迁编号'] }}</h3>
        <dl class="detail-list">
          <div v-for="item in detailRows" :key="item.label" class="detail-row">
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </div>
        </dl>
        <p v-if="detail.snapshot" class="modal-tip">该单已于 {{ detail.snapshot.exportDate }} 首次导出，涉及户数与险情上报待办同源：{{ detail.snapshot.涉及户数 }} 户。</p>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadRelocatePackages,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  createRelocateEntry,
  listExportSnapshots,
  relocateStats,
  resettledTodoCode,
  SETTLEMENT_MODES,
  snapshotByCode,
  toHouseholdCount,
  type DraftErrors,
  type ExportSnapshot,
} from '@/data/relocate'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('relocate')
const columns = ['搬迁编号', '所属隐患点', '涉及户数', '安置方式', '安置地点', '签订日期', '完成日期', '搬迁状态']
const actions = ['确认签订', '开始搬迁', '确认完成']
const statuses = ['待签订', '已签订', '搬迁中', '已完成']
const settlementModes = [...SETTLEMENT_MODES]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const successMessage = ref('')
const exporting = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const snapshots = ref<ExportSnapshot[]>([])
const snapshotCodes = computed(() => new Set(snapshots.value.map((item) => item.搬迁编号)))

const stats = computed(() => relocateStats(rows.value))
const statusSummary = computed(() =>
  statuses.map((status) => {
    const matched = rows.value.filter((row) => String(row.status) === status)
    return {
      status,
      count: matched.length,
      households: matched.reduce((sum, row) => sum + (toHouseholdCount(row['涉及户数']) ?? 0), 0),
    }
  }),
)

// 涉及户数以独立列为准（定列 + CSV 转义，不被安置地点里的数字带偏）；异常精度直接标红提示。
function displayHouseholds(row: EntryRow): string {
  const count = toHouseholdCount(row['涉及户数'])
  return count === null ? `户数异常：${String(row['涉及户数'])}` : `${count} 户`
}

function resetFilters() {
  filters.value = {}
  reload()
}

async function exportRows() {
  errorMessage.value = ''
  successMessage.value = ''
  exporting.value = true
  try {
    const summary = await downloadRelocatePackages()
    if (!summary.ok) {
      errorMessage.value = summary.message
    } else {
      successMessage.value = summary.message
    }
  } finally {
    exporting.value = false
    reload()
  }
}

// ---------- 登记 ----------

const creating = ref(false)
const form = reactive<Record<string, string>>({
  搬迁编号: '',
  所属隐患点: '',
  涉及户数: '',
  安置方式: '',
  安置地点: '',
})
const formErrors = ref<DraftErrors>({})

function openCreate() {
  form['搬迁编号'] = ''
  form['所属隐患点'] = ''
  form['涉及户数'] = ''
  form['安置方式'] = ''
  form['安置地点'] = ''
  formErrors.value = {}
  creating.value = true
}

function closeCreate() {
  creating.value = false
}

function submitCreate() {
  errorMessage.value = ''
  successMessage.value = ''
  const result = createRelocateEntry({ ...form })
  if (!result.ok) {
    formErrors.value = result.errors
    errorMessage.value = result.message
    return
  }
  creating.value = false
  successMessage.value = result.message
  reload()
}

// ---------- 详情：与险情上报待办同源 ----------

const detail = ref<{ row: EntryRow; snapshot: ExportSnapshot | null } | null>(null)

const detailRows = computed(() => {
  if (!detail.value) {
    return []
  }
  const { row, snapshot } = detail.value
  // 已导出的单子，户数/地点/方式一律取首次快照，跟险情上报页点开看到的是同一套。
  const households = snapshot ? snapshot.涉及户数 : displayHouseholds(row)
  const location = snapshot ? snapshot.安置地点 : String(row['安置地点'] ?? '—')
  const mode = snapshot ? snapshot.安置方式 : String(row['安置方式'] ?? '—')
  return [
    { label: '搬迁编号', value: String(row['搬迁编号']) },
    { label: '所属隐患点', value: String(row['所属隐患点'] ?? '—') },
    { label: '涉及户数', value: typeof households === 'number' ? `${households} 户` : households },
    { label: '安置方式', value: mode },
    { label: '安置地点', value: location || '—' },
    { label: '当前状态', value: String(row.status) },
    { label: '待办编号', value: snapshot ? resettledTodoCode(snapshot) : '尚未导出，导出后自动生成' },
    { label: '首次导出日期', value: snapshot ? snapshot.exportDate : '—' },
  ]
})

function openDetail(row: EntryRow) {
  const code = String(row['搬迁编号'])
  detail.value = { row, snapshot: snapshotByCode(code) }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  successMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  successMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    snapshots.value = listExportSnapshots()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险搬迁列表读取失败'
  }
}

onMounted(reload)
</script>
