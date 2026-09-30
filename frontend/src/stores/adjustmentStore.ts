import { createStore } from 'zustand/vanilla'
import type { AdjustmentRun } from '@/types'
import { db, syncAll, syncPut } from '@/hooks/usePersistentStore'

export interface AdjustmentState {
  runs: AdjustmentRun[]
  loaded: boolean
  hydrate: () => Promise<void>
  saveRun: (run: AdjustmentRun) => Promise<void>
  removeByCave: (caveId: string) => Promise<void>
  /** 某洞穴的全部版本（版本号倒序） */
  runsForCave: (caveId: string) => AdjustmentRun[]
  /** 某洞穴最新一版（不论成败） */
  latestForCave: (caveId: string) => AdjustmentRun | null
  /**
   * 当前成果：最新一版成功且读数哈希与当前读数一致。
   * 读数一改动即返回 null，表示成果待重算。
   */
  currentForCave: (caveId: string, readingHash: string) => AdjustmentRun | null
}

export const adjustmentStore = createStore<AdjustmentState>((set, get) => ({
  runs: [],
  loaded: false,
  hydrate: async () => {
    const runs = await syncAll<AdjustmentRun>(db.adjustments)
    runs.sort((a, b) => b.version - a.version)
    set({ runs, loaded: true })
  },
  saveRun: async (run) => {
    await syncPut<AdjustmentRun>(db.adjustments, run)
    await get().hydrate()
  },
  removeByCave: async (caveId) => {
    const ids = get()
      .runs.filter((run) => run.caveId === caveId)
      .map((run) => run.id)
    await db.adjustments.bulkDelete(ids)
    await get().hydrate()
  },
  runsForCave: (caveId) =>
    get()
      .runs.filter((run) => run.caveId === caveId)
      .sort((a, b) => b.version - a.version),
  latestForCave: (caveId) => {
    const list = get().runsForCave(caveId)
    return list.length > 0 ? list[0] : null
  },
  currentForCave: (caveId, readingHash) => {
    const list = get().runsForCave(caveId)
    const current = list.find((run) => run.status === 'success' && run.readingHash === readingHash)
    return current ?? null
  }
}))
