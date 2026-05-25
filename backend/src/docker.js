const Docker = require('dockerode');
const os = require('os');
const {
  appStatusFromState,
  cpuPercent,
  memoryStats,
  sumBlockIo,
  sumNetwork,
} = require('./docker-metrics');

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
});

const DOCKER_NETWORK = process.env.DOCKER_NETWORK || 'onvif_macvlan';
const EGRESS_NETWORK = process.env.DOCKER_EGRESS_NETWORK || 'bridge';
const IMAGE = process.env.VIRTUALWEBCAM_IMAGE || 'virtualwebcam:latest';
const CONTAINER_PREFIX = process.env.CONTAINER_PREFIX || 'virtualwebcam';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const CAMERA_RTSP_PORT = process.env.CAMERA_RTSP_PORT || '554';
const RTSP_GATEWAY_PORT = process.env.RTSP_GATEWAY_PORT || '554';
const RTSP_GATEWAY_CONTAINER = process.env.RTSP_GATEWAY_CONTAINER || `${CONTAINER_PREFIX}-rtsp-gateway`;
const RTSP_NETWORK = process.env.RTSP_NETWORK || `${CONTAINER_PREFIX}_rtsp`;
const CAMERA_RESTART_POLICY = { Name: 'no' };
const RESOURCE_STATS_CONCURRENCY = 10;
const RESOURCE_STATS_TIMEOUT_MS = 2500;

function defaultGatewayHost() {
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses || []) {
      if (address.family === 'IPv4' && !address.internal) {
        return address.address;
      }
    }
  }

  return '127.0.0.1';
}

const RTSP_GATEWAY_HOST = process.env.RTSP_GATEWAY_HOST || process.env.HOST_IP || defaultGatewayHost();

function slugify(value) {
  return String(value || 'camera')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 40) || 'camera';
}

function containerName(camera) {
  return `${CONTAINER_PREFIX}-${camera.id}-${slugify(camera.name || camera.stream_name)}`;
}

function sourceType(camera) {
  return camera.source_type === 'rtsp' ? 'rtsp' : 'camera';
}

function labels(camera) {
  return {
    'virtualwebcam.managed': 'true',
    'virtualwebcam.cameraId': String(camera.id),
    'virtualwebcam.sourceType': sourceType(camera),
  };
}

function dockerEnv(camera) {
  const env = [
    `WEB_URL=${camera.web_url}`,
    `STREAM_NAME=${camera.stream_name}`,
    `WIDTH=${camera.width || 1280}`,
    `HEIGHT=${camera.height || 720}`,
    `FPS=${camera.fps || 15}`,
  ];

  if (sourceType(camera) === 'rtsp') {
    env.push(
      'OUTPUT_MODE=rtsp-publisher',
      `RTSP_PUSH_URL=rtsp://${RTSP_GATEWAY_CONTAINER}:${RTSP_GATEWAY_PORT}/${camera.stream_name}`,
    );
  } else {
    env.push(
      'OUTPUT_MODE=onvif',
      `GO2RTC_RTSP_PORT=${CAMERA_RTSP_PORT}`,
    );
  }

  return env;
}

function friendlyDockerError(error) {
  const message = error?.json?.message || error?.reason || error?.message || String(error);

  if (message.includes('No such image') || message.includes('pull access denied')) {
    return `Docker 镜像不存在：${IMAGE}。请先构建：docker build -t ${IMAGE} ./container`;
  }

  if (message.includes('network') && (message.includes('not found') || message.includes('No such'))) {
    return `Docker 网络不存在：${DOCKER_NETWORK}。请先创建 macvlan 网络。`;
  }

  if (message.includes('Address already in use') || message.includes('already allocated')) {
    return '虚拟 IP 已被占用，请换一个未使用的 IP。';
  }

  if (message.includes('permission denied') || message.includes('EACCES')) {
    return `当前后端进程无权访问 Docker socket：${DOCKER_SOCKET}。请将运行管理后台的用户加入 docker 组，或用具备 Docker 权限的用户启动后端。`;
  }

  if (message.includes('connect ENOENT')) {
    return `无法访问 Docker socket：${DOCKER_SOCKET}。请检查 Docker 是否运行，以及管理后台是否挂载 /var/run/docker.sock。`;
  }

  return message;
}

function timeoutError(label, timeoutMs) {
  const error = new Error(`${label} timed out after ${timeoutMs}ms`);
  error.code = 'ETIMEOUT';
  return error;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer = null;

  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(timeoutError(label, timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

async function runtimeStatus() {
  const status = {
    docker: {
      available: false,
      socketPath: DOCKER_SOCKET,
      error: null,
    },
    network: {
      name: DOCKER_NETWORK,
      exists: false,
      error: null,
    },
    image: {
      name: IMAGE,
      exists: false,
      error: null,
    },
  };

  try {
    await docker.ping();
    status.docker.available = true;
  } catch (error) {
    status.docker.error = friendlyDockerError(error);
    return status;
  }

  try {
    await docker.getNetwork(DOCKER_NETWORK).inspect();
    status.network.exists = true;
  } catch (error) {
    status.network.error = friendlyDockerError(error);
  }

  try {
    await docker.getImage(IMAGE).inspect();
    status.image.exists = true;
  } catch (error) {
    status.image.error = friendlyDockerError(error);
  }

  return status;
}

async function assertCreatePrerequisites() {
  const status = await runtimeStatus();

  if (!status.docker.available) {
    throw new Error(status.docker.error || 'Docker daemon 不可用');
  }

  if (!status.network.exists) {
    throw new Error(status.network.error || `Docker 网络不存在：${DOCKER_NETWORK}`);
  }

  if (!status.image.exists) {
    throw new Error(status.image.error || `Docker 镜像不存在：${IMAGE}`);
  }
}

async function assertDockerAndImage() {
  const status = await runtimeStatus();

  if (!status.docker.available) {
    throw new Error(status.docker.error || 'Docker daemon 不可用');
  }

  if (!status.image.exists) {
    throw new Error(status.image.error || `Docker 镜像不存在：${IMAGE}`);
  }
}

async function ensureRtspNetwork() {
  try {
    await docker.getNetwork(RTSP_NETWORK).inspect();
  } catch (error) {
    const message = error?.json?.message || error?.message || '';
    if (!message.includes('No such network') && error.statusCode !== 404) {
      throw error;
    }

    await docker.createNetwork({
      Name: RTSP_NETWORK,
      Driver: 'bridge',
      CheckDuplicate: true,
    });
  }
}

async function ensureRtspGateway() {
  await assertDockerAndImage();
  await ensureRtspNetwork();

  let container = null;
  const found = await docker.listContainers({
    all: true,
    filters: {
      name: [RTSP_GATEWAY_CONTAINER],
      label: ['virtualwebcam.rtspGateway=true'],
    },
  });

  if (found.length > 0) {
    container = docker.getContainer(found[0].Id);
  } else {
    container = await docker.createContainer({
      Image: IMAGE,
      name: RTSP_GATEWAY_CONTAINER,
      Env: [
        'OUTPUT_MODE=rtsp-gateway',
        `MEDIAMTX_RTSP_PORT=${RTSP_GATEWAY_PORT}`,
      ],
      Labels: {
        'virtualwebcam.managed': 'true',
        'virtualwebcam.rtspGateway': 'true',
      },
      ExposedPorts: {
        [`${RTSP_GATEWAY_PORT}/tcp`]: {},
      },
      HostConfig: {
        RestartPolicy: {
          Name: 'unless-stopped',
        },
        PortBindings: {
          [`${RTSP_GATEWAY_PORT}/tcp`]: [{ HostPort: RTSP_GATEWAY_PORT }],
        },
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [RTSP_NETWORK]: {
            Aliases: [RTSP_GATEWAY_CONTAINER],
          },
        },
      },
    });
  }

  const info = await container.inspect();
  if (!info.State.Running) {
    await container.start();
  }

  return container.inspect();
}

function decodeDockerLog(buffer) {
  if (!buffer || buffer.length === 0) {
    return '';
  }

  const chunks = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const streamType = buffer[offset];
    const length = buffer.readUInt32BE(offset + 4);

    if ((streamType !== 1 && streamType !== 2) || length < 0 || offset + 8 + length > buffer.length) {
      return buffer.toString('utf8');
    }

    chunks.push(buffer.subarray(offset + 8, offset + 8 + length).toString('utf8'));
    offset += 8 + length;
  }

  if (offset < buffer.length) {
    chunks.push(buffer.subarray(offset).toString('utf8'));
  }

  return chunks.join('');
}

function padNumber(value, size = 2) {
  return String(value).padStart(size, '0');
}

function formatDateChinaTime(date) {
  const chinaTime = new Date(date.getTime() + 8 * 60 * 60 * 1000);

  return [
    chinaTime.getUTCFullYear(),
    '-',
    padNumber(chinaTime.getUTCMonth() + 1),
    '-',
    padNumber(chinaTime.getUTCDate()),
    ' ',
    padNumber(chinaTime.getUTCHours()),
    ':',
    padNumber(chinaTime.getUTCMinutes()),
    ':',
    padNumber(chinaTime.getUTCSeconds()),
    '.',
    padNumber(chinaTime.getUTCMilliseconds(), 3),
    ' +08:00',
  ].join('');
}

function parseDockerTimestamp(value) {
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})$/);
  if (!match) {
    return null;
  }

  const [, base, fraction = '0', zone] = match;
  const millis = fraction.padEnd(3, '0').slice(0, 3);
  const normalizedZone = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const date = new Date(`${base}.${millis}${normalizedZone}`);

  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDockerLogLineChinaTime(line) {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)(.*)$/);
  if (!match) {
    return line;
  }

  const date = parseDockerTimestamp(match[1]);
  if (!date) {
    return line;
  }

  return `${formatDateChinaTime(date)}${match[2]}`;
}

function formatDockerLogsChinaTime(logs) {
  return String(logs || '')
    .split('\n')
    .map(formatDockerLogLineChinaTime)
    .join('\n');
}

async function findContainer(camera) {
  const found = await docker.listContainers({
    all: true,
    filters: {
      label: [
        'virtualwebcam.managed=true',
        `virtualwebcam.cameraId=${camera.id}`,
      ],
    },
  });

  if (found.length === 0) {
    return null;
  }

  return docker.getContainer(found[0].Id);
}

async function inspectCamera(camera) {
  const container = await findContainer(camera);
  if (!container) {
    return { dockerStatus: 'missing', appStatus: 'stopped' };
  }

  await ensureCameraRestartPolicy(container).catch(() => {});
  const info = await container.inspect();
  const state = info.State || {};

  return {
    dockerStatus: state.Status || (state.Running ? 'running' : 'unknown'),
    appStatus: appStatusFromState(state),
    containerId: info.Id,
  };
}

async function inspectManagedCameras() {
  const containers = await docker.listContainers({
    all: true,
    filters: {
      label: ['virtualwebcam.managed=true'],
    },
  });
  const result = new Map();

  for (const item of containers) {
    const cameraId = Number.parseInt(item.Labels?.['virtualwebcam.cameraId'], 10);
    if (!Number.isFinite(cameraId)) {
      continue;
    }

    await docker.getContainer(item.Id).update({
      RestartPolicy: CAMERA_RESTART_POLICY,
    }).catch(() => {});

    result.set(cameraId, {
      dockerStatus: item.State || item.Status || 'unknown',
      appStatus: item.State === 'running' ? 'running' : (item.State === 'exited' && item.Status?.includes('(0)') ? 'stopped' : 'error'),
      containerId: item.Id,
    });
  }

  return result;
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );

  return results;
}

function appStatusFromListItem(item) {
  if (item.State === 'running') {
    return 'running';
  }

  if (item.State === 'exited' && item.Status?.includes('(0)')) {
    return 'stopped';
  }

  return item.State === 'exited' ? 'error' : appStatusFromState({ Status: item.State });
}

function managedContainerMap(containers) {
  const result = new Map();

  for (const item of containers) {
    const cameraId = Number.parseInt(item.Labels?.['virtualwebcam.cameraId'], 10);
    if (Number.isFinite(cameraId)) {
      result.set(cameraId, item);
    }
  }

  return result;
}

async function collectCameraResourceStats(camera, containerItem) {
  if (!containerItem) {
    return {
      camera_id: camera.id,
      status: 'missing',
    };
  }

  const status = appStatusFromListItem(containerItem);
  if (status !== 'running') {
    return {
      camera_id: camera.id,
      container_id: containerItem.Id,
      status,
    };
  }

  try {
    const container = docker.getContainer(containerItem.Id);
    const stats = await withTimeout(
      container.stats({ stream: false }),
      RESOURCE_STATS_TIMEOUT_MS,
      `Docker stats ${camera.id}`,
    );
    const memory = memoryStats(stats);
    const network = sumNetwork(stats.networks);
    const block = sumBlockIo(stats.blkio_stats?.io_service_bytes_recursive);
    const cpu = cpuPercent(stats);

    return {
      camera_id: camera.id,
      container_id: containerItem.Id,
      status: 'running',
      cpu_percent: cpu,
      memory_usage_bytes: memory.usageBytes,
      memory_limit_bytes: memory.limitBytes,
      memory_percent: memory.percent,
      network_rx_bytes: network.rxBytes,
      network_tx_bytes: network.txBytes,
      block_read_bytes: block.readBytes,
      block_write_bytes: block.writeBytes,
    };
  } catch (error) {
    return {
      camera_id: camera.id,
      container_id: containerItem.Id,
      status: 'unavailable',
      error: error.code === 'ETIMEOUT' ? '采集超时' : friendlyDockerError(error),
    };
  }
}

function summarizeResourceItems(items, total) {
  const summary = {
    cpuPercent: 0,
    memoryUsageBytes: 0,
    memoryLimitBytes: 0,
    networkRxBytes: 0,
    networkTxBytes: 0,
    blockReadBytes: 0,
    blockWriteBytes: 0,
    running: 0,
    sampled: 0,
    failed: 0,
    total,
  };

  for (const item of items) {
    if (item.status === 'running') {
      summary.running += 1;
      summary.sampled += 1;
    } else if (item.status === 'unavailable') {
      summary.running += 1;
      summary.failed += 1;
    }

    if (item.status !== 'running') {
      continue;
    }

    summary.cpuPercent += item.cpu_percent || 0;
    summary.memoryUsageBytes += item.memory_usage_bytes || 0;
    summary.memoryLimitBytes += item.memory_limit_bytes || 0;
    summary.networkRxBytes += item.network_rx_bytes || 0;
    summary.networkTxBytes += item.network_tx_bytes || 0;
    summary.blockReadBytes += item.block_read_bytes || 0;
    summary.blockWriteBytes += item.block_write_bytes || 0;
  }

  summary.memoryPercent = summary.memoryLimitBytes > 0
    ? (summary.memoryUsageBytes / summary.memoryLimitBytes) * 100
    : 0;

  return summary;
}

async function cameraResourceStats(cameras) {
  const containers = await withTimeout(
    docker.listContainers({
      all: true,
      filters: {
        label: ['virtualwebcam.managed=true'],
      },
    }),
    RESOURCE_STATS_TIMEOUT_MS,
    'Docker container list',
  );
  const containersByCameraId = managedContainerMap(containers);
  const items = await mapWithConcurrency(
    cameras,
    RESOURCE_STATS_CONCURRENCY,
    (camera) => collectCameraResourceStats(camera, containersByCameraId.get(camera.id)),
  );
  const summary = summarizeResourceItems(items, cameras.length);

  return {
    collected_at: new Date().toISOString(),
    summary,
    items,
  };
}

async function createContainer(camera) {
  if (sourceType(camera) === 'rtsp') {
    await ensureRtspGateway();

    return docker.createContainer({
      Image: IMAGE,
      name: containerName(camera),
      Env: dockerEnv(camera),
      Labels: labels(camera),
      HostConfig: {
        RestartPolicy: CAMERA_RESTART_POLICY,
      },
      NetworkingConfig: {
        EndpointsConfig: {
          [RTSP_NETWORK]: {},
        },
      },
    });
  }

  await assertCreatePrerequisites();

  const endpointsConfig = {};

  if (EGRESS_NETWORK && EGRESS_NETWORK !== DOCKER_NETWORK) {
    endpointsConfig[EGRESS_NETWORK] = {};
  }

  endpointsConfig[DOCKER_NETWORK] = {
    IPAMConfig: {
      IPv4Address: camera.ip,
    },
  };

  return docker.createContainer({
    Image: IMAGE,
    name: containerName(camera),
    Env: dockerEnv(camera),
    Labels: labels(camera),
    HostConfig: {
      RestartPolicy: CAMERA_RESTART_POLICY,
    },
    NetworkingConfig: {
      EndpointsConfig: endpointsConfig,
    },
  });
}

async function ensureCameraRestartPolicy(container) {
  await container.update({
    RestartPolicy: CAMERA_RESTART_POLICY,
  });
}

async function ensureStarted(camera) {
  let container = await findContainer(camera);

  if (!container) {
    container = await createContainer(camera);
  }

  await ensureCameraRestartPolicy(container);

  const info = await container.inspect();
  if (!info.State.Running) {
    await container.start();
  }

  return container.inspect();
}

async function stopCamera(camera) {
  const container = await findContainer(camera);
  if (!container) {
    return null;
  }

  const info = await container.inspect();
  if (info.State.Running) {
    await container.stop({ t: 10 });
  }

  return container.inspect();
}

async function restartCamera(camera) {
  const container = await findContainer(camera);
  if (!container) {
    return ensureStarted(camera);
  }

  await ensureCameraRestartPolicy(container);

  const info = await container.inspect();
  if (info.State.Running) {
    await container.restart({ t: 10 });
  } else {
    await container.start();
  }

  return container.inspect();
}

async function removeCameraContainer(camera) {
  const container = await findContainer(camera);
  if (!container) {
    return false;
  }

  await container.remove({ force: true });
  return true;
}

async function recreateCamera(camera) {
  await removeCameraContainer(camera);
  return ensureStarted(camera);
}

async function cameraLogs(camera, tail = 300) {
  const container = await findContainer(camera);
  if (!container) {
    return '';
  }

  const buffer = await container.logs({
    stdout: true,
    stderr: true,
    timestamps: true,
    tail,
  });

  return formatDockerLogsChinaTime(decodeDockerLog(buffer));
}

module.exports = {
  DOCKER_NETWORK,
  EGRESS_NETWORK,
  IMAGE,
  CAMERA_RTSP_PORT,
  RTSP_GATEWAY_HOST,
  RTSP_GATEWAY_PORT,
  cameraLogs,
  cameraResourceStats,
  ensureStarted,
  formatDockerLogsChinaTime,
  friendlyDockerError,
  inspectCamera,
  inspectManagedCameras,
  recreateCamera,
  removeCameraContainer,
  restartCamera,
  runtimeStatus,
  stopCamera,
};
