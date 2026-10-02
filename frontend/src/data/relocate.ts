import { MODULES } from './modules'
import { listRows, saveRows } from './local-store'
import type { EntryRow } from './types'

// 避险搬迁领域规则集中在这里：页面只负责渲染，不自己做业务判断。
//  - 状态只能「待签订 → 已签订 → 搬迁中 → 已完成」逐段向前，倒序、跳段一律挡下
//  - 涉及户数必须是正整数，精度不对直接退回，不落库
//  - 同一搬迁编号重复导出，只认第一次的快照结果
//  - 导出结论同步成险情上报里的「已安置户」待办，两处涉及户数同源

export const RELOCATE_KEY = 'relocate'
export const REPORT_KEY = 'report'

// 固定的安置方式：每种都要有一份材料（没有记录时给说明文件，不给空文件）。
export const SETTLEMENT_MODES = ['集中安置', '分散安置', '货币安置'] as const
export const RELOCATE_STATUSES = ['待签订', '已签订', '搬迁中', '已完成'] as const

const SNAPSHOT_STORAGE_KEY = 'geohazard-patrol:relocate-export-snapshots:v1'

type SimpleStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

// 没有 localStorage（如 Node 单测）时退到内存存储，规则代码两边都能跑。
const memoryStorage = new Map<string, string>()
const memoryFallback: SimpleStorage = {
  getItem: (key) => (memoryStorage.has(key) ? (memoryStorage.get(key) as string) : null),
  setItem: (key, value) => void memoryStorage.set(key, value),
  removeItem: (key) => void memoryStorage.delete(key),
}
let storageOverride: SimpleStorage | null = null

function snapshotStorage(): SimpleStorage {
  if (storageOverride) {
    return storageOverride
  }
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage
  }
  return memoryFallback
}

/** 测试钩子：替换快照存储并清空内存态。 */
export function __setSnapshotStorageForTest(storage: SimpleStorage | null): void {
  storageOverride = storage
  memoryStorage.clear()
}

export type RelocateDraft = {
  搬迁编号: string
  所属隐患点: string
  涉及户数: number
  安置方式: string
  安置地点: string
  签订日期: string
  完成日期: string
}

export type DraftErrors = Partial<Record<'搬迁编号' | '所属隐患点' | '涉及户数' | '安置方式' | '安置地点', string>>

export type DraftResult =
  | { ok: true; entry: EntryRow; message: string }
  | { ok: false; errors: DraftErrors; message: string }

export type ExportSnapshot = {
  搬迁编号: string
  涉及户数: number
  安置方式: string
  安置地点: string
  所属隐患点: string
  exportDate: string
}

export type PackageFile = {
  filename: string
  content: string
  mime: 'text/csv' | 'text/plain'
  /** 无记录的安置方式给的是说明文件，不是空表 */
  note: boolean
  mode: string
  count: number
}

// ---------- 涉及户数：精度校验 ----------

/** 独立「涉及户数」字段：只认正整数，小数 / 负数 / 0 / 非数字一律退回。 */
export function toHouseholdCount(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null
  }
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) {
    return null
  }
  const parsed = Number(text)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null
}

// 户数与地点连写时的识别形态，如「12户 青龙镇集中安置点A区」「12户青龙镇安置点」。
// 必须是整数户，「12.5户」「0户」直接不认。
const EMBEDDED_HOUSEHOLD = /^(\d+)户[\s,，:：、-]*(.*)$/

/**
 * 解析「涉及户数 / 安置地点」录入，优先级如下：
 *  1. 独立的「涉及户数」字段是正整数 —— 最高优先级，直接采用，不看地点文本；
 *  2. 两栏连写且地点栏为空（如「12户 青龙镇集中安置点」）—— 从开头拆出整数户，
 *     剩余文字作为安置地点；
 *  3. 只给了安置地点、里面没有「N户」—— 户数缺失，退回；
 *  4. 户数精度不对（小数 / 0 / 非数字）—— 直接退回，不允许落库。
 */
export function parseHouseholdInput(rawHousehold: string, rawLocation: string):
  | { ok: true; households: number; location: string }
  | { ok: false; reason: 'missing' | 'precision'; detail: string } {
  const householdText = rawHousehold.trim()
  const locationText = rawLocation.trim()

  if (householdText) {
    const count = toHouseholdCount(householdText)
    if (count === null) {
      return { ok: false, reason: 'precision', detail: `涉及户数「${householdText}」不是正整数，小数、零、负数或非数字不予登记` }
    }
    // 独立户数栏优先级最高：地点栏只作地点用，哪怕地点文本里也写着数字也不覆盖户数。
    return { ok: true, households: count, location: locationText }
  }

  // 户数栏为空时，才允许从连写文本里拆。
  const match = locationText.match(EMBEDDED_HOUSEHOLD)
  if (match) {
    const count = Number(match[1])
    if (count <= 0) {
      return { ok: false, reason: 'precision', detail: '涉及户数必须大于 0' }
    }
    return { ok: true, households: count, location: match[2].trim() }
  }

  return { ok: false, reason: 'missing', detail: '涉及户数缺失：请在「涉及户数」栏填写正整数，或在地点栏写成「N户 + 地点」' }
}

// ---------- 登记 ----------

export function prepareRelocateEntry(input: Partial<Record<keyof RelocateDraft | string, string>>):
  | { ok: true; draft: RelocateDraft }
  | { ok: false; errors: DraftErrors } {
  const errors: DraftErrors = {}
  const code = String(input['搬迁编号'] ?? '').trim()
  const hazard = String(input['所属隐患点'] ?? '').trim()
  const mode = String(input['安置方式'] ?? '').trim()
  const rawHousehold = String(input['涉及户数'] ?? '')
  const rawLocation = String(input['安置地点'] ?? '')

  if (!code) {
    errors['搬迁编号'] = '搬迁编号不能为空'
  } else if (listRows(RELOCATE_KEY).some((row) => String(row['搬迁编号']) === code)) {
    errors['搬迁编号'] = `搬迁编号 ${code} 已存在，不能重复登记`
  }
  if (!hazard) {
    errors['所属隐患点'] = '所属隐患点不能为空'
  }
  if (!mode) {
    errors['安置方式'] = '安置方式不能为空'
  }

  const parsed = parseHouseholdInput(rawHousehold, rawLocation)
  let households = 0
  let location = ''
  if (!parsed.ok) {
    errors['涉及户数'] = parsed.detail
  } else {
    households = parsed.households
    location = parsed.location
    if (!location) {
      errors['安置地点'] = '安置地点不能为空'
    }
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors }
  }

  return {
    ok: true,
    draft: {
      搬迁编号: code,
      所属隐患点: hazard,
      涉及户数: households,
      安置方式: mode,
      安置地点: location,
      签订日期: String(input['签订日期'] ?? '').trim(),
      完成日期: String(input['完成日期'] ?? '').trim(),
    },
  }
}

/** 登记一张搬迁安置单；户数精度不过直接退回，不写入存储。 */
export function createRelocateEntry(input: Partial<Record<string, string>>): DraftResult {
  const prepared = prepareRelocateEntry(input)
  if (!prepared.ok) {
    return { ok: false, errors: prepared.errors, message: '登记失败，请按提示修正标红字段' }
  }
  const draft = prepared.draft
  const rows = listRows(RELOCATE_KEY)
  const nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  const entry: EntryRow = {
    id: nextId,
    status: '待签订',
    pending: true,
    abnormal: false,
    ...draft,
    搬迁状态: '待签订',
  }
  saveRows(RELOCATE_KEY, [...rows, entry])
  return { ok: true, entry, message: `搬迁安置单 ${draft.搬迁编号} 已登记，涉及 ${draft.涉及户数} 户` }
}

// ---------- 状态逐段向前 ----------

/**
 * 线性状态推进：目标状态必须正好是当前状态的下一段。
 * 倒序、跳段、重复操作一律挡下。
 */
export function assertAdvance(current: string, target: string): { ok: boolean; message: string } {
  const currentIndex = RELOCATE_STATUSES.indexOf(current as (typeof RELOCATE_STATUSES)[number])
  const targetIndex = RELOCATE_STATUSES.indexOf(target as (typeof RELOCATE_STATUSES)[number])
  if (currentIndex < 0 || targetIndex < 0) {
    return { ok: false, message: `未知的搬迁状态：${current} → ${target}` }
  }
  if (targetIndex < currentIndex) {
    return { ok: false, message: `状态只能向前推进，不能从「${current}」倒回「${target}」` }
  }
  if (targetIndex === currentIndex) {
    return { ok: false, message: `搬迁安置单已经是「${target}」，不用重复操作` }
  }
  if (targetIndex > currentIndex + 1) {
    return { ok: false, message: `不能从「${current}」直接跳到「${target}」，请先推进到「${RELOCATE_STATUSES[currentIndex + 1]}」` }
  }
  return { ok: true, message: '' }
}

// ---------- 导出快照：同一搬迁编号只认第一次 ----------

function readSnapshots(): Record<string, ExportSnapshot> {
  try {
    return (JSON.parse(snapshotStorage().getItem(SNAPSHOT_STORAGE_KEY) ?? '{}')) as Record<string, ExportSnapshot>
  } catch {
    return {}
  }
}

function persistSnapshots(snapshots: Record<string, ExportSnapshot>): void {
  snapshotStorage().setItem(SNAPSHOT_STORAGE_KEY, JSON.stringify(snapshots))
}

export function listExportSnapshots(): ExportSnapshot[] {
  return Object.values(readSnapshots()).sort((a, b) => a.搬迁编号.localeCompare(b.搬迁编号))
}

export function snapshotByCode(code: string): ExportSnapshot | null {
  return readSnapshots()[code] ?? null
}

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

/** 导出前全量校验：任何一张单子户数精度不对，整批退回，不出材料也不写快照。 */
export function validateHouseholdPrecision(rows: EntryRow[]): { ok: true } | { ok: false; message: string } {
  for (const row of rows) {
    if (toHouseholdCount(row['涉及户数']) === null) {
      return {
        ok: false,
        message: `搬迁安置单 ${String(row['搬迁编号'])} 的涉及户数「${String(row['涉及户数'])}」不是正整数，已退回，请先修正再导出`,
      }
    }
  }
  return { ok: true }
}

// ---------- CSV（定列 + RFC4180 转义，地点里的逗号不会把户数挤错位） ----------

export function csvEscape(value: string | number): string {
  const text = String(value)
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

/** 分送材料的固定列顺序：搬迁编号 → 涉及户数 → 安置地点 → 安置方式。 */
export const PACKAGE_COLUMNS = ['搬迁编号', '涉及户数', '安置地点', '安置方式'] as const

function buildCsv(snapshots: ExportSnapshot[]): string {
  const lines = [PACKAGE_COLUMNS.join(',')]
  for (const snapshot of snapshots) {
    lines.push(
      [
        csvEscape(snapshot.搬迁编号),
        csvEscape(snapshot.涉及户数),
        csvEscape(snapshot.安置地点),
        csvEscape(snapshot.安置方式),
      ].join(','),
    )
  }
  return `\uFEFF${lines.join('\r\n')}`
}

function buildNote(mode: string, exportDate: string): string {
  return [
    `避险搬迁安置材料说明`,
    ``,
    `安置方式：${mode}`,
    `导出日期：${exportDate}`,
    ``,
    `本次导出的避险搬迁安置单中，没有采用「${mode}」的搬迁记录，`,
    `因此不生成空表格，仅出具本说明。如有疑问，请联系地质灾害防治值班室核对。`,
  ].join('\r\n')
}

function safeFilename(text: string): string {
  return text.replace(/[\\/:*?"<>|\s]+/g, '')
}

/**
 * 按安置方式生成整包分送材料：
 *  - 固定安置方式每种一份：有记录出 CSV，没有记录出非空说明文件（绝不出空文件）；
 *  - 固定清单之外的安置方式另出一份材料；
 *  - 同一搬迁编号重复导出，只认第一次导出的快照（含户数、地点、方式、日期）。
 * 调用方负责把返回的文件逐个下载，并已完成险情上报待办的同步。
 */
export function buildRelocatePackage(now: Date = new Date()):
  | { ok: true; files: PackageFile[]; exported: ExportSnapshot[]; reused: string[]; exportDate: string }
  | { ok: false; message: string } {
  const rows = listRows(RELOCATE_KEY)
  if (rows.length === 0) {
    return { ok: false, message: '暂无搬迁安置单可导出' }
  }
  const validation = validateHouseholdPrecision(rows)
  if (!validation.ok) {
    return { ok: false, message: validation.message }
  }

  const today = formatDate(now)
  const snapshots = readSnapshots()
  const frozen: ExportSnapshot[] = []
  const reused: string[] = []
  let hasNew = false

  for (const row of rows) {
    const code = String(row['搬迁编号'])
    const existing = snapshots[code]
    if (existing) {
      // 重复导出只认第一次：沿用首次快照，即便列表数据后来被改动。
      frozen.push(existing)
      reused.push(code)
      continue
    }
    const snapshot: ExportSnapshot = {
      搬迁编号: code,
      涉及户数: toHouseholdCount(row['涉及户数']) as number,
      安置方式: String(row['安置方式'] ?? ''),
      安置地点: String(row['安置地点'] ?? ''),
      所属隐患点: String(row['所属隐患点'] ?? ''),
      exportDate: today,
    }
    snapshots[code] = snapshot
    frozen.push(snapshot)
    hasNew = true
  }
  if (hasNew) {
    persistSnapshots(snapshots)
  }

  // 纯重复导出（没有新增记录）整包按首次导出重建，取最早的首次导出日期；
  // 有新增记录时属于一次新的导出，整包日期用本次日期（已存在的编号仍沿用首次快照内容）。
  const exportDate = hasNew ? today : frozen.map((snapshot) => snapshot.exportDate).sort()[0]

  const groups = new Map<string, ExportSnapshot[]>()
  for (const mode of SETTLEMENT_MODES) {
    groups.set(mode, [])
  }
  for (const snapshot of frozen) {
    const key = groups.has(snapshot.安置方式) ? snapshot.安置方式 : snapshot.安置方式 || '未填安置方式'
    const bucket = groups.get(key)
    if (bucket) {
      bucket.push(snapshot)
    } else {
      groups.set(key, [snapshot])
    }
  }

  const files: PackageFile[] = []
  const orderedModes = [...SETTLEMENT_MODES, ...[...groups.keys()].filter((mode) => !SETTLEMENT_MODES.includes(mode as (typeof SETTLEMENT_MODES)[number]))]
  for (const mode of orderedModes) {
    const bucket = groups.get(mode) ?? []
    const name = safeFilename(mode)
    if (bucket.length > 0) {
      files.push({
        filename: `避险搬迁安置单-${name}-${exportDate}.csv`,
        content: buildCsv(bucket),
        mime: 'text/csv',
        note: false,
        mode,
        count: bucket.length,
      })
    } else {
      files.push({
        filename: `避险搬迁安置单-${name}-${exportDate}-说明.txt`,
        content: buildNote(mode, exportDate),
        mime: 'text/plain',
        note: true,
        mode,
        count: 0,
      })
    }
  }

  return { ok: true, files, exported: frozen, reused, exportDate }
}

function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

// ---------- 导出结论 → 险情上报待办（已安置户） ----------

/** 已安置户待办在险情上报列表里的稳定标识，便于两个页面点开看同一份数据。 */
export function resettledTodoCode(snapshot: ExportSnapshot): string {
  return `已安置户-${snapshot.搬迁编号}`
}

function stableTodoId(code: string): number {
  let hash = 0
  for (let index = 0; index < code.length; index += 1) {
    hash = (hash * 31 + code.charCodeAt(index)) >>> 0
  }
  // 避开常规 seed id（1..999）。
  return 1000 + (hash % 900000)
}

/**
 * 把导出快照同步成险情上报清单里的「已安置户」待办：
 *  - 每张已导出的搬迁安置单一条待办，重复导出不重复产生；
 *  - 涉及户数直接取自导出快照，搬迁页与上报页点开看到的必然是同一个数。
 */
export function syncReportTodos(): { added: number; total: number } {
  const snapshots = listExportSnapshots()
  const rows = listRows(REPORT_KEY)
  const byCode = new Map(rows.map((row) => [String(row['上报编号']), row]))
  let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1

  let added = 0
  const appended: EntryRow[] = []
  for (const snapshot of snapshots) {
    const code = resettledTodoCode(snapshot)
    if (byCode.has(code)) {
      continue
    }
    let id = stableTodoId(code)
    while (rows.some((row) => Number(row.id) === id) || appended.some((row) => Number(row.id) === id)) {
      id += 1
    }
    appended.push({
      id,
      status: '待上报',
      pending: true,
      abnormal: false,
      上报编号: code,
      所属隐患点: snapshot.所属隐患点,
      险情类别: '已安置户',
      发现时间: snapshot.exportDate,
      上报层级: '乡镇',
      处置意见: `安置方式：${snapshot.安置方式}；安置地点：${snapshot.安置地点}`,
      反馈时间: '',
      上报状态: '待上报',
      涉及户数: snapshot.涉及户数,
      安置方式: snapshot.安置方式,
      安置地点: snapshot.安置地点,
      来源搬迁编号: snapshot.搬迁编号,
      待办来源: '避险搬迁导出',
    })
    added += 1
    nextId += 1
  }

  if (appended.length > 0) {
    saveRows(REPORT_KEY, [...rows, ...appended])
  }
  return { added, total: snapshots.length }
}

// ---------- 概览统计 ----------

export type RelocateStat = { label: string; value: number }

/** 避险搬迁页的三张统计卡：按户数汇总，两处页面与导出快照共用同一套口径。 */
export function relocateStats(rows: EntryRow[]): RelocateStat[] {
  const sumBy = (status: string) =>
    rows
      .filter((row) => String(row.status) === status)
      .reduce((sum, row) => sum + (toHouseholdCount(row['涉及户数']) ?? 0), 0)
  return [
    { label: '待签订户数', value: sumBy('待签订') },
    { label: '搬迁中户数', value: sumBy('已签订') + sumBy('搬迁中') },
    { label: '已安置户数', value: sumBy('已完成') },
  ]
}

/** 险情上报页：待办里由避险搬迁导出产生的「已安置户」及其户数合计。 */
export function resettledTodoRows(reportRows: EntryRow[]): EntryRow[] {
  return reportRows.filter((row) => String(row['险情类别']) === '已安置户' && String(row['待办来源']) === '避险搬迁导出')
}

// 让模块清单保持唯一引用来源，便于测试与页面复用。
export const relocateModule = MODULES.find((item) => item.key === RELOCATE_KEY)

/** 仅供测试：清空导出快照（内存态与注入存储都清）。 */
export function _clearSnapshotsForTest(): void {
  memoryStorage.delete(SNAPSHOT_STORAGE_KEY)
  if (storageOverride) {
    storageOverride.removeItem(SNAPSHOT_STORAGE_KEY)
  }
  if (!storageOverride && typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.removeItem(SNAPSHOT_STORAGE_KEY)
  }
}
