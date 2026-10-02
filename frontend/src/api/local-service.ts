import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import {
  assertAdvance,
  buildRelocatePackage,
  REPORT_KEY,
  syncReportTodos,
  type PackageFile,
} from '@/data/relocate'
import type { ActionResult, EntryRow, ModuleMeta, OverviewResult, PageResult } from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  // 线性流程（如避险搬迁）：只能逐段向前，倒序、跳段一律挡下。
  if (meta.linearFlow) {
    const guard = assertAdvance(current, target)
    if (!guard.ok) {
      return guard
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  // 避险搬迁：推进状态时同步落「搬迁状态」与签订/完成日期，留痕完整。
  if (key === 'relocate') {
    updated['搬迁状态'] = target
    const today = new Date().toISOString().slice(0, 10)
    if (target === '已签订' && !updated['签订日期']) {
      updated['签订日期'] = today
    }
    if (target === '已完成' && !updated['完成日期']) {
      updated['完成日期'] = today
    }
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  // 险情上报里由避险搬迁导出联动生成的「已安置户」是系统待办，不混进人工上报清单导出。
  const dataRows = listRows(key).filter(
    (row) => !(key === REPORT_KEY && String(row['待办来源']) === '避险搬迁导出'),
  )
  for (const row of dataRows) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function triggerDownload(file: PackageFile): void {
  const type = file.mime === 'text/csv' ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8'
  const blob = new Blob([file.content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export type RelocateDownloadSummary = {
  ok: boolean
  message: string
  files: PackageFile[]
  exportedCount: number
  reusedCodes: string[]
  addedTodos: number
}

/**
 * 避险搬迁分送材料导出：
 * 按安置方式一份份生成（无记录给说明文件），逐个下载；
 * 导出结论同步进险情上报待办。同一搬迁编号重复导出只认第一次的快照。
 */
export async function downloadRelocatePackages(): Promise<RelocateDownloadSummary> {
  const result = buildRelocatePackage()
  if (!result.ok) {
    return {
      ok: false,
      message: result.message,
      files: [],
      exportedCount: 0,
      reusedCodes: [],
      addedTodos: 0,
    }
  }

  for (const file of result.files) {
    triggerDownload(file)
    // 错开一点，避免浏览器把连续下载合并拦截。
    await wait(150)
  }

  // 导出结论落到险情上报待办，清单里随之冒出「已安置户」。
  const sync = syncReportTodos()

  const dataFiles = result.files.filter((file) => !file.note).length
  const noteFiles = result.files.length - dataFiles
  const reusedText = result.reused.length
    ? `；${result.reused.length} 个编号为重复导出，沿用首次结果（${result.reused.join('、')}）`
    : ''
  return {
    ok: true,
    message: `已生成 ${result.files.length} 份材料（${dataFiles} 份安置清单、${noteFiles} 份无记录说明），并在险情上报新增 ${sync.added} 条已安置户待办${reusedText}`,
    files: result.files,
    exportedCount: result.exported.length,
    reusedCodes: result.reused,
    addedTodos: sync.added,
  }
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
