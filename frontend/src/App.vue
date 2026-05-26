<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import {
  Copy,
  ExternalLink,
  FileText,
  GripVertical,
  House,
  LogOut,
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
  UserPlus,
  X,
} from 'lucide-vue-next';
import {
  bulkCreateCameras,
  changePassword,
  createCamera,
  createProject,
  createScreenUrl,
  createUser,
  deleteCamera,
  deleteScreenUrl,
  exportProjectConfig,
  getCurrentUser,
  getHealth,
  getLogs,
  getResourceStats,
  importProjectConfig,
  listAuditLogs,
  listCameraStatuses,
  listCameras,
  listProjects,
  listScreenUrls,
  listUserProjects,
  listUsers,
  login,
  restartCamera,
  startCamera,
  stopCamera,
  storeAuthToken,
  updateCamera,
  updateCameraTargets,
  updateProject,
  updateScreenUrl,
  updateUserProjects,
} from './api';
import {
  mpvCommand as buildMpvCommand,
  sourceAddress as buildSourceAddress,
  sourceTypeLabel as buildSourceTypeLabel,
  statusLabel as buildStatusLabel,
} from './utils/cameras';
import {
  createDisplayRegion as buildDisplayRegion,
  createRegionFromCells as buildRegionFromCells,
  displayTargetLabel as buildDisplayTargetLabel,
  displayTargetMeta as buildDisplayTargetMeta,
  indexFromRowCol as buildIndexFromRowCol,
  normalizeCameraRegion as buildNormalizedCameraRegion,
  regionSummary as buildRegionSummary,
  regionTargetLabels as buildRegionTargetLabels,
  rowColFromIndex as buildRowColFromIndex,
  targetSummary as buildTargetSummary,
} from './utils/display';
import {
  calculateResourceRates,
  formatByteRate,
  formatBytes,
  formatPercent,
  resourceDiskText as buildResourceDiskText,
  resourceNetworkText as buildResourceNetworkText,
  resourceStatusText as buildResourceStatusText,
} from './utils/resources';
import { matchScreenUrls as matchScreenUrlsFromList } from './utils/screen-urls';

const projects = ref([]);
const selectedProjectId = ref(null);
const currentView = ref('projects');
const projectSection = ref('cameras');
const authChecking = ref(true);
const currentUser = ref(null);
const loginLoading = ref(false);
const loginError = ref('');
const cameras = ref([]);
const loading = ref(false);
const saving = ref(false);
const createError = ref('');
const bulkCreating = ref(false);
const bulkError = ref('');
const statusRefreshing = ref(false);
let statusPollTimer = null;
let resourcePollTimer = null;
let stickyHeaderObserver = null;
let projectHeaderObserver = null;
let matrixBoardObserver = null;
const error = ref('');
const toast = ref('');
const toastKind = ref('info');
const activeLogs = ref(null);
const editingCamera = ref(null);
const cameraEditorMode = ref('full');
const logText = ref('');
const logLoading = ref(false);
const auditLogs = ref([]);
const auditLoading = ref(false);
const auditLimit = ref(80);
const auditLimitOptions = [50, 80, 150, 300];
const screenUrls = ref([]);
const screenUrlsLoading = ref(false);
const screenUrlSaving = ref(false);
const screenUrlImporting = ref(false);
const editingScreenUrlId = ref(null);
const screenUrlEditorOpen = ref(false);
const screenUrlQuery = ref('');
const screenUrlImportInput = ref(null);
const urlPickerLimit = 20;
const urlPickerState = reactive({
  create: {
    open: false,
    query: '',
  },
  bulk: {
    open: false,
    query: '',
  },
  edit: {
    open: false,
    query: '',
  },
});
const systemStatus = ref(null);
const systemLoading = ref(true);
const resourceStats = ref(null);
const previousResourceStats = ref(null);
const resourceRates = ref(null);
const resourceRefreshing = ref(false);
const resourceMonitorExpanded = ref(false);
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
const matrixAssignCameraId = ref('');
const matrixDensity = ref('standard');
const importInput = ref(null);
const importingProject = ref(false);
const showCreateModal = ref(false);
const showBulkModal = ref(false);
const showPasswordModal = ref(false);
const passwordSaving = ref(false);
const openActionMenuId = ref(null);
const themeOptions = [
  { value: 'eye', label: '护眼' },
  { value: 'light', label: '浅色' },
  { value: 'cyber', label: '深色' },
  { value: 'ocean', label: '海蓝' },
];
const themeValues = new Set(themeOptions.map((item) => item.value));
const projectSections = new Set(['cameras', 'matrix', 'screenUrls', 'settings', 'audit']);
const navigationStateKey = 'virtualwebcam-navigation-state';
function normalizeTheme(theme) {
  return themeValues.has(theme) ? theme : 'eye';
}
const uiTheme = ref(normalizeTheme(window.localStorage.getItem('virtualwebcam-theme')));
const themeClass = computed(() => (uiTheme.value === 'light' ? '' : `theme-${uiTheme.value}`));
const stickyHeaderRef = ref(null);
const projectHeaderRef = ref(null);
const matrixBoardRef = ref(null);
const matrixSourceListMaxHeight = ref(null);
const users = ref([]);
const selectedUserId = ref(null);
const userProjectRoles = ref({});
const membersLoading = ref(false);
const membersSaving = ref(false);
const userCreating = ref(false);
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

const loginForm = reactive({
  username: 'admin',
  password: '',
});

const newUserForm = reactive({
  username: '',
  display_name: '',
  password: '',
  role: 'user',
});

const passwordForm = reactive({
  old_password: '',
  new_password: '',
  confirm_password: '',
});

const screenUrlForm = reactive({
  name: '',
  url: '',
  remark: '',
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
  source_type: 'camera',
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
const selectedManagedUser = computed(() => users.value.find((user) => user.id === selectedUserId.value));
const isAuthenticated = computed(() => Boolean(currentUser.value));
const isSystemAdmin = computed(() => currentUser.value?.role === 'admin');
const selectedProjectPermission = computed(() => selectedProject.value?.permission_role || (isSystemAdmin.value ? 'admin' : ''));
const canManageSelectedProject = computed(() => (
  isSystemAdmin.value || selectedProjectPermission.value === 'operator' || selectedProjectPermission.value === 'admin'
));
const canCreateProjects = computed(() => isSystemAdmin.value);

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

const canCreateCamera = computed(() => !saving.value && Boolean(selectedProjectId.value) && canManageSelectedProject.value);
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
  total: filteredCameras.value.length,
  running: cameras.value.filter((camera) => camera.status === 'running').length,
  stopped: cameras.value.filter((camera) => camera.status === 'stopped').length,
  error: cameras.value.filter((camera) => camera.status === 'error').length,
  bound: cameras.value.filter((camera) => (camera.display_targets || []).length > 0).length,
  unbound: cameras.value.filter((camera) => (camera.display_targets || []).length === 0).length,
}));

const filteredScreenUrls = computed(() => {
  const keyword = screenUrlQuery.value.trim().toLowerCase();

  if (!keyword) {
    return screenUrls.value;
  }

  return screenUrls.value.filter((item) => [
    item.name,
    item.url,
    item.remark,
  ].some((value) => String(value || '').toLowerCase().includes(keyword)));
});

function matchScreenUrls(keyword) {
  return matchScreenUrlsFromList(screenUrls.value, keyword);
}

function urlPickerMatches(key) {
  return matchScreenUrls(urlPickerState[key]?.query || '').slice(0, urlPickerLimit);
}

function urlPickerMatchCount(key) {
  return matchScreenUrls(urlPickerState[key]?.query || '').length;
}

function openUrlPicker(key) {
  Object.keys(urlPickerState).forEach((itemKey) => {
    urlPickerState[itemKey].open = itemKey === key;
  });
}

function toggleUrlPicker(key) {
  if (urlPickerState[key].open) {
    urlPickerState[key].open = false;
    return;
  }

  openUrlPicker(key);
}

function closeUrlPicker(key) {
  urlPickerState[key].open = false;
}

function resetUrlPicker(key) {
  urlPickerState[key].open = false;
  urlPickerState[key].query = '';
}

function resetAllUrlPickers() {
  Object.keys(urlPickerState).forEach(resetUrlPicker);
}

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
const resourceCompactSummary = computed(() => [
  `CPU ${formatPercent(resourceSummary.value.cpuPercent)}`,
  `内存 ${formatPercent(resourceSummary.value.memoryPercent)}`,
  `网络 ↓${formatByteRate(resourceRates.value?.summary?.network_rx_bps || 0)}`,
  `磁盘写 ${formatByteRate(resourceRates.value?.summary?.block_write_bps || 0)}`,
].join(' · '));

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
const selectedMatrixAssignCamera = computed(() => (
  cameras.value.find((camera) => String(camera.id) === String(matrixAssignCameraId.value)) || null
));

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
const matrixSourceListStyle = computed(() => (
  matrixSourceListMaxHeight.value
    ? { maxHeight: `${matrixSourceListMaxHeight.value}px` }
    : {}
));

function showToast(message, options = {}) {
  const duration = options.duration || 1800;
  toast.value = message;
  toastKind.value = options.kind || 'info';
  window.setTimeout(() => {
    if (toast.value === message) {
      toast.value = '';
    }
  }, duration);
}

function showOperationError(message) {
  error.value = message;
  showToast(message, {
    kind: 'error',
    duration: 6000,
  });
}

function operationFailureMessage(doneMessage, err) {
  const actionName = String(doneMessage || '操作').replace(/^已/, '') || '操作';
  return `${actionName}失败：${err.message || '未知错误'}`;
}

function userRoleLabel(role) {
  return role === 'admin' ? '系统管理员' : '普通用户';
}

function projectRoleLabel(role) {
  if (role === 'admin') return '系统管理员';
  if (role === 'operator') return '可操作';
  if (role === 'viewer') return '仅查看';
  return '未授权';
}

function canManageProject(project) {
  return isSystemAdmin.value || project?.permission_role === 'operator' || project?.permission_role === 'admin';
}

function normalizeProjectSection(section, project = selectedProject.value) {
  if (!projectSections.has(section)) return 'cameras';
  if (section === 'settings' && !canManageProject(project)) return 'cameras';
  return section;
}

function readNavigationState() {
  try {
    const value = JSON.parse(window.localStorage.getItem(navigationStateKey) || '{}');
    return {
      view: value.view === 'users' || value.view === 'project' ? value.view : 'projects',
      projectId: Number.isFinite(Number(value.projectId)) ? Number(value.projectId) : null,
      section: projectSections.has(value.section) ? value.section : 'cameras',
    };
  } catch {
    return {
      view: 'projects',
      projectId: null,
      section: 'cameras',
    };
  }
}

function writeNavigationState() {
  if (!isAuthenticated.value) return;

  window.localStorage.setItem(navigationStateKey, JSON.stringify({
    view: currentView.value,
    projectId: selectedProjectId.value,
    section: projectSection.value,
  }));
}

function clearNavigationState() {
  window.localStorage.removeItem(navigationStateKey);
}

function resetSessionState({ clearNavigation = true } = {}) {
  projects.value = [];
  selectedProjectId.value = null;
  currentView.value = 'projects';
  projectSection.value = 'cameras';
  cameras.value = [];
  auditLogs.value = [];
  users.value = [];
  selectedUserId.value = null;
  userProjectRoles.value = {};
  activeLogs.value = null;
  editingCamera.value = null;
  error.value = '';
  if (clearNavigation) {
    clearNavigationState();
  }
}

function handleUnauthorized(event) {
  stopBackgroundPolling();
  storeAuthToken('');
  currentUser.value = null;
  authChecking.value = false;
  resetSessionState();
  loginError.value = event.detail?.message || '登录已过期，请重新登录';
  showToast(loginError.value, {
    kind: 'error',
    duration: 6000,
  });
}

function startBackgroundPolling() {
  if (!statusPollTimer) {
    statusPollTimer = window.setInterval(() => {
      if (isAuthenticated.value && currentView.value === 'project' && projectSection.value === 'cameras') {
        refreshCameraStatuses({ silent: true });
      }
    }, 10000);
  }

  if (!resourcePollTimer) {
    resourcePollTimer = window.setInterval(() => {
      if (isAuthenticated.value && currentView.value === 'project' && projectSection.value === 'cameras') {
        refreshResourceStats({ silent: true });
      }
    }, 15000);
  }
}

function stopBackgroundPolling() {
  if (statusPollTimer) {
    window.clearInterval(statusPollTimer);
    statusPollTimer = null;
  }
  if (resourcePollTimer) {
    window.clearInterval(resourcePollTimer);
    resourcePollTimer = null;
  }
}

async function bootstrapAfterAuth() {
  const navigationState = readNavigationState();
  await refreshProjects();
  const restoredProject = navigationState.projectId
    ? projects.value.find((project) => project.id === navigationState.projectId)
    : null;

  if (navigationState.view === 'project' && restoredProject) {
    await enterProject(restoredProject, normalizeProjectSection(navigationState.section, restoredProject));
  } else if (navigationState.view === 'users' && isSystemAdmin.value) {
    await openUserManagement();
  }

  await refreshSystemStatus();
  startBackgroundPolling();
}

async function loadCurrentSession() {
  authChecking.value = true;
  loginError.value = '';

  try {
    const session = await getCurrentUser();
    currentUser.value = session.user;
    await bootstrapAfterAuth();
  } catch {
    storeAuthToken('');
    currentUser.value = null;
  } finally {
    authChecking.value = false;
  }
}

async function submitLogin() {
  if (loginLoading.value) return;

  loginLoading.value = true;
  loginError.value = '';

  try {
    const session = await login({ ...loginForm });
    storeAuthToken(session.token);
    currentUser.value = session.user;
    loginForm.password = '';
    resetSessionState();
    await bootstrapAfterAuth();
  } catch (err) {
    loginError.value = err.message;
  } finally {
    loginLoading.value = false;
  }
}

function logout() {
  storeAuthToken('');
  stopBackgroundPolling();
  currentUser.value = null;
  resetSessionState();
}

function openPasswordModal() {
  passwordForm.old_password = '';
  passwordForm.new_password = '';
  passwordForm.confirm_password = '';
  showPasswordModal.value = true;
}

async function submitPasswordChange() {
  if (passwordSaving.value) return;

  if (passwordForm.new_password !== passwordForm.confirm_password) {
    error.value = '两次输入的新密码不一致';
    return;
  }

  passwordSaving.value = true;
  error.value = '';

  try {
    await changePassword({
      old_password: passwordForm.old_password,
      new_password: passwordForm.new_password,
    });
    showPasswordModal.value = false;
    showToast('密码已修改，请重新登录');
    logout();
  } catch (err) {
    error.value = err.message;
  } finally {
    passwordSaving.value = false;
  }
}

function cycleTheme() {
  const index = themeOptions.findIndex((item) => item.value === uiTheme.value);
  uiTheme.value = themeOptions[(index + 1) % themeOptions.length].value;
}

function themeLabel(theme = uiTheme.value) {
  return themeOptions.find((item) => item.value === theme)?.label || '护眼';
}

function themeSwitchTitle() {
  const index = themeOptions.findIndex((item) => item.value === uiTheme.value);
  const next = themeOptions[(index + 1) % themeOptions.length] || themeOptions[0];
  return `当前：${themeLabel()}，切换为${next.label}主题`;
}

function updateAuditLimit(value) {
  auditLimit.value = Number.parseInt(value, 10) || 80;
  refreshAuditLogs();
}

watch(uiTheme, (theme) => {
  const normalized = normalizeTheme(theme);
  if (normalized !== theme) {
    uiTheme.value = normalized;
    return;
  }
  window.localStorage.setItem('virtualwebcam-theme', normalized);
  for (const option of themeOptions) {
    document.body.classList.toggle(`virtualwebcam-${option.value}-body`, normalized === option.value && normalized !== 'light');
  }
  nextTick(() => {
    updateFixedHeaderHeights();
    window.requestAnimationFrame?.(updateFixedHeaderHeights);
  });
}, { immediate: true });

function normalizedStickyHeaderHeight(height) {
  if (!height) return 0;
  return Math.ceil(height);
}

function updateStickyHeaderHeight() {
  const height = stickyHeaderRef.value?.offsetHeight || 0;
  document.documentElement.style.setProperty('--sticky-status-header-height', `${normalizedStickyHeaderHeight(height)}px`);
}

function updateProjectHeaderHeight() {
  const height = projectHeaderRef.value?.offsetHeight || 0;
  document.documentElement.style.setProperty('--project-header-panel-height', `${height}px`);
}

function updateFixedHeaderHeights() {
  updateStickyHeaderHeight();
  updateProjectHeaderHeight();
}

function updateMatrixSourceListHeight() {
  const height = matrixBoardRef.value?.offsetHeight || 0;
  matrixSourceListMaxHeight.value = height > 0 ? Math.round(height) : null;
}

function observeProjectHeader() {
  if (projectHeaderObserver && projectHeaderRef.value) {
    projectHeaderObserver.observe(projectHeaderRef.value);
  }
}

function observeMatrixBoard() {
  if (matrixBoardObserver && matrixBoardRef.value) {
    matrixBoardObserver.observe(matrixBoardRef.value);
  }
}

watch([isAuthenticated, currentView, systemLoading, systemProblems, selectedProjectId, projectSection], async () => {
  await nextTick();
  observeProjectHeader();
  observeMatrixBoard();
  updateFixedHeaderHeights();
  updateMatrixSourceListHeight();
});

watch([matrixDensity, () => projectDraft.rows, () => projectDraft.cols], async () => {
  if (projectSection.value !== 'matrix') return;
  await nextTick();
  updateMatrixSourceListHeight();
});

watch([draftRegion, cameras], () => {
  if (!draftRegion.value) {
    matrixAssignCameraId.value = '';
    return;
  }

  if (cameras.value.some((camera) => String(camera.id) === String(matrixAssignCameraId.value))) {
    return;
  }

  const preferredCamera = unassignedCameras.value[0] || cameras.value[0] || null;
  matrixAssignCameraId.value = preferredCamera ? String(preferredCamera.id) : '';
});

watch([currentView, selectedProjectId, projectSection], () => {
  writeNavigationState();
});

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

function nextStreamName(prefix = 'screen') {
  const used = new Set(cameras.value.map((camera) => camera.stream_name).filter(Boolean));

  for (let index = 1; index < 10000; index += 1) {
    const candidate = `${prefix}${String(index).padStart(2, '0')}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return `${prefix}${Date.now().toString(36)}`;
}

function resetForm() {
  form.source_type = 'camera';
  form.name = '';
  form.ip = '';
  form.stream_name = nextStreamName();
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

async function openCreateSourceModal() {
  error.value = '';
  createError.value = '';
  await refreshScreenUrls();
  resetUrlPicker('create');
  showCreateModal.value = true;
}

async function openBulkCreateModal() {
  error.value = '';
  bulkError.value = '';
  await refreshScreenUrls();
  resetUrlPicker('bulk');
  showBulkModal.value = true;
}

async function cloneCamera(camera) {
  form.source_type = camera.source_type || 'camera';
  form.name = uniqueName(camera.name);
  form.ip = camera.source_type === 'rtsp' ? '' : incrementIp(camera.ip);
  form.stream_name = incrementStreamName(camera.stream_name);
  form.web_url = camera.web_url;
  form.width = camera.width;
  form.height = camera.height;
  form.fps = camera.fps;
  form.display_targets = [];
  await refreshScreenUrls();
  resetUrlPicker('create');
  showCreateModal.value = true;
  showToast(form.source_type === 'rtsp' || form.ip ? '已复制到新增弹窗' : '已复制，请补充虚拟 IP');
}

function sourcePayload(payload, { autoStreamName = false } = {}) {
  return {
    ...payload,
    stream_name: payload.stream_name || (autoStreamName ? nextStreamName() : payload.stream_name),
    ip: payload.source_type === 'rtsp' ? null : payload.ip,
  };
}

function toggleActionMenu(id) {
  openActionMenuId.value = openActionMenuId.value === id ? null : id;
}

function isCameraRowActive(camera) {
  return openActionMenuId.value === camera.id
    || editingCamera.value?.id === camera.id
    || activeLogs.value?.id === camera.id;
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

  if (currentView.value === 'users') {
    await refreshUserManagement();
    return;
  }

  if (!selectedProjectId.value) return;

  if (projectSection.value === 'audit') {
    await refreshAuditLogs();
    return;
  }

  if (projectSection.value === 'screenUrls') {
    await refreshScreenUrls();
    return;
  }

  loading.value = true;
  error.value = '';

	  try {
	    cameras.value = await listCameras(selectedProjectId.value);
	    syncSelectedCameras();
      if (projectSection.value === 'cameras') {
        await refreshScreenUrls();
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

async function openUserManagement() {
  currentView.value = 'users';
  activeLogs.value = null;
  editingCamera.value = null;
  clearDraftRegion();
  await refreshUserManagement();
}

async function switchProjectSection(section) {
  projectSection.value = section;
  clearDraftRegion();

  if (section === 'audit') {
    await refreshAuditLogs();
  } else if (section === 'screenUrls') {
    await refreshScreenUrls();
  }
}

async function refreshAuditLogs() {
  if (!selectedProjectId.value) return;

  auditLoading.value = true;
  error.value = '';

  try {
    auditLogs.value = await listAuditLogs(selectedProjectId.value, auditLimit.value);
  } catch (err) {
    error.value = err.message;
  } finally {
    auditLoading.value = false;
  }
}

async function refreshScreenUrls() {
  if (!selectedProjectId.value) return;

  screenUrlsLoading.value = true;
  error.value = '';

  try {
    screenUrls.value = await listScreenUrls(selectedProjectId.value);
  } catch (err) {
    error.value = err.message;
  } finally {
    screenUrlsLoading.value = false;
  }
}

function resetScreenUrlForm() {
  editingScreenUrlId.value = null;
  screenUrlEditorOpen.value = false;
  screenUrlForm.name = '';
  screenUrlForm.url = '';
  screenUrlForm.remark = '';
}

function openScreenUrlCreator() {
  resetScreenUrlForm();
  screenUrlEditorOpen.value = true;
}

function editScreenUrl(item) {
  editingScreenUrlId.value = item.id;
  screenUrlEditorOpen.value = true;
  screenUrlForm.name = item.name;
  screenUrlForm.url = item.url;
  screenUrlForm.remark = item.remark || '';
}

async function saveScreenUrl() {
  if (!selectedProjectId.value || !canManageSelectedProject.value || screenUrlSaving.value) return;

  screenUrlSaving.value = true;
  error.value = '';

  try {
    if (editingScreenUrlId.value) {
      await updateScreenUrl(editingScreenUrlId.value, { ...screenUrlForm });
      showToast('大屏地址已更新');
    } else {
      await createScreenUrl({ ...screenUrlForm }, selectedProjectId.value);
      showToast('大屏地址已添加');
    }
    resetScreenUrlForm();
    await refreshScreenUrls();
  } catch (err) {
    error.value = err.message;
  } finally {
    screenUrlSaving.value = false;
  }
}

async function removeScreenUrl(item) {
  if (!canManageSelectedProject.value || !window.confirm(`删除大屏地址「${item.name}」？`)) return;

  error.value = '';

  try {
    await deleteScreenUrl(item.id);
    if (editingScreenUrlId.value === item.id) {
      resetScreenUrlForm();
    }
    await refreshScreenUrls();
    showToast('大屏地址已删除');
  } catch (err) {
    error.value = err.message;
  }
}

function downloadScreenUrlsCsv() {
  if (!selectedProject.value) return;

  const csv = screenUrlCsvPayload(screenUrls.value);
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  const date = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `screen-urls-${safeFilename(selectedProject.value.name)}-${date}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.URL.revokeObjectURL(url);
  showToast('大屏地址 CSV 已导出');
}

function pickScreenUrlImportFile() {
  if (!canManageSelectedProject.value || screenUrlImporting.value) return;
  screenUrlImportInput.value?.click();
}

function screenUrlsFromCsv(text) {
  const rows = parseCsvRows(text.replace(/^\uFEFF/, ''));
  if (rows.length === 0) return [];

  const first = rows[0].map((cell) => cell.trim().toLowerCase());
  const hasHeader = first.includes('name') && first.includes('url');
  const header = hasHeader ? first : ['name', 'url', 'remark'];
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const nameIndex = header.indexOf('name');
  const urlIndex = header.indexOf('url');
  const remarkIndex = header.indexOf('remark');

  if (nameIndex < 0 || urlIndex < 0) {
    throw new Error('CSV 必须包含 name 和 url 列');
  }

  return dataRows.map((row) => ({
    name: String(row[nameIndex] || '').trim(),
    url: String(row[urlIndex] || '').trim(),
    remark: remarkIndex >= 0 ? String(row[remarkIndex] || '').trim() : '',
  })).filter((item) => item.name || item.url);
}

async function importScreenUrlsFromCsv(event) {
  const file = event.target.files?.[0];
  event.target.value = '';

  if (!file || screenUrlImporting.value || !selectedProjectId.value || !canManageSelectedProject.value) return;

  screenUrlImporting.value = true;
  error.value = '';

  try {
    const items = screenUrlsFromCsv(await file.text());
    if (items.length === 0) {
      throw new Error('CSV 中没有可导入的大屏地址');
    }

    let success = 0;
    let failed = 0;
    for (const item of items) {
      if (!item.name || !item.url) {
        failed += 1;
        continue;
      }
      try {
        await createScreenUrl(item, selectedProjectId.value);
        success += 1;
      } catch {
        failed += 1;
      }
    }

    await refreshScreenUrls();
    showToast(failed ? `已导入 ${success} 个，${failed} 个失败` : `已导入 ${success} 个大屏地址`);
  } catch (err) {
    error.value = err.message;
  } finally {
    screenUrlImporting.value = false;
  }
}

function applyScreenUrl(target, item) {
  target.web_url = item.url;
  showToast(`已选择：${item.name}`);
}

function applyScreenUrlFromPicker(key, target, item) {
  applyScreenUrl(target, item);
  if (key === 'create' || key === 'edit') {
    target.name = item.name;
  }
  closeUrlPicker(key);
}

function openScreenUrlManagerFromModal(modalKey) {
  if (modalKey === 'create') {
    showCreateModal.value = false;
  } else if (modalKey === 'bulk') {
    showBulkModal.value = false;
  } else if (modalKey === 'edit') {
    editingCamera.value = null;
  }

  resetAllUrlPickers();
  switchProjectSection('screenUrls');
}

async function refreshUserManagement() {
  if (!isSystemAdmin.value) return;

  membersLoading.value = true;
  error.value = '';

  try {
    const [loadedUsers, loadedProjects] = await Promise.all([
      listUsers(),
      listProjects(),
    ]);
    users.value = loadedUsers;
    projects.value = loadedProjects;

    const selectableUser = loadedUsers.find((user) => user.role !== 'admin') || loadedUsers[0] || null;
    if (!selectedUserId.value || !loadedUsers.some((user) => user.id === selectedUserId.value)) {
      selectedUserId.value = selectableUser?.id || null;
    }

    if (selectedUserId.value) {
      await loadUserProjectRoles(selectedUserId.value);
    }
  } catch (err) {
    error.value = err.message;
  } finally {
    membersLoading.value = false;
  }
}

async function loadUserProjectRoles(userId) {
  if (!userId || !isSystemAdmin.value) return;

  const result = await listUserProjects(userId);
  userProjectRoles.value = Object.fromEntries(
    result.projects
      .filter((project) => project.role === 'viewer' || project.role === 'operator' || project.role === 'admin')
      .map((project) => [project.project_id, project.role]),
  );
}

async function selectManagedUser(user) {
  selectedUserId.value = user.id;
  error.value = '';

  try {
    await loadUserProjectRoles(user.id);
  } catch (err) {
    error.value = err.message;
  }
}

async function addUser() {
  if (!isSystemAdmin.value || userCreating.value) return;

  userCreating.value = true;
  error.value = '';

  try {
    const created = await createUser({ ...newUserForm });
    users.value = [...users.value, created];
    selectedUserId.value = created.id;
    userProjectRoles.value = {};
    newUserForm.username = '';
    newUserForm.display_name = '';
    newUserForm.password = '';
    newUserForm.role = 'user';
    showToast('用户已创建');
  } catch (err) {
    error.value = err.message;
  } finally {
    userCreating.value = false;
  }
}

async function saveUserProjectAccess() {
  if (!selectedUserId.value || !isSystemAdmin.value || membersSaving.value) return;

  const user = selectedManagedUser.value;
  if (user?.role === 'admin') {
    showToast('系统管理员默认拥有全部项目权限');
    return;
  }

  membersSaving.value = true;
  error.value = '';

  try {
    const authorizedProjects = Object.entries(userProjectRoles.value)
      .filter(([, role]) => role === 'viewer' || role === 'operator')
      .map(([projectId, role]) => ({
        project_id: Number.parseInt(projectId, 10),
        role,
      }));
    const saved = await updateUserProjects(selectedUserId.value, authorizedProjects);
    userProjectRoles.value = Object.fromEntries(
      saved.projects
        .filter((project) => project.role === 'viewer' || project.role === 'operator' || project.role === 'admin')
        .map((project) => [project.project_id, project.role]),
    );
    showToast('用户项目授权已保存');
  } catch (err) {
    error.value = err.message;
  } finally {
    membersSaving.value = false;
  }
}

function setUserProjectRole(projectId, role) {
  userProjectRoles.value = {
    ...userProjectRoles.value,
    [projectId]: role,
  };

  if (!role) {
    const next = { ...userProjectRoles.value };
    delete next[projectId];
    userProjectRoles.value = next;
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

async function saveProject() {
  if (!selectedProjectId.value || !canManageSelectedProject.value) return;

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

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }

  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows.filter((cells) => cells.some((value) => String(value).trim()));
}

function screenUrlCsvPayload(items = screenUrls.value) {
  const rows = [
    ['name', 'url', 'remark'],
    ...items.map((item) => [item.name, item.url, item.remark || '']),
  ];
  return rows.map((row) => row.map(csvEscape).join(',')).join('\n');
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
    const remappedStreamCount = imported.remapped_streams?.length || 0;
    const screenUrlCount = imported.screen_urls?.length || 0;
    const suffixParts = [];
    if (remappedCount) suffixParts.push(`${remappedCount} 个 IP 已重映射`);
    if (remappedStreamCount) suffixParts.push(`${remappedStreamCount} 个 RTSP 流名已改名`);
    if (screenUrlCount) suffixParts.push(`含 ${screenUrlCount} 个大屏地址`);
    showToast(suffixParts.length ? `已导入，${suffixParts.join('，')}` : '项目已导入');
    await enterProject(imported.project, 'cameras');
  } catch (err) {
    error.value = err instanceof SyntaxError ? '导入文件不是有效 JSON' : err.message;
  } finally {
    importingProject.value = false;
  }
}

async function addProject() {
  if (!canCreateProjects.value) return;

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
  createError.value = '';

  try {
	    await createCamera(sourcePayload(form, { autoStreamName: true }), selectedProjectId.value);
	    resetForm();
	    await refresh();
	    showCreateModal.value = false;
	    showToast('已创建');
  } catch (err) {
    const message = err.message;
    await refresh().catch(() => {});
    error.value = '';
    createError.value = message;
  } finally {
    saving.value = false;
  }
}

async function submitBulk() {
  if (!selectedProjectId.value || bulkCreating.value || !canManageSelectedProject.value) return;

  bulkCreating.value = true;
  error.value = '';
  bulkError.value = '';

  try {
    const result = await bulkCreateCameras({ ...bulkForm }, selectedProjectId.value);
    await refresh();
    showBulkModal.value = false;
    const remappedCount = result.remapped_ips?.length || 0;
    const remappedStreamCount = result.remapped_streams?.length || 0;
    const suffixParts = [];
    if (remappedCount) suffixParts.push(`${remappedCount} 个 IP 已重映射`);
    if (remappedStreamCount) suffixParts.push(`${remappedStreamCount} 个流名已自动调整`);
    showToast(suffixParts.length ? `已生成 ${result.cameras.length} 路，${suffixParts.join('，')}` : `已生成 ${result.cameras.length} 路`);
  } catch (err) {
    error.value = '';
    bulkError.value = err.message;
  } finally {
    bulkCreating.value = false;
  }
}

async function openEditCamera(camera, mode = 'full') {
  editingCamera.value = camera;
  cameraEditorMode.value = mode;
  editForm.source_type = camera.source_type || 'camera';
  editForm.name = camera.name;
  editForm.ip = camera.ip || '';
  editForm.stream_name = camera.stream_name;
  editForm.web_url = camera.web_url;
  editForm.width = camera.width;
  editForm.height = camera.height;
  editForm.fps = camera.fps;
  await refreshScreenUrls();
  resetUrlPicker('edit');
}

async function openMatrixCameraEdit(camera) {
  if (!canManageSelectedProject.value || isCameraBusy(camera.id)) return;
  await openEditCamera(camera, 'matrix');
}

async function saveCameraEdit() {
  if (!editingCamera.value || isCameraBusy(editingCamera.value.id) || !canManageSelectedProject.value) return;

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
  return buildDisplayTargetLabel(index, projectDraft.prefix);
}

function displayTargetMeta(index) {
  return buildDisplayTargetMeta(index, projectDraft.cols);
}

function indexFromRowCol(row, col) {
  return buildIndexFromRowCol(row, col, projectDraft.cols);
}

function rowColFromIndex(index) {
  return buildRowColFromIndex(index, projectDraft.cols);
}

function createDisplayRegion(row, col, rowSpan, colSpan) {
  return buildDisplayRegion(row, col, rowSpan, colSpan, projectDraft);
}

function normalizeCameraRegion(camera) {
  return buildNormalizedCameraRegion(camera, projectDraft);
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
  return buildRegionFromCells(start, end, projectDraft);
}

function regionSummary(region) {
  return buildRegionSummary(region, projectDraft);
}

function regionTargetLabels(region) {
  return buildRegionTargetLabels(region, projectDraft);
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
  return buildTargetSummary(camera, projectDraft);
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
  if (!canManageSelectedProject.value) {
    event.preventDefault();
    return;
  }

  draggedCameraId.value = camera.id;
  event.dataTransfer.effectAllowed = 'copyMove';
  event.dataTransfer.setData('text/plain', String(camera.id));
}

function endDrag() {
  draggedCameraId.value = null;
  hoverScreen.value = null;
}

function beginRegionSelection(cell, event) {
  if (!canManageSelectedProject.value) return;
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
  matrixAssignCameraId.value = '';
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
  if (!canManageSelectedProject.value) return;

  const cameraId = Number.parseInt(event.dataTransfer.getData('text/plain') || draggedCameraId.value, 10);
  const camera = cameras.value.find((item) => item.id === cameraId);
  const region = dropRegionForCell(index, regionOverride);

  hoverScreen.value = null;

  if (!camera) return;

  if (!region) {
    error.value = '合并区域超出当前矩阵范围';
    return;
  }

  const saved = await saveExclusiveScreenAssignment(camera, region, occupyingCamerasForRegion(region, camera));
  if (saved) {
    clearDraftRegion();
  }
}

async function clearCameraAssignment(camera) {
  if (!canManageSelectedProject.value) return;
  await saveCameraTargets(camera, [], null, '已移除绑定');
}

function occupyingCamerasForRegion(region, camera) {
  if (!region || !camera) return [];

  return cameras.value.filter((item) => {
    if (item.id === camera.id) return false;
    return (item.display_targets || []).some((target) => region.targets.includes(target));
  });
}

function matrixCameraOptionLabel(camera) {
  return `${camera.name} · ${sourceAddress(camera)} · ${camera.stream_name}`;
}

async function assignCameraToDraftRegion(camera) {
  if (!draftRegion.value || !camera || !canManageSelectedProject.value || isCameraBusy(camera.id)) return;

  const saved = await saveExclusiveScreenAssignment(
    camera,
    draftRegion.value,
    occupyingCamerasForRegion(draftRegion.value, camera),
  );

  if (saved) {
    clearDraftRegion();
  }
}

async function assignSelectedCameraToDraftRegion() {
  if (!selectedMatrixAssignCamera.value) return;
  await assignCameraToDraftRegion(selectedMatrixAssignCamera.value);
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
    return true;
  } catch (err) {
    error.value = err.message;
    return false;
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
  return canManageSelectedProject.value && camera.status !== 'running' && !isCameraBusy(camera.id);
}

function canStopCamera(camera) {
  return canManageSelectedProject.value && camera.status === 'running' && !isCameraBusy(camera.id);
}

function canRestartCamera(camera) {
  return canManageSelectedProject.value && camera.status === 'running' && !isCameraBusy(camera.id);
}

async function runAction(action, camera, doneMessage) {
  if (isCameraBusy(camera.id) || !canManageSelectedProject.value) return;

  error.value = '';
  const keepActionMenuOpen = openActionMenuId.value === camera.id;
  setCameraBusy(camera.id, true);

  try {
    await action(camera.id);
    await refresh();
    if (keepActionMenuOpen) {
      openActionMenuId.value = camera.id;
    }
    showToast(doneMessage);
  } catch (err) {
    showOperationError(operationFailureMessage(doneMessage, err));
    await refresh().catch(() => {});
    if (keepActionMenuOpen) {
      openActionMenuId.value = camera.id;
    }
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
  let firstErrorMessage = '';

  try {
    for (const camera of targets) {
      try {
        await action(camera.id);
      } catch (err) {
        failed += 1;
        if (!firstErrorMessage) {
          firstErrorMessage = operationFailureMessage(doneMessage, err);
        }
      }
    }

    await refresh();
    if (failed > 0) {
      showOperationError(`${doneMessage}，${failed} 路失败。${firstErrorMessage}`);
    } else {
      showToast(`${doneMessage} ${targets.length} 路`);
    }
  } catch (err) {
    showOperationError(operationFailureMessage(doneMessage, err));
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
  return buildMpvCommand(camera);
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
  return buildStatusLabel(status);
}

function sourceTypeLabel(camera) {
  return buildSourceTypeLabel(camera);
}

function sourceAddress(camera) {
  return buildSourceAddress(camera);
}

function resourceForCamera(camera) {
  return resourceByCameraId.value.get(camera.id);
}

function resourceRateForCamera(camera) {
  return resourceRates.value?.items?.get(camera.id);
}

function resourceStatusText(camera) {
  const stats = resourceForCamera(camera);
  return buildResourceStatusText(stats, statusLabel);
}

function resourceNetworkText(stats) {
  return buildResourceNetworkText(stats, resourceRates.value?.items?.get(stats?.camera_id));
}

function resourceDiskText(stats) {
  return buildResourceDiskText(stats, resourceRates.value?.items?.get(stats?.camera_id));
}

function projectSectionLabel(section) {
  const map = {
    cameras: '摄像头管理',
    matrix: '矩阵绑定',
    screenUrls: '大屏地址',
    settings: '项目设置',
    audit: '操作审计',
  };
  return map[section] || section;
}

function auditActionLabel(action) {
  const map = {
    'project.create': '创建项目',
    'project.update': '更新项目',
    'user.projects_update': '更新用户授权',
    'screen_url.create': '添加大屏地址',
    'screen_url.update': '更新大屏地址',
    'screen_url.delete': '删除大屏地址',
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

  if (log.action?.startsWith('user.')) {
    return `授权项目 ${detail.project_count ?? '-'} 个`;
  }

  if (log.action?.startsWith('screen_url.')) {
    return detail.url || detail.after?.url || log.target_name || '-';
  }

  return log.target_name || '-';
}

onMounted(async () => {
  window.addEventListener('virtualwebcam:unauthorized', handleUnauthorized);
  await loadCurrentSession();
  await nextTick();
  updateFixedHeaderHeights();

  if (window.ResizeObserver) {
    stickyHeaderObserver = new ResizeObserver(updateFixedHeaderHeights);
    if (stickyHeaderRef.value) {
      stickyHeaderObserver.observe(stickyHeaderRef.value);
    }
    projectHeaderObserver = new ResizeObserver(updateFixedHeaderHeights);
    observeProjectHeader();
    matrixBoardObserver = new ResizeObserver(updateMatrixSourceListHeight);
    observeMatrixBoard();
  }
});

onBeforeUnmount(() => {
  window.removeEventListener('virtualwebcam:unauthorized', handleUnauthorized);
  stopBackgroundPolling();
  stickyHeaderObserver?.disconnect();
  projectHeaderObserver?.disconnect();
  matrixBoardObserver?.disconnect();
  document.documentElement.style.removeProperty('--sticky-status-header-height');
  document.documentElement.style.removeProperty('--project-header-panel-height');
});
</script>

<template>
  <main class="shell" :class="themeClass">
    <section v-if="authChecking" class="auth-screen">
      <div class="auth-card">
        <h1>VirtualWebCam</h1>
        <p>正在校验登录状态</p>
      </div>
    </section>

    <section v-else-if="!isAuthenticated" class="auth-screen">
      <form class="auth-card" @submit.prevent="submitLogin">
        <div>
          <h1>VirtualWebCam</h1>
          <p>登录后仅能访问已授权的项目</p>
        </div>
        <label>
          <span>用户名</span>
          <input v-model.trim="loginForm.username" autocomplete="username" required />
        </label>
        <label>
          <span>密码</span>
          <input v-model="loginForm.password" autocomplete="current-password" required type="password" />
        </label>
        <p v-if="loginError" class="error">{{ loginError }}</p>
        <button class="primary-button auth-submit" type="submit" :disabled="loginLoading">
          <span>{{ loginLoading ? '登录中' : '登录系统' }}</span>
        </button>
      </form>
    </section>

    <template v-else>
      <div ref="stickyHeaderRef" class="sticky-status-header">
	      <header class="topbar">
	        <div>
	          <div class="title-line">
	            <h1>VirtualWebCam</h1>
	            <button class="theme-icon-button" type="button" :title="themeSwitchTitle()" @click="cycleTheme">
	              <Sparkles :size="16" />
                <span>{{ themeLabel() }}</span>
	            </button>
	          </div>
	          <p v-if="currentView === 'projects'">项目入口 · 网页转 RTSP + ONVIF 摄像头实例管理</p>
	          <p v-else-if="currentView === 'users'">系统管理 · 登录人员与项目授权</p>
	          <p v-else>{{ selectedProject?.name }} · {{ projectSectionLabel(projectSection) }}</p>
	        </div>
	        <div class="topbar-actions">
	          <div class="account-strip">
	            <span>{{ userRoleLabel(currentUser.role) }}</span>
	            <strong>{{ currentUser.display_name }}</strong>
	            <small>{{ currentUser.username }}</small>
	          </div>
          <div class="topbar-button-row">
            <button class="text-button" type="button" title="修改当前账号密码" @click="openPasswordModal">
              <Settings :size="16" />
              <span>修改密码</span>
            </button>
	          <button v-if="currentView === 'project'" class="text-button" type="button" @click="backToProjects">
	            <House :size="16" />
            <span>首页</span>
          </button>
          <button v-if="isSystemAdmin && currentView === 'projects'" class="text-button" type="button" @click="openUserManagement">
            <UserPlus :size="16" />
            <span>用户管理</span>
          </button>
          <button v-if="currentView === 'users'" class="text-button" type="button" @click="backToProjects">
            <House :size="16" />
            <span>首页</span>
          </button>
          <button class="text-button" type="button" title="退出登录" @click="logout">
            <LogOut :size="16" />
            <span>退出</span>
          </button>
          <button class="icon-button" type="button" title="刷新" @click="refresh">
            <RefreshCw :size="18" />
          </button>
          </div>
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

      <section v-if="currentView === 'project' && selectedProject" ref="projectHeaderRef" class="panel project-header-panel">
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
            <button type="button" :class="{ active: projectSection === 'screenUrls' }" @click="switchProjectSection('screenUrls')">
              大屏地址
            </button>
            <button v-if="canManageSelectedProject" type="button" :class="{ active: projectSection === 'settings' }" @click="switchProjectSection('settings')">
              项目设置
            </button>
            <button type="button" :class="{ active: projectSection === 'audit' }" @click="switchProjectSection('audit')">
              操作审计
            </button>
          </div>
        </div>
      </section>
    </div>

    <p v-if="error" class="error global-error">{{ error }}</p>

    <section v-if="currentView === 'projects'" class="project-home">
      <section v-if="canCreateProjects" class="panel project-create-panel">
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

      <section v-else class="panel project-access-panel">
        <div>
          <h2>授权项目</h2>
          <p>当前账号只能看到管理员授权的项目。需要新增项目或调整权限时，请联系系统管理员。</p>
        </div>
        <span class="count">{{ projects.length }}</span>
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
              <button v-if="canManageProject(project)" type="button" title="项目设置" @click="enterProject(project, 'settings')">
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
          <p class="project-permission">权限：{{ projectRoleLabel(project.permission_role) }}</p>
        </article>

        <div v-if="projects.length === 0" class="empty project-empty">暂无项目</div>
      </section>
    </section>

    <section v-else-if="currentView === 'users' && isSystemAdmin" class="members-page">
      <section class="panel members-panel">
        <div class="panel-heading">
          <div>
            <h2>用户管理</h2>
            <p>登录人员是系统级主体；项目是分配给用户的资源。</p>
          </div>
          <div class="panel-heading-actions">
            <button class="text-button" type="button" :disabled="membersLoading" @click="refreshUserManagement">
              <RefreshCw :size="15" />
              <span>{{ membersLoading ? '刷新中' : '刷新' }}</span>
            </button>
            <button class="primary-button" type="button" :disabled="membersSaving || !selectedManagedUser || selectedManagedUser.role === 'admin'" @click="saveUserProjectAccess">
              <Save :size="16" />
              <span>{{ membersSaving ? '保存中' : '保存授权' }}</span>
            </button>
          </div>
        </div>

        <form class="user-create-row" @submit.prevent="addUser">
          <label>
            <span>用户名</span>
            <input v-model.trim="newUserForm.username" required placeholder="operator01" />
          </label>
          <label>
            <span>显示名</span>
            <input v-model.trim="newUserForm.display_name" placeholder="值班人员" />
          </label>
          <label>
            <span>初始密码</span>
            <input v-model="newUserForm.password" required type="password" minlength="8" placeholder="至少 8 位" />
          </label>
          <label>
            <span>系统角色</span>
            <select v-model="newUserForm.role">
              <option value="user">普通用户</option>
              <option value="admin">系统管理员</option>
            </select>
          </label>
          <button class="text-button" type="submit" :disabled="userCreating || !newUserForm.username || !newUserForm.password">
            <UserPlus :size="15" />
            <span>{{ userCreating ? '创建中' : '创建用户' }}</span>
          </button>
        </form>

        <div class="user-admin-layout">
          <aside class="user-list-panel">
            <div class="members-table-head compact-head">
              <span>登录人员</span>
            </div>
            <button
              v-for="user in users"
              :key="user.id"
              class="user-row-button"
              type="button"
              :class="{ active: selectedUserId === user.id }"
              @click="selectManagedUser(user)"
            >
              <strong>{{ user.display_name }}</strong>
              <span>{{ user.username }} · {{ userRoleLabel(user.role) }}</span>
            </button>
            <div v-if="!membersLoading && users.length === 0" class="empty small">暂无用户</div>
          </aside>

          <section class="project-access-list">
            <div class="members-table-head">
              <span>项目资源</span>
              <span>矩阵</span>
              <span>授权</span>
            </div>
            <div v-if="membersLoading" class="empty small">加载中</div>
            <article v-for="project in projects" v-else :key="project.id" class="member-row">
              <div>
                <strong>{{ project.name }}</strong>
                <span>{{ project.prefix }}01 - {{ project.prefix }}{{ String(project.rows * project.cols).padStart(2, '0') }}</span>
              </div>
              <span>{{ project.rows }} 行 x {{ project.cols }} 列</span>
              <select
                v-if="selectedManagedUser?.role !== 'admin'"
                :value="userProjectRoles[project.id] || ''"
                :disabled="!selectedManagedUser"
                @change="setUserProjectRole(project.id, $event.target.value)"
              >
                <option value="">不授权</option>
                <option value="viewer">仅查看</option>
                <option value="operator">可操作</option>
              </select>
              <strong v-else>全部项目</strong>
            </article>
          </section>
        </div>
      </section>
    </section>

    <section v-else-if="selectedProject" class="project-detail">
      <section v-if="projectSection === 'cameras'" class="camera-page">
        <section class="panel list-panel">
          <div class="panel-heading camera-list-heading">
            <div>
              <h2>摄像头详情</h2>
              <p v-if="filteredCameras.length !== cameras.length">当前显示 {{ filteredCameras.length }} / {{ cameras.length }} 路</p>
              <p v-else>查看运行状态、投放屏幕和 RTSP / ONVIF 地址</p>
            </div>
            <div class="panel-heading-actions camera-primary-actions">
              <span class="count">{{ filteredCameras.length }}</span>
              <button class="text-button" type="button" :disabled="statusRefreshing" @click="refreshCameraStatuses">
                <RefreshCw :size="16" />
                <span>{{ statusRefreshing ? '刷新中' : '刷新状态' }}</span>
              </button>
              <button class="text-button" type="button" :disabled="resourceRefreshing" @click="refreshResourceStats">
                <RefreshCw :size="16" />
                <span>{{ resourceRefreshing ? '采集中' : '刷新资源' }}</span>
              </button>
              <button v-if="canManageSelectedProject" class="text-button" type="button" @click="openBulkCreateModal">
                <Plus :size="16" />
                <span>批量生成</span>
              </button>
              <button v-if="canManageSelectedProject" class="primary-button" type="button" @click="openCreateSourceModal">
                <Plus :size="16" />
                <span>新增摄像头源</span>
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
                  <p>{{ resourceCompactSummary }}</p>
                </div>
                <div class="resource-monitor-actions">
                  <span>更新 {{ resourceUpdatedAt }}</span>
                  <button class="text-button compact-button" type="button" @click="resourceMonitorExpanded = !resourceMonitorExpanded">
                    {{ resourceMonitorExpanded ? '收起' : '展开' }}
                  </button>
                </div>
              </div>
              <div v-if="resourceMonitorExpanded" class="resource-stat-grid">
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
                <span>根据排查目标隐藏长字段</span>
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
		                <tr :class="{ 'camera-row-active': isCameraRowActive(camera) }">
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
                <tr v-if="openActionMenuId === camera.id" class="action-detail-row" :class="{ 'camera-row-active': isCameraRowActive(camera) }">
                  <td :colspan="cameraTableColspan">
                    <div class="row-action-sheet" @click.stop>
                      <div class="row-action-sheet-buttons">
                        <div class="action-group">
                          <span>维护</span>
                          <button type="button" :disabled="!canStartCamera(camera)" @click="runAction(startCamera, camera, '已启动')">
                            <Play :size="15" />
                            <span>启动</span>
                          </button>
                          <button type="button" :disabled="!canStopCamera(camera)" @click="runAction(stopCamera, camera, '已停止')">
                            <Square :size="15" />
                            <span>停止</span>
                          </button>
                          <button type="button" :disabled="!canRestartCamera(camera)" @click="runAction(restartCamera, camera, '已重启')">
                            <RotateCcw :size="15" />
                            <span>重启</span>
                          </button>
                          <button type="button" @click="openLogs(camera)">
                            <FileText :size="15" />
                            <span>查看日志</span>
                          </button>
                          <button type="button" :disabled="isCameraBusy(camera.id) || !canManageSelectedProject" @click="openEditCamera(camera)">
                            <Settings :size="15" />
                            <span>编辑配置</span>
                          </button>
                        </div>
                        <div class="action-group">
                          <span>复制</span>
                          <button type="button" :disabled="!canManageSelectedProject" @click="cloneCamera(camera)">
                            <Plus :size="15" />
                            <span>复制为新摄像头</span>
                          </button>
                          <button type="button" @click="copy(camera.rtsp_url)">
                            <Copy :size="15" />
                            <span>复制 RTSP</span>
                          </button>
                          <button type="button" @click="copy(mpvCommand(camera))">
                            <Copy :size="15" />
                            <span>复制 mpv 命令</span>
                          </button>
                          <button v-if="sourceAddress(camera)" type="button" @click="copy(sourceAddress(camera))">
                            <Copy :size="15" />
                            <span>复制 IP</span>
                          </button>
                        </div>
                      </div>
                      <button type="button" class="danger row-delete-action" :disabled="isCameraBusy(camera.id) || !canManageSelectedProject" @click="remove(camera)">
                        <Trash2 :size="15" />
                        <span>删除摄像头</span>
                      </button>
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
          <div class="sidebar-section unassigned-section">
            <div class="panel-heading">
              <h2>未绑定摄像头源</h2>
              <span class="count">{{ unassignedCameras.length }}</span>
            </div>

            <div class="camera-source-scroll" :style="matrixSourceListStyle">
              <article
                v-for="camera in unassignedCameras"
                :key="camera.id"
                class="camera-card"
                :draggable="canManageSelectedProject"
                @dragstart="beginDrag(camera, $event)"
                @dragend="endDrag"
              >
                <GripVertical :size="16" />
                <div>
                  <strong>{{ camera.name }}</strong>
                  <span>{{ sourceAddress(camera) }} · {{ camera.stream_name }}</span>
                </div>
                <div class="camera-card-state">
                  <i :class="camera.status">{{ statusLabel(camera.status) }}</i>
                  <button
                    v-if="draftRegion && canManageSelectedProject"
                    class="camera-card-bind"
                    type="button"
                    title="绑定到当前围栏"
                    aria-label="绑定到当前围栏"
                    :disabled="isCameraBusy(camera.id)"
                    @pointerdown.stop
                    @click.stop="assignCameraToDraftRegion(camera)"
                  >
                    <Plus :size="14" />
                  </button>
                </div>
              </article>

              <div v-if="!loading && unassignedCameras.length === 0" class="empty small">没有未绑定摄像头源</div>
            </div>
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
            <div v-if="draftRegion" class="region-assign-panel">
              <label>
                <span>摄像头源</span>
                <select v-model="matrixAssignCameraId" :disabled="cameras.length === 0">
                  <option value="">请选择摄像头源</option>
                  <option v-for="camera in cameras" :key="camera.id" :value="String(camera.id)">
                    {{ matrixCameraOptionLabel(camera) }}
                  </option>
                </select>
              </label>
              <button
                class="primary-button region-assign-button"
                type="button"
                :disabled="!selectedMatrixAssignCamera || !canManageSelectedProject || isCameraBusy(selectedMatrixAssignCamera.id)"
                @click="assignSelectedCameraToDraftRegion"
              >
                <Save :size="15" />
                <span>绑定到围栏</span>
              </button>
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
            ref="matrixBoardRef"
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
              <button
                class="region-badge region-edit-trigger"
                type="button"
                title="编辑摄像头源"
                :disabled="!canManageSelectedProject || isCameraBusy(item.camera.id)"
                @pointerdown.stop
                @click.stop="openMatrixCameraEdit(item.camera)"
              >
                <strong>{{ item.camera.name }}</strong>
                <span>{{ item.region.targets.length }}块屏 · {{ item.camera.stream_name }}</span>
              </button>

              <div class="region-corner-actions">
                <span class="mini-status" :class="item.camera.status">{{ statusLabel(item.camera.status) }}</span>
                <div class="assignment-card-actions">
                  <button type="button" title="复制 RTSP" @click.stop="copy(item.camera.rtsp_url)">
                    <Copy :size="13" />
                  </button>
                  <button type="button" title="复制 mpv 测试命令" @click.stop="copy(mpvCommand(item.camera))">
                    <Play :size="13" />
                  </button>
                  <button v-if="item.camera.web_url" type="button" title="打开网页 URL" @click.stop="openUrl(item.camera.web_url)">
                    <ExternalLink :size="13" />
                  </button>
                  <button type="button" title="移除绑定" @click.stop="clearCameraAssignment(item.camera)">
                    <X :size="13" />
                  </button>
                </div>
              </div>
            </article>
          </div>
        </section>
      </section>

      <section v-else-if="projectSection === 'screenUrls'" class="screen-url-page">
        <section class="panel screen-url-panel">
          <div class="panel-heading">
            <div>
              <h2>大屏地址管理</h2>
              <p>维护项目常用网页地址，新增或编辑摄像头源时可搜索选择。</p>
            </div>
            <div class="panel-heading-actions">
              <span class="count">{{ filteredScreenUrls.length }}</span>
              <button class="text-button" type="button" :disabled="screenUrlsLoading" @click="downloadScreenUrlsCsv">
                <FileText :size="15" />
                <span>导出 CSV</span>
              </button>
              <button v-if="canManageSelectedProject" class="text-button" type="button" :disabled="screenUrlImporting" @click="pickScreenUrlImportFile">
                <Upload :size="15" />
                <span>{{ screenUrlImporting ? '导入中' : '导入 CSV' }}</span>
              </button>
              <input ref="screenUrlImportInput" class="visually-hidden" type="file" accept=".csv,text/csv" @change="importScreenUrlsFromCsv" />
              <button v-if="canManageSelectedProject" class="primary-button" type="button" @click="openScreenUrlCreator">
                <Plus :size="15" />
                <span>添加地址</span>
              </button>
              <button class="text-button" type="button" :disabled="screenUrlsLoading" @click="refreshScreenUrls">
                <RefreshCw :size="15" />
                <span>{{ screenUrlsLoading ? '刷新中' : '刷新' }}</span>
              </button>
            </div>
          </div>

          <div class="screen-url-toolbar">
            <input v-model.trim="screenUrlQuery" placeholder="搜索名称 / URL / 备注" />
          </div>

          <div class="screen-url-list">
            <div v-if="screenUrlsLoading" class="empty small">加载中</div>
            <div v-else-if="screenUrls.length === 0" class="empty small">暂无大屏地址</div>
            <div v-else-if="filteredScreenUrls.length === 0" class="empty small">没有匹配的大屏地址</div>
            <article v-for="item in filteredScreenUrls" v-else :key="item.id" class="screen-url-row">
              <div>
                <strong>{{ item.name }}</strong>
                <a :href="item.url" target="_blank" rel="noreferrer">{{ item.url }}</a>
                <span v-if="item.remark">{{ item.remark }}</span>
              </div>
              <div class="screen-url-actions">
                <button type="button" title="复制 URL" @click="copy(item.url)">
                  <Copy :size="14" />
                </button>
                <button v-if="canManageSelectedProject" type="button" title="编辑" @click="editScreenUrl(item)">
                  <Settings :size="14" />
                </button>
                <button v-if="canManageSelectedProject" type="button" title="删除" @click="removeScreenUrl(item)">
                  <Trash2 :size="14" />
                </button>
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
            <div class="panel-heading-actions audit-actions">
              <label>
                <span>显示</span>
                <select :value="auditLimit" :disabled="auditLoading" @change="updateAuditLimit($event.target.value)">
                  <option v-for="option in auditLimitOptions" :key="option" :value="option">最近 {{ option }} 条</option>
                </select>
              </label>
              <button class="text-button" type="button" :disabled="auditLoading" @click="refreshAuditLogs">
                <RefreshCw :size="15" />
                <span>{{ auditLoading ? '刷新中' : '刷新' }}</span>
              </button>
            </div>
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
	            <h2>新增摄像头源</h2>
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
	            <div class="url-picker-field">
	              <div class="url-input-row">
	                <input v-model.trim="form.web_url" required type="url" placeholder="可手动输入，或从大屏地址库选择" />
	                <button class="url-picker-trigger" type="button" @click="toggleUrlPicker('create')">
	                  {{ urlPickerState.create.open ? '收起' : '选择地址' }}
	                </button>
	              </div>
	              <div v-if="urlPickerState.create.open" class="url-picker-panel">
	                <input v-model.trim="urlPickerState.create.query" class="url-picker-search" placeholder="搜索名称 / URL / 备注" />
	                <div v-if="screenUrlsLoading" class="url-picker-empty">地址库加载中</div>
	                <div v-else-if="screenUrls.length === 0" class="url-picker-empty">
	                  <span>暂无可选大屏地址</span>
	                  <button type="button" @click="openScreenUrlManagerFromModal('create')">去维护</button>
	                </div>
	                <div v-else-if="urlPickerMatchCount('create') === 0" class="url-picker-empty">没有匹配的大屏地址</div>
	                <div v-else class="url-picker-list">
	                  <button v-for="item in urlPickerMatches('create')" :key="item.id" type="button" @click="applyScreenUrlFromPicker('create', form, item)">
	                    <strong>{{ item.name }}</strong>
	                    <span>{{ item.url }}</span>
	                    <em v-if="item.remark">{{ item.remark }}</em>
	                  </button>
	                  <div v-if="urlPickerMatchCount('create') > urlPickerLimit" class="url-picker-more">
	                    已显示前 {{ urlPickerLimit }} 条，请继续输入关键字缩小范围
	                  </div>
	                </div>
	              </div>
	            </div>
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
	            <input v-model.number="form.fps" required type="number" min="2" max="60" step="1" />
	          </label>
	        </div>
	        <p v-if="createError" class="error modal-error">{{ createError }}</p>
	        <div class="modal-actions">
	          <button class="text-button" type="button" @click="showCreateModal = false">取消</button>
	          <button class="primary-button" type="submit" :disabled="!canCreateCamera">
	            <Plus :size="16" />
	            <span>{{ saving ? '创建中' : '创建摄像头源' }}</span>
	          </button>
	        </div>
	      </form>
	    </div>

	    <div v-if="showBulkModal" class="modal-backdrop" role="dialog" aria-modal="true" @click.self="showBulkModal = false">
	      <section class="modal-card">
	        <div class="modal-head">
	          <div>
	            <h2>批量生成摄像头源配置</h2>
	            <p>只写入配置，不启动 Docker 容器，适合先录入多路 ONVIF 摄像头或 RTSP 流源。</p>
	          </div>
	          <button class="icon-button" type="button" title="关闭" @click="showBulkModal = false">
	            <X :size="16" />
	          </button>
	        </div>
	        <div class="bulk-form-grid modal-form-grid">
	          <label class="wide-field source-type-field">
	            <span>源类型</span>
	            <select v-model="bulkForm.source_type">
	              <option value="camera">ONVIF 摄像头（独立 IP）</option>
	              <option value="rtsp">RTSP 流源（共享 IP + 流路径）</option>
	            </select>
	          </label>
	          <label>
	            <span>数量</span>
	            <input v-model.number="bulkForm.count" type="number" min="1" max="200" />
	          </label>
	          <label v-if="bulkForm.source_type === 'camera'">
	            <span>起始 IP</span>
	            <input v-model.trim="bulkForm.start_ip" inputmode="numeric" />
	          </label>
	          <label>
	            <span>名称前缀</span>
	            <input v-model.trim="bulkForm.name_prefix" />
	          </label>
	          <label class="wide-field">
	            <span>网页 URL</span>
	            <div class="url-picker-field">
	              <div class="url-input-row">
	                <input v-model.trim="bulkForm.web_url" type="url" placeholder="可手动输入，或从大屏地址库选择" />
	                <button class="url-picker-trigger" type="button" @click="toggleUrlPicker('bulk')">
	                  {{ urlPickerState.bulk.open ? '收起' : '选择地址' }}
	                </button>
	              </div>
	              <div v-if="urlPickerState.bulk.open" class="url-picker-panel">
	                <input v-model.trim="urlPickerState.bulk.query" class="url-picker-search" placeholder="搜索名称 / URL / 备注" />
	                <div v-if="screenUrlsLoading" class="url-picker-empty">地址库加载中</div>
	                <div v-else-if="screenUrls.length === 0" class="url-picker-empty">
	                  <span>暂无可选大屏地址</span>
	                  <button type="button" @click="openScreenUrlManagerFromModal('bulk')">去维护</button>
	                </div>
	                <div v-else-if="urlPickerMatchCount('bulk') === 0" class="url-picker-empty">没有匹配的大屏地址</div>
	                <div v-else class="url-picker-list">
	                  <button v-for="item in urlPickerMatches('bulk')" :key="item.id" type="button" @click="applyScreenUrlFromPicker('bulk', bulkForm, item)">
	                    <strong>{{ item.name }}</strong>
	                    <span>{{ item.url }}</span>
	                    <em v-if="item.remark">{{ item.remark }}</em>
	                  </button>
	                  <div v-if="urlPickerMatchCount('bulk') > urlPickerLimit" class="url-picker-more">
	                    已显示前 {{ urlPickerLimit }} 条，请继续输入关键字缩小范围
	                  </div>
	                </div>
	              </div>
	            </div>
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
	            <input v-model.number="bulkForm.fps" type="number" min="2" max="60" />
	          </label>
	        </div>
	        <p v-if="bulkError" class="error modal-error">{{ bulkError }}</p>
	        <div class="modal-actions">
	          <button class="text-button" type="button" @click="showBulkModal = false">取消</button>
	          <button class="primary-button" type="button" :disabled="bulkCreating" @click="submitBulk">
	            <Plus :size="16" />
	            <span>{{ bulkCreating ? '生成中' : '批量生成' }}</span>
	          </button>
	        </div>
	      </section>
	    </div>

	    <div v-if="showPasswordModal" class="modal-backdrop" role="dialog" aria-modal="true" @click.self="showPasswordModal = false">
	      <form class="modal-card password-modal-card" @submit.prevent="submitPasswordChange">
	        <div class="modal-head">
	          <div>
	            <h2>修改密码</h2>
	            <p>{{ currentUser.display_name }} · {{ currentUser.username }}</p>
	          </div>
	          <button class="icon-button" type="button" title="关闭" @click="showPasswordModal = false">
	            <X :size="16" />
	          </button>
	        </div>
	        <div class="password-form-grid">
	          <label>
	            <span>当前密码</span>
	            <input v-model="passwordForm.old_password" required type="password" autocomplete="current-password" />
	          </label>
	          <label>
	            <span>新密码</span>
	            <input v-model="passwordForm.new_password" required type="password" minlength="8" autocomplete="new-password" />
	          </label>
	          <label>
	            <span>确认新密码</span>
	            <input v-model="passwordForm.confirm_password" required type="password" minlength="8" autocomplete="new-password" />
	          </label>
	        </div>
	        <div class="modal-actions">
	          <button class="text-button" type="button" @click="showPasswordModal = false">取消</button>
	          <button class="primary-button" type="submit" :disabled="passwordSaving || passwordForm.new_password.length < 8 || passwordForm.new_password !== passwordForm.confirm_password">
	            <Save :size="16" />
	            <span>{{ passwordSaving ? '保存中' : '保存密码' }}</span>
	          </button>
	        </div>
	      </form>
	    </div>

	    <div v-if="screenUrlEditorOpen" class="modal-backdrop" role="dialog" aria-modal="true" @click.self="resetScreenUrlForm">
	      <form class="modal-card screen-url-modal-card" @submit.prevent="saveScreenUrl">
	        <div class="modal-head">
	          <div>
	            <h2>{{ editingScreenUrlId ? '编辑大屏地址' : '添加大屏地址' }}</h2>
	            <p>{{ editingScreenUrlId ? '修改后会同步到地址库，已使用该地址的摄像头源不会自动改写。' : '添加后可在新增或编辑摄像头源时直接搜索选择。' }}</p>
	          </div>
	          <button class="icon-button" type="button" title="关闭" @click="resetScreenUrlForm">
	            <X :size="16" />
	          </button>
	        </div>
	        <div class="screen-url-edit-form">
	          <label>
	            <span>名称</span>
	            <input v-model.trim="screenUrlForm.name" required placeholder="大厅信息屏" />
	          </label>
	          <label>
	            <span>网页地址</span>
	            <input v-model.trim="screenUrlForm.url" required type="url" placeholder="https://example.com/dashboard" />
	          </label>
	          <label>
	            <span>备注</span>
	            <input v-model.trim="screenUrlForm.remark" maxlength="200" placeholder="可选" />
	          </label>
	        </div>
	        <div class="modal-actions">
	          <button class="text-button" type="button" @click="resetScreenUrlForm">取消</button>
	          <button class="primary-button" type="submit" :disabled="screenUrlSaving || !screenUrlForm.name || !screenUrlForm.url">
	            <Save :size="16" />
	            <span>{{ screenUrlSaving ? '保存中' : '保存地址' }}</span>
	          </button>
	        </div>
	      </form>
	    </div>

	    <div v-if="activeLogs" class="drawer log-drawer" role="dialog" aria-modal="true">
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
      <pre><code>{{ logLoading ? '加载中' : logText }}</code></pre>
    </div>

    <div v-if="editingCamera" class="drawer edit-drawer" role="dialog" aria-modal="true">
      <div class="drawer-head">
        <div>
          <h2>编辑摄像头源</h2>
          <p>{{ editingCamera.name }} · {{ sourceAddress(editingCamera) }} · {{ sourceTypeLabel(editingCamera) }}</p>
        </div>
        <div class="drawer-actions">
          <button type="button" @click="editingCamera = null">关闭</button>
        </div>
      </div>

      <form class="drawer-form" @submit.prevent="saveCameraEdit">
        <label v-if="cameraEditorMode !== 'matrix'">
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
        <label v-if="cameraEditorMode !== 'matrix' && editForm.source_type === 'camera'">
          <span>虚拟 IP</span>
          <input v-model.trim="editForm.ip" required inputmode="numeric" />
        </label>
        <label>
          <span>网页 URL</span>
          <div class="url-picker-field">
            <div class="url-input-row">
              <input v-model.trim="editForm.web_url" required type="url" placeholder="可手动输入，或从大屏地址库选择" />
              <button class="url-picker-trigger" type="button" @click="toggleUrlPicker('edit')">
                {{ urlPickerState.edit.open ? '收起' : '选择地址' }}
              </button>
            </div>
            <div v-if="urlPickerState.edit.open" class="url-picker-panel">
              <input v-model.trim="urlPickerState.edit.query" class="url-picker-search" placeholder="搜索名称 / URL / 备注" />
              <div v-if="screenUrlsLoading" class="url-picker-empty">地址库加载中</div>
              <div v-else-if="screenUrls.length === 0" class="url-picker-empty">
                <span>暂无可选大屏地址</span>
                <button type="button" @click="openScreenUrlManagerFromModal('edit')">去维护</button>
              </div>
              <div v-else-if="urlPickerMatchCount('edit') === 0" class="url-picker-empty">没有匹配的大屏地址</div>
              <div v-else class="url-picker-list compact">
                <button v-for="item in urlPickerMatches('edit')" :key="item.id" type="button" @click="applyScreenUrlFromPicker('edit', editForm, item)">
                  <strong>{{ item.name }}</strong>
                  <span>{{ item.url }}</span>
                  <em v-if="item.remark">{{ item.remark }}</em>
                </button>
                <div v-if="urlPickerMatchCount('edit') > urlPickerLimit" class="url-picker-more">
                  已显示前 {{ urlPickerLimit }} 条，请继续输入关键字缩小范围
                </div>
              </div>
            </div>
          </div>
        </label>
        <label v-if="cameraEditorMode !== 'matrix'">
          <span>流名称</span>
          <input v-model.trim="editForm.stream_name" required />
        </label>
        <div v-if="cameraEditorMode !== 'matrix'" class="drawer-form-grid">
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
            <input v-model.number="editForm.fps" required type="number" min="2" max="60" />
          </label>
        </div>
        <button class="primary-button" type="submit" :disabled="isCameraBusy(editingCamera.id)">
          <Save :size="16" />
          <span>{{ isCameraBusy(editingCamera.id) ? '保存中' : '保存配置' }}</span>
        </button>
      </form>
    </div>

    <div v-if="toast" class="toast" :class="toastKind">{{ toast }}</div>
    </template>
  </main>
</template>
