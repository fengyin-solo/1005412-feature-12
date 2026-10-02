import { MODULE_BY_KEY } from '@/data/modules'
import {
  allRows,
  listRows,
  readRelocationLedger,
  resetRows,
  saveRelocationLedger,
  saveRows,
} from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  ExportFile,
  ModuleMeta,
  OverviewResult,
  PageResult,
  RelocateExportRecord,
  RelocationExportResult,
} from '@/data/types'

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
  if (meta.strictSequence) {
    const currentIndex = meta.statuses.indexOf(current)
    const targetIndex = meta.statuses.indexOf(target)
    if (targetIndex >= 0 && targetIndex < currentIndex) {
      return {
        ok: false,
        message: `${meta.entity}状态只能一段一段往前推，不允许从「${current}」倒序改回「${target}」`,
      }
    }
    if (targetIndex > currentIndex + 1) {
      return {
        ok: false,
        message: `${meta.entity}状态要一段一段往前推，不能从「${current}」直接跳到「${target}」`,
      }
    }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
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
  for (const row of listRows(key)) {
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

// —— 避险搬迁：登记校验、按安置方式拆分导出、导出结论同步险情上报 ——

/** 安置方式的固定口径：分送乡镇的材料按这几类拆，没有记录的类别也要给说明文件。 */
export const RELOCATION_METHODS = ['集中安置', '分散安置', '货币安置']

/** 涉及户数必须是正整数：小数、负数、零、非数字都算精度不对。 */
export function parseHouseholds(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 ? value : null
  }
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) {
    return null
  }
  const parsed = Number(text)
  return parsed >= 1 ? parsed : null
}

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * 登记搬迁安置单。
 * 校验顺序即优先级：搬迁编号 -> 涉及户数 -> 安置地点 -> 安置方式。
 * 涉及户数与安置地点撞在一起（同时有问题）时，先判涉及户数精度，精度不对直接退回，不落库。
 */
export function registerRelocation(values: Record<string, string>): ActionResult {
  const meta = moduleMeta('relocate')
  const code = String(values['搬迁编号'] ?? '').trim()
  if (!code) {
    return { ok: false, message: '搬迁编号不能为空，已退回未落库' }
  }
  const households = parseHouseholds(values['涉及户数'])
  if (households === null) {
    return {
      ok: false,
      message: `涉及户数「${String(values['涉及户数'] ?? '').trim() || '空'}」精度不对，必须是正整数，已退回未落库`,
    }
  }
  const place = String(values['安置地点'] ?? '').trim()
  if (!place) {
    return { ok: false, message: '安置地点不能为空，已退回未落库' }
  }
  const method = String(values['安置方式'] ?? '').trim()
  if (!method) {
    return { ok: false, message: '安置方式不能为空，已退回未落库' }
  }
  const rows = listRows(meta.key)
  const id = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const first = meta.statuses[0]
  const row: EntryRow = {
    id,
    status: first,
    pending: true,
    abnormal: false,
    搬迁编号: code,
    所属隐患点: String(values['所属隐患点'] ?? '').trim(),
    涉及户数: households,
    安置方式: method,
    安置地点: place,
    签订日期: String(values['签订日期'] ?? '').trim(),
    完成日期: '',
    搬迁状态: first,
  }
  saveRows(meta.key, [...rows, row])
  return { ok: true, message: `搬迁安置单 ${code} 已登记，涉及 ${households} 户，当前状态「${first}」` }
}

type AcceptedRow = { row: EntryRow; households: number; method: string }

type MethodBucket = {
  total: number
  accepted: AcceptedRow[]
  duplicated: number
  rejected: number
}

function buildSheetCsv(method: string, accepted: AcceptedRow[]): string {
  const lines = ['搬迁编号,涉及户数,安置地点,安置方式']
  for (const { row, households } of accepted) {
    lines.push(
      [row['搬迁编号'], households, row['安置地点'], method].map(csvCell).join(','),
    )
  }
  return `\uFEFF${lines.join('\n')}`
}

function buildNoteText(method: string, date: string, bucket: MethodBucket | undefined): string {
  let reason: string
  if (!bucket || bucket.total === 0) {
    reason = `本期没有「${method}」的搬迁安置记录，无可分送乡镇的清单。`
  } else {
    const parts: string[] = []
    if (bucket.duplicated > 0) {
      parts.push(`${bucket.duplicated} 条此前已导出，同一搬迁编号只认首次导出结果`)
    }
    if (bucket.rejected > 0) {
      parts.push(`${bucket.rejected} 条涉及户数精度不对，已退回整改`)
    }
    reason = `「${method}」本期无新增可分送记录：${parts.join('；')}。`
  }
  return [
    '避险搬迁安置单分送说明',
    `安置方式：${method}`,
    `导出日期：${date}`,
    reason,
    '本说明用于代替空清单，分送乡镇时以本说明为准。',
  ].join('\n')
}

/**
 * 把搬迁安置单按安置方式拆成几份分送材料：
 * - 每份清单列全搬迁编号、涉及户数、安置地点、安置方式，文件名带安置方式与导出日期；
 * - 没有可导出记录的安置方式给说明文件，不出空文件；
 * - 同一搬迁编号重复导出只认第一次的结果（台账落第一次，之后跳过）；
 * - 涉及户数精度不对的记录直接退回，不落台账、不同步险情上报；
 * - 首次导出的结论同步到险情上报待办，清单里冒出「已安置户」，涉及户数与搬迁侧同一套。
 */
export function exportRelocationSheets(): RelocationExportResult {
  const date = todayText()
  const rows = listRows('relocate')
  const ledger = readRelocationLedger()
  const buckets = new Map<string, MethodBucket>()
  const bucketOf = (method: string): MethodBucket => {
    let bucket = buckets.get(method)
    if (!bucket) {
      bucket = { total: 0, accepted: [], duplicated: 0, rejected: 0 }
      buckets.set(method, bucket)
    }
    return bucket
  }
  const seenInRun = new Set<string>()
  let duplicated = 0
  let rejected = 0

  for (const row of rows) {
    const code = String(row['搬迁编号'] ?? '').trim()
    const method = String(row['安置方式'] ?? '').trim() || '未填写安置方式'
    const bucket = bucketOf(method)
    bucket.total += 1
    if (!code) {
      bucket.rejected += 1
      rejected += 1
      continue
    }
    if (ledger[code] || seenInRun.has(code)) {
      bucket.duplicated += 1
      duplicated += 1
      continue
    }
    const households = parseHouseholds(row['涉及户数'])
    if (households === null) {
      bucket.rejected += 1
      rejected += 1
      continue
    }
    seenInRun.add(code)
    bucket.accepted.push({ row, households, method })
  }

  const methods = [...RELOCATION_METHODS]
  for (const method of buckets.keys()) {
    if (!methods.includes(method)) {
      methods.push(method)
    }
  }

  const files: ExportFile[] = []
  const acceptedAll: AcceptedRow[] = []
  for (const method of methods) {
    const bucket = buckets.get(method)
    const accepted = bucket?.accepted ?? []
    if (accepted.length > 0) {
      files.push({
        filename: `避险搬迁安置单-${method}-${date}.csv`,
        content: buildSheetCsv(method, accepted),
        mime: 'text/csv;charset=utf-8',
      })
      acceptedAll.push(...accepted)
    } else {
      files.push({
        filename: `避险搬迁安置单-${method}-${date}-说明.txt`,
        content: buildNoteText(method, date, bucket),
        mime: 'text/plain;charset=utf-8',
      })
    }
  }

  if (acceptedAll.length > 0) {
    const nextLedger: Record<string, RelocateExportRecord> = { ...ledger }
    for (const { row, households, method } of acceptedAll) {
      const code = String(row['搬迁编号']).trim()
      if (!nextLedger[code]) {
        nextLedger[code] = {
          搬迁编号: code,
          安置方式: method,
          涉及户数: households,
          安置地点: String(row['安置地点'] ?? ''),
          导出日期: date,
        }
      }
    }
    saveRelocationLedger(nextLedger)

    const reportRows = listRows('report')
    let nextId = reportRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0)
    let seq = reportRows.reduce((max, row) => {
      const match = /^REPO-(\d+)$/.exec(String(row['上报编号'] ?? ''))
      return match ? Math.max(max, Number(match[1])) : max
    }, 0)
    const appended = acceptedAll.map(({ row, households, method }) => {
      nextId += 1
      seq += 1
      const code = String(row['搬迁编号']).trim()
      const place = String(row['安置地点'] ?? '')
      const entry: EntryRow = {
        id: nextId,
        status: '待上报',
        pending: true,
        abnormal: false,
        上报编号: `REPO-${String(seq).padStart(4, '0')}`,
        所属隐患点: String(row['所属隐患点'] ?? ''),
        险情类别: '已安置户',
        涉及户数: households,
        发现时间: date,
        上报层级: '乡镇',
        处置意见: `搬迁编号 ${code} 按「${method}」安置于${place}，涉及 ${households} 户`,
        反馈时间: '',
        上报状态: '待上报',
        搬迁编号: code,
      }
      return entry
    })
    saveRows('report', [...reportRows, ...appended])
  }

  const sheetCount = files.filter((file) => file.filename.endsWith('.csv')).length
  const message = [
    `已按安置方式生成 ${files.length} 份分送材料（清单 ${sheetCount} 份、说明 ${files.length - sheetCount} 份）`,
    `新导出 ${acceptedAll.length} 条`,
    `重复导出 ${duplicated} 条只认首次结果`,
    `涉及户数精度不对退回 ${rejected} 条`,
    `险情上报待办同步新增 ${acceptedAll.length} 条已安置户`,
  ].join('；')
  return {
    files,
    exported: acceptedAll.length,
    duplicated,
    rejected,
    synced: acceptedAll.length,
    message,
  }
}

function triggerDownload(file: ExportFile): void {
  const blob = new Blob([file.content], { type: file.mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 拆分导出并逐份下载，返回本次导出的结论说明。 */
export async function downloadRelocationSheets(): Promise<string> {
  const result = exportRelocationSheets()
  for (const [index, file] of result.files.entries()) {
    if (index > 0) {
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    triggerDownload(file)
  }
  return result.message
}
