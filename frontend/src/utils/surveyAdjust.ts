import type { Segment, Station } from '@/types'
import type { StationAdjustment, SegmentAdjustment, StationProblem } from '@/types'
import {
  computeHorizontal,
  isValidBearing,
  isValidDip,
  normalizeBearing,
  round,
  stakeToNumber,
  toRadians
} from './survey'

/** 参与平差的一个导线点：测点 + 所属洞段 */
export interface TraversePoint {
  station: Station
  segment: Segment
}

/** 平差计算的中间结果（未落库） */
export interface AdjustmentComputation {
  ok: boolean
  problems: StationProblem[]
  stationAdjustments: StationAdjustment[]
  segmentAdjustments: SegmentAdjustment[]
  closureEast: number
  closureNorth: number
  closure: number
  residualEast: number
  residualNorth: number
  residual: number
  totalHorizontal: number
  measuredTotalLength: number
  totalLength: number
  stationCount: number
  startChainage: number
}

/**
 * 导线点排序：沿桩号前进方向，先按洞段起始桩号、再按测点桩号数字排序。
 * 读数原样使用，仅决定平差推算顺序。
 */
export function orderTraversePoints(segments: Segment[], stations: Station[]): TraversePoint[] {
  const segOrder = new Map(
    [...segments]
      .sort((a, b) => stakeToNumber(a.startStake) - stakeToNumber(b.startStake))
      .map((segment, index) => [segment.id, index])
  )
  const points: TraversePoint[] = []
  for (const station of stations) {
    const segment = segments.find((item) => item.id === station.segmentId)
    if (segment) points.push({ station, segment })
  }
  points.sort((a, b) => {
    const sa = segOrder.get(a.segment.id) ?? 0
    const sb = segOrder.get(b.segment.id) ?? 0
    if (sa !== sb) return sa - sb
    const na = Number((a.station.code.match(/\d+/) ?? ['0'])[0])
    const nb = Number((b.station.code.match(/\d+/) ?? ['0'])[0])
    return na - nb
  })
  return points
}

/** 由斜距/倾角取水平距（读数里没算就现算） */
function horizontalOf(station: Station): number {
  return station.horizontalDistance || computeHorizontal(station.dip, station.slopeDistance)
}

/** 校验读数，返回问题测站清单（分不下去时逐站说清原因） */
export function validatePoints(points: TraversePoint[]): StationProblem[] {
  const problems: StationProblem[] = []
  const codeCount = new Map<string, number>()
  for (const { station } of points) {
    codeCount.set(station.code, (codeCount.get(station.code) ?? 0) + 1)
  }
  for (const { station, segment } of points) {
    const reasons: string[] = []
    if (!isValidBearing(station.bearing)) reasons.push('方位角超出 0°–360°')
    if (!isValidDip(station.dip)) reasons.push('倾角超出 -90°–90°')
    if (!(station.slopeDistance > 0)) reasons.push('斜距非正')
    const h = horizontalOf(station)
    if (!(h > 0)) reasons.push('水平距为 0，无法参与分配')
    if (h > Math.abs(station.slopeDistance) + 0.001) reasons.push('水平距大于斜距，读数矛盾')
    if ((codeCount.get(station.code) ?? 0) > 1) reasons.push(`桩号「${station.code}」重复，导线顺序无法确定`)
    if (reasons.length > 0) {
      problems.push({ stationId: station.id, code: station.code, segmentCode: segment.code, reasons })
    }
  }
  return problems
}

/**
 * 读数快照哈希：把各站读数拼成稳定字符串后做 FNV-1a 散列。
 * 读数一改动，哈希即变，据此判断平差成果是否需要重算。
 */
export function computeReadingHash(points: TraversePoint[]): string {
  const parts = points
    .map(
      (point) =>
        `${point.station.id}|${point.station.bearing}|${point.station.dip}|${point.station.slopeDistance}|${point.station.horizontalDistance}`
    )
    .sort()
  const text = parts.join(';')
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return `fnv1a_${(hash >>> 0).toString(16)}_${text.length}`
}

/**
 * 导线平差（罗盘仪法则 / Bowditch）：
 * 闭合差 f = √(ΣΔE² + ΣΔN²)，按各站水平距成比例反号分配坐标改正数。
 * 现场读数（方位角/倾角/斜距）原样不动，调整量另存，成果（坐标与边长）用分配后的值。
 */
export function computeAdjustment(points: TraversePoint[]): AdjustmentComputation {
  const problems = validatePoints(points)
  const base: AdjustmentComputation = {
    ok: false,
    problems,
    stationAdjustments: [],
    segmentAdjustments: [],
    closureEast: 0,
    closureNorth: 0,
    closure: 0,
    residualEast: 0,
    residualNorth: 0,
    residual: 0,
    totalHorizontal: 0,
    measuredTotalLength: 0,
    totalLength: 0,
    stationCount: points.length,
    startChainage: 0
  }

  if (points.length === 0) {
    problems.push({ stationId: '', code: '', segmentCode: '', reasons: ['洞穴暂无测点，无法平差'] })
    return base
  }

  const rows = points.map((point) => {
    const h = horizontalOf(point.station)
    const bearing = toRadians(normalizeBearing(point.station.bearing))
    return {
      station: point.station,
      segment: point.segment,
      h,
      dE: h * Math.sin(bearing),
      dN: h * Math.cos(bearing)
    }
  })

  const totalH = rows.reduce((sum, row) => sum + row.h, 0)
  if (totalH <= 0) {
    problems.push({
      stationId: '',
      code: '',
      segmentCode: '',
      reasons: ['各站水平距合计为 0，无法按水平距分配闭合差']
    })
    return { ...base, problems, totalHorizontal: 0 }
  }
  // 读数有问题时停下，不分下去（逐站原因见 problems）
  if (problems.length > 0) {
    return { ...base, problems, totalHorizontal: round(totalH, 3) }
  }

  const closureEast = rows.reduce((sum, row) => sum + row.dE, 0)
  const closureNorth = rows.reduce((sum, row) => sum + row.dN, 0)
  const closure = Math.hypot(closureEast, closureNorth)

  // 起点里程：取首洞段起始桩号
  const startChainage = stakeToNumber(points[0].segment.startStake)

  let east = 0
  let north = 0
  let chainage = startChainage
  const stationAdjustments: StationAdjustment[] = []
  const segmentMap = new Map<string, SegmentAdjustment>()

  for (const row of rows) {
    // 坐标改正数：与闭合差反号、按水平距成比例
    const vE = -closureEast * (row.h / totalH)
    const vN = -closureNorth * (row.h / totalH)
    const adjDE = row.dE + vE
    const adjDN = row.dN + vN
    const adjustedHorizontal = Math.hypot(adjDE, adjDN)
    east += adjDE
    north += adjDN
    const chainageBefore = chainage
    chainage += adjustedHorizontal

    stationAdjustments.push({
      stationId: row.station.id,
      code: row.station.code,
      segmentId: row.segment.id,
      segmentCode: row.segment.code,
      bearing: row.station.bearing,
      dip: row.station.dip,
      slopeDistance: row.station.slopeDistance,
      horizontalDistance: round(row.h, 3),
      dE: round(row.dE, 4),
      dN: round(row.dN, 4),
      vE: round(vE, 4),
      vN: round(vN, 4),
      east: round(east, 3),
      north: round(north, 3),
      adjustedHorizontal: round(adjustedHorizontal, 3),
      chainage: round(chainage, 3)
    })

    let seg = segmentMap.get(row.segment.id)
    if (!seg) {
      seg = {
        segmentId: row.segment.id,
        code: row.segment.code,
        stationCount: 0,
        measuredLength: 0,
        adjustedLength: 0,
        startChainage: round(chainageBefore, 3),
        endChainage: round(chainage, 3)
      }
      segmentMap.set(row.segment.id, seg)
    }
    seg.stationCount += 1
    seg.measuredLength = round(seg.measuredLength + row.h, 3)
    seg.adjustedLength = round(seg.adjustedLength + adjustedHorizontal, 3)
    seg.endChainage = round(chainage, 3)
  }

  const segmentAdjustments = [...segmentMap.values()]
  const measuredTotalLength = round(rows.reduce((sum, row) => sum + row.h, 0), 3)
  const totalLength = round(stationAdjustments.reduce((sum, item) => sum + item.adjustedHorizontal, 0), 3)
  // 残余闭合差（用落库的改正数反算，反映舍入后的真实残差）
  const residualEast = round(closureEast + stationAdjustments.reduce((sum, item) => sum + item.vE, 0), 4)
  const residualNorth = round(closureNorth + stationAdjustments.reduce((sum, item) => sum + item.vN, 0), 4)
  const residual = round(Math.hypot(residualEast, residualNorth), 4)

  return {
    ok: true,
    problems: [],
    stationAdjustments,
    segmentAdjustments,
    closureEast: round(closureEast, 4),
    closureNorth: round(closureNorth, 4),
    closure: round(closure, 3),
    residualEast,
    residualNorth,
    residual,
    totalHorizontal: round(totalH, 3),
    measuredTotalLength,
    totalLength,
    stationCount: points.length,
    startChainage: round(startChainage, 3)
  }
}
