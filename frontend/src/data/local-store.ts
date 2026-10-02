import { SEED_ROWS } from './seed'
import type { EntryRow, RelocateExportRecord } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-patrol:entries'
// 搬迁安置单的导出台账：搬迁编号 -> 首次导出结果，单独存一份，重置业务数据不动它。
const EXPORT_LEDGER_KEY = 'geohazard-patrol:relocate-exports'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

let ledgerCache: Record<string, RelocateExportRecord> | null = null

export function readRelocationLedger(): Record<string, RelocateExportRecord> {
  if (ledgerCache !== null) {
    return ledgerCache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    ledgerCache = {}
    return ledgerCache
  }
  const raw = window.localStorage.getItem(EXPORT_LEDGER_KEY)
  if (!raw) {
    ledgerCache = {}
    return ledgerCache
  }
  try {
    ledgerCache = JSON.parse(raw) as Record<string, RelocateExportRecord>
  } catch {
    ledgerCache = {}
  }
  return ledgerCache
}

export function saveRelocationLedger(ledger: Record<string, RelocateExportRecord>): void {
  ledgerCache = ledger
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(EXPORT_LEDGER_KEY, JSON.stringify(ledger))
  }
}
