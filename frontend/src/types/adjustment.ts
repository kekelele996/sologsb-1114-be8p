/** Adjustment 导线平差成果：现场读数不动，闭合差按水平距分配后另存的成果记录 */

/** 单站平差成果（读数原样保留，调整量另存） */
export interface StationAdjustment {
  stationId: string
  code: string
  segmentId: string
  segmentCode: string
  // —— 原始读数快照（现场读数留着不动） ——
  bearing: number
  dip: number
  slopeDistance: number
  horizontalDistance: number
  // —— 原始坐标增量（由读数直接推算） ——
  dE: number
  dN: number
  // —— 调整量（坐标改正数，另存） ——
  vE: number
  vN: number
  // —— 调整后坐标（以导线首站为原点的假定坐标） ——
  east: number
  north: number
  /** 调整后水平距（由调整后坐标增量反算的边长） */
  adjustedHorizontal: number
  /** 调整后累计里程（米，自导线首站起算） */
  chainage: number
}

/** 洞段平差成果 */
export interface SegmentAdjustment {
  segmentId: string
  code: string
  stationCount: number
  /** 实测长度（原始水平距之和，读数改动即重算） */
  measuredLength: number
  /** 调整后长度（调整后边长之和，成果采用此值） */
  adjustedLength: number
  /** 调整后起止里程（米） */
  startChainage: number
  endChainage: number
}

/** 问题测站：分不下去时逐站说清原因 */
export interface StationProblem {
  stationId: string
  code: string
  segmentCode: string
  reasons: string[]
}

/** 一次平差运行（一个洞穴可保留多版，失败不覆盖上一版成果） */
export interface AdjustmentRun {
  id: string
  caveId: string
  /** 版本号，同一洞穴内递增 */
  version: number
  createdAt: string
  /** success = 已分配；failed = 读数有问题分不下去（保留原因，可重试） */
  status: 'success' | 'failed'
  /** 读数快照哈希：读数一改动即与当前读数不符，据此判定成果待重算 */
  readingHash: string
  stationCount: number
  /** 参与分配的水平距合计（米） */
  totalHorizontal: number
  // —— 分配前闭合差 ——
  closureEast: number
  closureNorth: number
  closure: number
  threshold: number
  // —— 分配后残余闭合差 ——
  residualEast: number
  residualNorth: number
  residual: number
  /** 实测总长（原始水平距合计） */
  measuredTotalLength: number
  /** 调整后洞穴实测总长 */
  totalLength: number
  /** 导线起点里程（米，取首洞段起始桩号） */
  startChainage: number
  /** 问题测站（failed 时逐站列出；success 时为空） */
  problems: StationProblem[]
  /** 失败说明 */
  failReason?: string
  // —— 成果明细 ——
  stationAdjustments: StationAdjustment[]
  segmentAdjustments: SegmentAdjustment[]
}
