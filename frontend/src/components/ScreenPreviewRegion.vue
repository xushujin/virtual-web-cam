<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { ExternalLink, RefreshCw } from 'lucide-vue-next';
import { getPreviewFrameStyle, previewUrl } from '../utils/screen-preview';

const props = defineProps({
  camera: { type: Object, required: true },
  width: { type: Number, required: true },
  height: { type: Number, required: true },
  fit: { type: String, default: 'contain' },
  showLabels: { type: Boolean, default: true },
});

const revision = ref(0);
const loading = ref(true);
const slow = ref(false);
const failed = ref(false);
let loadingTimer;
const url = computed(() => previewUrl(props.camera.web_url));
const mixedContent = computed(() => window.location.protocol === 'https:' && url.value.startsWith('http:'));
const message = computed(() => {
  if (!url.value) return '未配置有效的网页地址';
  if (mixedContent.value) return '当前 HTTPS 页面无法嵌入 HTTP 网页';
  if (failed.value) return '网页加载失败，可打开原网页检查';
  return '';
});
const frameStyle = computed(() => getPreviewFrameStyle(props.camera, props.width, props.height, props.fit));

function settleLoad() {
  loading.value = false;
  slow.value = false;
  window.clearTimeout(loadingTimer);
}

function failLoad() {
  settleLoad();
  failed.value = true;
}

watch([url, revision], () => {
  window.clearTimeout(loadingTimer);
  loading.value = true;
  slow.value = false;
  failed.value = false;
  if (url.value && !mixedContent.value) {
    loadingTimer = window.setTimeout(() => { slow.value = true; }, 12000);
  }
}, { immediate: true });

onBeforeUnmount(() => window.clearTimeout(loadingTimer));
</script>

<template>
  <article class="preview-region" :aria-label="`${camera.name} 预览`">
    <iframe
      v-if="url && !mixedContent && !failed"
      :key="`${url}-${revision}`"
      :src="url"
      :title="`${camera.name} 网页预览`"
      :style="frameStyle"
      sandbox="allow-scripts allow-same-origin"
      referrerpolicy="no-referrer"
      tabindex="-1"
      @load="settleLoad"
      @error="failLoad"
    />
    <div v-if="message || loading" class="preview-region-message" :class="{ 'is-loading': !message, 'is-slow': slow && !message }" role="status">
      <span>{{ message || (slow ? '加载较慢，可打开原网页检查' : '正在加载网页…') }}</span>
      <a v-if="url && (message || slow)" :href="url" target="_blank" rel="noopener noreferrer">打开原网页 <ExternalLink :size="12" /></a>
    </div>
    <header v-if="showLabels" class="preview-region-caption">
      <span :title="`${camera.name} · ${camera.width} × ${camera.height}`">{{ camera.name }}</span>
      <button type="button" :aria-label="`刷新 ${camera.name}`" title="刷新此网页" @click="revision += 1"><RefreshCw :size="12" /></button>
      <a v-if="url" :href="url" target="_blank" rel="noopener noreferrer" :aria-label="`打开 ${camera.name} 原网页`" title="打开原网页"><ExternalLink :size="12" /></a>
    </header>
  </article>
</template>

<style scoped>
.preview-region {
  position: absolute;
  overflow: hidden;
  background: #000;
}

.preview-region iframe {
  position: absolute;
  border: 0;
  pointer-events: none;
  color-scheme: normal;
  background: #fff;
}

.preview-region-caption {
  position: absolute;
  top: 6px;
  left: 6px;
  right: 6px;
  display: flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  max-width: calc(100% - 12px);
  padding: 4px 5px 4px 8px;
  border: 1px solid #ffffff24;
  border-radius: 5px;
  background: #0b1426db;
  color: #e2e8f0;
  font-size: 11px;
}

.preview-region-caption span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.preview-region-caption button, .preview-region-caption a {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 24px;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: #cbd5e1;
  cursor: pointer;
}

.preview-region-caption button:hover, .preview-region-caption a:hover {
  background: #ffffff24;
  color: #fff;
}

.preview-region-message {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px;
  overflow: auto;
  background: #0e1727;
  color: #aabbd0;
  text-align: center;
  font-size: 12px;
}

.preview-region-message.is-loading {
  background: #0e1727dd;
  pointer-events: none;
}

.preview-region-message.is-slow {
  inset: auto 0 0;
  flex-direction: row;
  flex-wrap: wrap;
  padding: 6px;
}

.preview-region-message a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #93c5fd;
  pointer-events: auto;
}

button:focus-visible, a:focus-visible {
  outline: 2px solid #93c5fd;
  outline-offset: 2px;
}
</style>
