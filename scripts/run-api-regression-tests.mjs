import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '..');
const backendDir = path.join(rootDir, 'backend');
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'virtualwebcam-api-test-'));
const port = String(8300 + Math.floor(Math.random() * 500));
const baseUrl = `http://127.0.0.1:${port}/api`;

let server;
let serverOutput = '';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function startServer() {
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: backendDir,
    env: {
      ...process.env,
      PORT: port,
      SQLITE_PATH: path.join(tempDir, 'virtualwebcam-test.db'),
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'admin123456',
      SESSION_SECRET: 'api-regression-test-secret',
      API_TOKEN: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  server.stdout.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on('data', (chunk) => {
    serverOutput += chunk.toString();
  });
}

async function stopServer() {
  if (server && !server.killed) {
    server.kill('SIGTERM');
  }

  await fs.rm(tempDir, { recursive: true, force: true });
}

async function request(pathname, {
  method = 'GET',
  token = '',
  body,
  expected = 200,
} = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (response.status !== expected) {
    throw new Error(`Expected ${method} ${pathname} -> ${expected}, got ${response.status}: ${text}`);
  }

  return payload;
}

async function login(username, password) {
  const payload = await request('/auth/login', {
    method: 'POST',
    body: { username, password },
  });

  assert(payload.token, `login failed for ${username}`);
  return payload.token;
}

async function waitForServer() {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10000) {
    if (server.exitCode !== null) {
      throw new Error(`Backend exited early:\n${serverOutput}`);
    }

    try {
      return await login('admin', 'admin123456');
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  throw new Error(`Backend did not become ready:\n${serverOutput}`);
}

try {
  startServer();
  const adminToken = await waitForServer();

  await request('/auth/login', {
    method: 'POST',
    body: { username: 'admin', password: 'bad-password' },
    expected: 401,
  });

  const project = await request('/projects', {
    method: 'POST',
    token: adminToken,
    body: {
      name: '回归测试项目',
      rows: 2,
      cols: 2,
      prefix: '屏',
    },
    expected: 201,
  });

  const screenUrl = await request(`/screen-urls?project_id=${project.id}`, {
    method: 'POST',
    token: adminToken,
    body: {
      name: '大厅看板',
      url: 'https://example.com/dashboard',
      remark: 'API regression',
    },
    expected: 201,
  });
  assert(screenUrl.id, 'screen URL was not created');

  const screenUrls = await request(`/screen-urls?project_id=${project.id}`, { token: adminToken });
  assert(screenUrls.length === 1 && screenUrls[0].name === '大厅看板', 'screen URL list mismatch');

  const user = await request('/users', {
    method: 'POST',
    token: adminToken,
    body: {
      username: 'operator1',
      password: 'operator123',
      display_name: '项目操作员',
      role: 'user',
      enabled: true,
    },
    expected: 201,
  });

  await request(`/users/${user.id}/projects`, {
    method: 'PUT',
    token: adminToken,
    body: {
      projects: [{ project_id: project.id, role: 'viewer' }],
    },
  });

  const userToken = await login('operator1', 'operator123');
  const visibleProjects = await request('/projects', { token: userToken });
  assert(
    visibleProjects.length === 1 && visibleProjects[0].id === project.id && visibleProjects[0].permission_role === 'viewer',
    'viewer project visibility mismatch',
  );

  await request(`/screen-urls?project_id=${project.id}`, {
    method: 'POST',
    token: userToken,
    body: {
      name: '禁止写入',
      url: 'https://example.com/blocked',
      remark: '',
    },
    expected: 403,
  });

  await request(`/users/${user.id}/projects`, {
    method: 'PUT',
    token: adminToken,
    body: {
      projects: [{ project_id: project.id, role: 'operator' }],
    },
  });

  const extraScreenUrl = await request(`/screen-urls?project_id=${project.id}`, {
    method: 'POST',
    token: userToken,
    body: {
      name: '生产看板',
      url: 'https://example.com/production',
      remark: '',
    },
    expected: 201,
  });
  assert(extraScreenUrl.name === '生产看板', 'operator could not create screen URL');

  const bulkResult = await request(`/cameras/bulk?project_id=${project.id}`, {
    method: 'POST',
    token: userToken,
    body: {
      count: 2,
      start_ip: '192.168.77.211',
      name_prefix: 'web-cam-',
      stream_prefix: 'screen',
      web_url: 'https://example.com/dashboard',
      width: 1280,
      height: 720,
      fps: 15,
    },
    expected: 201,
  });
  assert(bulkResult.cameras.length === 2, 'bulk camera creation failed');

  const bulkRtspResult = await request(`/cameras/bulk?project_id=${project.id}`, {
    method: 'POST',
    token: userToken,
    body: {
      source_type: 'rtsp',
      count: 2,
      name_prefix: 'rtsp-source-',
      stream_prefix: 'bulk-rtsp-',
      web_url: 'https://example.com/rtsp-dashboard',
      width: 1280,
      height: 720,
      fps: 15,
    },
    expected: 201,
  });
  assert(bulkRtspResult.cameras.length === 2, 'bulk RTSP creation failed');
  assert(bulkRtspResult.cameras.every((camera) => camera.source_type === 'rtsp' && camera.ip === null), 'bulk RTSP should not allocate camera IPs');

  const [cameraA, cameraB] = bulkResult.cameras;
  await request(`/cameras/${cameraA.id}/display-targets`, {
    method: 'PATCH',
    token: userToken,
    body: {
      display_targets: [1],
      display_region: null,
    },
  });

  await request(`/cameras/${cameraB.id}/display-targets`, {
    method: 'PATCH',
    token: userToken,
    body: {
      display_targets: [1],
      display_region: null,
    },
    expected: 409,
  });

  await request(`/cameras/${cameraB.id}/display-targets`, {
    method: 'PATCH',
    token: userToken,
    body: {
      display_targets: [],
      display_region: {
        row: 1,
        col: 2,
        row_span: 1,
        col_span: 1,
      },
    },
  });

  const exported = await request(`/projects/${project.id}/export`, { token: adminToken });
  assert(exported.cameras.length === 4, 'exported camera count mismatch');
  assert(exported.screen_urls.length === 2, 'exported screen URL count mismatch');
  assert(exported.summary.screen_url_count === 2, 'exported screen URL summary mismatch');

  const imported = await request('/projects/import', {
    method: 'POST',
    token: adminToken,
    body: exported,
    expected: 201,
  });
  assert(imported.cameras.length === 4, 'imported camera count mismatch');
  assert(imported.screen_urls.length === 2, 'imported screen URL count mismatch');
  assert(imported.remapped_ips.length === 2, 'import should remap duplicate camera IPs');
  assert(imported.remapped_streams.length === 2, 'import should remap duplicate RTSP stream names');

  const importedScreenUrls = await request(`/screen-urls?project_id=${imported.project.id}`, { token: adminToken });
  assert(importedScreenUrls.length === 2, 'imported screen URL list mismatch');

  const rtspImportPayload = {
    project: {
      name: 'RTSP 导入项目',
      rows: 1,
      cols: 1,
      prefix: '屏',
    },
    cameras: [{
      source_type: 'rtsp',
      name: '共享 RTSP 流源',
      ip: null,
      stream_name: 'shared-screen',
      web_url: 'https://example.com/shared',
      width: 1280,
      height: 720,
      fps: 15,
      display_targets: [],
      display_region: null,
    }],
    screen_urls: [],
  };
  const firstRtspImport = await request('/projects/import', {
    method: 'POST',
    token: adminToken,
    body: rtspImportPayload,
    expected: 201,
  });
  assert(firstRtspImport.cameras[0].stream_name === 'shared-screen', 'first RTSP import should keep stream name');

  const secondRtspImport = await request('/projects/import', {
    method: 'POST',
    token: adminToken,
    body: rtspImportPayload,
    expected: 201,
  });
  assert(secondRtspImport.remapped_streams.length === 1, 'duplicate RTSP import should remap stream name');
  assert(secondRtspImport.cameras[0].stream_name === 'shared-screen-import', 'RTSP stream remap mismatch');

  const projectsBeforeFailedImport = await request('/projects', { token: adminToken });
  await request('/projects/import', {
    method: 'POST',
    token: adminToken,
    body: {
      project: {
        name: '失败导入项目',
        rows: 1,
        cols: 2,
        prefix: '屏',
      },
      screen_urls: [{
        name: '失败前置地址',
        url: 'https://example.com/fail-before-camera',
        remark: '',
      }],
      cameras: [
        {
          source_type: 'camera',
          name: '失败导入 A',
          ip: '192.168.88.211',
          stream_name: 'failed-a',
          web_url: 'https://example.com/a',
          width: 1280,
          height: 720,
          fps: 15,
          display_targets: [1],
          display_region: null,
        },
        {
          source_type: 'camera',
          name: '失败导入 B',
          ip: '192.168.88.212',
          stream_name: 'failed-b',
          web_url: 'https://example.com/b',
          width: 1280,
          height: 720,
          fps: 15,
          display_targets: [1],
          display_region: null,
        },
      ],
    },
    expected: 400,
  });
  const projectsAfterFailedImport = await request('/projects', { token: adminToken });
  assert(
    projectsAfterFailedImport.length === projectsBeforeFailedImport.length,
    'failed import should clean up partially created project',
  );

  console.log('API regression tests passed');
} finally {
  await stopServer();
}
