<template>
  <section class="page" data-module="report">
    <header class="page-head">
      <div>
        <h2>险情上报管理</h2>
        <p class="page-desc">维护险情上报单，围绕上报编号、所属隐患点、险情类别、发现时间做登记、筛选与状态流转；避险搬迁导出的已安置户会自动进入待办。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记险情上报单</button>
        <button class="btn" type="button" @click="exportRows">导出险情上报清单</button>
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
        {{ item.status }}：{{ item.count }}
      </span>
      <span class="legend-item legend-todo">已安置户待办：{{ todoRows.length }} 条 / {{ todoHouseholds }} 户</span>
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
        <tr v-for="row in rows" :key="String(row.id)" :class="{ 'todo-row': isTodo(row) }">
          <td v-for="column in columns" :key="column">
            <template v-if="column === '上报编号'">
              {{ row[column] }}
              <span v-if="isTodo(row)" class="tag tag-synced">已安置户待办</span>
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
          <td :colspan="columns.length + 2" class="empty-state">暂无险情上报数据，可先登记险情上报单</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条险情上报记录，其中 {{ todoRows.length }} 条来自避险搬迁导出</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <!-- 详情弹窗：已安置户待办的涉及户数取自搬迁首次导出快照，与搬迁页是同一套数 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal">
        <h3 class="modal-title">险情上报详情 · {{ detail.row['上报编号'] }}</h3>
        <dl class="detail-list">
          <div v-for="item in detailRows" :key="item.label" class="detail-row">
            <dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd>
          </div>
        </dl>
        <p v-if="detail.snapshot" class="modal-tip">
          涉及户数 {{ detail.snapshot.涉及户数 }} 户取自搬迁单 {{ detail.snapshot.搬迁编号 }} 于
          {{ detail.snapshot.exportDate }} 的首次导出，避险搬迁页点开看到的也是这个数。
        </p>
        <div class="modal-actions">
          <button class="btn primary" type="button" @click="detail = null">关闭</button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import {
  resettledTodoRows,
  snapshotByCode,
  toHouseholdCount,
  type ExportSnapshot,
} from '@/data/relocate'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('report')
const columns = ['上报编号', '所属隐患点', '险情类别', '发现时间', '上报层级', '处置意见', '反馈时间', '上报状态']
const actions = ['确认上报', '登记处置', '退回补充']
const statuses = ['待上报', '已上报', '已处置', '已退回']

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const todoRows = computed(() => resettledTodoRows(rows.value))
const todoHouseholds = computed(() =>
  todoRows.value.reduce((sum, row) => sum + (toHouseholdCount(row['涉及户数']) ?? 0), 0),
)

const stats = computed(() => {
  const countBy = (status: string) => rows.value.filter((row) => String(row.status) === status).length
  return [
    { label: '待上报险情', value: countBy('待上报') },
    { label: '已上报险情', value: countBy('已上报') },
    { label: '已安置户待办（户）', value: todoHouseholds.value },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function isTodo(row: EntryRow): boolean {
  return resettledTodoRows([row]).length > 0
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '险情上报单登记入口尚未接入审批流'
}

// ---------- 详情 ----------

const detail = ref<{ row: EntryRow; snapshot: ExportSnapshot | null } | null>(null)

const detailRows = computed(() => {
  if (!detail.value) {
    return []
  }
  const { row, snapshot } = detail.value
  const base = [
    { label: '上报编号', value: String(row['上报编号']) },
    { label: '所属隐患点', value: String(row['所属隐患点'] ?? '—') },
    { label: '险情类别', value: String(row['险情类别']) },
    { label: '发现时间', value: String(row['发现时间'] ?? '—') },
    { label: '上报层级', value: String(row['上报层级'] ?? '—') },
    { label: '当前状态', value: String(row.status) },
  ]
  if (snapshot) {
    base.push(
      { label: '涉及户数', value: `${snapshot.涉及户数} 户` },
      { label: '安置方式', value: snapshot.安置方式 },
      { label: '安置地点', value: snapshot.安置地点 || '—' },
      { label: '来源搬迁编号', value: snapshot.搬迁编号 },
      { label: '首次导出日期', value: snapshot.exportDate },
    )
  } else {
    base.push({ label: '处置意见', value: String(row['处置意见'] ?? '—') })
  }
  return base
})

function openDetail(row: EntryRow) {
  // 已安置户待办通过来源搬迁编号回溯首次导出快照，保证两处点开户数完全一致。
  const sourceCode = row['来源搬迁编号'] ? String(row['来源搬迁编号']) : null
  detail.value = { row, snapshot: sourceCode ? snapshotByCode(sourceCode) : null }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '险情上报列表读取失败'
  }
}

onMounted(reload)
</script>
