<template>
  <section class="page" data-module="relocate">
    <header class="page-head">
      <div>
        <h2>避险搬迁管理</h2>
        <p class="page-desc">维护搬迁安置单，围绕搬迁编号、所属隐患点、涉及户数、安置方式做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="toggleCreate">登记搬迁安置单</button>
        <button class="btn" type="button" @click="exportRows">按安置方式导出分送材料</button>
      </div>
    </header>

    <form v-if="showCreate" class="create-panel" @submit.prevent="submitCreate">
      <label v-for="field in createFields" :key="field.key" class="filter-item">
        <span>{{ field.label }}</span>
        <select v-if="field.key === '安置方式'" v-model="createForm[field.key]">
          <option value="" disabled>请选择安置方式</option>
          <option v-for="method in methods" :key="method" :value="method">{{ method }}</option>
        </select>
        <input
          v-else
          v-model="createForm[field.key]"
          :type="field.key === '签订日期' ? 'date' : 'text'"
          :placeholder="`请输入${field.label}`"
        />
      </label>
      <button class="btn primary" type="submit">提交登记</button>
      <button class="btn ghost" type="button" @click="toggleCreate">取消</button>
    </form>

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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
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
      <span>共 {{ total }} 条避险搬迁记录</span>
      <span v-if="noticeMessage" class="notice-text">{{ noticeMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  RELOCATION_METHODS,
  downloadRelocationSheets,
  listEntries,
  moduleMeta,
  parseHouseholds,
  registerRelocation,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('relocate')
const columns = ["搬迁编号", "所属隐患点", "涉及户数", "安置方式", "安置地点", "签订日期", "完成日期", "搬迁状态"]
const actions = ["确认签订", "开始搬迁", "确认完成"]
const statuses = ["待签订", "已签订", "搬迁中", "已完成"]
const methods = RELOCATION_METHODS
const createFields = [
  { key: "搬迁编号", label: "搬迁编号" },
  { key: "所属隐患点", label: "所属隐患点" },
  { key: "涉及户数", label: "涉及户数" },
  { key: "安置方式", label: "安置方式" },
  { key: "安置地点", label: "安置地点" },
  { key: "签订日期", label: "签订日期" },
]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const noticeMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const showCreate = ref(false)
const createForm = ref<Record<string, string>>(blankForm())

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

// 户数指标按涉及户数求和，精度不对的历史数据不计入。
const stats = computed(() => {
  const sumHouseholds = (status: string) =>
    rows.value
      .filter((row) => String(row.status) === status)
      .reduce((sum, row) => sum + (parseHouseholds(row['涉及户数']) ?? 0), 0)
  return [
    { label: '待签订户数', value: sumHouseholds('待签订') },
    { label: '搬迁中户数', value: sumHouseholds('搬迁中') },
    { label: '已安置户数', value: sumHouseholds('已完成') },
  ]
})

function blankForm(): Record<string, string> {
  return { 搬迁编号: '', 所属隐患点: '', 涉及户数: '', 安置方式: '', 安置地点: '', 签订日期: '' }
}

function toggleCreate() {
  showCreate.value = !showCreate.value
  errorMessage.value = ''
  if (showCreate.value) {
    createForm.value = blankForm()
  }
}

function submitCreate() {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = registerRelocation(createForm.value)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  showCreate.value = false
  createForm.value = blankForm()
  reload()
}

function resetFilters() {
  filters.value = {}
  reload()
}

async function exportRows() {
  errorMessage.value = ''
  noticeMessage.value = ''
  try {
    noticeMessage.value = await downloadRelocationSheets()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '按安置方式导出失败'
  }
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  noticeMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  noticeMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险搬迁列表读取失败'
  }
}

onMounted(reload)
</script>
