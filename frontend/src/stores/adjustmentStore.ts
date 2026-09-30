import { createStore } from 'zustand/vanilla'
import type { AdjustmentComputeResult, AdjustmentRecord, Cave, Segment, Station } from '@/types'
import { db, syncAll } from '@/hooks/usePersistentStore'
import { planAdjustment } from '@/utils/adjustment'
import { round, sortStationsByCode, traverseChainage } from '@/utils/survey'
import { uid } from '@/utils/id'

export interface AdjustmentState {
  records: AdjustmentRecord[]
  loaded: boolean
  hydrate: () => Promise<void>
  /** 按当前读数对洞段做一次闭合差分配，失败时不写入并返回问题测站 */
  apply: (segmentId: string, options?: { createdBy?: string; note?: string }) => Promise<AdjustmentComputeResult>
  /** 从上一版分配重试（读数改动后用新读数重算并生成新版本） */
  retry: (segmentId: string, options?: { createdBy?: string; note?: string }) => Promise<AdjustmentComputeResult>
  /** 清除洞段当前分配，成果回落到现场读数 */
  clearAdjustment: (segmentId: string) => Promise<void>
  /** 删除某一版分配历史；若删的是当前版，自动回落到最新剩余版本 */
  removeRecord: (recordId: string) => Promise<void>
  /** 洞段删除时连带清理其分配版本 */
  removeBySegment: (segmentId: string) => Promise<void>
  /**
   * 读数改动后的核对：指纹不符的当前版本作废（清成果），
   * 洞段长度 / 洞穴实测总长重算。
   */
  reconcile: () => Promise<void>
  /** 取洞段当前有效版本 */
  activeOf: (segmentId: string) => AdjustmentRecord | undefined
  /** 取洞段全部版本（新→旧） */
  versionsOf: (segmentId: string) => AdjustmentRecord[]
}

/** 各洞段当前有效版本（active 且版本号最大） */
function activeBySegment(records: AdjustmentRecord[]): Map<string, AdjustmentRecord> {
  const map = new Map<string, AdjustmentRecord>()
  for (const record of records) {
    if (!record.active) continue
    const current = map.get(record.segmentId)
    if (!current || record.version > current.version) map.set(record.segmentId, record)
  }
  return map
}

/** 依据有效版本把调整成果写回各站（无有效版本的洞段清空成果），返回更新后的测站表 */
async function syncStationAdjustments(
  txStations: Station[],
  txRecords: AdjustmentRecord[]
): Promise<Station[]> {
  const activeMap = activeBySegment(txRecords)
  return txStations.map((station) => {
    const record = activeMap.get(station.segmentId)
    const snapshot = record?.stations.find((item) => item.stationId === station.id)
    if (!record || !snapshot) {
      return station.adjusted === null ? station : { ...station, adjusted: null }
    }
    return {
      ...station,
      adjusted: {
        horizontalDistance: snapshot.horizontalDistance,
        verticalDistance: snapshot.verticalDistance,
        horizontalCorrection: snapshot.horizontalCorrection,
        east: snapshot.east,
        north: snapshot.north,
        chainage: snapshot.chainage,
        source: snapshot.source
      }
    }
  })
}

/** 重算各洞段实测长度（各站成果水平距累计）与各洞穴实测总长 */
function recomputeLengths(segments: Segment[], stations: Station[]): {
  segments: Segment[]
  cavesDelta: Map<string, number>
} {
  const bySegment = new Map<string, Station[]>()
  for (const station of stations) {
    const list = bySegment.get(station.segmentId)
    if (list) list.push(station)
    else bySegment.set(station.segmentId, [station])
  }

  const now = new Date().toISOString()
  const nextSegments = segments.map((segment) => {
    const list = sortStationsByCode(bySegment.get(segment.id) ?? [])
    if (list.length === 0) {
      return segment.surveyedLength === null ? segment : { ...segment, surveyedLength: null, surveyedAt: '' }
    }
    const chainage = traverseChainage(list, true)
    const surveyedLength = round(chainage[chainage.length - 1] ?? 0, 3)
    return { ...segment, surveyedLength, surveyedAt: now }
  })

  const cavesDelta = new Map<string, number>()
  for (const segment of nextSegments) {
    if (typeof segment.surveyedLength !== 'number') continue
    cavesDelta.set(segment.caveId, round((cavesDelta.get(segment.caveId) ?? 0) + segment.surveyedLength, 3))
  }
  return { segments: nextSegments, cavesDelta }
}

/** 重算洞段/洞穴长度并写库（事务外调用时使用独立事务） */
async function persistLengths(txStations: Station[]): Promise<void> {
  await db.transaction('rw', db.segments, db.caves, db.stations, async () => {
    const segments = await db.segments.toArray()
    const { segments: nextSegments, cavesDelta } = recomputeLengths(segments, txStations)
    await db.segments.bulkPut(nextSegments)
    const caves = await db.caves.toArray()
    const now = new Date().toISOString()
    await db.caves.bulkPut(
      caves.map((cave: Cave) => ({
        ...cave,
        surveyedLength: cavesDelta.has(cave.id) ? (cavesDelta.get(cave.id) as number) : null,
        surveyedAt: cavesDelta.has(cave.id) ? now : ''
      }))
    )
  })
}

export const adjustmentStore = createStore<AdjustmentState>((set, get) => ({
  records: [],
  loaded: false,

  hydrate: async () => {
    const records = await syncAll<AdjustmentRecord>(db.adjustments)
    records.sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))
    set({ records, loaded: true })
  },

  activeOf: (segmentId) => get().records.filter((r) => r.active && r.segmentId === segmentId).sort((a, b) => b.version - a.version)[0],

  versionsOf: (segmentId) => get().records.filter((r) => r.segmentId === segmentId),

  apply: async (segmentId, options) => {
    const stations = sortStationsByCode(await db.stations.where('segmentId').equals(segmentId).toArray())
    const result = planAdjustment(stations, {
      segmentId,
      createdBy: options?.createdBy,
      note: options?.note
    })
    if (!result.ok || !result.record) return result

    await db.transaction('rw', db.adjustments, db.stations, db.segments, db.caves, async () => {
      const maxVersion = Math.max(0, ...(await db.adjustments.where('segmentId').equals(segmentId).toArray()).map((r) => r.version))
      const record: AdjustmentRecord = {
        ...(result.record as Omit<AdjustmentRecord, 'id' | 'version' | 'active'>),
        id: uid('adj'),
        version: maxVersion + 1,
        active: true
      }
      // 同洞段旧版本全部归档
      const oldRecords = (await db.adjustments.where('segmentId').equals(segmentId).toArray()).map((r) => ({
        ...r,
        active: false
      }))
      await db.adjustments.bulkPut(oldRecords)
      await db.adjustments.put(record)

      const allRecords = await db.adjustments.toArray()
      const txStations = await db.stations.toArray()
      await db.stations.bulkPut(await syncStationAdjustments(txStations, allRecords))

      const nextStations = await db.stations.toArray()
      const { segments: nextSegments, cavesDelta } = recomputeLengths(await db.segments.toArray(), nextStations)
      await db.segments.bulkPut(nextSegments)
      const now = new Date().toISOString()
      const caves = await db.caves.toArray()
      await db.caves.bulkPut(
        caves.map((cave) => ({
          ...cave,
          surveyedLength: cavesDelta.has(cave.id) ? (cavesDelta.get(cave.id) as number) : cave.surveyedLength,
          surveyedAt: cavesDelta.has(cave.id) ? now : cave.surveyedAt
        }))
      )
    })

    await get().hydrate()
    await rehydrateDownstream()
    return result
  },

  retry: async (segmentId, options) => {
    const history = get()
      .records.filter((r) => r.segmentId === segmentId)
      .sort((a, b) => b.version - a.version)
    if (history.length === 0) {
      return {
        ok: false,
        issues: [
          {
            stationCodes: [],
            code: 'NO_HISTORY' as const,
            message: '该洞段还没有上一版分配可重试，请直接执行「按水平距分配」。'
          }
        ],
        adjustedCount: 0,
        remeasuredCount: 0,
        closureBefore: 0,
        closureAfter: 0
      }
    }
    const base = history[0]
    return get().apply(segmentId, {
      createdBy: options?.createdBy ?? base.createdBy,
      note: options?.note ?? `自第 ${base.version} 版重试`
    })
  },

  clearAdjustment: async (segmentId) => {
    await db.transaction('rw', db.adjustments, db.stations, db.segments, db.caves, async () => {
      await db.adjustments.where('segmentId').equals(segmentId).delete()
      const txStations = await db.stations.toArray()
      await db.stations.bulkPut(await syncStationAdjustments(txStations, await db.adjustments.toArray()))
    })
    await persistLengths(await db.stations.toArray())
    await get().hydrate()
    await rehydrateDownstream()
  },

  removeRecord: async (recordId) => {
    const target = get().records.find((r) => r.id === recordId)
    await db.transaction('rw', db.adjustments, db.stations, db.segments, db.caves, async () => {
      await db.adjustments.delete(recordId)
      const remaining = await db.adjustments.where('segmentId').equals(target?.segmentId ?? '').toArray()
      // 若删的是当前版，剩余版本中最新的一版重新置为有效
      if (target?.active && remaining.length > 0) {
        const latest = remaining.sort((a, b) => b.version - a.version)[0]
        await db.adjustments.put({ ...latest, active: true })
      }
      const txStations = await db.stations.toArray()
      await db.stations.bulkPut(await syncStationAdjustments(txStations, await db.adjustments.toArray()))
    })
    await persistLengths(await db.stations.toArray())
    await get().hydrate()
    await rehydrateDownstream()
  },

  removeBySegment: async (segmentId) => {
    await db.adjustments.where('segmentId').equals(segmentId).delete()
    await get().hydrate()
  },

  reconcile: async () => {
    await db.transaction('rw', db.adjustments, db.stations, db.segments, db.caves, async () => {
      const stations = await db.stations.toArray()
      const stationById = new Map(stations.map((s) => [s.id, s]))
      const records = await db.adjustments.toArray()

      // 当前版本逐站核对读数指纹：任一测站读数改动（含复测标记变化）、
      // 测站被删除或同洞段新增测站，整版作废
      const stationsBySegment = new Map<string, Station[]>()
      for (const station of stations) {
        const list = stationsBySegment.get(station.segmentId)
        if (list) list.push(station)
        else stationsBySegment.set(station.segmentId, [station])
      }
      const deactivateIds = new Set<string>()
      for (const record of records.filter((r) => r.active)) {
        const current = stationsBySegment.get(record.segmentId) ?? []
        let stale = current.length !== record.stations.length
        if (!stale) {
          stale = record.stations.some((snapshot) => {
            const station = stationById.get(snapshot.stationId)
            if (!station) return true
            const fingerprint = [station.bearing, station.dip, station.slopeDistance, station.isRemeasured ? 1 : 0].join('|')
            return fingerprint !== snapshot.fingerprint
          })
        }
        if (stale) deactivateIds.add(record.id)
      }
      if (deactivateIds.size > 0) {
        await db.adjustments.bulkPut(
          records.filter((r) => deactivateIds.has(r.id)).map((r) => ({ ...r, active: false }))
        )
      }

      const txStations = await db.stations.toArray()
      await db.stations.bulkPut(await syncStationAdjustments(txStations, await db.adjustments.toArray()))

      const nextStations = await db.stations.toArray()
      const { segments: nextSegments, cavesDelta } = recomputeLengths(await db.segments.toArray(), nextStations)
      await db.segments.bulkPut(nextSegments)
      const now = new Date().toISOString()
      const caves = await db.caves.toArray()
      await db.caves.bulkPut(
        caves.map((cave) => ({
          ...cave,
          surveyedLength: cavesDelta.has(cave.id)
            ? (cavesDelta.get(cave.id) as number)
            : cave.surveyedLength === null
              ? null
              : cave.surveyedLength,
          surveyedAt: cavesDelta.has(cave.id) ? now : cave.surveyedAt
        }))
      )
    })
    await get().hydrate()
    await rehydrateDownstream()
  }
}))

/** 写库完成后刷新各业务 store（动态引入避免与 station/segment store 形成循环依赖） */
async function rehydrateDownstream(): Promise<void> {
  const [{ stationStore }, { segmentStore }, { caveStore }] = await Promise.all([
    import('@/stores/stationStore'),
    import('@/stores/segmentStore'),
    import('@/stores/caveStore')
  ])
  await Promise.all([stationStore.getState().hydrate(), segmentStore.getState().hydrate(), caveStore.getState().hydrate()])
}
