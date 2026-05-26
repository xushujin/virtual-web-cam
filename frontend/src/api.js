const JSON_HEADERS = {
  'Content-Type': 'application/json',
};

const AUTH_TOKEN_KEY = 'virtualwebcam-auth-token';
const UNAUTHORIZED_EVENT = 'virtualwebcam:unauthorized';

function withAuthHeaders(headers = {}) {
  const sessionToken = window.localStorage.getItem(AUTH_TOKEN_KEY) || '';

  if (sessionToken) {
    return {
      ...headers,
      Authorization: `Bearer ${sessionToken}`,
    };
  }

  return headers;
}

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: withAuthHeaders(options.headers || {}),
  });
  const isJson = response.headers.get('content-type')?.includes('application/json');
  const payload = isJson ? await response.json() : null;

  if (!response.ok) {
    const detail = payload?.error || response.statusText || 'Request failed';
    const sessionExpired = response.status === 401 && path !== '/api/auth/login';
    const error = new Error(sessionExpired ? '登录已过期，请重新登录' : detail);
    error.status = response.status;

    if (sessionExpired) {
      storeAuthToken('');
      window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT, {
        detail: {
          message: error.message,
        },
      }));
    }

    throw error;
  }

  return payload;
}

export function storeAuthToken(token) {
  if (token) {
    window.localStorage.setItem(AUTH_TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(AUTH_TOKEN_KEY);
  }
}

export function hasStoredAuthToken() {
  return Boolean(window.localStorage.getItem(AUTH_TOKEN_KEY));
}

export function login(credentials) {
  return request('/api/auth/login', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(credentials),
  });
}

export function getCurrentUser() {
  return request('/api/auth/me');
}

export function changePassword(payload) {
  return request('/api/auth/password', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export function listUsers() {
  return request('/api/users');
}

export function createUser(user) {
  return request('/api/users', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(user),
  });
}

export function updateUser(id, user) {
  return request(`/api/users/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(user),
  });
}

export function listUserProjects(id) {
  return request(`/api/users/${id}/projects`);
}

export function updateUserProjects(id, projects) {
  return request(`/api/users/${id}/projects`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ projects }),
  });
}

function withProject(path, projectId) {
  if (!projectId) {
    return path;
  }

  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}project_id=${projectId}`;
}

export function listProjects() {
  return request('/api/projects');
}

export function createProject(project) {
  return request('/api/projects', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(project),
  });
}

export function updateProject(id, project) {
  return request(`/api/projects/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(project),
  });
}

export function exportProjectConfig(id) {
  return request(`/api/projects/${id}/export`);
}

export function importProjectConfig(config) {
  return request('/api/projects/import', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  });
}

export function listCameras(projectId) {
  return request(withProject('/api/cameras', projectId));
}

export function listCameraStatuses(projectId) {
  return request(withProject('/api/cameras/statuses', projectId));
}

export function getResourceStats(projectId) {
  return request(withProject('/api/resource-stats', projectId));
}

export function createCamera(camera, projectId) {
  return request(withProject('/api/cameras', projectId), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(camera),
  });
}

export function bulkCreateCameras(payload, projectId) {
  return request(withProject('/api/cameras/bulk', projectId), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export function updateCamera(id, camera) {
  return request(`/api/cameras/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(camera),
  });
}

export function updateCameraTargets(id, displayTargets, displayRegion = null) {
  return request(`/api/cameras/${id}/display-targets`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      display_targets: displayTargets,
      display_region: displayRegion,
    }),
  });
}

export function startCamera(id) {
  return request(`/api/cameras/${id}/start`, { method: 'POST' });
}

export function stopCamera(id) {
  return request(`/api/cameras/${id}/stop`, { method: 'POST' });
}

export function restartCamera(id) {
  return request(`/api/cameras/${id}/restart`, { method: 'POST' });
}

export async function deleteCamera(id) {
  return request(`/api/cameras/${id}`, { method: 'DELETE' });
}

export function getLogs(id) {
  return request(`/api/cameras/${id}/logs`);
}

export function listAuditLogs(projectId, limit = 80) {
  return request(withProject(`/api/audit-logs?limit=${limit}`, projectId));
}

export function getHealth() {
  return request('/api/health');
}

export function getDatabaseBackupConfig() {
  return request('/api/system/database-backup');
}

export function updateDatabaseBackupConfig(config) {
  return request('/api/system/database-backup', {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(config),
  });
}

export function runDatabaseBackup() {
  return request('/api/system/database-backup/run', {
    method: 'POST',
  });
}

export function listDatabaseBackupFiles() {
  return request('/api/system/database-backup/files');
}

export function restoreDatabaseBackup(file) {
  return request('/api/system/database-backup/restore', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({
      file,
      confirmation: 'RESTORE',
    }),
  });
}

export function getScreenMatrix(projectId) {
  return request(withProject('/api/screen-matrix', projectId));
}

export function updateScreenMatrix(matrix, projectId) {
  return request(withProject('/api/screen-matrix', projectId), {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(matrix),
  });
}

export function listScreenUrls(projectId) {
  return request(withProject('/api/screen-urls', projectId));
}

export function createScreenUrl(payload, projectId) {
  return request(withProject('/api/screen-urls', projectId), {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export function updateScreenUrl(id, payload) {
  return request(`/api/screen-urls/${id}`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify(payload),
  });
}

export function deleteScreenUrl(id) {
  return request(`/api/screen-urls/${id}`, { method: 'DELETE' });
}
