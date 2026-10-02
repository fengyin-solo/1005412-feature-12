// 避险搬迁规则单测：esbuild 打包 test/relocate.entry.ts 后在当前 Node 进程里执行，不引第三方测试框架。
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = path.join(root, '.test-build')
const outFile = path.join(outDir, 'relocate.test.mjs')

function makeMemoryStorage() {
  const map = new Map()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, String(value)),
  }
}

function relocateRows() {
  const base = (id, code, households, mode, location, status) => ({
    id,
    status,
    pending: status !== '已完成',
    abnormal: false,
    搬迁编号: code,
    所属隐患点: '测试隐患点',
    涉及户数: households,
    安置方式: mode,
    安置地点: location,
    签订日期: '',
    完成日期: '',
    搬迁状态: status,
  })
  return [
    base(1, 'BQ-T-001', 12, '集中安置', '青龙镇集中安置点A区', '待签订'),
    base(2, 'BQ-T-002', 8, '分散安置', '白沙村分散安置点', '已签订'),
    base(3, 'BQ-T-003', 15, '集中安置', '河西镇安置点C区,近卫生院', '搬迁中'),
    base(4, 'BQ-T-004', 6, '分散安置', '南山村二组', '已完成'),
  ]
}

const cases = [
  {
    name: '状态只能逐段向前：倒序、跳段、重复全部挡下',
    run(api) {
      assert.equal(api.assertAdvance('已签订', '待签订').ok, false, '倒序必须挡下')
      assert.equal(api.assertAdvance('搬迁中', '待签订').ok, false)
      assert.equal(api.assertAdvance('已完成', '搬迁中').ok, false)
      assert.equal(api.assertAdvance('待签订', '搬迁中').ok, false, '跳段必须挡下')
      assert.equal(api.assertAdvance('待签订', '已完成').ok, false, '跨两段必须挡下')
      assert.equal(api.assertAdvance('待签订', '待签订').ok, false, '重复操作必须挡下')
      assert.equal(api.assertAdvance('待签订', '已签订').ok, true, '相邻向前放行')
      assert.equal(api.assertAdvance('已签订', '搬迁中').ok, true)
      assert.equal(api.assertAdvance('搬迁中', '已完成').ok, true)
      assert.match(api.assertAdvance('待签订', '搬迁中').message, /不能从「待签订」直接跳到「搬迁中」/)
      assert.match(api.assertAdvance('已完成', '已签订').message, /不能从「已完成」倒回「已签订」/)
    },
  },
  {
    name: '涉及户数精度：正整数才认，小数/零/负数/非数字直接退回',
    run(api) {
      assert.equal(api.toHouseholdCount(12), 12)
      assert.equal(api.toHouseholdCount('12'), 12)
      assert.equal(api.toHouseholdCount(' 12 '), 12)
      for (const bad of ['12.5', '12.0', '0', '-3', 'abc', '12户', '', '1e3', 12.5, 0, -1]) {
        assert.equal(api.toHouseholdCount(bad), null, `异常值应退回：${String(bad)}`)
      }
      assert.equal(api.validateHouseholdPrecision(relocateRows()).ok, true)
      const badRows = relocateRows().concat([
        { id: 9, status: '待签订', pending: true, abnormal: false, 搬迁编号: 'BQ-BAD', 涉及户数: 3.5 },
      ])
      const result = api.validateHouseholdPrecision(badRows)
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.message, /BQ-BAD/)
    },
  },
  {
    name: '户数与地点优先级：独立户数栏最高，连写才从地点拆',
    run(api) {
      assert.deepEqual(api.parseHouseholdInput('12', '三社安置点，5号楼'), {
        ok: true,
        households: 12,
        location: '三社安置点，5号楼',
      })
      assert.deepEqual(api.parseHouseholdInput('', '12户 青龙镇集中安置点A区'), {
        ok: true,
        households: 12,
        location: '青龙镇集中安置点A区',
      })
      assert.deepEqual(api.parseHouseholdInput('', '8户，白沙村'), { ok: true, households: 8, location: '白沙村' })
      assert.equal(api.parseHouseholdInput('', '12.5户 某地点').ok, false)
      const missing = api.parseHouseholdInput('', '青龙镇安置点')
      assert.equal(missing.ok, false)
      if (!missing.ok) assert.equal(missing.reason, 'missing')
      const precision = api.parseHouseholdInput('十二', '12户 某地点')
      assert.equal(precision.ok, false)
      if (!precision.ok) assert.equal(precision.reason, 'precision')
      assert.equal(api.parseHouseholdInput('0', '某地点').ok, false)
    },
  },
  {
    name: '登记：精度不对/编号重复不落库',
    run(api) {
      const bad = api.createRelocateEntry({
        搬迁编号: 'BQ-T-005',
        所属隐患点: '某隐患点',
        涉及户数: '12.5',
        安置方式: '集中安置',
        安置地点: '某地点',
      })
      assert.equal(bad.ok, false)
      if (!bad.ok) assert.ok(bad.errors['涉及户数'])
      assert.equal(api.__listRows('relocate').length, 4, '退回的单子不得落库')

      const duplicate = api.createRelocateEntry({
        搬迁编号: 'BQ-T-001',
        所属隐患点: '某隐患点',
        涉及户数: '3',
        安置方式: '集中安置',
        安置地点: '某地点',
      })
      assert.equal(duplicate.ok, false)
      if (!duplicate.ok) assert.ok(duplicate.errors['搬迁编号'])

      const good = api.createRelocateEntry({
        搬迁编号: 'BQ-T-005',
        所属隐患点: '某隐患点',
        涉及户数: '3',
        安置方式: '集中安置',
        安置地点: '某地点',
      })
      assert.equal(good.ok, true)
      if (good.ok) {
        assert.equal(good.entry['涉及户数'], 3)
        assert.equal(good.entry.status, '待签订')
      }
      assert.equal(api.__listRows('relocate').length, 5)
    },
  },
  {
    name: '拆包导出：按安置方式分文件，无记录给说明文件，列与转义正确',
    run(api) {
      const result = api.buildRelocatePackage(new Date('2026-10-02T08:00:00'))
      assert.equal(result.ok, true)
      if (!result.ok) throw new Error(result.message)
      assert.deepEqual(
        result.files.map((file) => file.filename),
        [
          '避险搬迁安置单-集中安置-2026-10-02.csv',
          '避险搬迁安置单-分散安置-2026-10-02.csv',
          '避险搬迁安置单-货币安置-2026-10-02-说明.txt',
        ],
      )

      const central = result.files.find((file) => file.mode === '集中安置')
      assert.equal(central.note, false)
      assert.equal(central.count, 2)
      const csvLines = central.content.replace(/^﻿/, '').split('\r\n')
      assert.equal(csvLines[0], '搬迁编号,涉及户数,安置地点,安置方式')
      assert.ok(csvLines.includes('BQ-T-001,12,青龙镇集中安置点A区,集中安置'))
      assert.ok(
        csvLines.includes('BQ-T-003,15,"河西镇安置点C区,近卫生院",集中安置'),
        `地点含逗号时应加引号：${csvLines.join(' | ')}`,
      )

      const note = result.files.find((file) => file.note)
      assert.equal(note.count, 0)
      assert.match(note.content, /没有采用「货币安置」的搬迁记录/)
      assert.ok(note.content.trim().length > 20, '说明文件不能是空文件')
    },
  },
  {
    name: '重复导出只认第一次：改数据后仍沿用首份快照',
    run(api) {
      // 本用例自己完成首次导出。
      const first = api.buildRelocatePackage(new Date('2026-10-02T08:00:00'))
      assert.equal(first.ok, true)
      if (!first.ok) throw new Error(first.message)
      assert.deepEqual(first.reused, [])

      // 事后篡改列表：户数、地点、安置方式全改了。
      const changed = relocateRows().map((row) =>
        row['搬迁编号'] === 'BQ-T-001'
          ? { ...row, 涉及户数: 99, 安置方式: '货币安置', 安置地点: '被篡改的地点' }
          : row,
      )
      api.__seedAllForTest({ relocate: changed, report: [] })
      api.__resetCacheForTest()

      const second = api.buildRelocatePackage(new Date('2026-11-20T08:00:00'))
      assert.equal(second.ok, true)
      if (!second.ok) throw new Error(second.message)
      assert.deepEqual([...second.reused].sort(), ['BQ-T-001', 'BQ-T-002', 'BQ-T-003', 'BQ-T-004'])
      const central = second.files.find((file) => file.mode === '集中安置')
      assert.match(central.filename, /2026-10-02/)
      const firstLine = central.content.split('\r\n').find((line) => line.startsWith('BQ-T-001'))
      assert.equal(firstLine, 'BQ-T-001,12,青龙镇集中安置点A区,集中安置')
      const money = second.files.find((file) => file.mode === '货币安置')
      assert.equal(money.note, true)
    },
  },
  {
    name: '导出结论同步险情上报待办：冒出已安置户且两处户数同源，不重复产生',
    run(api) {
      const built = api.buildRelocatePackage(new Date('2026-10-02T08:00:00'))
      assert.equal(built.ok, true)
      const sync1 = api.syncReportTodos()
      assert.equal(sync1.added, 4)
      assert.equal(sync1.total, 4)

      const reportRows = api.__listRows('report')
      const todos = api.resettledTodoRows(reportRows)
      assert.equal(todos.length, 4)
      const first = todos.find((row) => String(row['上报编号']) === '已安置户-BQ-T-001')
      assert.ok(first)
      assert.equal(Number(first['涉及户数']), 12)
      assert.equal(String(first['险情类别']), '已安置户')
      assert.equal(String(first.status), '待上报')
      assert.equal(String(first['来源搬迁编号']), 'BQ-T-001')

      const sync2 = api.syncReportTodos()
      assert.equal(sync2.added, 0)
      assert.equal(api.resettledTodoRows(api.__listRows('report')).length, 4)

      const fromReport = api.snapshotByCode(String(first['来源搬迁编号']))
      const fromRelocate = api.snapshotByCode('BQ-T-001')
      assert.deepEqual(fromReport, fromRelocate)
      assert.equal(fromReport.涉及户数, 12)

      const stats = api.relocateStats(relocateRows())
      assert.deepEqual(
        stats.map((item) => item.value),
        [12, 23, 6],
      )
    },
  },
  {
    name: '有坏户数时整批导出被退回：不出文件、不写快照、不产生待办',
    run(api) {
      const badRows = relocateRows().concat([
        {
          id: 5,
          status: '待签订',
          pending: true,
          abnormal: false,
          搬迁编号: 'BQ-T-BAD',
          所属隐患点: '测试隐患点',
          涉及户数: '约十户',
          安置方式: '货币安置',
          安置地点: '某地点',
          签订日期: '',
          完成日期: '',
          搬迁状态: '待签订',
        },
      ])
      api._clearSnapshotsForTest()
      api.__seedAllForTest({ relocate: badRows, report: [] })
      api.__resetCacheForTest()

      const result = api.buildRelocatePackage(new Date('2026-10-02T08:00:00'))
      assert.equal(result.ok, false)
      if (!result.ok) assert.match(result.message, /BQ-T-BAD/)
      assert.equal(api.listExportSnapshots().length, 0, '退回时不得写快照')
      const sync = api.syncReportTodos()
      assert.equal(sync.total, 0)
      assert.equal(api.__listRows('report').length, 0)
    },
  },
]

async function bundle() {
  await build({
    entryPoints: [path.join(root, 'test', 'relocate.entry.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: outFile,
    alias: { '@': path.join(root, 'src') },
    logLevel: 'silent',
  })
}

async function main() {
  await rm(outDir, { recursive: true, force: true })
  await bundle()

  for (const item of cases) {
    // 每个用例使用全新的模块实例 + 全新存储，互不串数据。
    const { ...api } = await import(`${pathToFileURL(outFile).href}?case=${encodeURIComponent(item.name)}`)
    const caseStore = makeMemoryStorage()
    globalThis.window = { localStorage: caseStore }
    api.__resetCacheForTest()
    api.__setSnapshotStorageForTest(caseStore)
    api.__seedAllForTest({ relocate: relocateRows(), report: [] })
    item.run(api)
    console.log(`  ✓ ${item.name}`)
  }
  await rm(outDir, { recursive: true, force: true })
  console.log(`\n${cases.length} 个用例全部通过`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
