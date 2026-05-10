const JSON_HEADERS = {
  'Content-Type': 'application/json',
};

const API_TOKEN = import.meta.env.VITE_API_TOKEN || window.localStorage.getItem('virtualwebcam-api-token') || '';

function withAuthHeaders(headers = {}) {
  if (!API_TOKEN) {
    return headers;
  }

  return {
    ...headers,
    'X-API-Token': API_TOKEN,
  };
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
    throw new Error(detail);
  }

  return payload;
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
