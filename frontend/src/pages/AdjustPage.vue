<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import type { AdjustmentRun, SegmentAdjustment, StationAdjustment } from '@/types'
import { useStore } from '@/hooks/usePersistentStore'
import { adjustmentStore } from '@/stores/adjustmentStore'
import { caveStore } from '@/stores/caveStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import {
  computeAdjustment,
  computeReadingHash,
  orderTraversePoints,
  type TraversePoint
} from '@/utils/surveyAdjust'
import { formatDms, round } from '@/utils/survey'
import { downloadCsv } from '@/utils/export'
import { uid } from '@/utils/id'

const THRESHOLD = 0.25

const router = useRouter()
const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const adjustmentState = useStore(adjustmentStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')

const caves = computed(() => caveState.caves)

/** 当前洞穴沿桩号排序的导线点（读数原样，仅决定平差顺序） */
const points = computed<TraversePoint[]>(() => {
  if (!selectedCaveId.value) return []
  const segs = segmentState.segments.filter((segment) => segment.caveId === selectedCaveId.value)
  const sts = stationState.stations.filter((station) => segs.some((segment) => segment.id === station.segmentId))
  return orderTraversePoints(segs, sts)
})

const readingHash = computed(() => computeReadingHash(points.value))
const computation = computed(() => computeAdjustment(points.value))

const runs = computed(() => adjustmentState.runsForCave(selectedCaveId.value))
const latestRun = computed<AdjustmentRun | null>(() => adjustmentState.latestForCave(selectedCaveId.value))
const currentRun = computed<AdjustmentRun | null>(() =>
  adjustmentState.currentForCave(selectedCaveId.value, readingHash.value)
)

/** 成果状态：applied 已采用 / stale 读数变动待重算 / failed 上次分配失败 / none 尚未分配 */
const status = computed<'applied' | 'stale' | 'failed' | 'none'>(() => {
  if (currentRun.value) return 'applied'
  if (latestRun.value?.status === 'failed') return 'failed'
  if (latestRun.value?.status === 'success') return 'stale'
  return 'none'
})

/** 展示用成果：优先当前采用版，否则回退到最近一版成功成果（失败/变动时仍可查看上一版） */
const displayRun = computed<AdjustmentRun | null>(() => {
  if (currentRun.value) return currentRun.value
  return runs.value.find((run) => run.status === 'success') ?? null
})

const stationRows = computed(() => displayRun.value?.stationAdjustments ?? computation.value.stationAdjustments)
const segmentRows = computed(() => displayRun.value?.segmentAdjustments ?? computation.value.segmentAdjustments)

const statusTag = computed(() => {
  switch (status.value) {
    case 'applied':
      return { type: 'success' as const, text: '已采用平差成果' }
    case 'stale':
      return { type: 'warning' as const, text: '读数已变动 · 成果待重算' }
    case 'failed':
      return { type: 'danger' as const, text: '上次分配失败 · 可重试' }
    default:
      return { type: 'info' as const, text: '尚未分配' }
  }
})

const buttonText = computed(() => {
  if (status.value === 'none') return '按水平距分配闭合差'
  if (status.value === 'failed') return '从上一版重试分配'
  return '重新分配（读数已更新）'
})

watch(
  () => caveState.caves.length,
  (count) => {
    if (!selectedCaveId.value && count > 0) selectedCaveId.value = caveState.caves[0].id
  },
  { immediate: true }
)

/** 分配 / 重试：读数原样不动，把闭合差按水平距分配后另存一版成果 */
async function distribute(): Promise<void> {
  if (!selectedCaveId.value) {
    ElMessage.warning('请先选择洞穴')
    return
  }
  if (points.value.length === 0) {
    ElMessage.warning('该洞穴暂无测点，请先录入读数')
    return
  }
  const result = computation.value
  const version = (latestRun.value?.version ?? 0) + 1
  const base = {
    id: uid('adj'),
    caveId: selectedCaveId.value,
    version,
    createdAt: new Date().toISOString(),
    readingHash: readingHash.value,
    stationCount: result.stationCount,
    totalHorizontal: result.totalHorizontal,
    closureEast: result.closureEast,
    closureNorth: result.closureNorth,
    closure: result.closure,
    threshold: THRESHOLD,
    residualEast: result.residualEast,
    residualNorth: result.residualNorth,
    residual: result.residual,
    measuredTotalLength: result.measuredTotalLength,
    totalLength: result.totalLength,
    startChainage: result.startChainage
  }
  if (!result.ok) {
    const run: AdjustmentRun = {
      ...base,
      status: 'failed',
      problems: result.problems,
      failReason: `有 ${result.problems.length} 站读数不符合要求，无法按水平距分配`,
      stationAdjustments: [],
      segmentAdjustments: []
    }
    await adjustmentStore.getState().saveRun(run)
    ElMessage.error(`第 ${version} 版分配失败：${result.problems.length} 站读数有问题，请修正后重试`)
    return
  }
  const run: AdjustmentRun = {
    ...base,
    status: 'success',
    problems: [],
    stationAdjustments: result.stationAdjustments,
    segmentAdjustments: result.segmentAdjustments
  }
  await adjustmentStore.getState().saveRun(run)
  ElMessage.success(
    `第 ${version} 版分配完成：闭合差 ${result.closure} m → 残余 ${result.residual} m，成果已另存`
  )
}

function goStations(): void {
  router.push('/stations')
}

function exportCsv(): void {
  if (stationRows.value.length === 0) {
    ElMessage.warning('暂无可导出的平差成果')
    return
  }
  downloadCsv(
    '导线平差成果.csv',
    stationRows.value as unknown as Record<string, unknown>[],
    [
      { key: 'code', label: '桩号' },
      { key: 'segmentCode', label: '洞段' },
      { key: 'bearing', label: '方位角' },
      { key: 'dip', label: '倾角' },
      { key: 'slopeDistance', label: '斜距(m)' },
      { key: 'horizontalDistance', label: '水平距(m)' },
      { key: 'dE', label: 'ΔE(m)' },
      { key: 'dN', label: 'ΔN(m)' },
      { key: 'vE', label: '改正数vE' },
      { key: 'vN', label: '改正数vN' },
      { key: 'east', label: '调整后E(m)' },
      { key: 'north', label: '调整后N(m)' },
      { key: 'adjustedHorizontal', label: '调整后水平距(m)' },
      { key: 'chainage', label: '累计里程(m)' }
    ]
  )
  ElMessage.success('平差成果已导出')
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">导线平差 · 闭合差分配</h2>
        <p class="page-sub">
          现场读数原样保留，闭合差按各站水平距成比例分配（罗盘仪法则），调整量另存一版成果；读数改动后旧长度与总长随读数重算，成果需重新分配。
        </p>
      </div>
      <div class="head-actions">
        <el-tag :type="statusTag.type" effect="dark" size="large">{{ statusTag.text }}</el-tag>
        <el-button type="primary" @click="distribute">{{ buttonText }}</el-button>
      </div>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 240px">
        <el-option v-for="cave in caves" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-tag effect="plain">测站 {{ computation.stationCount }} 个</el-tag>
      <el-tag effect="plain">水平距合计 {{ computation.totalHorizontal || '—' }} m</el-tag>
      <el-tag effect="plain">阈值 {{ THRESHOLD }} m</el-tag>
      <el-button @click="goStations">去测点读数修正</el-button>
      <el-button @click="exportCsv">导出平差成果</el-button>
    </div>

    <!-- 闭合差与成果指标 -->
    <div class="metric-row">
      <div class="metric">
        <span>分配前闭合差 f</span>
        <b :class="{ over: computation.closure >= THRESHOLD }">{{ computation.closure.toFixed(3) }} m</b>
        <small>ΣΔE {{ computation.closureEast.toFixed(3) }} · ΣΔN {{ computation.closureNorth.toFixed(3) }}</small>
      </div>
      <div class="metric">
        <span>分配后残余闭合差</span>
        <b class="ok">{{ (displayRun?.residual ?? computation.residual).toFixed(3) }} m</b>
        <small>分配后应趋近 0</small>
      </div>
      <div class="metric">
        <span>实测总长（旧 · 读数合计）</span>
        <b>{{ (displayRun?.measuredTotalLength ?? computation.measuredTotalLength).toFixed(1) }} m</b>
        <small>读数改动即重算</small>
      </div>
      <div class="metric">
        <span>调整后洞穴实测总长</span>
        <b class="adj">{{ (displayRun?.totalLength ?? computation.totalLength).toFixed(1) }} m</b>
        <small>成果采用此值</small>
      </div>
    </div>

    <!-- 分不下去：逐站说清问题 -->
    <el-alert
      v-if="!computation.ok && computation.problems.length > 0"
      class="problems"
      type="error"
      :closable="false"
      title="读数有问题，本次分配停下未分"
      description="以下测站读数不符合要求，闭合差分不下去。请按站核对修正后再从上一版重试；现场读数不会被改动。"
    >
      <ul class="problem-list">
        <li v-for="(problem, index) in computation.problems" :key="`${problem.stationId}-${index}`">
          <b>{{ problem.code || '（未命名测站）' }}</b>
          <span class="muted">〔{{ problem.segmentCode || '未归属洞段' }}〕</span>
          <span v-for="(reason, rIndex) in problem.reasons" :key="rIndex" class="reason">{{ reason }}</span>
        </li>
      </ul>
    </el-alert>

    <el-alert
      v-if="status === 'stale'"
      class="problems"
      type="warning"
      :closable="false"
      title="读数已变动，平差成果待重算"
      description="当前读数与上一版成果的读数快照不一致，旧长度与总长已按读数重算。点击「重新分配」即可以现读数重算并另存新版成果，上一版保留可查。"
    />

    <h3 class="section-title">测站平差成果（读数不动，调整量另存）</h3>
    <el-table :data="stationRows" border stripe size="small" max-height="420">
      <el-table-column prop="code" label="桩号" width="80" fixed />
      <el-table-column prop="segmentCode" label="洞段" width="80" fixed />
      <el-table-column label="方位角" width="150">
        <template #default="{ row }: { row: StationAdjustment }">
          {{ row.bearing }}° / {{ formatDms(row.bearing) }}
        </template>
      </el-table-column>
      <el-table-column label="倾角" width="90">
        <template #default="{ row }: { row: StationAdjustment }">{{ row.dip }}°</template>
      </el-table-column>
      <el-table-column prop="slopeDistance" label="斜距(m)" width="90" />
      <el-table-column prop="horizontalDistance" label="水平距(m)" width="95" />
      <el-table-column label="ΔE(m)" width="92">
        <template #default="{ row }: { row: StationAdjustment }">{{ row.dE.toFixed(3) }}</template>
      </el-table-column>
      <el-table-column label="ΔN(m)" width="92">
        <template #default="{ row }: { row: StationAdjustment }">{{ row.dN.toFixed(3) }}</template>
      </el-table-column>
      <el-table-column label="改正数 vE" width="92">
        <template #default="{ row }: { row: StationAdjustment }">
          <span class="corr">{{ row.vE > 0 ? '+' : '' }}{{ row.vE.toFixed(3) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="改正数 vN" width="92">
        <template #default="{ row }: { row: StationAdjustment }">
          <span class="corr">{{ row.vN > 0 ? '+' : '' }}{{ row.vN.toFixed(3) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="调整后 E(m)" width="100">
        <template #default="{ row }: { row: StationAdjustment }">{{ row.east.toFixed(3) }}</template>
      </el-table-column>
      <el-table-column label="调整后 N(m)" width="100">
        <template #default="{ row }: { row: StationAdjustment }">{{ row.north.toFixed(3) }}</template>
      </el-table-column>
      <el-table-column label="调整后水平距(m)" width="120">
        <template #default="{ row }: { row: StationAdjustment }">
          <b class="adj">{{ row.adjustedHorizontal.toFixed(3) }}</b>
        </template>
      </el-table-column>
      <el-table-column label="累计里程(m)" width="110">
        <template #default="{ row }: { row: StationAdjustment }">{{ round(row.chainage, 1) }}</template>
      </el-table-column>
      <template #empty>暂无成果，点击右上角「按水平距分配闭合差」</template>
    </el-table>

    <h3 class="section-title">洞段长度（实测旧值 → 调整后采用值）</h3>
    <el-table :data="segmentRows" border stripe size="small">
      <el-table-column prop="code" label="洞段" width="100" />
      <el-table-column prop="stationCount" label="测站数" width="90" />
      <el-table-column label="实测长度（旧 · m）" width="160">
        <template #default="{ row }: { row: SegmentAdjustment }">{{ row.measuredLength.toFixed(3) }}</template>
      </el-table-column>
      <el-table-column label="调整后长度（采用 · m）" width="180">
        <template #default="{ row }: { row: SegmentAdjustment }">
          <b class="adj">{{ row.adjustedLength.toFixed(3) }}</b>
        </template>
      </el-table-column>
      <el-table-column label="长度较差(m)" width="120">
        <template #default="{ row }: { row: SegmentAdjustment }">
          <span class="corr">{{ (row.adjustedLength - row.measuredLength) > 0 ? '+' : '' }}{{ (row.adjustedLength - row.measuredLength).toFixed(3) }}</span>
        </template>
      </el-table-column>
      <el-table-column label="调整后起止里程(m)" min-width="200">
        <template #default="{ row }: { row: SegmentAdjustment }">
          {{ round(row.startChainage, 1) }} → {{ round(row.endChainage, 1) }}
        </template>
      </el-table-column>
      <template #empty>暂无洞段成果</template>
    </el-table>

    <h3 class="section-title">平差版本记录（失败不覆盖上一版，可重试）</h3>
    <el-table :data="runs" border stripe size="small">
      <el-table-column label="版本" width="90">
        <template #default="{ row }: { row: AdjustmentRun }">第 {{ row.version }} 版</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }: { row: AdjustmentRun }">
          <el-tag :type="row.status === 'success' ? 'success' : 'danger'" size="small" effect="plain">
            {{ row.status === 'success' ? '成功' : '失败' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="分配前闭合差" width="140">
        <template #default="{ row }: { row: AdjustmentRun }">{{ row.closure.toFixed(3) }} m</template>
      </el-table-column>
      <el-table-column label="分配后残余" width="130">
        <template #default="{ row }: { row: AdjustmentRun }">{{ row.residual.toFixed(3) }} m</template>
      </el-table-column>
      <el-table-column label="调整后总长" width="130">
        <template #default="{ row }: { row: AdjustmentRun }">{{ row.totalLength.toFixed(1) }} m</template>
      </el-table-column>
      <el-table-column label="问题站" width="90">
        <template #default="{ row }: { row: AdjustmentRun }">{{ row.problems.length }}</template>
      </el-table-column>
      <el-table-column label="读数快照" width="120">
        <template #default="{ row }: { row: AdjustmentRun }">
          <el-tag v-if="row.readingHash === readingHash" type="success" size="small" effect="plain">与当前一致</el-tag>
          <el-tag v-else type="warning" size="small" effect="plain">已变动</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="时间" width="170">
        <template #default="{ row }: { row: AdjustmentRun }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column prop="failReason" label="说明" min-width="180" show-overflow-tooltip />
      <template #empty>尚无平差记录</template>
    </el-table>
  </div>
</template>

<style scoped>
.head-actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.metric-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}
.metric {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  border-radius: 10px;
  background: #f5f8fb;
  border: 1px solid #dde6ee;
}
.metric span {
  font-size: 12px;
  color: #6b7b8c;
}
.metric b {
  font-size: 20px;
  color: #1f3a4d;
}
.metric b.over {
  color: #c0392b;
}
.metric b.ok {
  color: #2e7d32;
}
.metric b.adj {
  color: #2f6f8f;
}
.metric small {
  font-size: 11px;
  color: #8a97a3;
}
.problems {
  margin-bottom: 16px;
}
.problem-list {
  margin: 8px 0 0;
  padding-left: 18px;
  font-size: 13px;
  line-height: 1.9;
}
.problem-list .reason {
  display: inline-block;
  margin-left: 8px;
  padding: 0 8px;
  border-radius: 4px;
  background: #fdf2f2;
  color: #b03030;
}
.problem-list .muted {
  color: #8a97a3;
  margin-left: 4px;
}
.corr {
  color: #c98a1b;
  font-variant-numeric: tabular-nums;
}
.adj {
  color: #2f6f8f;
}
.section-title {
  margin: 18px 0 10px;
  font-size: 15px;
}
</style>
