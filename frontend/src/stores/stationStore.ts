import { createStore } from 'zustand/vanilla'
import type { Station } from '@/types'
import { db, syncAll, syncDelete, syncPut } from '@/hooks/usePersistentStore'

export interface StationState {
  stations: Station[]
  loaded: boolean
  hydrate: () => Promise<void>
  save: (station: Station) => Promise<void>
  remove: (id: string) => Promise<void>
}

/**
 * 读数落库后核对分配版本并重算长度：
 * 动态引入避免与 adjustmentStore 形成模块循环依赖。
 */
async function reconcileAfterReadingsChange(): Promise<void> {
  const { adjustmentStore } = await import('@/stores/adjustmentStore')
  await adjustmentStore.getState().reconcile()
}

export const stationStore = createStore<StationState>((set) => ({
  stations: [],
  loaded: false,
  hydrate: async () => {
    const stations = await syncAll<Station>(db.stations)
    stations.sort((a, b) => a.code.localeCompare(b.code, 'zh-Hans-CN', { numeric: true }))
    set({ stations, loaded: true })
  },
  save: async (station) => {
    await syncPut<Station>(db.stations, station)
    // 读数一改动：旧分配按指纹作废，长度/总长/草图锚点/图幅偏移随之重算
    await reconcileAfterReadingsChange()
  },
  remove: async (id) => {
    await syncDelete(db.stations, id)
    await reconcileAfterReadingsChange()
  }
}))
