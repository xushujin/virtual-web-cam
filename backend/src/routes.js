const express = require('express');
const { z } = require('zod');
const { getDb } = require('./db');
const dockerService = require('./docker');

const router = express.Router();

const displayTargetsSchema = z.array(z.coerce.number().int().min(1).max(9999)).max(300).default([]);
const displayRegionSchema = z.object({
  row: z.coerce.number().int().min(1).max(9999),
  col: z.coerce.number().int().min(1).max(9999),
  row_span: z.coerce.number().int().min(1).max(9999).default(1),
  col_span: z.coerce.number().int().min(1).max(9999).default(1),
}).nullable();

const cameraSchema = z.object({
  name: z.string().trim().min(1).max(80),
  ip: z.string().trim().ip({ version: 'v4' }),
  stream_name: z.string().trim().regex(/^[A-Za-z0-9._-]+$/).min(1).max(80),
  web_url: z.string().trim().url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'web_url must start with http:// or https://',
  }),
  width: z.coerce.number().int().min(320).max(7680).default(1280),
  height: z.coerce.number().int().min(240).max(4320).default(720),
  fps: z.coerce.number().int().min(1).max(60).default(15),
  display_targets: displayTargetsSchema,
  display_region: displayRegionSchema.optional().default(null),
});

const cameraUpdateSchema = cameraSchema.omit({
  display_targets: true,
  display_region: true,
});

const matrixSchema = z.object({
  rows: z.coerce.number().int().min(1).max(20),
  cols: z.coerce.number().int().min(1).max(30),
  prefix: z.string().trim().min(1).max(8).default('屏'),
});

const projectSchema = matrixSchema.extend({
  name: z.string().trim().min(1).max(80),
});

const projectImportSchema = z.object({
  project: projectSchema,
  cameras: z.array(cameraSchema.passthrough()).max(1000).default([]),
}).passthrough();

const cameraBulkCreateSchema = z.object({
  count: z.coerce.number().int().min(1).max(200),
  start_ip: z.string().trim().ip({ version: 'v4' }),
  name_prefix: z.string().trim().min(1).max(60).default('web-cam-'),
  stream_prefix: z.string().trim().regex(/^[A-Za-z0-9._-]+$/).min(1).max(60).default('screen'),
  web_url: z.string().trim().url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'web_url must start with http:// or https://',
  }),
  width: z.coerce.number().int().min(320).max(7680).default(1280),
  height: z.coerce.number().int().min(240).max(4320).default(720),
  fps: z.coerce.number().int().min(1).max(60).default(15),
});

const displayTargetsPayloadSchema = z.object({
  display_targets: displayTargetsSchema,
  display_region: displayRegionSchema.optional().default(null),
});

function normalizeDisplayTargets(targets) {
  return [...new Set((targets || []).map((target) => Number.parseInt(target, 10)).filter(Number.isFinite))].sort((a, b) => a - b);
}

function parseDisplayTargets(value) {
  if (Array.isArray(value)) {
    return normalizeDisplayTargets(value);
  }

  if (!value) {
    return [];
  }

  try {
    return normalizeDisplayTargets(JSON.parse(value));
  } catch {
    return [];
  }
}

function parseDisplayRegion(value) {
  if (!value) {
    return null;
  }

  if (typeof value === 'object') {
    const parsed = displayRegionSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  }

  try {
    const parsed = displayRegionSchema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseJsonSetting(value, fallback) {
  try {
    return { ...fallback, ...JSON.parse(value) };
  } catch {
    return fallback;
  }
}

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function projectIdFromRequest(req) {
  const raw = req.query.project_id || req.params.projectId || req.body.project_id || 1;
  const id = Number.parseInt(raw, 10);
  return Number.isFinite(id) && id > 0 ? id : 1;
}

async function getProjectOr404(req, res) {
  const db = getDb();
  const id = Number.parseInt(req.params.id || req.params.projectId, 10);
  const project = await db.get('SELECT * FROM projects WHERE id = ?', id);

  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }

  return project;
}

async function getScreenMatrix(projectId = 1) {
  const db = getDb();
  const fallback = { rows: 6, cols: 8, prefix: '屏' };
  const project = await db.get('SELECT rows, cols, prefix FROM projects WHERE id = ?', projectId);

  if (project) {
    return {
      rows: project.rows,
      cols: project.cols,
      prefix: project.prefix,
    };
  }

  const row = await db.get('SELECT value FROM settings WHERE key = ?', 'screen_matrix');

  if (!row) {
    return fallback;
  }

  return parseJsonSetting(row.value, fallback);
}

async function setScreenMatrix(matrix, projectId = 1) {
  const db = getDb();
  const project = await db.get('SELECT id, rows, cols, prefix FROM projects WHERE id = ?', projectId);

  if (project) {
    await db.run(
      'UPDATE projects SET rows = ?, cols = ?, prefix = ? WHERE id = ?',
      matrix.rows,
      matrix.cols,
      matrix.prefix,
      projectId,
    );
  } else {
    await db.run(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('screen_matrix', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      JSON.stringify(matrix),
    );
  }
}

function addUrls(camera) {
  return {
    ...camera,
    project_id: camera.project_id || 1,
    display_targets: parseDisplayTargets(camera.display_targets),
    display_region: parseDisplayRegion(camera.display_region),
    rtsp_url: `rtsp://${camera.ip}:8554/${camera.stream_name}`,
    onvif_url: `http://${camera.ip}/onvif/device_service`,
    go2rtc_url: `http://${camera.ip}`,
  };
}

function indexFromRowCol(row, col, cols) {
  return (row - 1) * cols + col;
}

function targetsFromRegion(region, project) {
  if (!region) {
    return [];
  }

  const rowEnd = region.row + region.row_span - 1;
  const colEnd = region.col + region.col_span - 1;

  if (rowEnd > project.rows || colEnd > project.cols) {
    throw new ApiError('Display region exceeds project screen matrix', 400);
  }

  const targets = [];

  for (let row = region.row; row <= rowEnd; row += 1) {
    for (let col = region.col; col <= colEnd; col += 1) {
      targets.push(indexFromRowCol(row, col, project.cols));
    }
  }

  return targets;
}

async function uniqueProjectName(baseName) {
  const db = getDb();
  const base = `${baseName || '导入项目'} 导入`;
  const existing = await db.all('SELECT name FROM projects WHERE name LIKE ?', `${base}%`);
  const used = new Set(existing.map((project) => project.name));

  if (!used.has(base)) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }

  return `${base} ${Date.now()}`;
}

async function availableIp(preferredIp, reservedIps = new Set()) {
  const db = getDb();
  const existingRows = await db.all('SELECT ip FROM cameras');
  const used = new Set(existingRows.map((camera) => camera.ip));
  const parts = String(preferredIp || '').split('.').map((part) => Number.parseInt(part, 10));

  if (
    parts.length !== 4 ||
    parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  ) {
    throw new ApiError(`Invalid camera IP: ${preferredIp}`, 400);
  }

  const format = (last) => `${parts[0]}.${parts[1]}.${parts[2]}.${last}`;
  if (!used.has(preferredIp) && !reservedIps.has(preferredIp)) {
    return preferredIp;
  }

  for (let last = parts[3] + 1; last <= 254; last += 1) {
    const candidate = format(last);
    if (!used.has(candidate) && !reservedIps.has(candidate)) {
      return candidate;
    }
  }

  for (let last = 2; last < parts[3]; last += 1) {
    const candidate = format(last);
    if (!used.has(candidate) && !reservedIps.has(candidate)) {
      return candidate;
    }
  }

  throw new ApiError(`No available IP in subnet for ${preferredIp}`, 409);
}

function resolveDisplayAssignment(displayTargets, displayRegion, project) {
  const region = parseDisplayRegion(displayRegion);

  if (region) {
    return {
      displayTargets: targetsFromRegion(region, project),
      displayRegion: region,
    };
  }

  const maxTarget = project.rows * project.cols;
  const targets = normalizeDisplayTargets(displayTargets);
  const invalidTarget = targets.find((target) => target > maxTarget);

  if (targets.length > 1) {
    throw new ApiError('Multiple display targets require display_region', 400);
  }

  if (invalidTarget) {
    throw new ApiError(`Display target ${invalidTarget} exceeds project screen matrix`, 400);
  }

  return {
    displayTargets: targets,
    displayRegion: null,
  };
}

async function assertDisplayTargetsAvailable(projectId, cameraId, displayTargets) {
  if (displayTargets.length === 0) {
    return;
  }

  const db = getDb();
  const cameras = await db.all(
    'SELECT id, name, display_targets FROM cameras WHERE project_id = ? AND id <> ?',
    projectId,
    cameraId || 0,
  );
  const requested = new Set(displayTargets);

  for (const camera of cameras) {
    const occupied = parseDisplayTargets(camera.display_targets);
    const overlap = occupied.find((target) => requested.has(target));

    if (overlap) {
      throw new ApiError(`Screen ${overlap} is already assigned to ${camera.name}`, 409);
    }
  }
}

async function getCameraOr404(req, res) {
  const db = getDb();
  const camera = await db.get('SELECT * FROM cameras WHERE id = ?', req.params.id);

  if (!camera) {
    res.status(404).json({ error: 'Camera not found' });
    return null;
  }

  return camera;
}

async function setStatus(id, status) {
  const db = getDb();
  await db.run('UPDATE cameras SET status = ? WHERE id = ?', status, id);
}

async function syncCameraStatuses(projectId) {
  const db = getDb();
  const cameras = await db.all('SELECT * FROM cameras WHERE project_id = ? ORDER BY id DESC', projectId);
  const inspectedByCameraId = await dockerService.inspectManagedCameras().catch(() => null);

  for (const camera of cameras) {
    const inspected = inspectedByCameraId
      ? inspectedByCameraId.get(camera.id) || { appStatus: 'stopped' }
      : { appStatus: 'error' };

    if (inspected.appStatus && inspected.appStatus !== camera.status) {
      await setStatus(camera.id, inspected.appStatus);
      camera.status = inspected.appStatus;
    }
  }

  return cameras;
}

function errorResponse(res, error, status = 500) {
  res.status(status).json({
    error: dockerService.friendlyDockerError(error),
  });
}

async function recordAudit({
  projectId = null,
  cameraId = null,
  action,
  targetType,
  targetName = '',
  detail = {},
}) {
  try {
    await getDb().run(
      `INSERT INTO audit_logs (project_id, camera_id, action, target_type, target_name, detail)
       VALUES (?, ?, ?, ?, ?, ?)`,
      projectId,
      cameraId,
      action,
      targetType,
      targetName,
      JSON.stringify(detail || {}),
    );
  } catch (error) {
    console.warn('Failed to record audit log:', error.message);
  }
}

router.get('/health', async (req, res) => {
  const runtime = await dockerService.runtimeStatus();

  res.json({
    ok: true,
    docker_network: dockerService.DOCKER_NETWORK,
    image: dockerService.IMAGE,
    runtime,
  });
});

router.get('/projects', async (req, res) => {
  try {
    const projects = await getDb().all('SELECT * FROM projects ORDER BY id ASC');
    res.json(projects);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/projects/:id/export', async (req, res) => {
  const project = await getProjectOr404(req, res);
  if (!project) return;

  try {
    const cameras = await getDb().all('SELECT * FROM cameras WHERE project_id = ? ORDER BY id ASC', project.id);
    res.json({
      version: 1,
      exported_at: new Date().toISOString(),
      project,
      cameras: cameras.map(addUrls),
      summary: {
        camera_count: cameras.length,
        bound_camera_count: cameras.filter((camera) => parseDisplayTargets(camera.display_targets).length > 0).length,
        screen_count: project.rows * project.cols,
      },
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/audit-logs', async (req, res) => {
  const projectId = projectIdFromRequest(req);
  const limit = Math.min(Math.max(Number.parseInt(req.query.limit || '80', 10) || 80, 1), 300);

  try {
    const rows = await getDb().all(
      `SELECT id, project_id, camera_id, action, target_type, target_name, detail, created_at
       FROM audit_logs
       WHERE project_id = ? OR project_id IS NULL
       ORDER BY id DESC
       LIMIT ?`,
      projectId,
      limit,
    );

    res.json(rows.map((row) => ({
      ...row,
      detail: parseJsonSetting(row.detail, {}),
    })));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post('/projects', async (req, res) => {
  const parsed = projectSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid project payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const project = parsed.data;
    const result = await getDb().run(
      'INSERT INTO projects (name, rows, cols, prefix) VALUES (?, ?, ?, ?)',
      project.name,
      project.rows,
      project.cols,
      project.prefix,
    );
    const created = await getDb().get('SELECT * FROM projects WHERE id = ?', result.lastID);
    await recordAudit({
      projectId: created.id,
      action: 'project.create',
      targetType: 'project',
      targetName: created.name,
      detail: created,
    });
    return res.status(201).json(created);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Project name already exists' });
    }
    return errorResponse(res, error);
  }
});

router.post('/projects/import', async (req, res) => {
  const rawPayload = req.body?.project ? req.body : req.body?.config;
  const parsed = projectImportSchema.safeParse(rawPayload);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid import payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const db = getDb();
    const payload = parsed.data;
    const projectName = await uniqueProjectName(payload.project.name);
    const projectResult = await db.run(
      'INSERT INTO projects (name, rows, cols, prefix) VALUES (?, ?, ?, ?)',
      projectName,
      payload.project.rows,
      payload.project.cols,
      payload.project.prefix,
    );
    const project = await db.get('SELECT * FROM projects WHERE id = ?', projectResult.lastID);
    const reservedIps = new Set();
    const remappedIps = [];
    const occupiedTargets = new Set();
    const importedCameras = [];

    for (const camera of payload.cameras) {
      const assignment = resolveDisplayAssignment(camera.display_targets, camera.display_region, project);
      const overlap = assignment.displayTargets.find((target) => occupiedTargets.has(target));

      if (overlap) {
        throw new ApiError(`Imported camera bindings overlap at ${project.prefix}${String(overlap).padStart(2, '0')}`, 400);
      }

      assignment.displayTargets.forEach((target) => occupiedTargets.add(target));

      const nextIp = await availableIp(camera.ip, reservedIps);
      reservedIps.add(nextIp);

      if (nextIp !== camera.ip) {
        remappedIps.push({
          name: camera.name,
          from: camera.ip,
          to: nextIp,
        });
      }

      const result = await db.run(
        `INSERT INTO cameras
          (name, ip, stream_name, web_url, width, height, fps, status, display_targets, display_region, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?)`,
        camera.name,
        nextIp,
        camera.stream_name,
        camera.web_url,
        camera.width,
        camera.height,
        camera.fps,
        JSON.stringify(assignment.displayTargets),
        assignment.displayRegion ? JSON.stringify(assignment.displayRegion) : null,
        project.id,
      );
      const createdCamera = await db.get('SELECT * FROM cameras WHERE id = ?', result.lastID);
      importedCameras.push(addUrls(createdCamera));
    }

    await recordAudit({
      projectId: project.id,
      action: 'project.import',
      targetType: 'project',
      targetName: project.name,
      detail: {
        source_project: payload.project.name,
        camera_count: importedCameras.length,
        remapped_ips: remappedIps,
      },
    });

    return res.status(201).json({
      project,
      cameras: importedCameras,
      remapped_ips: remappedIps,
    });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.put('/projects/:id', async (req, res) => {
  const project = await getProjectOr404(req, res);
  if (!project) return;

  const parsed = projectSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid project payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const payload = parsed.data;
    await getDb().run(
      'UPDATE projects SET name = ?, rows = ?, cols = ?, prefix = ? WHERE id = ?',
      payload.name,
      payload.rows,
      payload.cols,
      payload.prefix,
      project.id,
    );
    const updated = await getDb().get('SELECT * FROM projects WHERE id = ?', project.id);
    await recordAudit({
      projectId: updated.id,
      action: 'project.update',
      targetType: 'project',
      targetName: updated.name,
      detail: updated,
    });
    res.json(updated);
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Project name already exists' });
    }
    return errorResponse(res, error);
  }
});

router.get('/cameras', async (req, res) => {
  try {
    const projectId = projectIdFromRequest(req);
    const cameras = await syncCameraStatuses(projectId);
    res.json(cameras.map(addUrls));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/cameras/statuses', async (req, res) => {
  try {
    const cameras = await syncCameraStatuses(projectIdFromRequest(req));
    res.json(cameras.map((camera) => ({
      id: camera.id,
      status: camera.status,
    })));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/screen-matrix', async (req, res) => {
  try {
    res.json(await getScreenMatrix(projectIdFromRequest(req)));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.put('/screen-matrix', async (req, res) => {
  const parsed = matrixSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid screen matrix payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    await setScreenMatrix(parsed.data, projectIdFromRequest(req));
    await recordAudit({
      projectId: projectIdFromRequest(req),
      action: 'matrix.update',
      targetType: 'project',
      targetName: 'screen_matrix',
      detail: parsed.data,
    });
    res.json(parsed.data);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post('/cameras/bulk', async (req, res) => {
  const parsed = cameraBulkCreateSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid bulk camera payload',
      details: parsed.error.flatten(),
    });
  }

  const projectId = projectIdFromRequest(req);
  const db = getDb();
  const project = await db.get('SELECT id FROM projects WHERE id = ?', projectId);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  try {
    const payload = parsed.data;
    const reservedIps = new Set();
    const created = [];
    const remappedIps = [];

    for (let offset = 0; offset < payload.count; offset += 1) {
      const number = String(offset + 1).padStart(2, '0');
      const requestedIpParts = payload.start_ip.split('.');
      requestedIpParts[3] = String(Number.parseInt(requestedIpParts[3], 10) + offset);
      const requestedIp = requestedIpParts.join('.');
      const ip = await availableIp(requestedIp, reservedIps);
      reservedIps.add(ip);

      if (ip !== requestedIp) {
        remappedIps.push({
          index: offset + 1,
          from: requestedIp,
          to: ip,
        });
      }

      const result = await db.run(
        `INSERT INTO cameras (project_id, name, ip, stream_name, web_url, width, height, fps, display_targets, display_region, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 'stopped')`,
        projectId,
        `${payload.name_prefix}${number}`,
        ip,
        `${payload.stream_prefix}${number}`,
        payload.web_url,
        payload.width,
        payload.height,
        payload.fps,
      );
      const camera = await db.get('SELECT * FROM cameras WHERE id = ?', result.lastID);
      created.push(addUrls(camera));
    }

    await recordAudit({
      projectId,
      action: 'camera.bulk_create',
      targetType: 'camera',
      targetName: `${created.length} cameras`,
      detail: {
        count: created.length,
        start_ip: payload.start_ip,
        name_prefix: payload.name_prefix,
        stream_prefix: payload.stream_prefix,
        remapped_ips: remappedIps,
      },
    });

    return res.status(201).json({
      cameras: created,
      remapped_ips: remappedIps,
    });
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (String(error.message).includes('SQLITE_CONSTRAINT') || String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Camera IP already exists' });
    }
    return errorResponse(res, error);
  }
});

router.post('/cameras', async (req, res) => {
  const parsed = cameraSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid camera payload',
      details: parsed.error.flatten(),
    });
  }

  const camera = parsed.data;
  const projectId = projectIdFromRequest(req);
  const db = getDb();
  const project = await db.get('SELECT id, rows, cols, prefix FROM projects WHERE id = ?', projectId);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  try {
    const { displayTargets, displayRegion } = resolveDisplayAssignment(camera.display_targets, camera.display_region, project);
    await assertDisplayTargetsAvailable(projectId, 0, displayTargets);

    const result = await db.run(
      `INSERT INTO cameras (project_id, name, ip, stream_name, web_url, width, height, fps, display_targets, display_region, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped')`,
      projectId,
      camera.name,
      camera.ip,
      camera.stream_name,
      camera.web_url,
      camera.width,
      camera.height,
      camera.fps,
      JSON.stringify(displayTargets),
      displayRegion ? JSON.stringify(displayRegion) : null,
    );

    const created = await db.get('SELECT * FROM cameras WHERE id = ?', result.lastID);

    try {
      await dockerService.ensureStarted(created);
      await setStatus(created.id, 'running');
      created.status = 'running';
      await recordAudit({
        projectId,
        cameraId: created.id,
        action: 'camera.create',
        targetType: 'camera',
        targetName: created.name,
        detail: addUrls(created),
      });
      return res.status(201).json(addUrls(created));
    } catch (error) {
      await setStatus(created.id, 'error');
      created.status = 'error';
      await recordAudit({
        projectId,
        cameraId: created.id,
        action: 'camera.create_failed',
        targetType: 'camera',
        targetName: created.name,
        detail: {
          camera: addUrls(created),
          error: dockerService.friendlyDockerError(error),
        },
      });
      return res.status(500).json({
        error: dockerService.friendlyDockerError(error),
        camera: addUrls(created),
      });
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (String(error.message).includes('SQLITE_CONSTRAINT') || String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Camera IP already exists' });
    }
    return errorResponse(res, error);
  }
});

router.put('/cameras/:id', async (req, res) => {
  const camera = await getCameraOr404(req, res);
  if (!camera) return;

  const parsed = cameraUpdateSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid camera payload',
      details: parsed.error.flatten(),
    });
  }

  const payload = parsed.data;
  const db = getDb();
  const projectId = camera.project_id || 1;

  try {
    const duplicateIp = await db.get('SELECT id FROM cameras WHERE ip = ? AND id <> ?', payload.ip, camera.id);
    if (duplicateIp) {
      return res.status(409).json({ error: 'Camera IP already exists' });
    }

    await db.run(
      `UPDATE cameras
       SET name = ?, ip = ?, stream_name = ?, web_url = ?, width = ?, height = ?, fps = ?
       WHERE id = ?`,
      payload.name,
      payload.ip,
      payload.stream_name,
      payload.web_url,
      payload.width,
      payload.height,
      payload.fps,
      camera.id,
    );

    const updated = await db.get('SELECT * FROM cameras WHERE id = ?', camera.id);
    let nextStatus = updated.status;
    let recreateError = null;

    if (camera.status === 'running') {
      try {
        await dockerService.recreateCamera(updated);
        nextStatus = 'running';
      } catch (error) {
        nextStatus = 'error';
        recreateError = dockerService.friendlyDockerError(error);
      }

      await setStatus(camera.id, nextStatus);
      updated.status = nextStatus;
    }

    await recordAudit({
      projectId,
      cameraId: camera.id,
      action: recreateError ? 'camera.update_failed' : 'camera.update',
      targetType: 'camera',
      targetName: updated.name,
      detail: {
        before: addUrls(camera),
        after: addUrls(updated),
        error: recreateError,
      },
    });

    const response = addUrls(updated);
    if (recreateError) {
      response.warning = recreateError;
    }

    return res.json(response);
  } catch (error) {
    if (String(error.message).includes('SQLITE_CONSTRAINT') || String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Camera IP already exists' });
    }
    return errorResponse(res, error);
  }
});

router.patch('/cameras/:id/display-targets', async (req, res) => {
  const camera = await getCameraOr404(req, res);
  if (!camera) return;

  const parsed = displayTargetsPayloadSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid display targets payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const db = getDb();
    const projectId = camera.project_id || 1;
    const project = await db.get('SELECT id, rows, cols, prefix FROM projects WHERE id = ?', projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const { displayTargets, displayRegion } = resolveDisplayAssignment(
      parsed.data.display_targets,
      parsed.data.display_region,
      project,
    );
    await assertDisplayTargetsAvailable(projectId, camera.id, displayTargets);

    await getDb().run(
      'UPDATE cameras SET display_targets = ?, display_region = ? WHERE id = ?',
      JSON.stringify(displayTargets),
      displayRegion ? JSON.stringify(displayRegion) : null,
      camera.id,
    );
    await recordAudit({
      projectId,
      cameraId: camera.id,
      action: 'camera.bind',
      targetType: 'camera',
      targetName: camera.name,
      detail: {
        display_targets: displayTargets,
        display_region: displayRegion,
      },
    });
    res.json(addUrls({ ...camera, display_targets: displayTargets, display_region: displayRegion }));
  } catch (error) {
    if (error instanceof ApiError) {
      return res.status(error.status).json({ error: error.message });
    }
    return errorResponse(res, error);
  }
});

router.post('/cameras/:id/start', async (req, res) => {
  const camera = await getCameraOr404(req, res);
  if (!camera) return;

  try {
    await dockerService.ensureStarted(camera);
    await setStatus(camera.id, 'running');
    await recordAudit({
      projectId: camera.project_id || 1,
      cameraId: camera.id,
      action: 'camera.start',
      targetType: 'camera',
      targetName: camera.name,
    });
    res.json(addUrls({ ...camera, status: 'running' }));
  } catch (error) {
    await setStatus(camera.id, 'error');
    errorResponse(res, error);
  }
});

router.post('/cameras/:id/stop', async (req, res) => {
  const camera = await getCameraOr404(req, res);
  if (!camera) return;

  try {
    await dockerService.stopCamera(camera);
    await setStatus(camera.id, 'stopped');
    await recordAudit({
      projectId: camera.project_id || 1,
      cameraId: camera.id,
      action: 'camera.stop',
      targetType: 'camera',
      targetName: camera.name,
    });
    res.json(addUrls({ ...camera, status: 'stopped' }));
  } catch (error) {
    await setStatus(camera.id, 'error');
    errorResponse(res, error);
  }
});

router.post('/cameras/:id/restart', async (req, res) => {
  const camera = await getCameraOr404(req, res);
  if (!camera) return;

  try {
    await dockerService.restartCamera(camera);
    await setStatus(camera.id, 'running');
    await recordAudit({
      projectId: camera.project_id || 1,
      cameraId: camera.id,
      action: 'camera.restart',
      targetType: 'camera',
      targetName: camera.name,
    });
    res.json(addUrls({ ...camera, status: 'running' }));
  } catch (error) {
    await setStatus(camera.id, 'error');
    errorResponse(res, error);
  }
});

router.delete('/cameras/:id', async (req, res) => {
  const camera = await getCameraOr404(req, res);
  if (!camera) return;

  try {
    await dockerService.removeCameraContainer(camera);
    await getDb().run('DELETE FROM cameras WHERE id = ?', camera.id);
    await recordAudit({
      projectId: camera.project_id || 1,
      cameraId: camera.id,
      action: 'camera.delete',
      targetType: 'camera',
      targetName: camera.name,
      detail: addUrls(camera),
    });
    res.status(204).send();
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/cameras/:id/logs', async (req, res) => {
  const camera = await getCameraOr404(req, res);
  if (!camera) return;

  const rawTail = Number.parseInt(req.query.tail || '300', 10);
  const tail = Math.min(Math.max(Number.isFinite(rawTail) ? rawTail : 300, 1), 2000);

  try {
    const logs = await dockerService.cameraLogs(camera, tail);
    res.json({ logs });
  } catch (error) {
    errorResponse(res, error);
  }
});

module.exports = router;
