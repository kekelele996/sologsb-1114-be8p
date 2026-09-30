import type {
  AdjustmentComputeResult,
  AdjustmentIssue,
  AdjustmentRecord,
  AdjustmentStationSnapshot,
  Station
} from '@/types'
import { stationFingerprint } from '@/types'
import {
  isStationReadingAbnormal,
  normalizeBearing,
  round,
  sortStationsByCode,
  toRadians
} from './survey'

/** 认为导线已闭合的容差（米）：闭合差小于该值无需分配 */
export const CLOSED_TOLERANCE = 0.001

/**
 * 按各站水平距分配闭合差（罗盘法则 / compass rule）。
 *
 * 设导线东向、北向累计偏差为 ΣΔE、ΣΔN，对每个参与改正的测站 i：
 *   vEi = -(Si / ΣS) · ΣΔE，vNi = -(Si / ΣS) · ΣΔN
 * 即按水平距占比反向配赋，改正后累计偏差恰为 0。
 *
 * 复测站（isRemeasured）不参与配赋，按原读数重算坐标。
 */
export function planAdjustment(
  stations: Station[],
  meta: { segmentId: string; createdBy?: string; note?: string }
): AdjustmentComputeResult {
  const ordered = sortStationsByCode(stations)
  const issues: AdjustmentIssue[] = []

  if (ordered.length === 0) {
    return {
      ok: false,
      issues: [
        {
          stationCodes: [],
          code: 'NO_STATIONS',
          message: '该洞段还没有测点读数，先录入测站后再做闭合差分配。'
        }
      ],
      adjustedCount: 0,
      remeasuredCount: 0,
      closureBefore: 0,
      closureAfter: 0
    }
  }

  // 异常读数必须先处理（复测或改正），分不下去
  const badCodes = ordered.filter(isStationReadingAbnormal).map((station) => station.code)
  if (badCodes.length > 0) {
    issues.push({
      stationCodes: badCodes,
      code: 'BAD_READING',
      message: `测站 ${badCodes.join('、')} 读数异常（方位角/倾角越界或斜距非正），请复测后再分配。`
    })
  }

  let east = 0
  let north = 0
  const raw: { sin: number; cos: number; s: number }[] = []
  for (const station of ordered) {
    const bearing = toRadians(normalizeBearing(station.bearing))
    const s = station.horizontalDistance
    const sin = Math.sin(bearing)
    const cos = Math.cos(bearing)
    raw.push({ sin, cos, s })
    east += s * sin
    north += s * cos
  }
  const closureBefore = round(Math.hypot(east, north), 3)

  if (closureBefore < CLOSED_TOLERANCE) {
    issues.push({
      stationCodes: [],
      code: 'NOT_CLOSED',
      message: `导线已经闭合（闭合差 ${closureBefore} m < ${CLOSED_TOLERANCE} m），无需分配。`
    })
  }

  const adjustable = ordered.map((station, index) => ({ station, index })).filter(({ station }) => !station.isRemeasured)
  const remeasured = ordered.filter((station) => station.isRemeasured)
  const totalS = adjustable.reduce((sum, { index }) => sum + raw[index].s, 0)

  if (adjustable.length === 0 || totalS <= 0) {
    issues.push({
      stationCodes: ordered.filter((station) => !station.isRemeasured && station.horizontalDistance <= 0).map((s) => s.code),
      code: 'ZERO_DISTANCE',
      message:
        adjustable.length === 0
          ? '所有测站均已复测，没有可承担改正的测站，无法按水平距分配；请取消部分复测标记。'
          : '可分配测站的水平距合计为 0，无法按水平距比例分配；请检查斜距与倾角读数。'
    })
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
      adjustedCount: adjustable.length,
      remeasuredCount: remeasured.length,
      closureBefore,
      closureAfter: closureBefore
    }
  }

  // 各站改正数（罗盘法则，复测站为 0）
  const corrections = new Array<{ vE: number; vN: number }>(ordered.length)
  for (const { index } of adjustable) {
    const ratio = raw[index].s / totalS
    corrections[index] = { vE: -ratio * east, vN: -ratio * north }
  }
  for (let i = 0; i < ordered.length; i += 1) {
    if (!corrections[i]) corrections[i] = { vE: 0, vN: 0 }
  }

  const snapshots: AdjustmentStationSnapshot[] = []
  let curEast = 0
  let curNorth = 0
  let chainage = 0
  let checkEast = 0
  let checkNorth = 0
  for (let i = 0; i < ordered.length; i += 1) {
    const station = ordered[i]
    const { vE, vN } = corrections[i]
    const dE = raw[i].s * raw[i].sin + vE
    const dN = raw[i].s * raw[i].cos + vN
    const adjustedHorizontal = round(Math.hypot(dE, dN), 3)
    // 水平距调整量（米）：正=加长，复测站为 0
    const correction = round(adjustedHorizontal - raw[i].s, 3)
    curEast = round(curEast + dE, 3)
    curNorth = round(curNorth + dN, 3)
    chainage = round(chainage + adjustedHorizontal, 3)
    checkEast += dE
    checkNorth += dN
    snapshots.push({
      stationId: station.id,
      code: station.code,
      fingerprint: stationFingerprint(station),
      horizontalDistance: adjustedHorizontal,
      verticalDistance: station.verticalDistance,
      horizontalCorrection: correction,
      east: curEast,
      north: curNorth,
      chainage,
      source: station.isRemeasured ? 'remeasured' : 'adjusted'
    })
  }

  const closureAfter = round(Math.hypot(checkEast, checkNorth), 6)
  const record: Omit<AdjustmentRecord, 'id' | 'version' | 'active'> = {
    segmentId: meta.segmentId,
    createdAt: new Date().toISOString(),
    createdBy: meta.createdBy ?? '',
    note: meta.note ?? '',
    closureBefore,
    closureAfter,
    stations: snapshots
  }

  return {
    ok: true,
    record,
    issues: [],
    adjustedCount: adjustable.length,
    remeasuredCount: remeasured.length,
    closureBefore,
    closureAfter
  }
}
