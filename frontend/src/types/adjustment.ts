import type { Station } from './station'

/** 分配失败的具体原因（按站给出，方便复测） */
export type AdjustmentIssueCode =
  | 'NO_STATIONS' // 洞段下没有测点
  | 'NOT_CLOSED' // 导线已经闭合，无需分配
  | 'ZERO_DISTANCE' // 可分配站水平距合计为 0（如全是竖井零水平距）
  | 'BAD_READING' // 存在异常读数（方位角/倾角越界、斜距非正）
  | 'NO_HISTORY' // 没有可重试的上一版分配

export interface AdjustmentIssue {
  /** 问题测站桩号；洞段级问题为空数组 */
  stationCodes: string[]
  code: AdjustmentIssueCode
  message: string
}

/** 写入快照的单站成果（AdjustedLeg 的持久化形态） */
export interface AdjustmentStationSnapshot {
  stationId: string
  code: string
  /** 现场读数指纹（bearing|dip|slope|remeasured），用于判断读数是否改动 */
  fingerprint: string
  horizontalDistance: number
  verticalDistance: number
  horizontalCorrection: number
  east: number
  north: number
  chainage: number
  source: 'adjusted' | 'remeasured'
}

/**
 * 闭合差分配版本：每次分配成功保存一版。
 * 读数改动后当前版本作废，可从上一版重试。
 */
export interface AdjustmentRecord {
  id: string
  segmentId: string
  /** 版本号，从 1 递增；version 越大越新 */
  version: number
  createdAt: string
  createdBy: string
  note: string
  /** 分配前导线闭合差（米） */
  closureBefore: number
  /** 分配后闭合差（米，正常应趋近 0） */
  closureAfter: number
  /** 本站是否为当前有效版本 */
  active: boolean
  stations: AdjustmentStationSnapshot[]
}

/** 分配计算结果（不落库的中间产物） */
export interface AdjustmentComputeResult {
  ok: boolean
  record?: Omit<AdjustmentRecord, 'id' | 'version' | 'active'>
  issues: AdjustmentIssue[]
  /** 参与分配（改正）的测点数 */
  adjustedCount: number
  /** 复测站数（按原读数重算） */
  remeasuredCount: number
  closureBefore: number
  closureAfter: number
}

/** 计算一站读数指纹 */
export function stationFingerprint(station: Pick<Station, 'bearing' | 'dip' | 'slopeDistance' | 'isRemeasured'>): string {
  return [station.bearing, station.dip, station.slopeDistance, station.isRemeasured ? 1 : 0].join('|')
}
