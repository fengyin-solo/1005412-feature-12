/** 单测入口：把领域 API 与测试钩子打平导出，供 scripts/run-relocate-tests.mjs 使用。 */
export {
  assertAdvance,
  buildRelocatePackage,
  createRelocateEntry,
  listExportSnapshots,
  parseHouseholdInput,
  relocateStats,
  resettledTodoRows,
  snapshotByCode,
  syncReportTodos,
  toHouseholdCount,
  validateHouseholdPrecision,
  _clearSnapshotsForTest,
  __setSnapshotStorageForTest,
  SETTLEMENT_MODES,
} from '../src/data/relocate'
export { __resetCacheForTest, __seedAllForTest, listRows as __listRows } from '../src/data/local-store'
