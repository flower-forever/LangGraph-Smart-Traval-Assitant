/**
 * P · 景点资料卡 · 收进预填载荷（三期 S3）。
 *
 * 收进 = 打开预填表单（用户可改），确认才存；不采纳（取消 / 关闭）零写入。
 * 本类型是 WebSourcesPanel（tavily）/ DayPoiSourcesPanel（osm）→ App →
 * PoiCardPanel 的预填契约：来源面板构造（逐字段 provenance + collectNotice），
 * App 只负责按名称找卡（唯一命中 → 编辑态补空字段；否则新建态）并打开面板，
 * PoiCardPanel 用它初始化内存表单。它本身不落盘，也没有任何写路径；
 * 不点「收进」就不会构造、不会出现预填表单。
 */
import type { CardImageV1, PoiCardFieldProvenanceV1 } from './poiCards'

/** 预填字段的逐字段来源；缺省 / null = 该字段无来源（用户补填时标 manual）。 */
export interface PoiCardPrefillProvenance {
  intro?: PoiCardFieldProvenanceV1 | null
  openingHours?: PoiCardFieldProvenanceV1 | null
  ticket?: PoiCardFieldProvenanceV1 | null
}

/** 一路收进的预填载荷：全部内容默认「未核实」，确认保存才落盘。 */
export interface PoiCardPrefill {
  /** 预填名称；空 = 来源未提供名称，用户必须填写后才能保存。 */
  name: string
  /** 只参与 identityKey 计算，不落在卡上（与 PoiCardInput.address 同语义）。 */
  address?: string | null
  intro?: string
  openingHours?: string
  ticket?: string
  /** 预填图片（来源标注完整）；保存时随卡写入。 */
  images?: CardImageV1[]
  /** 预填字段来源（tavily / osm 等）；缺省 = 无来源。 */
  provenance?: PoiCardPrefillProvenance | null
  /** 收进路径说明（含「未核实」语义）；null / 缺省 = 手动新建，不显示。 */
  collectNotice?: string | null
  /** 收进表单里用户新贴图片 URL 的来源标注；缺省 = manual（手动粘贴）。 */
  imageSourceHint?: CardImageV1['source']
  /** imageSourceHint 为 'tavily' 时，图片 attribution 标的页面来源。 */
  imageAttributionHint?: string | null
}
