<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { Grid2X2, Maximize, Minimize, Monitor, RefreshCw, Tags } from 'lucide-vue-next';
import { displayTargetLabel, rowColFromIndex } from '../utils/display';
import { buildPreviewLayout } from '../utils/screen-preview';
import ScreenPreviewRegion from './ScreenPreviewRegion.vue';

const props = defineProps({
  project: { type: Object, required: true },
  cameras: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
});
defineEmits(['configure']);

const previewRef = ref(null);
const stageRef = ref(null);
const stageSize = reactive({ width: 0, height: 0 });
const screenRatio = ref('16:9');
const fit = ref('contain');
const showGrid = ref(true);
const showLabels = ref(true);
const revision = ref(0);
const fullscreen = ref(false);
const fullscreenError = ref('');
const fullscreenSupported = ref(false);
let stageObserver;

const layout = computed(() => buildPreviewLayout(props.cameras, props.project));
const cells = computed(() => Array.from({ length: props.project.rows * props.project.cols }, (_, index) => ({
  index: index + 1,
  ...rowColFromIndex(index + 1, props.project.cols),
})));
const wallSize = computed(() => {
  const [width, height] = screenRatio.value.split(':').map(Number);
  const ratio = (props.project.cols * width) / (props.project.rows * height);
  const wallWidth = Math.max(0, Math.min(stageSize.width - 40, (stageSize.height - 40) * ratio));
  return { width: wallWidth, height: wallWidth / ratio };
});
const wallStyle = computed(() => ({ width: `${wallSize.value.width}px`, height: `${wallSize.value.height}px` }));
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${props.project.cols}, minmax(0, 1fr))`,
  gridTemplateRows: `repeat(${props.project.rows}, minmax(0, 1fr))`,
}));
const conflictLabels = computed(() => layout.value.conflictTargets.map((index) => displayTargetLabel(index, props.project.prefix)).join('、'));

function regionSize(region) {
  return {
    width: wallSize.value.width * region.col_span / props.project.cols,
    height: wallSize.value.height * region.row_span / props.project.rows,
  };
}

function regionStyle(region) {
  const { width, height } = regionSize(region);
  return {
    left: `${(region.col - 1) * wallSize.value.width / props.project.cols}px`,
    top: `${(region.row - 1) * wallSize.value.height / props.project.rows}px`,
    width: `${width}px`,
    height: `${height}px`,
  };
}

function measureStage() {
  if (!stageRef.value) return;
  stageSize.width = stageRef.value.clientWidth;
  stageSize.height = stageRef.value.clientHeight;
}

function syncFullscreen() {
  fullscreen.value = document.fullscreenElement === previewRef.value;
}

async function toggleFullscreen() {
  fullscreenError.value = '';
  try {
    if (fullscreen.value) await document.exitFullscreen();
    else await previewRef.value.requestFullscreen();
  } catch {
    fullscreenError.value = '浏览器暂时无法进入全屏，请使用浏览器的全屏功能。';
  }
}

onMounted(() => {
  fullscreenSupported.value = Boolean(document.fullscreenEnabled && previewRef.value?.requestFullscreen);
  if (window.ResizeObserver) {
    stageObserver = new ResizeObserver(measureStage);
    stageObserver.observe(stageRef.value);
  }
  window.addEventListener('resize', measureStage);
  document.addEventListener('fullscreenchange', syncFullscreen);
  measureStage();
});

onBeforeUnmount(() => {
  stageObserver?.disconnect();
  window.removeEventListener('resize', measureStage);
  document.removeEventListener('fullscreenchange', syncFullscreen);
  if (document.fullscreenElement === previewRef.value) document.exitFullscreen().catch(() => {});
});
</script>

<template>
  <section ref="previewRef" class="screen-preview" aria-label="大屏整体预览">
    <header class="preview-header">
      <div class="preview-heading">
        <div class="preview-heading-icon"><Monitor :size="22" /></div>
        <div>
          <h2>{{ fullscreen ? project.name : '大屏预览' }}</h2>
          <p>{{ project.rows }} 行 × {{ project.cols }} 列 <span>·</span> {{ layout.regions.length }} 路画面 <span>·</span> {{ cells.length - layout.occupiedTargets.size }} 块空闲屏</p>
        </div>
        <span class="preview-mode">网页模拟</span>
      </div>
      <div class="preview-toolbar" role="group" aria-label="预览设置">
        <label>单屏比例
          <select v-model="screenRatio" aria-label="单屏比例">
            <option>16:9</option><option>16:10</option><option>4:3</option><option>1:1</option><option>9:16</option>
          </select>
        </label>
        <label>画面适配
          <select v-model="fit" aria-label="画面适配">
            <option value="contain">等比完整</option>
            <option value="cover">等比铺满</option>
            <option value="stretch">拉伸填满</option>
          </select>
        </label>
        <div class="preview-toggles">
          <button type="button" :class="{ active: showGrid }" :aria-pressed="showGrid" @click="showGrid = !showGrid"><Grid2X2 :size="15" /><span>分界线</span></button>
          <button type="button" :class="{ active: showLabels }" :aria-pressed="showLabels" @click="showLabels = !showLabels"><Tags :size="15" /><span>标注</span></button>
        </div>
        <button type="button" :disabled="loading || !layout.regions.length" @click="revision += 1"><RefreshCw :size="15" /><span>刷新画面</span></button>
        <button v-if="fullscreenSupported" type="button" class="preview-fullscreen-button" @click="toggleFullscreen">
          <Minimize v-if="fullscreen" :size="15" /><Maximize v-else :size="15" /><span>{{ fullscreen ? '退出全屏' : '全屏预览' }}</span>
        </button>
      </div>
    </header>

    <div ref="stageRef" class="preview-stage" :aria-busy="loading">
      <div v-if="wallSize.width" class="preview-wall" :style="wallStyle">
        <div class="preview-cells" :style="gridStyle">
          <div v-for="cell in cells" :key="cell.index" class="preview-empty-cell">
            <span v-if="showLabels && !layout.occupiedTargets.has(cell.index) && layout.regions.length">未绑定</span>
          </div>
        </div>
        <template v-if="!loading">
          <ScreenPreviewRegion
            v-for="item in layout.regions"
            :key="`${item.camera.id}-${revision}`"
            :camera="item.camera"
            :width="regionSize(item.region).width"
            :height="regionSize(item.region).height"
            :fit="fit"
            :show-labels="showLabels"
            :style="regionStyle(item.region)"
          />
        </template>
        <div class="preview-grid" :class="{ 'with-lines': showGrid }" :style="gridStyle" aria-hidden="true">
          <div v-for="cell in cells" :key="cell.index" class="preview-grid-cell" :class="{ conflict: layout.conflictTargets.includes(cell.index) }">
            <span v-if="showLabels">{{ displayTargetLabel(cell.index, project.prefix) }}</span>
          </div>
        </div>
      </div>
      <div v-if="loading || !layout.regions.length" class="preview-empty-state" role="status">
        <Monitor :size="32" :stroke-width="1.3" />
        <strong>{{ loading ? '正在读取大屏配置…' : '大屏已就绪，等待绑定画面' }}</strong>
        <p v-if="!loading">在矩阵中绑定视频源，即可在这里查看整体效果。</p>
        <button v-if="!loading" type="button" @click="$emit('configure')">前往矩阵绑定</button>
      </div>
    </div>

    <footer class="preview-footer">
      <div class="preview-notes">
        <p>按已保存的矩阵和网页分辨率模拟，无需启动视频源；实际播放以终端输出为准。</p>
        <p v-if="layout.unassignedCount">{{ layout.unassignedCount }} 路视频源未绑定有效区域，未显示在预览中。</p>
        <p v-if="layout.conflictTargets.length" class="preview-warning" role="alert">{{ conflictLabels }} 存在重叠绑定，画面可能互相遮挡，请在矩阵中调整。</p>
        <p v-if="fullscreenError" class="preview-warning" role="alert">{{ fullscreenError }}</p>
      </div>
      <details class="preview-help">
        <summary>网页没有显示？</summary>
        <p>打开「标注」，点击画面上的外链图标检查原网页。网页需能从当前浏览器访问；登录要求、禁止嵌入或 HTTPS / HTTP 限制可能影响显示。模拟预览不使用视频源容器中的登录状态。</p>
      </details>
    </footer>
  </section>
</template>

<style scoped>
.screen-preview {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--vc-border);
  border-radius: 12px;
  background: var(--vc-surface);
  color: var(--vc-text-primary);
}

.preview-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px;
}

.preview-heading {
  display: flex;
  align-items: center;
  gap: 12px;
}

.preview-heading-icon {
  display: grid;
  place-items: center;
  width: 44px;
  height: 44px;
  border: 1px solid var(--vc-border);
  border-radius: 10px;
  background: var(--vc-surface-muted);
  color: var(--vc-primary);
}

.preview-heading h2 {
  margin: 0 0 6px;
  font-size: 18px;
  line-height: 1.2;
}

.preview-heading p {
  margin: 0;
  color: var(--vc-text-muted);
  font-size: 12px;
}

.preview-heading p span {
  padding: 0 4px;
  opacity: .55;
}

.preview-mode {
  align-self: flex-start;
  border: 1px solid var(--vc-border);
  border-radius: 4px;
  padding: 3px 6px;
  color: var(--vc-text-muted);
  font-size: 10px;
  white-space: nowrap;
}

.preview-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}

.preview-toolbar label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--vc-text-muted);
  font-size: 12px;
}

.preview-toolbar select {
  width: auto;
  min-height: 34px;
  height: 34px;
  border: 1px solid var(--vc-border);
  border-radius: 6px;
  padding: 0 8px;
  background: var(--vc-surface);
  color: var(--vc-text-primary);
  font-size: 12px;
}

.preview-toolbar button, .preview-empty-state button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  border: 1px solid var(--vc-border);
  border-radius: 6px;
  padding: 7px 10px;
  background: var(--vc-surface);
  color: var(--vc-text-secondary);
  cursor: pointer;
  font-size: 12px;
  white-space: nowrap;
}

.preview-toolbar button:hover {
  background: var(--vc-surface-muted);
}

.preview-toolbar button.active {
  background: var(--vc-primary-subtle);
  border-color: var(--vc-primary);
  color: var(--vc-primary);
}

.preview-toolbar .preview-fullscreen-button {
  background: var(--vc-primary-bg);
  border-color: var(--vc-primary-bg);
  color: var(--vc-primary-contrast);
}

.preview-toolbar .preview-fullscreen-button:hover {
  background: var(--vc-primary-bg-hover);
}

.preview-toolbar button:disabled {
  opacity: .4;
  cursor: not-allowed;
}

.preview-toggles {
  display: flex;
  gap: 5px;
}

.preview-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  min-height: 300px;
  height: clamp(340px, calc(100dvh - var(--sticky-status-header-height) - var(--project-header-panel-height) - 210px), 900px);
  overflow: hidden;
  background: radial-gradient(circle at 1px 1px, #ffffff12 1px, transparent 0) 0 0 / 20px 20px, #080e18;
}

.preview-wall {
  position: relative;
  flex: none;
  overflow: hidden;
  background: #000;
  box-shadow: 0 0 0 1px #51617a, 0 12px 40px #0009;
}

.preview-cells, .preview-grid {
  position: absolute;
  inset: 0;
  display: grid;
}

.preview-empty-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: 0;
  overflow: hidden;
  color: #546174;
  font-size: 11px;
  white-space: nowrap;
}

.preview-grid {
  pointer-events: none;
}

.preview-grid-cell {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.preview-grid.with-lines .preview-grid-cell {
  box-shadow: inset 0 0 0 .5px #a8b9cf77;
}

.preview-grid .preview-grid-cell.conflict {
  box-shadow: inset 0 0 0 2px #fbbf24;
}

.preview-grid-cell span {
  position: absolute;
  right: 4px;
  bottom: 4px;
  max-width: calc(100% - 8px);
  overflow: hidden;
  border-radius: 3px;
  padding: 2px 4px;
  background: #080e18c9;
  color: #9aabc0;
  font-size: 10px;
  white-space: nowrap;
}

.preview-empty-state {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  background: #080e18b8;
  color: #aabbd0;
  text-align: center;
}

.preview-empty-state strong {
  color: #e2e8f0;
  font-size: 16px;
  font-weight: 500;
}

.preview-empty-state p {
  margin: 0;
  font-size: 13px;
}

.preview-empty-state button {
  margin-top: 4px;
  border-color: #475569;
  background: #1e293b;
  color: #e2e8f0;
}

.preview-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 20px;
  color: var(--vc-text-muted);
  font-size: 12px;
  line-height: 1.7;
}

.preview-footer p {
  margin: 0;
}

.preview-notes {
  flex: 1 1 300px;
}

.preview-help {
  max-width: 420px;
}

.preview-help summary {
  color: var(--vc-primary);
  cursor: pointer;
}

.preview-help p {
  margin-top: 8px;
}

.preview-warning {
  color: var(--vc-warning);
}

.screen-preview:fullscreen {
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 0;
}

.screen-preview:fullscreen .preview-stage {
  min-height: 0;
  height: 100%;
}

button:focus-visible, select:focus-visible, summary:focus-visible {
  outline: 2px solid var(--vc-primary);
  outline-offset: 3px;
}

@media (max-width: 700px) {
  .preview-header {
    padding: 14px;
    gap: 16px;
  }

  .preview-heading {
    gap: 8px;
  }

  .preview-heading-icon {
    display: none;
  }

  .preview-toolbar {
    gap: 8px;
  }

  .preview-toolbar label {
    gap: 5px;
  }

  .preview-footer {
    padding: 12px 14px;
  }

  .preview-stage {
    min-height: 280px;
    height: 45dvh;
  }

  .preview-heading p {
    font-size: 11px;
  }

}
</style>
