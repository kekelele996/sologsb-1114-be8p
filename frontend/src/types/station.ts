/** 一站导线的调整后成果（现场读数不改动，成果单独保存） */
export interface AdjustedLeg {
  /** 调整后水平距（米） */
  horizontalDistance: number
  /** 调整后垂距（米）：倾角/斜距未参与分配，沿用原读数推算值 */
  verticalDistance: number
  /** 分配到本站的水平距改正数（米，正=加长） */
  horizontalCorrection: number
  /** 站点平面坐标（东向，米；导线起点为原点） */
  east: number
  /** 站点平面坐标（北向，米） */
  north: number
  /** 沿导线累计里程（米，用于草图锚点/图幅偏移） */
  chainage: number
  /** 成果来源：adjusted = 参与分配；remeasured = 复测站按原读数重算 */
  source: 'adjusted' | 'remeasured'
}

/** Station 测点：由方位角与斜距自动推算水平距与垂距 */
export interface Station {
  id: string
  segmentId: string
  /** 测点桩号，如 P12 */
  code: string
  /** 前视方位角（十进制度，0-360） */
  bearing: number
  /** 倾角（十进制度，-90 ~ 90） */
  dip: number
  /** 斜距（米） */
  slopeDistance: number
  /** 水平距（米，由斜距与倾角推算） */
  horizontalDistance: number
  /** 垂距（米，由斜距与倾角推算） */
  verticalDistance: number
  /** 仪器号 */
  instrumentNo: string
  /** 测量人 */
  surveyor: string
  /** 测量日期 */
  date: string
  /** 是否闭合点 */
  isClosurePoint: boolean
  /** 是否复测站：复测站按原读数重算，不参与闭合差分配 */
  isRemeasured: boolean
  /** 最近一次成功分配写入的调整后成果；读数改动后作废重算 */
  adjusted: AdjustedLeg | null
  note: string
}

export interface ClosureResult {
  /** 闭合差（米） */
  closure: number
  /** 阈值（米） */
  threshold: number
  /** 是否超限 */
  over: boolean
  level: '优' | '良' | '超限'
  /** 参与计算的测点数 */
  count: number
  /** 累计水平位移（东向 / 北向） */
  east: number
  north: number
  /** 计算过程说明 */
  detail: string
}
