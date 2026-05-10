const Docker = require('dockerode');

const docker = new Docker({
  socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock',
});

const DOCKER_NETWORK = process.env.DOCKER_NETWORK || 'onvif_macvlan';
const EGRESS_NETWORK = process.env.DOCKER_EGRESS_NETWORK || 'bridge';
const IMAGE = process.env.VIRTUALWEBCAM_IMAGE || 'virtualwebcam:latest';
const CONTAINER_PREFIX = process.env.CONTAINER_PREFIX || 'virtualwebcam';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';

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

function labels(camera) {
  return {
    'virtualwebcam.managed': 'true',
    'virtualwebcam.cameraId': String(camera.id),
  };
}

function dockerEnv(camera) {
  return [
    `WEB_URL=${camera.web_url}`,
    `STREAM_NAME=${camera.stream_name}`,
    `WIDTH=${camera.width || 1280}`,
    `HEIGHT=${camera.height || 720}`,
    `FPS=${camera.fps || 15}`,
  ];
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

function appStatusFromState(state = {}) {
  if (state.Running) {
    return 'running';
  }

  if (state.Status === 'exited' || state.Status === 'created' || state.Status === 'dead') {
    return state.ExitCode === 0 ? 'stopped' : 'error';
  }

  return 'stopped';
}

async function inspectCamera(camera) {
  const container = await findContainer(camera);
  if (!container) {
    return { dockerStatus: 'missing', appStatus: 'stopped' };
  }

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

    result.set(cameraId, {
      dockerStatus: item.State || item.Status || 'unknown',
      appStatus: item.State === 'running' ? 'running' : (item.State === 'exited' && item.Status?.includes('(0)') ? 'stopped' : 'error'),
      containerId: item.Id,
    });
  }

  return result;
}

async function createContainer(camera) {
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
      RestartPolicy: {
        Name: 'unless-stopped',
      },
    },
    NetworkingConfig: {
      EndpointsConfig: endpointsConfig,
    },
  });
}

async function ensureStarted(camera) {
  let container = await findContainer(camera);

  if (!container) {
    container = await createContainer(camera);
  }

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

  return decodeDockerLog(buffer);
}

module.exports = {
  DOCKER_NETWORK,
  EGRESS_NETWORK,
  IMAGE,
  cameraLogs,
  ensureStarted,
  friendlyDockerError,
  inspectCamera,
  inspectManagedCameras,
  recreateCamera,
  removeCameraContainer,
  restartCamera,
  runtimeStatus,
  stopCamera,
};
