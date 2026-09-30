import type { ClosureResult, Station } from '@/types'

/** 按桩号数字顺序排列测点（P2 在 P10 之前） */
export function sortStationsByCode(stations: Station[]): Station[] {
  return [...stations].sort(
    (a, b) => Number((a.code.match(/\d+/) ?? ['0'])[0]) - Number((b.code.match(/\d+/) ?? ['0'])[0])
  )
}

/** 异常读数：方位角或倾角超范围、斜距非正、水平距大于斜距 */
export function isStationReadingAbnormal(station: Station): boolean {
  if (!isValidBearing(station.bearing)) return true
  if (!isValidDip(station.dip)) return true
  if (!(station.slopeDistance > 0)) return true
  return station.horizontalDistance > Math.abs(station.slopeDistance) + 0.001
}

/** 角度转弧度 */
export function toRadians(deg: number): number {
  return (deg * Math.PI) / 180
}

/** 弧度转角度 */
export function toDegrees(rad: number): number {
  return (rad * 180) / Math.PI
}

/** 保留 n 位小数（避免浮点噪声） */
export function round(value: number, digits = 3): number {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

/** 方位角归一到 0-360 */
export function normalizeBearing(deg: number): number {
  const value = deg % 360
  return value < 0 ? value + 360 : value
}

/** 度分秒转十进制度 */
export function dmsToDecimal(d: number, m: number, s: number): number {
  const sign = d < 0 ? -1 : 1
  return sign * (Math.abs(d) + Math.abs(m) / 60 + Math.abs(s) / 3600)
}

/** 十进制度转度分秒 */
export function decimalToDms(deg: number): { d: number; m: number; s: number } {
  const sign = deg < 0 ? -1 : 1
  const abs = Math.abs(deg)
  const d = Math.floor(abs)
  const mFloat = (abs - d) * 60
  const m = Math.floor(mFloat)
  const s = round((mFloat - m) * 60, 1)
  return { d: sign * d, m, s }
}

/** 解析 "123°45'30\"" / "123 45 30" / "123.5" 形式的角值 */
export function parseAngle(input: string): number | null {
  const text = input.trim()
  if (!text) return null
  const dms = /^(-?\d+(?:\.\d+)?)[°\s]+(\d+(?:\.\d+)?)?['′\s]*(\d+(?:\.\d+)?)?["″]?$/.exec(text)
  if (dms) {
    const d = Number(dms[1])
    const m = dms[2] ? Number(dms[2]) : 0
    const s = dms[3] ? Number(dms[3]) : 0
    return round(dmsToDecimal(d, m, s), 4)
  }
  const plain = Number.parseFloat(text)
  return Number.isFinite(plain) ? plain : null
}

/** 格式化为度分秒字符串 */
export function formatDms(deg: number): string {
  const { d, m, s } = decimalToDms(deg)
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1)}″`
}

/** 校验方位角 */
export function isValidBearing(deg: number): boolean {
  return Number.isFinite(deg) && deg >= 0 && deg < 360
}

/** 校验倾角 */
export function isValidDip(deg: number): boolean {
  return Number.isFinite(deg) && deg >= -90 && deg <= 90
}

/** 由斜距与倾角推算水平距 */
export function computeHorizontal(dip: number, slope: number): number {
  return round(Math.abs(slope) * Math.cos(toRadians(dip)), 3)
}

/** 由斜距与倾角推算垂距 */
export function computeVertical(dip: number, slope: number): number {
  return round(Math.abs(slope) * Math.sin(toRadians(dip)), 3)
}

/** 桩号文本转数字，如 K1+250 -> 1250 */
export function stakeToNumber(stake: string): number {
  const match = /(\d+)\s*\+\s*(\d+)/.exec(stake ?? '')
  if (match) return Number(match[1]) * 1000 + Number(match[2])
  const plain = Number.parseFloat(String(stake ?? '').replace(/[^\d.-]/g, ''))
  return Number.isFinite(plain) ? plain : 0
}

/** 数字转桩号文本，如 1250 -> K1+250 */
export function numberToStake(value: number): string {
  const km = Math.floor(Math.max(0, value) / 1000)
  const m = round(Math.max(0, value) % 1000, 1)
  return `K${km}+${String(Math.floor(m)).padStart(3, '0')}`
}

/** 桩号区间标签 */
export function stakeRangeLabel(start: string, end: string): string {
  return `${start} → ${end}（${round(stakeToNumber(end) - stakeToNumber(start), 2)} m）`
}

/** 桩号区间是否相交 */
export function stakeRangeOverlap(a1: number, a2: number, b1: number, b2: number): boolean {
  const lo1 = Math.min(a1, a2)
  const hi1 = Math.max(a1, a2)
  const lo2 = Math.min(b1, b2)
  const hi2 = Math.max(b1, b2)
  return lo1 <= hi2 && lo2 <= hi1
}

/**
 * 把草图锚点桩号换算成沿导线的累计里程（米）。
 * 以洞段起始桩号为导线起点，读数/分配改动后由调用方重算；
 * 超出导线范围时夹取到首末站。
 */
export function anchorChainage(
  anchorStake: string,
  startStake: string,
  stations: Station[],
  useAdjusted = true
): number {
  const offset = Math.max(0, stakeToNumber(anchorStake) - stakeToNumber(startStake))
  const chainage = traverseChainage(stations, useAdjusted)
  const total = chainage[chainage.length - 1] ?? 0
  return round(Math.min(offset, total), 3)
}

/**
 * 沿导线里程对应到平面坐标（在相邻站点间按里程线性插值）。
 * 里程超过首末站时夹取；无测点返回原点。
 */
export function chainageToPoint(
  stations: Station[],
  target: number,
  useAdjusted = true
): { east: number; north: number } {
  if (stations.length === 0) return { east: 0, north: 0 }
  const coords = traverseCoordinates(stations, { useAdjusted })
  const chain = [0, ...traverseChainage(stations, useAdjusted)]
  const goal = Math.min(Math.max(target, 0), chain[chain.length - 1])
  for (let i = 1; i < chain.length; i += 1) {
    if (goal <= chain[i] || i === chain.length - 1) {
      const span = chain[i] - chain[i - 1]
      const ratio = span <= 0 ? 0 : (goal - chain[i - 1]) / span
      return {
        east: round(coords[i - 1].east + (coords[i].east - coords[i - 1].east) * ratio, 3),
        north: round(coords[i - 1].north + (coords[i].north - coords[i - 1].north) * ratio, 3)
      }
    }
  }
  return { east: 0, north: 0 }
}

/** 一站参与成果计算的水平距/垂距：已分配则用调整后成果，否则用现场读数推算值 */
export function effectiveHorizontal(station: Station): number {
  return station.adjusted?.horizontalDistance ?? station.horizontalDistance
}

export function effectiveVertical(station: Station): number {
  return station.adjusted?.verticalDistance ?? station.verticalDistance
}

/** 一站的平面坐标增量（东向 / 北向） */
export function legDelta(
  station: Station,
  horizontal: number,
  baseBearingOffset = 0
): { east: number; north: number } {
  const bearing = toRadians(normalizeBearing(station.bearing - baseBearingOffset))
  return {
    east: horizontal * Math.sin(bearing),
    north: horizontal * Math.cos(bearing)
  }
}

/** 逐站平面坐标（含起点原点），默认使用调整后成果 */
export function traverseCoordinates(
  stations: Station[],
  options: { useAdjusted?: boolean; baseBearing?: number } = {}
): { east: number; north: number }[] {
  const { useAdjusted = true, baseBearing = 0 } = options
  const points: { east: number; north: number }[] = [{ east: 0, north: 0 }]
  let east = 0
  let north = 0
  for (const station of stations) {
    const horizontal = useAdjusted ? effectiveHorizontal(station) : station.horizontalDistance
    const delta = legDelta(station, horizontal, baseBearing)
    east += delta.east
    north += delta.north
    points.push({ east: round(east, 3), north: round(north, 3) })
  }
  return points
}

/** 各站沿导线累计里程（水平距累计，米） */
export function traverseChainage(stations: Station[], useAdjusted = true): number[] {
  const result: number[] = []
  let total = 0
  for (const station of stations) {
    total += useAdjusted ? effectiveHorizontal(station) : station.horizontalDistance
    result.push(round(total, 3))
  }
  return result
}

/**
 * 闭合差：把每站的方位角与水平距分解为东向/北向增量，
 * 导线闭合差即累计位移向量的模。
 * @param useAdjusted true=用分配后的成果（分配残差），false=用现场原读数
 */
export function computeClosure(stations: Station[], threshold = 0.25, useAdjusted = false): ClosureResult {
  let east = 0
  let north = 0
  for (const station of stations) {
    const horizontal = useAdjusted ? effectiveHorizontal(station) : station.horizontalDistance
    const delta = legDelta(station, horizontal)
    east += delta.east
    north += delta.north
  }
  const closure = round(Math.hypot(east, north), 3)
  const level: ClosureResult['level'] = closure < threshold * 0.4 ? '优' : closure < threshold ? '良' : '超限'
  const sourceLabel = useAdjusted ? '分配后成果水平距' : '原读数水平距'
  return {
    closure,
    threshold,
    over: closure >= threshold,
    level,
    count: stations.length,
    east: round(east, 3),
    north: round(north, 3),
    detail: `按${sourceLabel}分解：东向累计 ΣΔE = ${round(east, 3)} m，北向累计 ΣΔN = ${round(north, 3)} m，闭合差 f = √(ΣΔE² + ΣΔN²) = ${closure} m，阈值 ${threshold} m`
  }
}
