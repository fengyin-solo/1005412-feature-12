/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
  /** 为 true 时状态只能一段一段往前推：倒序改动和跨段跳转一律挡下。 */
  strictSequence?: boolean
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 搬迁编号首次导出的落账结果：之后再导出同一编号，只认这份。 */
export type RelocateExportRecord = {
  搬迁编号: string
  安置方式: string
  涉及户数: number
  安置地点: string
  导出日期: string
}

export type ExportFile = {
  filename: string
  content: string
  mime: string
}

export type RelocationExportResult = {
  files: ExportFile[]
  exported: number
  duplicated: number
  rejected: number
  synced: number
  message: string
}
