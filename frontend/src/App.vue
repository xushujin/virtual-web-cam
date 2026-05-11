<script setup>
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  ArrowLeft,
  Copy,
  ExternalLink,
  FileText,
  GripVertical,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  Sparkles,
  Square,
  Trash2,
  Upload,
  X,
} from 'lucide-vue-next';
import {
  bulkCreateCameras,
  createCamera,
  createProject,
  deleteCamera,
  exportProjectConfig,
  getHealth,
  getLogs,
  getResourceStats,
  importProjectConfig,
  listAuditLogs,
  listCameraStatuses,
  listCameras,
  listProjects,
  restartCamera,
  startCamera,
  stopCamera,
  updateCamera,
  updateCameraTargets,
  updateProject,
} from './api';

const projects = ref([]);
const selectedProjectId = ref(null);
const currentView = ref('projects');
const projectSection = ref('cameras');
const cameras = ref([]);
const loading = ref(false);
const saving = ref(false);
const bulkCreating = ref(false);
const statusRefreshing = ref(false);
let statusPollTimer = null;
let resourcePollTimer = null;
const error = ref('');
const toast = ref('');
const activeLogs = ref(null);
const editingCamera = ref(null);
const logText = ref('');
const logLoading = ref(false);
const auditLogs = ref([]);
const auditLoading = ref(false);
const systemStatus = ref(null);
const systemLoading = ref(true);
const resourceStats = ref(null);
const previousResourceStats = ref(null);
const resourceRates = ref(null);
const resourceRefreshing = ref(false);
const busyCameraIds = ref(new Set());
const selectedCameraIds = ref(new Set());
const cameraQuery = ref('');
const cameraStatusFilter = ref('all');
const draggedCameraId = ref(null);
const hoverScreen = ref(null);
const projectSaving = ref(false);
const projectCreating = ref(false);
const regionDragStart = ref(null);
const draftRegion = ref(null);
const isSelectingRegion = ref(false);
const matrixDensity = ref('standard');
const importInput = ref(null);
const importingProject = ref(false);
const showCreateModal = ref(false);
const showBulkModal = ref(false);
const openActionMenuId = ref(null);
const uiTheme = ref(window.localStorage.getItem('virtualwebcam-theme') || 'light');
const defaultCameraColumns = {
  ip: true,
  webUrl: true,
  status: true,
  resource: false,
  target: false,
  rtsp: false,
  onvif: false,
};
const cameraColumnOptions = [
  { key: 'ip', label: 'IP' },
  { key: 'webUrl', label: '网页 URL' },
  { key: 'status', label: '状态' },
  { key: 'resource', label: '资源' },
  { key: 'target', label: '投放屏幕' },
  { key: 'rtsp', label: 'RTSP' },
  { key: 'onvif', label: 'ONVIF' },
];

function loadCameraColumns() {
  try {
    const raw = window.localStorage.getItem('virtualwebcam-camera-columns');
    if (!raw) return { ...defaultCameraColumns };
    const stored = JSON.parse(raw);
    return {
      ...defaultCameraColumns,
      ...Object.fromEntries(Object.entries(stored).filter(([key]) => key in defaultCameraColumns)),
    };
  } catch {
    return { ...defaultCameraColumns };
  }
}

const cameraColumns = reactive(loadCameraColumns());

const projectDraft = reactive({
  name: '',
  rows: 6,
  cols: 8,
  prefix: '屏',
});

const newProject = reactive({
  name: '',
  rows: 6,
  cols: 8,
  prefix: '屏',
});

const form = reactive({
  source_type: 'camera',
  name: '',
  ip: '',
  stream_name: 'screen01',
  web_url: 'https://www.baidu.com',
  width: 1280,
  height: 720,
  fps: 15,
  display_targets: [],
});

const bulkForm = reactive({
  count: 8,
  start_ip: '192.168.110.211',
  name_prefix: 'web-cam-',
  stream_prefix: 'screen',
  web_url: 'https://www.baidu.com',
  width: 1280,
  height: 720,
  fps: 15,
});

const editForm = reactive({
  source_type: 'camera',
  name: '',
  ip: '',
  stream_name: '',
  web_url: '',
  width: 1280,
  height: 720,
  fps: 15,
});

const selectedProject = computed(() => projects.value.find((project) => project.id === selectedProjectId.value));

const systemProblems = computed(() => {
  const runtime = systemStatus.value?.runtime;

  if (!runtime) return [];

  const problems = [];

  if (!runtime.docker?.available) {
    problems.push(runtime.docker?.error || 'Docker daemon 不可用');
  }

  if (runtime.docker?.available && !runtime.network?.exists) {
    problems.push(runtime.network?.error || `Docker 网络不存在：${runtime.network?.name}`);
  }

  if (runtime.docker?.available && !runtime.image?.exists) {
    problems.push(runtime.image?.error || `Docker 镜像不存在：${runtime.image?.name}`);
  }

  return problems;
});

const canCreateCamera = computed(() => !saving.value && Boolean(selectedProjectId.value));
const filteredCameras = computed(() => {
  const keyword = cameraQuery.value.trim().toLowerCase();

  return cameras.value.filter((camera) => {
    if (cameraStatusFilter.value !== 'all' && camera.status !== cameraStatusFilter.value) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    return [
      camera.name,
      camera.ip,
      sourceTypeLabel(camera),
      camera.stream_name,
      camera.web_url,
      camera.rtsp_url,
      camera.onvif_url,
      statusLabel(camera.status),
      targetSummary(camera),
    ].some((value) => String(value || '').toLowerCase().includes(keyword));
  });
});
const selectedCameras = computed(() => cameras.value.filter((camera) => selectedCameraIds.value.has(camera.id)));
const allVisibleSelected = computed(() => filteredCameras.value.length > 0 && filteredCameras.value.every((camera) => selectedCameraIds.value.has(camera.id)));
const hasCameraSelection = computed(() => selectedCameraIds.value.size > 0);
const visibleCameraColumnCount = computed(() => Object.values(cameraColumns).filter(Boolean).length);
const cameraTableColspan = computed(() => visibleCameraColumnCount.value + 3);
const cameraTableClass = computed(() => ({
  'hide-web-url': !cameraColumns.webUrl,
  'hide-resource': !cameraColumns.resource,
  'hide-rtsp': !cameraColumns.rtsp,
  'hide-onvif': !cameraColumns.onvif,
}));
const cameraStats = computed(() => ({
  total: cameras.value.length,
  running: cameras.value.filter((camera) => camera.status === 'running').length,
  stopped: cameras.value.filter((camera) => camera.status === 'stopped').length,
  error: cameras.value.filter((camera) => camera.status === 'error').length,
  bound: cameras.value.filter((camera) => (camera.display_targets || []).length > 0).length,
  unbound: cameras.value.filter((camera) => (camera.display_targets || []).length === 0).length,
}));

const resourceByCameraId = computed(() => new Map((resourceStats.value?.items || []).map((item) => [item.camera_id, item])));
const resourceSummary = computed(() => resourceStats.value?.summary || {
  cpuPercent: 0,
  memoryUsageBytes: 0,
  memoryLimitBytes: 0,
  memoryPercent: 0,
  networkRxBytes: 0,
  networkTxBytes: 0,
  blockReadBytes: 0,
  blockWriteBytes: 0,
  running: 0,
  total: 0,
});
const resourceUpdatedAt = computed(() => {
  if (!resourceStats.value?.collected_at) return '未采集';
  return new Date(resourceStats.value.collected_at).toLocaleTimeString();
});

const screenCells = computed(() => {
  const total = projectDraft.rows * projectDraft.cols;
  return Array.from({ length: total }, (_, index) => ({
    index: index + 1,
    row: Math.floor(index / projectDraft.cols) + 1,
    col: (index % projectDraft.cols) + 1,
  }));
});

const assignmentsByScreen = computed(() => {
  const map = new Map();

  for (const camera of cameras.value) {
    for (const target of camera.display_targets || []) {
      if (!map.has(target)) {
        map.set(target, []);
      }
      map.get(target).push(camera);
    }
  }

  return map;
});

const unassignedCameras = computed(() => cameras.value.filter((camera) => (camera.display_targets || []).length === 0));

const assignedCameraRegions = computed(() => cameras.value
  .filter((camera) => (camera.display_targets || []).length > 0)
  .map((camera) => ({
    camera,
    region: normalizeCameraRegion(camera),
  }))
  .filter((item) => item.region));

const matrixDensityConfig = {
  compact: {
    column: 'minmax(92px, 1fr)',
    row: 'minmax(112px, auto)',
  },
  standard: {
    column: 'minmax(132px, 1fr)',
    row: 'minmax(158px, auto)',
  },
  detail: {
    column: 'minmax(172px, 1fr)',
    row: 'minmax(190px, auto)',
  },
};

const matrixColumnSize = computed(() => matrixDensityConfig[matrixDensity.value]?.column || matrixDensityConfig.standard.column);
const matrixRowSize = computed(() => matrixDensityConfig[matrixDensity.value]?.row || matrixDensityConfig.standard.row);

function showToast(message) {
  toast.value = message;
  window.setTimeout(() => {
    if (toast.value === message) {
      toast.value = '';
    }
  }, 1800);
}

function toggleTheme() {
  uiTheme.value = uiTheme.value === 'cyber' ? 'light' : 'cyber';
  window.localStorage.setItem('virtualwebcam-theme', uiTheme.value);
}

watch(uiTheme, (theme) => {
  document.body.classList.toggle('virtualwebcam-cyber-body', theme === 'cyber');
}, { immediate: true });

watch(cameraColumns, (columns) => {
  window.localStorage.setItem('virtualwebcam-camera-columns', JSON.stringify(columns));
}, { deep: true });

function showAllCameraColumns() {
  Object.assign(cameraColumns, defaultCameraColumns);
}

function showCompactCameraColumns() {
  Object.assign(cameraColumns, {
    ip: true,
    webUrl: true,
    status: true,
    resource: false,
    target: false,
    rtsp: false,
    onvif: false,
  });
}

function applyProject(project) {
  if (!project) return;

  projectDraft.name = project.name;
  projectDraft.rows = project.rows;
  projectDraft.cols = project.cols;
  projectDraft.prefix = project.prefix;
}

function resetForm() {
  const nextNumber = cameras.value.length + 1;
  form.source_type = 'camera';
  form.name = '';
  form.ip = '';
  form.stream_name = `screen${String(nextNumber).padStart(2, '0')}`;
  form.web_url = 'https://www.baidu.com';
  form.width = 1280;
  form.height = 720;
  form.fps = 15;
  form.display_targets = [];
}

function uniqueName(baseName) {
  const base = `${baseName || '摄像头'} 副本`;
  const used = new Set(cameras.value.map((camera) => camera.name));

  if (!used.has(base)) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return base;
}

function incrementStreamName(value) {
  const used = new Set(cameras.value.map((camera) => camera.stream_name));
  const match = String(value || '').match(/^(.*?)(\d+)$/);
  const prefix = match ? match[1] : `${value || 'screen'}-`;
  const start = match ? Number.parseInt(match[2], 10) + 1 : 2;
  const width = match ? match[2].length : 2;

  for (let index = start; index < start + 1000; index += 1) {
    const candidate = `${prefix}${String(index).padStart(width, '0')}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return `${value || 'screen'}-copy`;
}

function incrementIp(value) {
  const parts = String(value || '').split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
    return '';
  }

  const used = new Set(cameras.value.map((camera) => camera.ip));
  for (let last = parts[3] + 1; last <= 254; last += 1) {
    const candidate = `${parts[0]}.${parts[1]}.${parts[2]}.${last}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return '';
}

function cloneCamera(camera) {
  form.source_type = camera.source_type || 'camera';
  form.name = uniqueName(camera.name);
  form.ip = camera.source_type === 'rtsp' ? '' : incrementIp(camera.ip);
  form.stream_name = incrementStreamName(camera.stream_name);
  form.web_url = camera.web_url;
  form.width = camera.width;
  form.height = camera.height;
  form.fps = camera.fps;
  form.display_targets = [];
  showCreateModal.value = true;
  showToast(form.source_type === 'rtsp' || form.ip ? '已复制到新增弹窗' : '已复制，请补充虚拟 IP');
}

function sourcePayload(payload) {
  return {
    ...payload,
    ip: payload.source_type === 'rtsp' ? null : payload.ip,
  };
}

function toggleActionMenu(id) {
  openActionMenuId.value = openActionMenuId.value === id ? null : id;
}

function closeActionMenu() {
  openActionMenuId.value = null;
}

async function refreshSystemStatus() {
  systemLoading.value = true;

  try {
    systemStatus.value = await getHealth();
  } catch (err) {
    systemStatus.value = {
      runtime: {
        docker: {
          available: false,
          error: err.message,
        },
      },
    };
  } finally {
    systemLoading.value = false;
  }
}

async function refreshProjects() {
  const loaded = await listProjects();
  projects.value = loaded;

  const current = loaded.find((project) => project.id === selectedProjectId.value);
  if (current) {
    applyProject(current);
  } else if (selectedProjectId.value) {
    selectedProjectId.value = null;
    currentView.value = 'projects';
  }
}

async function refresh() {
  if (currentView.value === 'projects') {
    await refreshProjects();
    return;
  }

  if (!selectedProjectId.value) return;

  if (projectSection.value === 'audit') {
    await refreshAuditLogs();
    return;
  }

  loading.value = true;
  error.value = '';

	  try {
	    cameras.value = await listCameras(selectedProjectId.value);
	    syncSelectedCameras();
      if (projectSection.value === 'cameras') {
        await refreshResourceStats({ silent: true });
      }
	  } catch (err) {
    error.value = err.message;
  } finally {
    loading.value = false;
  }
}

async function enterProject(project, section = 'cameras') {
  selectedProjectId.value = project.id;
  projectSection.value = section;
  currentView.value = 'project';
  applyProject(project);
  clearDraftRegion();
  await refresh();
}

function backToProjects() {
  currentView.value = 'projects';
  activeLogs.value = null;
  editingCamera.value = null;
  clearDraftRegion();
  refreshProjects();
}

async function switchProjectSection(section) {
  projectSection.value = section;
  clearDraftRegion();

  if (section === 'audit') {
    await refreshAuditLogs();
  }
}

async function refreshAuditLogs() {
  if (!selectedProjectId.value) return;

  auditLoading.value = true;
  error.value = '';

  try {
    auditLogs.value = await listAuditLogs(selectedProjectId.value);
  } catch (err) {
    error.value = err.message;
  } finally {
    auditLoading.value = false;
  }
}

async function refreshCameraStatuses(options = {}) {
  if (!selectedProjectId.value || statusRefreshing.value) return;

  statusRefreshing.value = true;
  error.value = '';

  try {
    const statuses = await listCameraStatuses(selectedProjectId.value);
    const statusById = new Map(statuses.map((item) => [item.id, item.status]));
    cameras.value = cameras.value.map((camera) => ({
      ...camera,
      status: statusById.get(camera.id) || camera.status,
    }));
    if (!options.silent) {
      showToast('状态已刷新');
    }
    await refreshResourceStats({ silent: true });
  } catch (err) {
    error.value = err.message;
  } finally {
    statusRefreshing.value = false;
  }
}

async function refreshResourceStats(options = {}) {
  if (!selectedProjectId.value || resourceRefreshing.value) return;

  resourceRefreshing.value = true;

  try {
    const nextStats = await getResourceStats(selectedProjectId.value);
    resourceRates.value = calculateResourceRates(resourceStats.value, nextStats);
    previousResourceStats.value = resourceStats.value;
    resourceStats.value = nextStats;
    if (!options.silent) {
      showToast('资源数据已刷新');
    }
  } catch (err) {
    if (!options.silent) {
      error.value = err.message;
    }
  } finally {
    resourceRefreshing.value = false;
  }
}

function bytesDelta(current = 0, previous = 0) {
  return Math.max(Number(current || 0) - Number(previous || 0), 0);
}

function calculateResourceRates(previous, current) {
  if (!previous?.collected_at || !current?.collected_at) return null;

  const seconds = (new Date(current.collected_at).getTime() - new Date(previous.collected_at).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const previousById = new Map((previous.items || []).map((item) => [item.camera_id, item]));
  const items = new Map();

  for (const item of current.items || []) {
    const before = previousById.get(item.camera_id);
    if (!before) continue;
    items.set(item.camera_id, {
      network_rx_bps: bytesDelta(item.network_rx_bytes, before.network_rx_bytes) / seconds,
      network_tx_bps: bytesDelta(item.network_tx_bytes, before.network_tx_bytes) / seconds,
      block_read_bps: bytesDelta(item.block_read_bytes, before.block_read_bytes) / seconds,
      block_write_bps: bytesDelta(item.block_write_bytes, before.block_write_bytes) / seconds,
    });
  }

  return {
    seconds,
    summary: {
      network_rx_bps: bytesDelta(current.summary?.networkRxBytes, previous.summary?.networkRxBytes) / seconds,
      network_tx_bps: bytesDelta(current.summary?.networkTxBytes, previous.summary?.networkTxBytes) / seconds,
      block_read_bps: bytesDelta(current.summary?.blockReadBytes, previous.summary?.blockReadBytes) / seconds,
      block_write_bps: bytesDelta(current.summary?.blockWriteBytes, previous.summary?.blockWriteBytes) / seconds,
    },
    items,
  };
}

async function saveProject() {
  if (!selectedProjectId.value) return;

  projectSaving.value = true;
  error.value = '';

  try {
    const updated = await updateProject(selectedProjectId.value, { ...projectDraft });
    projects.value = projects.value.map((project) => (project.id === updated.id ? updated : project));
    applyProject(updated);
    showToast('项目已保存');
  } catch (err) {
    error.value = err.message;
  } finally {
    projectSaving.value = false;
  }
}

function safeFilename(value) {
  return String(value || 'project')
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'project';
}

async function downloadProjectConfig(project = selectedProject.value) {
  if (!project) return;

  error.value = '';

  try {
    const payload = await exportProjectConfig(project.id);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `virtualwebcam-${safeFilename(project.name)}-${date}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
    showToast('配置已导出');
  } catch (err) {
    error.value = err.message;
  }
}

function pickImportFile() {
  importInput.value?.click();
}

async function importProjectFromFile(event) {
  const file = event.target.files?.[0];
  event.target.value = '';

  if (!file || importingProject.value) return;

  importingProject.value = true;
  error.value = '';

  try {
    const text = await file.text();
    const config = JSON.parse(text);
    const imported = await importProjectConfig(config);
    projects.value = [...projects.value, imported.project];
    const remappedCount = imported.remapped_ips?.length || 0;
    showToast(remappedCount ? `已导入，${remappedCount} 个 IP 已重映射` : '项目已导入');
    await enterProject(imported.project, 'cameras');
  } catch (err) {
    error.value = err instanceof SyntaxError ? '导入文件不是有效 JSON' : err.message;
  } finally {
    importingProject.value = false;
  }
}

async function addProject() {
  projectCreating.value = true;
  error.value = '';

  try {
    const created = await createProject({ ...newProject });
    projects.value = [...projects.value, created];
    newProject.name = '';
    newProject.rows = 6;
    newProject.cols = 8;
    newProject.prefix = '屏';
    cameras.value = [];
    showToast('项目已创建');
    await enterProject(created, 'cameras');
  } catch (err) {
    error.value = err.message;
  } finally {
    projectCreating.value = false;
  }
}

async function submit() {
  if (!canCreateCamera.value) return;

  saving.value = true;
  error.value = '';

  try {
	    await createCamera(sourcePayload(form), selectedProjectId.value);
	    resetForm();
	    await refresh();
	    showCreateModal.value = false;
	    showToast('已创建');
  } catch (err) {
    error.value = err.message;
    await refresh().catch(() => {});
  } finally {
    saving.value = false;
  }
}

async function submitBulk() {
  if (!selectedProjectId.value || bulkCreating.value) return;

  bulkCreating.value = true;
  error.value = '';

  try {
	    const result = await bulkCreateCameras({ ...bulkForm }, selectedProjectId.value);
	    await refresh();
	    showBulkModal.value = false;
	    const remappedCount = result.remapped_ips?.length || 0;
    showToast(remappedCount ? `已生成 ${result.cameras.length} 路，${remappedCount} 个 IP 已重映射` : `已生成 ${result.cameras.length} 路`);
  } catch (err) {
    error.value = err.message;
  } finally {
    bulkCreating.value = false;
  }
}

function openEditCamera(camera) {
  editingCamera.value = camera;
  editForm.source_type = camera.source_type || 'camera';
  editForm.name = camera.name;
  editForm.ip = camera.ip || '';
  editForm.stream_name = camera.stream_name;
  editForm.web_url = camera.web_url;
  editForm.width = camera.width;
  editForm.height = camera.height;
  editForm.fps = camera.fps;
}

async function saveCameraEdit() {
  if (!editingCamera.value || isCameraBusy(editingCamera.value.id)) return;

  const camera = editingCamera.value;
  setCameraBusy(camera.id, true);
  error.value = '';

  try {
    const updated = await updateCamera(camera.id, sourcePayload(editForm));
    editingCamera.value = null;
    await refresh();
    showToast(updated.warning ? '已保存，容器需检查' : '已保存');
  } catch (err) {
    error.value = err.message;
  } finally {
    setCameraBusy(camera.id, false);
  }
}

function displayTargetLabel(index) {
  return `${projectDraft.prefix}${String(index).padStart(2, '0')}`;
}

function displayTargetMeta(index) {
  const row = Math.floor((index - 1) / projectDraft.cols) + 1;
  const col = ((index - 1) % projectDraft.cols) + 1;
  return `${row}行${col}列`;
}

function indexFromRowCol(row, col) {
  return (row - 1) * projectDraft.cols + col;
}

function rowColFromIndex(index) {
  return {
    row: Math.floor((index - 1) / projectDraft.cols) + 1,
    col: ((index - 1) % projectDraft.cols) + 1,
  };
}

function createDisplayRegion(row, col, rowSpan, colSpan) {
  if (
    row < 1 ||
    col < 1 ||
    rowSpan < 1 ||
    colSpan < 1 ||
    row + rowSpan - 1 > projectDraft.rows ||
    col + colSpan - 1 > projectDraft.cols
  ) {
    return null;
  }

  const targets = [];

  for (let r = row; r < row + rowSpan; r += 1) {
    for (let c = col; c < col + colSpan; c += 1) {
      targets.push(indexFromRowCol(r, c));
    }
  }

  return {
    row,
    col,
    row_span: rowSpan,
    col_span: colSpan,
    targets,
  };
}

function normalizeCameraRegion(camera) {
  if (camera.display_region) {
    const region = createDisplayRegion(
      camera.display_region.row,
      camera.display_region.col,
      camera.display_region.row_span || 1,
      camera.display_region.col_span || 1,
    );

    if (region) {
      return region;
    }
  }

  const targets = camera.display_targets || [];
  if (targets.length === 0) {
    return null;
  }

  const cells = targets.map(rowColFromIndex);
  const minRow = Math.min(...cells.map((cell) => cell.row));
  const maxRow = Math.max(...cells.map((cell) => cell.row));
  const minCol = Math.min(...cells.map((cell) => cell.col));
  const maxCol = Math.max(...cells.map((cell) => cell.col));

  return createDisplayRegion(minRow, minCol, maxRow - minRow + 1, maxCol - minCol + 1)
    || createDisplayRegion(cells[0].row, cells[0].col, 1, 1);
}

function regionStyle(region) {
  return {
    gridColumn: `${region.col} / span ${region.col_span}`,
    gridRow: `${region.row} / span ${region.row_span}`,
    '--region-cols': region.col_span,
    '--region-rows': region.row_span,
    '--region-cells': region.targets.length,
  };
}

function createRegionFromCells(start, end) {
  const minRow = Math.min(start.row, end.row);
  const maxRow = Math.max(start.row, end.row);
  const minCol = Math.min(start.col, end.col);
  const maxCol = Math.max(start.col, end.col);

  return createDisplayRegion(minRow, minCol, maxRow - minRow + 1, maxCol - minCol + 1);
}

function regionSummary(region) {
  if (!region) {
    return '未框选';
  }

  const start = displayTargetLabel(indexFromRowCol(region.row, region.col));
  const end = displayTargetLabel(indexFromRowCol(region.row + region.row_span - 1, region.col + region.col_span - 1));

  return region.targets.length === 1
    ? start
    : `${start} - ${end} · ${region.col_span}列x${region.row_span}行`;
}

function regionTargetLabels(region) {
  if (!region) {
    return [];
  }

  const labels = region.targets.map(displayTargetLabel);
  return labels.length <= 16 ? labels : [...labels.slice(0, 16), `+${labels.length - 16}`];
}

function regionCardClass(region) {
  return {
    single: region.targets.length === 1,
    small: region.targets.length > 1 && region.targets.length <= 4,
    medium: region.targets.length > 4 && region.targets.length <= 8,
    large: region.targets.length > 8,
    wide: region.col_span >= 3,
    tall: region.row_span >= 3,
  };
}

function targetSummary(camera) {
  const region = normalizeCameraRegion(camera);

  if (!region) {
    return '未绑定';
  }

  const label = displayTargetLabel(indexFromRowCol(region.row, region.col));
  return region.row_span === 1 && region.col_span === 1
    ? label
    : `${label} · ${region.col_span}列x${region.row_span}行`;
}

function screenAssignments(index) {
  return assignmentsByScreen.value.get(index) || [];
}

function isCellInRegion(index, region) {
  return Boolean(region?.targets?.includes(index));
}

function screenCellClass(index) {
  const assignments = screenAssignments(index);

  return {
    occupied: assignments.length > 0,
    conflict: assignments.length > 1,
    running: assignments.some((camera) => camera.status === 'running'),
    error: assignments.some((camera) => camera.status === 'error'),
    selected: form.display_targets.includes(index),
    fenced: isCellInRegion(index, draftRegion.value),
    drawing: isSelectingRegion.value && isCellInRegion(index, draftRegion.value),
    dropping: hoverScreen.value === index,
  };
}

function beginDrag(camera, event) {
  draggedCameraId.value = camera.id;
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData('text/plain', String(camera.id));
}

function endDrag() {
  draggedCameraId.value = null;
  hoverScreen.value = null;
}

function beginRegionSelection(cell, event) {
  if (event.button !== 0) return;
  if (event.target.closest('button, a, input, select')) return;

  regionDragStart.value = { row: cell.row, col: cell.col };
  draftRegion.value = createDisplayRegion(cell.row, cell.col, 1, 1);
  isSelectingRegion.value = true;
  hoverScreen.value = cell.index;
  event.preventDefault();
}

function updateRegionSelection(cell) {
  if (!isSelectingRegion.value || !regionDragStart.value) return;

  draftRegion.value = createRegionFromCells(regionDragStart.value, cell);
  hoverScreen.value = cell.index;
}

function endRegionSelection() {
  isSelectingRegion.value = false;
  regionDragStart.value = null;
  hoverScreen.value = null;
}

function clearDraftRegion() {
  draftRegion.value = null;
  regionDragStart.value = null;
  isSelectingRegion.value = false;
  hoverScreen.value = null;
}

function dropRegionForCell(index, regionOverride = null) {
  if (draftRegion.value && draftRegion.value.targets.includes(index)) {
    return draftRegion.value;
  }

  if (regionOverride) {
    return regionOverride;
  }

  const start = rowColFromIndex(index);
  return createDisplayRegion(start.row, start.col, 1, 1);
}

async function dropCameraOnScreen(index, event, regionOverride = null) {
  event.preventDefault();
  const cameraId = Number.parseInt(event.dataTransfer.getData('text/plain') || draggedCameraId.value, 10);
  const camera = cameras.value.find((item) => item.id === cameraId);
  const region = dropRegionForCell(index, regionOverride);

  hoverScreen.value = null;

  if (!camera) return;

  if (!region) {
    error.value = '合并区域超出当前矩阵范围';
    return;
  }

  const occupyingCameras = cameras.value.filter((item) => {
    if (item.id === camera.id) return false;
    return (item.display_targets || []).some((target) => region.targets.includes(target));
  });

  await saveExclusiveScreenAssignment(camera, region, occupyingCameras);
  clearDraftRegion();
}

async function clearCameraAssignment(camera) {
  await saveCameraTargets(camera, [], null, '已移除绑定');
}

async function saveCameraTargets(camera, targets, region, message) {
  setCameraBusy(camera.id, true);
  error.value = '';

  try {
    await updateCameraTargets(camera.id, targets, region);
    await refresh();
    showToast(message);
  } catch (err) {
    error.value = err.message;
  } finally {
    setCameraBusy(camera.id, false);
  }
}

async function saveExclusiveScreenAssignment(camera, region, occupyingCameras) {
  const busyIds = [camera.id, ...occupyingCameras.map((item) => item.id)];
  busyIds.forEach((id) => setCameraBusy(id, true));
  error.value = '';

  try {
    for (const occupyingCamera of occupyingCameras) {
      await updateCameraTargets(occupyingCamera.id, [], null);
    }

    await updateCameraTargets(camera.id, region.targets, {
      row: region.row,
      col: region.col,
      row_span: region.row_span,
      col_span: region.col_span,
    });
    await refresh();
    showToast(occupyingCameras.length > 0 ? '已替换合并区域' : '已分配到合并区域');
  } catch (err) {
    error.value = err.message;
  } finally {
    busyIds.forEach((id) => setCameraBusy(id, false));
  }
}

function setCameraBusy(id, busy) {
  const next = new Set(busyCameraIds.value);

  if (busy) {
    next.add(id);
  } else {
    next.delete(id);
  }

  busyCameraIds.value = next;
}

function syncSelectedCameras() {
  const visibleIds = new Set(cameras.value.map((camera) => camera.id));
  selectedCameraIds.value = new Set([...selectedCameraIds.value].filter((id) => visibleIds.has(id)));
}

function toggleCameraSelection(id, checked) {
  const next = new Set(selectedCameraIds.value);

  if (checked) {
    next.add(id);
  } else {
    next.delete(id);
  }

  selectedCameraIds.value = next;
}

function toggleAllCameras(checked) {
  const next = new Set(selectedCameraIds.value);

  for (const camera of filteredCameras.value) {
    if (checked) {
      next.add(camera.id);
    } else {
      next.delete(camera.id);
    }
  }

  selectedCameraIds.value = next;
}

function applyCameraStatusFilter(status) {
  cameraStatusFilter.value = status;
}

function applyCameraBindingFilter(bound) {
  cameraStatusFilter.value = 'all';
  cameraQuery.value = bound ? projectDraft.prefix : '未绑定';
}

function isCameraBusy(id) {
  return busyCameraIds.value.has(id);
}

function canStartCamera(camera) {
  return camera.status !== 'running' && !isCameraBusy(camera.id);
}

function canStopCamera(camera) {
  return camera.status === 'running' && !isCameraBusy(camera.id);
}

function canRestartCamera(camera) {
  return camera.status === 'running' && !isCameraBusy(camera.id);
}

async function runAction(action, camera, doneMessage) {
  if (isCameraBusy(camera.id)) return;

  error.value = '';
  setCameraBusy(camera.id, true);

  try {
    await action(camera.id);
    await refresh();
    showToast(doneMessage);
  } catch (err) {
    error.value = err.message;
    await refresh().catch(() => {});
  } finally {
    setCameraBusy(camera.id, false);
  }
}

async function runBatchAction(action, doneMessage) {
  const targets = selectedCameras.value.filter((camera) => {
    if (action === startCamera) return canStartCamera(camera);
    if (action === stopCamera) return canStopCamera(camera);
    if (action === restartCamera) return canRestartCamera(camera);
    return !isCameraBusy(camera.id);
  });
  if (targets.length === 0) return;

  error.value = '';
  targets.forEach((camera) => setCameraBusy(camera.id, true));

  let failed = 0;

  try {
    for (const camera of targets) {
      try {
        await action(camera.id);
      } catch {
        failed += 1;
      }
    }

    await refresh();
    showToast(failed > 0 ? `${doneMessage}，${failed} 路失败` : `${doneMessage} ${targets.length} 路`);
  } catch (err) {
    error.value = err.message;
    await refresh().catch(() => {});
  } finally {
    targets.forEach((camera) => setCameraBusy(camera.id, false));
  }
}

async function remove(camera) {
  if (!window.confirm(`删除 ${camera.name}？`)) return;
  await runAction(deleteCamera, camera, '已删除');
}

async function copy(value) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(value);
    showToast('已复制');
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
  showToast('已复制');
}

function mpvCommand(camera) {
  return `mpv --rtsp-transport=tcp ${camera.rtsp_url}`;
}

function openUrl(url) {
  window.open(url, '_blank', 'noopener,noreferrer');
}

async function openLogs(camera) {
  activeLogs.value = camera;
  logText.value = '';
  logLoading.value = true;

  try {
    const result = await getLogs(camera.id);
    logText.value = result.logs || '暂无日志';
  } catch (err) {
    logText.value = err.message;
  } finally {
    logLoading.value = false;
  }
}

function statusLabel(status) {
  const map = {
    running: '运行中',
    stopped: '已停止',
    error: '异常',
  };
  return map[status] || status;
}

function sourceTypeLabel(camera) {
  return camera.source_type === 'rtsp' ? 'RTSP流' : 'ONVIF';
}

function sourceAddress(camera) {
  return camera.source_type === 'rtsp' ? '共享网关' : (camera.ip || '-');
}

function formatPercent(value, digits = 1) {
  const number = Number(value || 0);
  return `${number.toFixed(digits)}%`;
}

function formatBytes(value) {
  const number = Number(value || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = number;
  let index = 0;

  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }

  return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
}

function formatByteRate(value) {
  return `${formatBytes(value)}/s`;
}

function resourceForCamera(camera) {
  return resourceByCameraId.value.get(camera.id);
}

function resourceRateForCamera(camera) {
  return resourceRates.value?.items?.get(camera.id);
}

function resourceStatusText(camera) {
  const stats = resourceForCamera(camera);
  if (!stats) return '未采集';
  if (stats.status !== 'running') return statusLabel(stats.status);
  return `${formatPercent(stats.cpu_percent)} / ${formatBytes(stats.memory_usage_bytes)}`;
}

function resourceNetworkText(stats) {
  if (!stats || stats.status !== 'running') return '-';
  const rate = resourceRates.value?.items?.get(stats.camera_id);
  if (rate) {
    return `网络 ↓${formatByteRate(rate.network_rx_bps)} ↑${formatByteRate(rate.network_tx_bps)}`;
  }
  return `网络累计 ↓${formatBytes(stats.network_rx_bytes)} ↑${formatBytes(stats.network_tx_bytes)}`;
}

function resourceDiskText(stats) {
  if (!stats || stats.status !== 'running') return '-';
  const rate = resourceRates.value?.items?.get(stats.camera_id);
  if (rate) {
    return `磁盘 读 ${formatByteRate(rate.block_read_bps)} / 写 ${formatByteRate(rate.block_write_bps)}`;
  }
  return `磁盘累计 读 ${formatBytes(stats.block_read_bytes)} / 写 ${formatBytes(stats.block_write_bytes)}`;
}

function projectSectionLabel(section) {
  const map = {
    cameras: '摄像头管理',
    matrix: '矩阵绑定',
    settings: '项目设置',
    audit: '操作审计',
  };
  return map[section] || section;
}

function auditActionLabel(action) {
  const map = {
    'project.create': '创建项目',
    'project.update': '更新项目',
    'matrix.update': '更新矩阵',
    'camera.create': '创建摄像头',
    'camera.create_failed': '创建摄像头失败',
    'camera.bind': '更新绑定',
    'camera.start': '启动摄像头',
    'camera.stop': '停止摄像头',
    'camera.restart': '重启摄像头',
    'camera.delete': '删除摄像头',
  };
  return map[action] || action;
}

function auditDetailSummary(log) {
  const detail = log.detail || {};

  if (log.action === 'camera.bind') {
    const targets = detail.display_targets || [];
    return targets.length > 0 ? `绑定 ${targets.length} 块屏：${targets.join(', ')}` : '解除屏幕绑定';
  }

  if (log.action?.startsWith('camera.')) {
    return detail.camera?.ip || detail.ip || detail.error || log.target_name || '-';
  }

  if (log.action === 'matrix.update') {
    return `${detail.rows || '-'} 行 x ${detail.cols || '-'} 列，前缀 ${detail.prefix || '-'}`;
  }

  if (log.action?.startsWith('project.')) {
    return detail.rows && detail.cols ? `${detail.rows} 行 x ${detail.cols} 列` : log.target_name || '-';
  }

  return log.target_name || '-';
}

onMounted(async () => {
  await refreshProjects();
  refreshSystemStatus();
  statusPollTimer = window.setInterval(() => {
    if (currentView.value === 'project' && projectSection.value === 'cameras') {
      refreshCameraStatuses({ silent: true });
    }
  }, 10000);
  resourcePollTimer = window.setInterval(() => {
    if (currentView.value === 'project' && projectSection.value === 'cameras') {
      refreshResourceStats({ silent: true });
    }
  }, 15000);
});

onBeforeUnmount(() => {
  if (statusPollTimer) {
    window.clearInterval(statusPollTimer);
  }
  if (resourcePollTimer) {
    window.clearInterval(resourcePollTimer);
  }
});
</script>

<template>
  <main class="shell" :class="{ 'theme-cyber': uiTheme === 'cyber' }" @click="closeActionMenu">
	    <header class="topbar">
	      <div>
	        <div class="title-line">
	          <h1>VirtualWebCam</h1>
	          <button class="theme-icon-button" type="button" :title="uiTheme === 'cyber' ? '切换为标准主题' : '切换为科技主题'" @click="toggleTheme">
	            <Sparkles :size="16" />
	          </button>
	        </div>
	        <p v-if="currentView === 'projects'">项目入口 · 网页转 RTSP + ONVIF 摄像头实例管理</p>
	        <p v-else>{{ selectedProject?.name }} · {{ projectSectionLabel(projectSection) }}</p>
	      </div>
	      <div class="topbar-actions">
	        <button v-if="currentView === 'project'" class="text-button" type="button" @click="backToProjects">
	          <ArrowLeft :size="16" />
          <span>项目列表</span>
        </button>
        <button class="icon-button" type="button" title="刷新" @click="refresh">
          <RefreshCw :size="18" />
        </button>
      </div>
    </header>

    <section class="system-strip" :class="{ ok: systemProblems.length === 0 && !systemLoading }">
      <div>
        <strong>运行环境</strong>
        <span v-if="systemLoading">检测中</span>
        <span v-else-if="systemProblems.length === 0">Docker、macvlan 网络、VirtualWebCam 镜像均可用</span>
        <span v-else>{{ systemProblems[0] }}</span>
      </div>
      <button class="icon-button" type="button" title="重新检测" @click="refreshSystemStatus">
        <RefreshCw :size="16" />
      </button>
    </section>

    <p v-if="error" class="error global-error">{{ error }}</p>

    <section v-if="currentView === 'projects'" class="project-home">
      <section class="panel project-create-panel">
        <div class="panel-heading">
          <h2>创建管理项目</h2>
        </div>
        <div class="project-create">
          <input v-model.trim="newProject.name" placeholder="项目名称" />
          <input v-model.number="newProject.rows" type="number" min="1" max="20" title="行" />
          <input v-model.number="newProject.cols" type="number" min="1" max="30" title="列" />
          <input v-model.trim="newProject.prefix" maxlength="8" title="前缀" />
          <div class="project-create-actions">
            <span class="count">{{ projects.length }}</span>
            <input ref="importInput" class="visually-hidden" type="file" accept="application/json,.json" @change="importProjectFromFile" />
            <button class="text-button" type="button" :disabled="importingProject" @click="pickImportFile">
              <Upload :size="16" />
              <span>{{ importingProject ? '导入中' : '导入配置' }}</span>
            </button>
            <button class="primary-button" type="button" :disabled="projectCreating || !newProject.name" @click="addProject">
              <Plus :size="16" />
              <span>{{ projectCreating ? '创建中' : '新建项目' }}</span>
            </button>
          </div>
        </div>
      </section>

      <section class="project-grid">
        <article v-for="project in projects" :key="project.id" class="project-card">
          <div class="project-card-head">
            <strong>{{ project.name }}</strong>
            <div class="project-card-tools">
              <span>{{ project.rows }}x{{ project.cols }}</span>
              <button type="button" title="导出配置" @click="downloadProjectConfig(project)">
                <FileText :size="15" />
              </button>
              <button type="button" title="项目设置" @click="enterProject(project, 'settings')">
                <Settings :size="15" />
              </button>
            </div>
          </div>
          <dl>
            <div>
              <dt>矩阵</dt>
              <dd>{{ project.rows }} 行 x {{ project.cols }} 列</dd>
            </div>
            <div>
              <dt>编号</dt>
              <dd>{{ project.prefix }}01 - {{ project.prefix }}{{ String(project.rows * project.cols).padStart(2, '0') }}</dd>
            </div>
          </dl>
          <div class="project-card-actions">
            <button class="primary-button" type="button" @click="enterProject(project, 'cameras')">
              <ExternalLink :size="15" />
              <span>摄像头管理</span>
            </button>
            <button class="text-button" type="button" @click="enterProject(project, 'matrix')">
              <span>矩阵绑定</span>
            </button>
          </div>
        </article>

        <div v-if="projects.length === 0" class="empty project-empty">暂无项目</div>
      </section>
    </section>

    <section v-else-if="selectedProject" class="project-detail">
      <section class="panel project-header-panel">
        <div class="project-title-row">
          <div>
            <h2>{{ selectedProject.name }}</h2>
            <p>{{ projectDraft.rows }} 行 x {{ projectDraft.cols }} 列，共 {{ projectDraft.rows * projectDraft.cols }} 块屏</p>
          </div>
          <div class="section-tabs" role="tablist">
            <button type="button" :class="{ active: projectSection === 'cameras' }" @click="switchProjectSection('cameras')">
              摄像头管理
            </button>
            <button type="button" :class="{ active: projectSection === 'matrix' }" @click="switchProjectSection('matrix')">
              矩阵绑定
            </button>
            <button type="button" :class="{ active: projectSection === 'settings' }" @click="switchProjectSection('settings')">
              项目设置
            </button>
            <button type="button" :class="{ active: projectSection === 'audit' }" @click="switchProjectSection('audit')">
              操作审计
            </button>
          </div>
        </div>
      </section>

      <section v-if="projectSection === 'cameras'" class="camera-page">
        <section class="panel list-panel">
          <div class="panel-heading camera-list-heading">
            <div>
              <h2>摄像头详情</h2>
              <p v-if="filteredCameras.length !== cameras.length">当前显示 {{ filteredCameras.length }} / {{ cameras.length }} 路</p>
              <p v-else>查看运行状态、投放屏幕和 RTSP / ONVIF 地址</p>
            </div>
            <div class="panel-heading-actions camera-primary-actions">
              <span class="count">{{ cameras.length }}</span>
              <button class="text-button" type="button" :disabled="statusRefreshing" @click="refreshCameraStatuses">
                <RefreshCw :size="16" />
                <span>{{ statusRefreshing ? '刷新中' : '刷新状态' }}</span>
              </button>
              <button class="text-button" type="button" :disabled="resourceRefreshing" @click="refreshResourceStats">
                <RefreshCw :size="16" />
                <span>{{ resourceRefreshing ? '采集中' : '刷新资源' }}</span>
              </button>
              <button class="text-button" type="button" @click="showBulkModal = true">
                <Plus :size="16" />
                <span>批量生成</span>
              </button>
              <button class="primary-button" type="button" @click="showCreateModal = true">
                <Plus :size="16" />
                <span>新增源</span>
              </button>
            </div>
          </div>

	          <div class="camera-stat-grid">
	            <button type="button" @click="cameraQuery = ''; cameraStatusFilter = 'all'">
	              <span>总数</span>
	              <strong>{{ cameraStats.total }}</strong>
	            </button>
	            <button type="button" @click="applyCameraStatusFilter('running')">
	              <span>运行中</span>
	              <strong>{{ cameraStats.running }}</strong>
	            </button>
	            <button type="button" @click="applyCameraStatusFilter('stopped')">
	              <span>已停止</span>
	              <strong>{{ cameraStats.stopped }}</strong>
	            </button>
	            <button type="button" class="danger-stat" @click="applyCameraStatusFilter('error')">
	              <span>异常</span>
	              <strong>{{ cameraStats.error }}</strong>
	            </button>
	            <button type="button" @click="applyCameraBindingFilter(true)">
	              <span>已绑定</span>
	              <strong>{{ cameraStats.bound }}</strong>
	            </button>
	            <button type="button" @click="applyCameraBindingFilter(false)">
	              <span>未绑定</span>
	              <strong>{{ cameraStats.unbound }}</strong>
	            </button>
	          </div>

            <div class="resource-monitor">
              <div class="resource-monitor-head">
                <div>
                  <h3>资源监控</h3>
                  <p>实时采集 Docker 容器 CPU、内存、网络与磁盘读写，用于估算单路和整机负载。</p>
                </div>
                <span>更新 {{ resourceUpdatedAt }}</span>
              </div>
              <div class="resource-stat-grid">
                <article>
                  <span>CPU 合计</span>
                  <strong>{{ formatPercent(resourceSummary.cpuPercent) }}</strong>
                  <small>运行 {{ resourceSummary.running }} 路，共 {{ resourceSummary.total }} 路</small>
                </article>
                <article>
                  <span>内存合计</span>
                  <strong>{{ formatBytes(resourceSummary.memoryUsageBytes) }}</strong>
                  <small>{{ formatPercent(resourceSummary.memoryPercent) }} / 限额 {{ formatBytes(resourceSummary.memoryLimitBytes) }}</small>
                </article>
                <article>
                  <span>网络速率</span>
                  <strong>↓{{ formatByteRate(resourceRates?.summary?.network_rx_bps || 0) }}</strong>
                  <small>↑{{ formatByteRate(resourceRates?.summary?.network_tx_bps || 0) }} · 累计 ↓{{ formatBytes(resourceSummary.networkRxBytes) }}</small>
                </article>
                <article>
                  <span>磁盘读写速率</span>
                  <strong>写 {{ formatByteRate(resourceRates?.summary?.block_write_bps || 0) }}</strong>
                  <small>读 {{ formatByteRate(resourceRates?.summary?.block_read_bps || 0) }} · 累计写 {{ formatBytes(resourceSummary.blockWriteBytes) }}</small>
                </article>
              </div>
            </div>

	          <div class="camera-filter-bar">
	            <input v-model.trim="cameraQuery" placeholder="搜索名称 / IP / 流名 / URL / 屏幕" />
	            <select v-model="cameraStatusFilter">
	              <option value="all">全部状态</option>
	              <option value="running">运行中</option>
	              <option value="stopped">已停止</option>
	              <option value="error">异常</option>
	            </select>
	            <button class="text-button" type="button" :disabled="!cameraQuery && cameraStatusFilter === 'all'" @click="cameraQuery = ''; cameraStatusFilter = 'all'">
	              <X :size="15" />
	              <span>清除筛选</span>
	            </button>
	          </div>

            <div class="column-visibility-bar">
              <div>
                <strong>列表字段</strong>
                <span>根据当前排查目标隐藏长字段，配置会保存在本机浏览器。</span>
              </div>
              <div class="column-toggles">
                <label v-for="column in cameraColumnOptions" :key="column.key">
                  <input v-model="cameraColumns[column.key]" type="checkbox" />
                  <span>{{ column.label }}</span>
                </label>
              </div>
              <div class="column-actions">
                <button type="button" @click="showCompactCameraColumns">精简</button>
                <button type="button" @click="showAllCameraColumns">全部</button>
              </div>
            </div>

          <div class="camera-operation-bar" :class="{ muted: !hasCameraSelection }">
            <div>
              <strong>批量操作</strong>
              <span v-if="hasCameraSelection">已选择 {{ selectedCameraIds.size }} 路摄像头</span>
              <span v-else>勾选列表中的摄像头后，可批量启动、停止或重启</span>
            </div>
            <div class="batch-actions">
              <button class="text-button" type="button" :disabled="!selectedCameras.some(canStartCamera)" @click="runBatchAction(startCamera, '已启动')">
                <Play :size="16" />
                <span>启动</span>
              </button>
              <button class="text-button" type="button" :disabled="!selectedCameras.some(canStopCamera)" @click="runBatchAction(stopCamera, '已停止')">
                <Square :size="16" />
                <span>停止</span>
              </button>
              <button class="text-button" type="button" :disabled="!selectedCameras.some(canRestartCamera)" @click="runBatchAction(restartCamera, '已重启')">
                <RotateCcw :size="16" />
                <span>重启</span>
              </button>
            </div>
          </div>

	          <div class="table-wrap">
            <table :class="cameraTableClass">
              <colgroup>
                <col class="col-select" />
                <col class="col-name" />
                <col v-if="cameraColumns.ip" class="col-ip" />
                <col v-if="cameraColumns.webUrl" class="col-web-url" />
                <col v-if="cameraColumns.status" class="col-status" />
                <col v-if="cameraColumns.resource" class="col-resource" />
                <col v-if="cameraColumns.target" class="col-target" />
                <col v-if="cameraColumns.rtsp" class="col-rtsp" />
                <col v-if="cameraColumns.onvif" class="col-onvif" />
                <col class="col-actions" />
              </colgroup>
	              <thead>
	                <tr>
	                  <th class="select-cell">
	                    <input type="checkbox" :checked="allVisibleSelected" @change="toggleAllCameras($event.target.checked)" />
	                  </th>
	                  <th>名称</th>
                  <th v-if="cameraColumns.ip">IP</th>
                  <th v-if="cameraColumns.webUrl">网页 URL</th>
                  <th v-if="cameraColumns.status">状态</th>
                  <th v-if="cameraColumns.resource">资源</th>
                  <th v-if="cameraColumns.target">投放屏幕</th>
                  <th v-if="cameraColumns.rtsp">RTSP</th>
                  <th v-if="cameraColumns.onvif">ONVIF</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="loading">
	                  <td :colspan="cameraTableColspan" class="empty">加载中</td>
	                </tr>
		                <tr v-else-if="cameras.length === 0">
		                  <td :colspan="cameraTableColspan" class="empty">暂无摄像头</td>
		                </tr>
		                <tr v-else-if="filteredCameras.length === 0">
		                  <td :colspan="cameraTableColspan" class="empty">没有匹配的摄像头</td>
		                </tr>
		                <template v-for="camera in filteredCameras" :key="camera.id">
		                <tr>
	                  <td class="select-cell">
	                    <input type="checkbox" :checked="selectedCameraIds.has(camera.id)" @change="toggleCameraSelection(camera.id, $event.target.checked)" />
	                  </td>
	                  <td>
                    <strong>{{ camera.name }}</strong>
                    <small>{{ camera.stream_name }} · {{ camera.width }}x{{ camera.height }}@{{ camera.fps }}</small>
                  </td>
                  <td v-if="cameraColumns.ip">
                    <strong>{{ sourceAddress(camera) }}</strong>
                    <small>{{ sourceTypeLabel(camera) }}</small>
                  </td>
                  <td v-if="cameraColumns.webUrl" class="url-cell">
                    <a :href="camera.web_url" target="_blank" rel="noreferrer">{{ camera.web_url }}</a>
                  </td>
                  <td v-if="cameraColumns.status">
                    <span class="status" :class="camera.status">{{ statusLabel(camera.status) }}</span>
                  </td>
                  <td v-if="cameraColumns.resource" class="resource-cell">
                    <strong>{{ resourceStatusText(camera) }}</strong>
                    <small>{{ resourceNetworkText(resourceForCamera(camera)) }}</small>
                    <small>{{ resourceDiskText(resourceForCamera(camera)) }}</small>
                  </td>
                  <td v-if="cameraColumns.target" class="target-cell">{{ targetSummary(camera) }}</td>
                  <td v-if="cameraColumns.rtsp" class="url-cell">{{ camera.rtsp_url }}</td>
                  <td v-if="cameraColumns.onvif" class="url-cell">{{ camera.onvif_url }}</td>
                  <td>
                    <div class="actions row-actions" @click.stop>
                      <div class="quick-actions" aria-label="常用操作">
                        <button type="button" title="启动" :disabled="!canStartCamera(camera)" @click="runAction(startCamera, camera, '已启动')">
                          <Play :size="15" />
                        </button>
                        <button type="button" title="停止" :disabled="!canStopCamera(camera)" @click="runAction(stopCamera, camera, '已停止')">
                          <Square :size="15" />
                        </button>
                        <button type="button" title="重启" :disabled="!canRestartCamera(camera)" @click="runAction(restartCamera, camera, '已重启')">
                          <RotateCcw :size="15" />
                        </button>
                      </div>
                      <div class="more-menu-wrap">
                        <button class="action-menu-button" type="button" title="配置与更多操作" :aria-expanded="openActionMenuId === camera.id" @click="toggleActionMenu(camera.id)">
                          <Settings :size="15" />
                          <span>配置</span>
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
                <tr v-if="openActionMenuId === camera.id" class="action-detail-row">
                  <td :colspan="cameraTableColspan">
                    <div class="row-action-sheet" @click.stop>
                      <div>
                        <strong>{{ camera.name }}</strong>
                        <small>{{ camera.ip }} · {{ camera.stream_name }}</small>
                      </div>
                      <div class="row-action-sheet-buttons">
                        <div class="action-group">
                          <span>维护</span>
                          <button type="button" @click="openLogs(camera); closeActionMenu()">
                            <FileText :size="15" />
                            <span>查看日志</span>
                          </button>
                          <button type="button" :disabled="isCameraBusy(camera.id)" @click="openEditCamera(camera); closeActionMenu()">
                            <Settings :size="15" />
                            <span>编辑配置</span>
                          </button>
                        </div>
                        <div class="action-group">
                          <span>复制</span>
                          <button type="button" @click="cloneCamera(camera); closeActionMenu()">
                            <Plus :size="15" />
                            <span>复制为新摄像头</span>
                          </button>
                          <button type="button" @click="copy(camera.rtsp_url); closeActionMenu()">
                            <Copy :size="15" />
                            <span>复制 RTSP</span>
                          </button>
                          <button type="button" @click="copy(mpvCommand(camera)); closeActionMenu()">
                            <Copy :size="15" />
                            <span>复制 mpv 命令</span>
                          </button>
                          <button v-if="camera.onvif_url" type="button" @click="copy(camera.onvif_url); closeActionMenu()">
                            <Copy :size="15" />
                            <span>复制 ONVIF</span>
                          </button>
                        </div>
                        <div class="action-group">
                          <span>访问</span>
                          <a v-if="camera.go2rtc_url" :href="camera.go2rtc_url" target="_blank" rel="noreferrer" @click="closeActionMenu">
                            <ExternalLink :size="15" />
                            <span>打开 go2rtc</span>
                          </a>
                          <button type="button" class="danger" :disabled="isCameraBusy(camera.id)" @click="remove(camera); closeActionMenu()">
                            <Trash2 :size="15" />
                            <span>删除摄像头</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
                </template>
              </tbody>
            </table>
          </div>
        </section>
      </section>

      <section v-else-if="projectSection === 'matrix'" class="binding-page">
        <aside class="panel binding-sidebar">
          <div class="sidebar-section">
            <div class="panel-heading">
              <h2>未绑定摄像头源</h2>
              <span class="count">{{ unassignedCameras.length }}</span>
            </div>

            <article
              v-for="camera in unassignedCameras"
              :key="camera.id"
              class="camera-card"
              draggable="true"
              @dragstart="beginDrag(camera, $event)"
              @dragend="endDrag"
            >
              <GripVertical :size="16" />
              <div>
                <strong>{{ camera.name }}</strong>
                <span>{{ sourceAddress(camera) }} · {{ camera.stream_name }}</span>
              </div>
              <i :class="camera.status">{{ statusLabel(camera.status) }}</i>
            </article>

            <div v-if="!loading && unassignedCameras.length === 0" class="empty small">没有未绑定摄像头源</div>
          </div>

          <div class="sidebar-section selection-summary">
            <div class="panel-heading">
              <h2>当前围栏</h2>
              <button class="text-button compact-button" type="button" :disabled="!draftRegion" @click="clearDraftRegion">
                <X :size="14" />
                <span>清除</span>
              </button>
            </div>
            <strong>{{ regionSummary(draftRegion) }}</strong>
            <div v-if="draftRegion" class="region-screen-tags">
              <span v-for="label in regionTargetLabels(draftRegion)" :key="label">{{ label }}</span>
            </div>
          </div>

          <div class="sidebar-section assigned-list">
            <div class="panel-heading">
              <h2>已绑定区域</h2>
              <span class="count">{{ assignedCameraRegions.length }}</span>
            </div>
            <article v-for="item in assignedCameraRegions" :key="item.camera.id" class="assigned-row">
              <div>
                <strong>{{ item.camera.name }}</strong>
                <span>{{ regionSummary(item.region) }}</span>
                <small>{{ sourceAddress(item.camera) }} · {{ item.camera.stream_name }} · {{ item.region.targets.length }}块屏</small>
              </div>
              <button type="button" title="移除绑定" @click="clearCameraAssignment(item.camera)">
                <X :size="14" />
              </button>
            </article>
            <div v-if="!loading && assignedCameraRegions.length === 0" class="empty small">暂无绑定区域</div>
          </div>
        </aside>

        <section class="panel matrix-panel">
          <div class="panel-heading">
            <div>
              <h2>矩阵围栏</h2>
              <p>{{ projectDraft.rows }} 行 x {{ projectDraft.cols }} 列，共 {{ projectDraft.rows * projectDraft.cols }} 块屏</p>
            </div>
            <div class="matrix-density-control" role="group" aria-label="矩阵密度">
              <button type="button" :class="{ active: matrixDensity === 'compact' }" @click="matrixDensity = 'compact'">紧凑</button>
              <button type="button" :class="{ active: matrixDensity === 'standard' }" @click="matrixDensity = 'standard'">标准</button>
              <button type="button" :class="{ active: matrixDensity === 'detail' }" @click="matrixDensity = 'detail'">详情</button>
            </div>
          </div>

          <div
            class="matrix-board"
            :class="`density-${matrixDensity}`"
            :style="{ gridTemplateColumns: `repeat(${projectDraft.cols}, ${matrixColumnSize})`, gridAutoRows: matrixRowSize }"
            @pointerup="endRegionSelection"
            @pointercancel="endRegionSelection"
            @pointerleave="endRegionSelection"
          >
            <section
              v-for="cell in screenCells"
              :key="cell.index"
              class="matrix-cell"
              :class="screenCellClass(cell.index)"
              :style="{ gridColumn: cell.col, gridRow: cell.row }"
              @pointerdown="beginRegionSelection(cell, $event)"
              @pointerenter="updateRegionSelection(cell)"
              @pointerup="endRegionSelection"
              @dragenter.prevent="hoverScreen = cell.index"
              @dragover.prevent
              @dragleave="hoverScreen = null"
              @drop="dropCameraOnScreen(cell.index, $event)"
            >
              <header>
                <strong>{{ displayTargetLabel(cell.index) }}</strong>
                <span>{{ displayTargetMeta(cell.index) }}</span>
              </header>

              <div class="screen-empty">{{ screenAssignments(cell.index).length === 0 ? '单屏区域' : '围栏内' }}</div>
            </section>

            <article
              v-if="draftRegion"
              class="selection-fence"
              :style="regionStyle(draftRegion)"
            >
              <div class="fence-content">
                <div class="fence-title">
                  <strong>框选区域</strong>
                  <span>{{ regionSummary(draftRegion) }}</span>
                </div>
                <div class="region-screen-tags">
                  <span v-for="label in regionTargetLabels(draftRegion)" :key="label">{{ label }}</span>
                </div>
              </div>
            </article>

            <article
              v-for="item in assignedCameraRegions"
              :key="item.camera.id"
              class="assignment-card region-card"
              :class="[item.camera.status, regionCardClass(item.region)]"
              :style="regionStyle(item.region)"
              @pointerdown.stop
              @dragenter.prevent="hoverScreen = indexFromRowCol(item.region.row, item.region.col)"
              @dragover.prevent
              @dragleave="hoverScreen = null"
              @drop="dropCameraOnScreen(indexFromRowCol(item.region.row, item.region.col), $event, item.region)"
            >
              <div class="region-badge">
                <strong>{{ item.camera.name }}</strong>
                <span>{{ item.region.targets.length }}块屏 · {{ item.camera.stream_name }}</span>
              </div>

              <div class="region-corner-actions">
                <span class="mini-status" :class="item.camera.status">{{ statusLabel(item.camera.status) }}</span>
                <div class="assignment-card-actions">
                  <button type="button" title="复制 RTSP" @click="copy(item.camera.rtsp_url)">
                    <Copy :size="13" />
                  </button>
                  <button type="button" title="复制 mpv 测试命令" @click="copy(mpvCommand(item.camera))">
                    <Play :size="13" />
                  </button>
                  <button v-if="item.camera.go2rtc_url" type="button" title="打开 go2rtc" @click="openUrl(item.camera.go2rtc_url)">
                    <ExternalLink :size="13" />
                  </button>
                  <button type="button" title="移除绑定" @click="clearCameraAssignment(item.camera)">
                    <X :size="13" />
                  </button>
                </div>
              </div>
            </article>
          </div>
        </section>
      </section>

      <section v-else-if="projectSection === 'settings'" class="settings-page">
        <section class="panel settings-panel">
          <div class="panel-heading">
            <div>
              <h2>项目设置</h2>
              <p>修改项目名称、屏幕矩阵规格和屏幕编号前缀</p>
            </div>
            <div class="panel-heading-actions">
              <button class="text-button" type="button" @click="downloadProjectConfig()">
                <FileText :size="16" />
                <span>导出配置</span>
              </button>
              <button class="primary-button" type="button" :disabled="projectSaving" @click="saveProject">
                <Save :size="16" />
                <span>{{ projectSaving ? '保存中' : '保存设置' }}</span>
              </button>
            </div>
          </div>

          <div class="project-main settings-form">
            <label>
              <span>项目名称</span>
              <input v-model.trim="projectDraft.name" />
            </label>
            <label>
              <span>行</span>
              <input v-model.number="projectDraft.rows" type="number" min="1" max="20" />
            </label>
            <label>
              <span>列</span>
              <input v-model.number="projectDraft.cols" type="number" min="1" max="30" />
            </label>
            <label>
              <span>前缀</span>
              <input v-model.trim="projectDraft.prefix" maxlength="8" />
            </label>
          </div>
        </section>
      </section>

      <section v-else class="audit-page">
        <section class="panel audit-panel">
          <div class="panel-heading">
            <div>
              <h2>操作审计</h2>
              <p>记录项目、摄像头和矩阵绑定的关键变更</p>
            </div>
            <button class="text-button" type="button" :disabled="auditLoading" @click="refreshAuditLogs">
              <RefreshCw :size="15" />
              <span>{{ auditLoading ? '刷新中' : '刷新' }}</span>
            </button>
          </div>

          <div class="audit-list">
            <div v-if="auditLoading" class="empty small">加载中</div>
            <div v-else-if="auditLogs.length === 0" class="empty small">暂无审计记录</div>
            <article v-for="log in auditLogs" v-else :key="log.id" class="audit-row">
              <div class="audit-marker"></div>
              <div class="audit-content">
                <div class="audit-row-head">
                  <strong>{{ auditActionLabel(log.action) }}</strong>
                  <time>{{ log.created_at }}</time>
                </div>
                <p>{{ log.target_name || log.target_type }}</p>
                <span>{{ auditDetailSummary(log) }}</span>
              </div>
            </article>
          </div>
        </section>
      </section>
	    </section>

	    <div v-if="showCreateModal" class="modal-backdrop" role="dialog" aria-modal="true" @click.self="showCreateModal = false">
	      <form class="modal-card" @submit.prevent="submit">
	        <div class="modal-head">
	          <div>
	            <h2>新增视频源</h2>
	            <p>ONVIF 摄像头使用独立 IP；RTSP 流源使用共享网关和不同流路径。</p>
	          </div>
	          <button class="icon-button" type="button" title="关闭" @click="showCreateModal = false">
	            <X :size="16" />
	          </button>
	        </div>
	        <div class="camera-form-grid modal-form-grid">
	          <label class="wide-field source-type-field">
	            <span>源类型</span>
	            <select v-model="form.source_type">
	              <option value="camera">ONVIF 摄像头（独立 IP）</option>
	              <option value="rtsp">RTSP 流源（共享 IP + 流路径）</option>
	            </select>
	          </label>
	          <label>
	            <span>名称</span>
	            <input v-model.trim="form.name" required placeholder="web-cam-01" />
	          </label>
	          <label v-if="form.source_type === 'camera'">
	            <span>虚拟 IP</span>
	            <input v-model.trim="form.ip" required inputmode="numeric" placeholder="192.168.110.211" />
	          </label>
	          <label class="wide-field">
	            <span>网页 URL</span>
	            <input v-model.trim="form.web_url" required type="url" placeholder="https://www.baidu.com" />
	          </label>
	          <label>
	            <span>流名称</span>
	            <input v-model.trim="form.stream_name" required placeholder="screen01" />
	          </label>
	          <label>
	            <span>宽度</span>
	            <input v-model.number="form.width" required type="number" min="320" max="7680" step="1" />
	          </label>
	          <label>
	            <span>高度</span>
	            <input v-model.number="form.height" required type="number" min="240" max="4320" step="1" />
	          </label>
	          <label>
	            <span>FPS</span>
	            <input v-model.number="form.fps" required type="number" min="1" max="60" step="1" />
	          </label>
	        </div>
	        <div class="modal-actions">
	          <button class="text-button" type="button" @click="showCreateModal = false">取消</button>
	          <button class="primary-button" type="submit" :disabled="!canCreateCamera">
	            <Plus :size="16" />
	            <span>{{ saving ? '创建中' : '创建视频源' }}</span>
	          </button>
	        </div>
	      </form>
	    </div>

	    <div v-if="showBulkModal" class="modal-backdrop" role="dialog" aria-modal="true" @click.self="showBulkModal = false">
	      <section class="modal-card">
	        <div class="modal-head">
	          <div>
	            <h2>批量生成摄像头配置</h2>
	            <p>只写入配置，不启动 Docker 容器，适合先录入几十路摄像头。</p>
	          </div>
	          <button class="icon-button" type="button" title="关闭" @click="showBulkModal = false">
	            <X :size="16" />
	          </button>
	        </div>
	        <div class="bulk-form-grid modal-form-grid">
	          <label>
	            <span>数量</span>
	            <input v-model.number="bulkForm.count" type="number" min="1" max="200" />
	          </label>
	          <label>
	            <span>起始 IP</span>
	            <input v-model.trim="bulkForm.start_ip" inputmode="numeric" />
	          </label>
	          <label>
	            <span>名称前缀</span>
	            <input v-model.trim="bulkForm.name_prefix" />
	          </label>
	          <label>
	            <span>流名前缀</span>
	            <input v-model.trim="bulkForm.stream_prefix" />
	          </label>
	          <label class="wide-field">
	            <span>网页 URL</span>
	            <input v-model.trim="bulkForm.web_url" type="url" />
	          </label>
	          <label>
	            <span>宽度</span>
	            <input v-model.number="bulkForm.width" type="number" min="320" max="7680" />
	          </label>
	          <label>
	            <span>高度</span>
	            <input v-model.number="bulkForm.height" type="number" min="240" max="4320" />
	          </label>
	          <label>
	            <span>FPS</span>
	            <input v-model.number="bulkForm.fps" type="number" min="1" max="60" />
	          </label>
	        </div>
	        <div class="modal-actions">
	          <button class="text-button" type="button" @click="showBulkModal = false">取消</button>
	          <button class="primary-button" type="button" :disabled="bulkCreating" @click="submitBulk">
	            <Plus :size="16" />
	            <span>{{ bulkCreating ? '生成中' : '批量生成' }}</span>
	          </button>
	        </div>
	      </section>
	    </div>

	    <div v-if="activeLogs" class="drawer" role="dialog" aria-modal="true">
      <div class="drawer-head">
        <div>
          <h2>{{ activeLogs.name }}</h2>
          <p>{{ sourceAddress(activeLogs) }} · {{ activeLogs.stream_name }}</p>
        </div>
        <div class="drawer-actions">
          <button type="button" @click="openLogs(activeLogs)">刷新</button>
          <button type="button" @click="copy(logText)">复制</button>
          <button type="button" @click="activeLogs = null">关闭</button>
        </div>
      </div>
      <pre>{{ logLoading ? '加载中' : logText }}</pre>
    </div>

    <div v-if="editingCamera" class="drawer edit-drawer" role="dialog" aria-modal="true">
      <div class="drawer-head">
        <div>
          <h2>编辑视频源</h2>
          <p>{{ editingCamera.name }} · {{ sourceAddress(editingCamera) }} · {{ sourceTypeLabel(editingCamera) }}</p>
        </div>
        <div class="drawer-actions">
          <button type="button" @click="editingCamera = null">关闭</button>
        </div>
      </div>

      <form class="drawer-form" @submit.prevent="saveCameraEdit">
        <label>
          <span>源类型</span>
          <select v-model="editForm.source_type">
            <option value="camera">ONVIF 摄像头（独立 IP）</option>
            <option value="rtsp">RTSP 流源（共享 IP + 流路径）</option>
          </select>
        </label>
        <label>
          <span>名称</span>
          <input v-model.trim="editForm.name" required />
        </label>
        <label v-if="editForm.source_type === 'camera'">
          <span>虚拟 IP</span>
          <input v-model.trim="editForm.ip" required inputmode="numeric" />
        </label>
        <label>
          <span>网页 URL</span>
          <input v-model.trim="editForm.web_url" required type="url" />
        </label>
        <label>
          <span>流名称</span>
          <input v-model.trim="editForm.stream_name" required />
        </label>
        <div class="drawer-form-grid">
          <label>
            <span>宽度</span>
            <input v-model.number="editForm.width" required type="number" min="320" max="7680" />
          </label>
          <label>
            <span>高度</span>
            <input v-model.number="editForm.height" required type="number" min="240" max="4320" />
          </label>
          <label>
            <span>FPS</span>
            <input v-model.number="editForm.fps" required type="number" min="1" max="60" />
          </label>
        </div>
        <button class="primary-button" type="submit" :disabled="isCameraBusy(editingCamera.id)">
          <Save :size="16" />
          <span>{{ isCameraBusy(editingCamera.id) ? '保存中' : '保存配置' }}</span>
        </button>
      </form>
    </div>

    <div v-if="toast" class="toast">{{ toast }}</div>
  </main>
</template>
