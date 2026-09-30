<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import type { AdjustmentComputeResult, AdjustmentRecord, Station } from '@/types'
import BearingInput from '@/components/common/BearingInput.vue'
import ClosureBadge from '@/components/common/ClosureBadge.vue'
import SegmentTag from '@/components/common/SegmentTag.vue'
import { useStore } from '@/hooks/usePersistentStore'
import { segmentStore } from '@/stores/segmentStore'
import { stationStore } from '@/stores/stationStore'
import { caveStore } from '@/stores/caveStore'
import { adjustmentStore } from '@/stores/adjustmentStore'
import {
  computeClosure,
  computeHorizontal,
  computeVertical,
  effectiveHorizontal,
  formatDms,
  isStationReadingAbnormal,
  isValidBearing,
  isValidDip,
  sortStationsByCode
} from '@/utils/survey'
import { nextCode, uid } from '@/utils/id'

const caveState = useStore(caveStore)
const segmentState = useStore(segmentStore)
const stationState = useStore(stationStore)
const adjustmentState = useStore(adjustmentStore)

const selectedCaveId = ref<string>(caveState.caves[0]?.id ?? '')
const selectedSegmentId = ref<string>('')
const editingId = ref<string | null>(null)
const lastSaved = ref<string>('')
const busy = ref(false)
const failureResult = ref<AdjustmentComputeResult | null>(null)

const form = reactive({
  code: 'P1',
  bearing: 90,
  dip: 0,
  slopeDistance: 10,
  instrumentNo: 'SOKKIA-2',
  surveyor: '',
  date: new Date().toISOString().slice(0, 10),
  isClosurePoint: false,
  isRemeasured: false,
  note: ''
})

const cavesWithSegments = computed(() => caveState.caves)
const segmentOptions = computed(() =>
  segmentState.segments.filter((segment) => !selectedCaveId.value || segment.caveId === selectedCaveId.value)
)
const currentSegment = computed(() => segmentState.segments.find((segment) => segment.id === selectedSegmentId.value))

const segmentStations = computed<Station[]>(() =>
  sortStationsByCode(stationState.stations.filter((station) => station.segmentId === selectedSegmentId.value))
)

/** 已保存测点 + 当前待录入测点一起参与原始闭合差计算，实时反映累计闭合差 */
const pendingStation = computed<Station>(() => ({
  id: 'pending',
  segmentId: selectedSegmentId.value,
  code: form.code,
  bearing: form.bearing,
  dip: form.dip,
  slopeDistance: form.slopeDistance,
  horizontalDistance: previewHorizontal.value,
  verticalDistance: previewVertical.value,
  instrumentNo: form.instrumentNo,
  surveyor: form.surveyor,
  date: form.date,
  isClosurePoint: form.isClosurePoint,
  isRemeasured: form.isRemeasured,
  adjusted: null,
  note: form.note
}))

const closureInput = computed<Station[]>(() => [...segmentStations.value, pendingStation.value])
/** 含待录入测点的实时闭合差是否超限（录入区提示用） */
const closureOverPending = computed(() => computeClosure(closureInput.value, 0.25, false).over)

/** 已保存测站的现场读数闭合差（不含待录入站） */
const rawClosure = computed(() => computeClosure(segmentStations.value, 0.25, false))
/** 分配后残差 */
const adjustedClosure = computed(() => computeClosure(segmentStations.value, 0.25, true))

const previewHorizontal = computed(() => computeHorizontal(form.dip, form.slopeDistance))
const previewVertical = computed(() => computeVertical(form.dip, form.slopeDistance))

/** 当前洞段的分配版本 */
const activeRecord = computed<AdjustmentRecord | undefined>(() =>
  adjustmentState.records.find((record) => record.active && record.segmentId === selectedSegmentId.value)
)
const versionList = computed<AdjustmentRecord[]>(() =>
  adjustmentState.records
    .filter((record) => record.segmentId === selectedSegmentId.value)
    .sort((a, b) => b.version - a.version)
)
/** 当前读数相对当前版本是否已改动（指纹不一致） */
const recordStale = computed(() => {
  const record = activeRecord.value
  if (!record) return false
  return segmentStations.value.some((station) => {
    const snapshot = record.stations.find((item) => item.stationId === station.id)
    if (!snapshot) return true
    return (
      snapshot.fingerprint !==
      [station.bearing, station.dip, station.slopeDistance, station.isRemeasured ? 1 : 0].join('|')
    )
  })
})
const hasHistory = computed(() => versionList.value.length > 0)
const surveyorName = computed(() => caveState.caves.find((c) => c.id === selectedCaveId.value)?.surveyor ?? '')

/** 异常读数：方位角或倾角超范围、斜距非正、水平距大于斜距 */
function isAbnormal(station: Station): boolean {
  return isStationReadingAbnormal(station)
}

function rowClassName(param: { row: Station }): string {
  return isAbnormal(param.row) ? 'abnormal-row' : ''
}

function refreshDefaultCode(): void {
  form.code = nextCode('P', segmentStations.value.map((station) => station.code))
}

// IndexedDB 数据是异步水合的，洞穴/洞段到达后自动选中第一条，避免空选
watch(
  () => [caveState.caves.length, selectedCaveId.value] as const,
  () => {
    if (!selectedCaveId.value && caveState.caves.length > 0) {
      selectedCaveId.value = caveState.caves[0].id
    }
  },
  { immediate: true }
)

watch(
  () => [selectedCaveId.value, segmentOptions.value.length] as const,
  () => {
    const list = segmentOptions.value
    if (!list.some((segment) => segment.id === selectedSegmentId.value)) {
      selectedSegmentId.value = list.length > 0 ? list[0].id : ''
    }
  },
  { immediate: true }
)

watch(
  () => selectedSegmentId.value,
  () => {
    editingId.value = null
    failureResult.value = null
    refreshDefaultCode()
  },
  { immediate: true }
)

async function submit(continueNext: boolean): Promise<void> {
  if (!selectedSegmentId.value) {
    ElMessage.warning('请先选择洞段')
    return
  }
  if (!form.code.trim()) {
    ElMessage.warning('请填写测点桩号')
    return
  }
  if (!(form.slopeDistance > 0)) {
    ElMessage.warning('斜距必须大于 0')
    return
  }
  if (!isValidBearing(form.bearing)) {
    ElMessage.warning('前视方位角必须在 0°–360° 之间')
    return
  }
  if (!isValidDip(form.dip)) {
    ElMessage.warning('倾角必须在 -90°–90° 之间')
    return
  }
  const existing = stationState.stations.find((station) => station.id === editingId.value)
  const station: Station = {
    id: existing?.id ?? uid('st'),
    segmentId: selectedSegmentId.value,
    code: form.code.trim(),
    bearing: form.bearing,
    dip: form.dip,
    slopeDistance: form.slopeDistance,
    horizontalDistance: previewHorizontal.value,
    verticalDistance: previewVertical.value,
    instrumentNo: form.instrumentNo.trim(),
    surveyor: form.surveyor.trim(),
    date: form.date,
    isClosurePoint: form.isClosurePoint,
    // 复测标记按现场情况保留；读数改动后旧分配成果由 store 统一作废
    isRemeasured: form.isRemeasured,
    adjusted: existing?.adjusted ?? null,
    note: form.note.trim()
  }
  await stationStore.getState().save(station)
  lastSaved.value = `${station.code} · 水平距 ${station.horizontalDistance} m / 垂距 ${station.verticalDistance} m`
  ElMessage.success(existing ? `测点 ${station.code} 已更新` : `测点 ${station.code} 已录入`)
  editingId.value = null
  form.isClosurePoint = false
  form.note = ''
  if (continueNext) {
    await stationStore.getState().hydrate()
    form.code = nextCode('P', segmentStations.value.map((item) => item.code))
  }
}

function editStation(station: Station): void {
  editingId.value = station.id
  form.code = station.code
  form.bearing = station.bearing
  form.dip = station.dip
  form.slopeDistance = station.slopeDistance
  form.instrumentNo = station.instrumentNo
  form.surveyor = station.surveyor
  form.date = station.date
  form.isClosurePoint = station.isClosurePoint
  form.isRemeasured = station.isRemeasured
  form.note = station.note
}

async function removeStation(station: Station): Promise<void> {
  await ElMessageBox.confirm(`确认删除测点「${station.code}」？相关分配成果会一并作废重算。`, '删除确认', {
    type: 'warning'
  })
  await stationStore.getState().remove(station.id)
  ElMessage.success('测点已删除')
}

async function runAdjustment(mode: 'apply' | 'retry'): Promise<void> {
  if (!selectedSegmentId.value) return
  busy.value = true
  failureResult.value = null
  try {
    const result =
      mode === 'retry'
        ? await adjustmentStore.getState().retry(selectedSegmentId.value, { createdBy: surveyorName.value })
        : await adjustmentStore.getState().apply(selectedSegmentId.value, { createdBy: surveyorName.value })
    if (!result.ok) {
      // 分不下去：停下来，说清哪几站有问题
      failureResult.value = result
      ElMessage.error('闭合差分配未完成，请先处理下列问题测站')
      return
    }
    ElMessage.success(
      `已按水平距分配 ${result.adjustedCount} 站（复测重算 ${result.remeasuredCount} 站）：闭合差 ${result.closureBefore} m → ${result.closureAfter} m`
    )
  } finally {
    busy.value = false
  }
}

async function clearAdjustment(): Promise<void> {
  await ElMessageBox.confirm('确认撤销该洞段的全部分配版本？成果将回落到现场原始读数。', '撤销分配', {
    type: 'warning'
  })
  await adjustmentStore.getState().clearAdjustment(selectedSegmentId.value)
  failureResult.value = null
  ElMessage.success('分配已撤销，长度与总长已按原读数重算')
}

async function removeVersion(record: AdjustmentRecord): Promise<void> {
  await ElMessageBox.confirm(`确认删除第 ${record.version} 版分配？`, '删除版本', { type: 'warning' })
  await adjustmentStore.getState().removeRecord(record.id)
  ElMessage.success('版本已删除')
}

function formatTime(iso: string): string {
  return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—'
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <h2 class="page-title">测点与读数录入</h2>
        <p class="page-sub">
          录入前视方位角、倾角与斜距，系统自动推算水平距与垂距，并实时累计该洞段的导线闭合差；现场读数保持不动，成果使用按水平距分配后的值。
        </p>
      </div>
      <el-tag v-if="lastSaved" type="success" effect="plain">最近保存：{{ lastSaved }}</el-tag>
    </div>

    <div class="toolbar">
      <el-select v-model="selectedCaveId" placeholder="选择洞穴" style="width: 200px">
        <el-option v-for="cave in cavesWithSegments" :key="cave.id" :label="cave.name" :value="cave.id" />
      </el-select>
      <el-select v-model="selectedSegmentId" placeholder="选择洞段" style="width: 220px">
        <el-option
          v-for="segment in segmentOptions"
          :key="segment.id"
          :label="`${segment.code}（${segment.startStake} → ${segment.endStake}）`"
          :value="segment.id"
        />
      </el-select>
      <SegmentTag v-if="currentSegment" :type="currentSegment.type" :closed="currentSegment.closed" size="small" />
      <el-button :disabled="!selectedSegmentId" @click="refreshDefaultCode">重算下一桩号</el-button>
    </div>

    <el-card shadow="never" class="form-card">
      <el-form label-width="96px">
        <el-row :gutter="16">
          <el-col :span="6">
            <el-form-item label="测点桩号" required>
              <el-input v-model="form.code" placeholder="如 P12" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="前视方位角">
              <BearingInput v-model="form.bearing" kind="bearing" @invalid="(msg: string) => ElMessage.warning(msg)" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="倾角">
              <BearingInput v-model="form.dip" kind="dip" @invalid="(msg: string) => ElMessage.warning(msg)" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="斜距(m)" required>
              <el-input-number v-model="form.slopeDistance" :min="0" :step="0.1" :precision="3" :controls="false" style="width: 100%" />
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="16">
          <el-col :span="6">
            <el-form-item label="仪器号">
              <el-input v-model="form.instrumentNo" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="测量人">
              <el-input v-model="form.surveyor" />
            </el-form-item>
          </el-col>
          <el-col :span="6">
            <el-form-item label="测量日期">
              <el-date-picker v-model="form.date" type="date" value-format="YYYY-MM-DD" style="width: 100%" />
            </el-form-item>
          </el-col>
          <el-col :span="3">
            <el-form-item label="闭合点">
              <el-switch v-model="form.isClosurePoint" />
            </el-form-item>
          </el-col>
          <el-col :span="3">
            <el-form-item label="复测站">
              <el-tooltip content="复测站按原读数重算，不承担闭合差改正" placement="top">
                <el-switch v-model="form.isRemeasured" />
              </el-tooltip>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="备注">
          <el-input v-model="form.note" type="textarea" :rows="2" placeholder="岩壁、滴水、崩塌堆积等现场情况" />
        </el-form-item>
        <div class="preview">
          <el-tag effect="plain">自动推算：水平距 {{ previewHorizontal.toFixed(3) }} m</el-tag>
          <el-tag effect="plain">垂距 {{ previewVertical.toFixed(3) }} m</el-tag>
          <el-tag effect="plain">方位角 {{ formatDms(form.bearing) }}</el-tag>
          <el-tag effect="plain">倾角 {{ formatDms(form.dip) }}</el-tag>
          <el-tag v-if="form.isRemeasured" type="warning" effect="dark">复测站：不参与分配</el-tag>
          <el-tag v-if="closureOverPending" type="danger" effect="dark">含当前录入，累计闭合差已超限</el-tag>
        </div>
        <div class="actions">
          <el-button type="primary" @click="submit(false)">{{ editingId ? '保存修改' : '保存测点' }}</el-button>
          <el-button type="success" plain @click="submit(true)">保存并录入下一站</el-button>
          <el-button v-if="editingId" @click="editingId = null">取消编辑</el-button>
        </div>
      </el-form>
    </el-card>

    <el-card shadow="never" class="adjust-card">
      <div class="adjust-head">
        <div>
          <h3 class="section-title">闭合差分配（罗盘法则：按各站水平距比例配赋）</h3>
          <p class="muted">
            现场读数不改动；调整量与调整后坐标另存为版本。复测站按原读数重算、不承担改正。读数改动后当前版本自动作废，可从上一版重试。
          </p>
        </div>
        <div class="adjust-actions">
          <el-button type="primary" :loading="busy" :disabled="!selectedSegmentId" @click="runAdjustment('apply')">
            按水平距分配
          </el-button>
          <el-button :loading="busy" :disabled="!hasHistory" @click="runAdjustment('retry')">从上一版重试</el-button>
          <el-button :disabled="!hasHistory" @click="clearAdjustment">撤销分配</el-button>
        </div>
      </div>

      <div class="badge-row">
        <div class="badge-block">
          <span class="badge-label">原始读数闭合差</span>
          <ClosureBadge
            :closure="rawClosure.closure"
            :threshold="rawClosure.threshold"
            :level="rawClosure.level"
            :detail="rawClosure.detail"
            :count="segmentStations.length"
          />
        </div>
        <div v-if="activeRecord" class="badge-block">
          <span class="badge-label">
            分配后残差（第 {{ activeRecord.version }} 版<template v-if="recordStale"> · 读数已改动，待重试</template>）
          </span>
          <ClosureBadge
            :closure="adjustedClosure.closure"
            :threshold="adjustedClosure.threshold"
            :level="adjustedClosure.closure < 0.001 ? '优' : '良'"
            :detail="adjustedClosure.detail"
            :count="segmentStations.length"
          />
        </div>
      </div>

      <el-alert
        v-if="recordStale"
        class="alert"
        type="warning"
        :closable="false"
        title="读数已改动，当前分配成果已作废"
        description="洞段长度、洞穴实测总长、草图锚点与图幅偏移已按新读数重算；复测或改正完成后可「从上一版重试」生成新版本。"
      />
      <el-alert
        v-if="rawClosure.over"
        class="alert"
        type="error"
        :closable="false"
        title="原始读数闭合差已超限"
        description="当前洞段原始读数累计闭合差超过阈值，建议复测异常测点（勾选复测站）或执行按水平距分配。"
      />
      <el-alert
        v-if="failureResult"
        class="alert"
        type="error"
        :closable="true"
        @close="failureResult = null"
        title="分配失败：以下问题导致闭合差分不下去"
      >
        <ul class="issue-list">
          <li v-for="(issue, index) in failureResult.issues" :key="index">
            <el-tag v-if="issue.stationCodes.length" type="danger" size="small" effect="dark">
              {{ issue.stationCodes.join('、') }}
            </el-tag>
            {{ issue.message }}
          </li>
        </ul>
      </el-alert>

      <el-table v-if="versionList.length > 0" :data="versionList" border stripe size="small" class="version-table">
        <el-table-column prop="version" label="版本" width="70">
          <template #default="{ row }: { row: AdjustmentRecord }">第 {{ row.version }} 版</template>
        </el-table-column>
        <el-table-column label="状态" width="110">
          <template #default="{ row }: { row: AdjustmentRecord }">
            <el-tag v-if="row.active" type="success" size="small" effect="dark">当前版本</el-tag>
            <el-tag v-else type="info" size="small" effect="plain">历史版本</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="闭合差变化" width="190">
          <template #default="{ row }: { row: AdjustmentRecord }">
            {{ row.closureBefore }} m → {{ row.closureAfter }} m
          </template>
        </el-table-column>
        <el-table-column label="生成时间" width="180">
          <template #default="{ row }: { row: AdjustmentRecord }">{{ formatTime(row.createdAt) }}</template>
        </el-table-column>
        <el-table-column prop="createdBy" label="操作人" width="100" />
        <el-table-column prop="note" label="说明" min-width="160" show-overflow-tooltip />
        <el-table-column label="操作" width="90">
          <template #default="{ row }: { row: AdjustmentRecord }">
            <el-button link type="danger" size="small" @click="removeVersion(row)">删除</el-button>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <h3 class="section-title">
      本洞段读数（{{ segmentStations.length }} 站）
      <el-tag v-if="activeRecord" type="success" size="small" effect="plain" class="title-tag">成果使用第 {{ activeRecord.version }} 版分配值</el-tag>
    </h3>
    <el-table :data="segmentStations" border stripe :row-class-name="rowClassName">
      <el-table-column prop="code" label="桩号" width="90" />
      <el-table-column label="方位角" width="150">
        <template #default="{ row }: { row: Station }">{{ row.bearing }}° / {{ formatDms(row.bearing) }}</template>
      </el-table-column>
      <el-table-column label="倾角" width="100">
        <template #default="{ row }: { row: Station }">{{ row.dip }}°</template>
      </el-table-column>
      <el-table-column prop="slopeDistance" label="斜距(m)" width="95" />
      <el-table-column label="原水平距(m)" width="105">
        <template #default="{ row }: { row: Station }">{{ row.horizontalDistance }}</template>
      </el-table-column>
      <el-table-column label="成果水平距(m)" width="115">
        <template #default="{ row }: { row: Station }">
          <b>{{ effectiveHorizontal(row) }}</b>
        </template>
      </el-table-column>
      <el-table-column label="调整量(m)" width="100">
        <template #default="{ row }: { row: Station }">
          <el-tag v-if="row.adjusted" :type="row.adjusted.horizontalCorrection >= 0 ? 'success' : 'warning'" size="small" effect="plain">
            {{ row.adjusted.horizontalCorrection > 0 ? '+' : '' }}{{ row.adjusted.horizontalCorrection }}
          </el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column prop="verticalDistance" label="垂距(m)" width="90" />
      <el-table-column label="成果坐标 E / N (m)" min-width="170">
        <template #default="{ row }: { row: Station }">
          <template v-if="row.adjusted">{{ row.adjusted.east }} , {{ row.adjusted.north }}</template>
          <span v-else class="muted">待分配</span>
        </template>
      </el-table-column>
      <el-table-column label="复测" width="80">
        <template #default="{ row }: { row: Station }">
          <el-tag v-if="row.isRemeasured" type="warning" size="small" effect="dark">复测</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="闭合点" width="80">
        <template #default="{ row }: { row: Station }">
          <el-tag v-if="row.isClosurePoint" type="success" size="small" effect="plain">是</el-tag>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="读数状态" width="100">
        <template #default="{ row }: { row: Station }">
          <el-tag v-if="isAbnormal(row)" type="danger" size="small" effect="dark">异常</el-tag>
          <el-tag v-else type="success" size="small" effect="plain">正常</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="note" label="备注" min-width="130" show-overflow-tooltip />
      <el-table-column label="操作" width="130" fixed="right">
        <template #default="{ row }: { row: Station }">
          <el-button link type="primary" size="small" @click="editStation(row)">编辑</el-button>
          <el-button link type="danger" size="small" @click="removeStation(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>
</template>

<style scoped>
.form-card {
  border-radius: 12px;
  margin-bottom: 16px;
}
.preview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 0 0 96px;
}
.actions {
  display: flex;
  gap: 10px;
  padding: 14px 0 0 96px;
}
.adjust-card {
  border-radius: 12px;
  margin-bottom: 16px;
}
.adjust-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 10px;
}
.adjust-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.badge-row {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  margin-bottom: 10px;
}
.badge-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.badge-label {
  font-size: 12px;
  color: #6b7b8c;
}
.alert {
  margin-bottom: 10px;
}
.version-table {
  margin-top: 8px;
}
.issue-list {
  margin: 6px 0 0;
  padding-left: 18px;
  line-height: 1.9;
}
.title-tag {
  margin-left: 8px;
}
:deep(.abnormal-row) {
  background: #fdf2f2 !important;
}
:deep(.abnormal-row td) {
  color: #b03030;
}
</style>
