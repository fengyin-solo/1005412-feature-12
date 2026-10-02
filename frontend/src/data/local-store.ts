import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'geohazard-patrol:entries:v2'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 统一从全局取 localStorage：浏览器里是 window.localStorage，
// 测试环境可以注入 globalThis.window.localStorage 而不被 typeof window 提前挡掉。
function backingStorage(): Storage | null {
  const host = (globalThis as { window?: { localStorage?: Storage } }).window
  return host?.localStorage ?? null
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  const storage = backingStorage()
  if (!storage) {
    return fallback
  }
  const raw = storage.getItem(STORAGE_KEY)
  if (!raw) {
    storage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    return { ...fallback, ...parsed }
  } catch {
    storage.setItem(STORAGE_KEY, JSON.stringify(fallback))
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
  backingStorage()?.setItem(STORAGE_KEY, JSON.stringify(next))
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 仅供测试：清掉内存缓存，强制重新从底层存储读取。 */
export function __resetCacheForTest(): void {
  cache = null
}

/** 仅供测试：直接替换整个存储内容（内存缓存与底层 localStorage 一起换）。 */
export function __seedAllForTest(data: Record<string, EntryRow[]>): void {
  cache = data
  backingStorage()?.setItem(STORAGE_KEY, JSON.stringify(data))
}
