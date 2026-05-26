const express = require('express');
const { z } = require('zod');
const { createToken, hashPassword, publicUser, verifyPassword } = require('./auth');
const { getDb } = require('./db');
const backupService = require('./backup');
const dockerService = require('./docker');

const router = express.Router();

const MIN_CAMERA_FPS = 2;
const MAX_CAMERA_FPS = 60;

const displayTargetsSchema = z.array(z.coerce.number().int().min(1).max(9999)).max(300).default([]);
const displayRegionSchema = z.object({
  row: z.coerce.number().int().min(1).max(9999),
  col: z.coerce.number().int().min(1).max(9999),
  row_span: z.coerce.number().int().min(1).max(9999).default(1),
  col_span: z.coerce.number().int().min(1).max(9999).default(1),
}).nullable();

const cameraBaseSchema = z.object({
  source_type: z.enum(['camera', 'rtsp']).default('camera'),
  name: z.string().trim().min(1).max(80),
  ip: z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().trim().ip({ version: 'v4' }).optional().nullable(),
  ),
  stream_name: z.string().trim().regex(/^[A-Za-z0-9._-]+$/).min(1).max(80),
  web_url: z.string().trim().url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'web_url must start with http:// or https://',
  }),
  width: z.coerce.number().int().min(320).max(7680).default(1280),
  height: z.coerce.number().int().min(240).max(4320).default(720),
  fps: z.coerce.number().int().min(MIN_CAMERA_FPS).max(MAX_CAMERA_FPS).default(15),
  display_targets: displayTargetsSchema,
  display_region: displayRegionSchema.optional().default(null),
});

const requireCameraIp = (value, ctx) => {
  if (value.source_type === 'camera' && !value.ip) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['ip'],
      message: 'ip is required for ONVIF camera source',
    });
  }
};

const cameraSchema = cameraBaseSchema.superRefine(requireCameraIp);

const cameraUpdateSchema = cameraBaseSchema.omit({
  display_targets: true,
  display_region: true,
}).superRefine(requireCameraIp);

const matrixSchema = z.object({
  rows: z.coerce.number().int().min(1).max(20),
  cols: z.coerce.number().int().min(1).max(30),
  prefix: z.string().trim().min(1).max(8).default('屏'),
});

const projectSchema = matrixSchema.extend({
  name: z.string().trim().min(1).max(80),
});

const screenUrlSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'url must start with http:// or https://',
  }),
  remark: z.string().trim().max(200).optional().default(''),
});

const projectImportSchema = z.object({
  project: projectSchema,
  cameras: z.array(cameraBaseSchema.passthrough().superRefine(requireCameraIp)).max(1000).default([]),
  screen_urls: z.array(screenUrlSchema.passthrough()).max(1000).default([]),
}).passthrough();

const loginSchema = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

const userCreateSchema = z.object({
  username: z.string().trim().regex(/^[A-Za-z0-9._-]+$/).min(3).max(60),
  password: z.string().min(8).max(200),
  display_name: z.string().trim().min(1).max(80).optional().default(''),
  role: z.enum(['admin', 'user']).default('user'),
  enabled: z.coerce.boolean().default(true),
});

const userUpdateSchema = z.object({
  password: z.string().min(8).max(200).optional().or(z.literal('')),
  display_name: z.string().trim().min(1).max(80).optional().default(''),
  role: z.enum(['admin', 'user']).default('user'),
  enabled: z.coerce.boolean().default(true),
});

const passwordChangeSchema = z.object({
  old_password: z.string().min(1).max(200),
  new_password: z.string().min(8).max(200),
});

const backupConfigSchema = z.object({
  enabled: z.coerce.boolean().default(false),
  frequency: z.enum(['hourly', 'daily', 'weekly', 'monthly']).default('daily'),
  backup_path: z.string().trim().min(1).max(240),
});

const backupRestoreSchema = z.object({
  file: z.string().trim().min(1).max(240),
  confirmation: z.literal('RESTORE'),
});

const projectMembersSchema = z.object({
  members: z.array(z.object({
    user_id: z.coerce.number().int().min(1),
    role: z.enum(['viewer', 'operator']).default('operator'),
  })).max(500).default([]),
});

const userProjectsSchema = z.object({
  projects: z.array(z.object({
    project_id: z.coerce.number().int().min(1),
    role: z.enum(['viewer', 'operator']).default('operator'),
  })).max(1000).default([]),
});

const cameraBulkCreateSchema = z.object({
  source_type: z.enum(['camera', 'rtsp']).default('camera'),
  count: z.coerce.number().int().min(1).max(200),
  start_ip: z.preprocess(
    (value) => (value === '' ? null : value),
    z.string().trim().optional().nullable(),
  ),
  name_prefix: z.string().trim().min(1).max(60).default('web-cam-'),
  stream_prefix: z.string().trim().regex(/^[A-Za-z0-9._-]+$/).min(1).max(60).default('screen'),
  web_url: z.string().trim().url().refine((value) => value.startsWith('http://') || value.startsWith('https://'), {
    message: 'web_url must start with http:// or https://',
  }),
  width: z.coerce.number().int().min(320).max(7680).default(1280),
  height: z.coerce.number().int().min(240).max(4320).default(720),
  fps: z.coerce.number().int().min(MIN_CAMERA_FPS).max(MAX_CAMERA_FPS).default(15),
}).superRefine((value, ctx) => {
  if (value.source_type === 'camera' && !value.start_ip) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['start_ip'],
      message: 'start_ip is required for ONVIF camera source',
    });
    return;
  }

  if (value.source_type === 'camera' && !z.string().ip({ version: 'v4' }).safeParse(value.start_ip).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['start_ip'],
      message: 'start_ip must be a valid IPv4 address',
    });
  }
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

function isSystemAdmin(req) {
  return req.user?.role === 'admin';
}

function assertSystemAdmin(req, res) {
  if (isSystemAdmin(req)) {
    return true;
  }

  res.status(403).json({ error: 'Admin permission required' });
  return false;
}

async function projectAccessRole(user, projectId) {
  if (!user) {
    return null;
  }

  if (user.role === 'admin') {
    return 'admin';
  }

  const membership = await getDb().get(
    'SELECT role FROM project_members WHERE project_id = ? AND user_id = ?',
    projectId,
    user.id,
  );

  return membership?.role || null;
}

async function requireProjectAccess(req, res, projectId, options = {}) {
  const id = Number.parseInt(projectId, 10);

  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'Invalid project id' });
    return null;
  }

  const role = await projectAccessRole(req.user, id);
  if (!role) {
    res.status(403).json({ error: 'Project permission required' });
    return null;
  }

  if (options.write && role === 'viewer') {
    res.status(403).json({ error: 'Project operator permission required' });
    return null;
  }

  return role;
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

  const role = await requireProjectAccess(req, res, project.id);
  if (!role) {
    return null;
  }

  project.permission_role = role;
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
  const sourceType = camera.source_type === 'rtsp' ? 'rtsp' : 'camera';
  const rtspHost = sourceType === 'rtsp' ? dockerService.RTSP_GATEWAY_HOST : camera.ip;
  const rtspPort = sourceType === 'rtsp' ? dockerService.RTSP_GATEWAY_PORT : dockerService.CAMERA_RTSP_PORT;

  return {
    ...camera,
    source_type: sourceType,
    project_id: camera.project_id || 1,
    display_targets: parseDisplayTargets(camera.display_targets),
    display_region: parseDisplayRegion(camera.display_region),
    rtsp_url: `rtsp://${rtspHost}:${rtspPort}/${camera.stream_name}`,
    onvif_url: sourceType === 'camera' ? `http://${camera.ip}/onvif/device_service` : null,
    go2rtc_url: sourceType === 'camera' ? `http://${camera.ip}` : null,
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

async function availableStreamName(preferredName, reservedStreamNames = new Set(), options = {}) {
  const db = getDb();
  const existingRows = await db.all(options.rtspOnly
    ? "SELECT stream_name FROM cameras WHERE source_type = 'rtsp'"
    : 'SELECT stream_name FROM cameras WHERE stream_name IS NOT NULL');
  const used = new Set(existingRows.map((camera) => camera.stream_name));

  if (!used.has(preferredName) && !reservedStreamNames.has(preferredName)) {
    return preferredName;
  }

  const numericName = String(preferredName || '').match(/^(.*?)(\d+)$/);
  if (numericName) {
    const prefix = numericName[1];
    const width = numericName[2].length;
    const start = Number.parseInt(numericName[2], 10) + 1;

    for (let index = start; index < start + 10000; index += 1) {
      const candidate = `${prefix}${String(index).padStart(width, '0')}`;
      if (!used.has(candidate) && !reservedStreamNames.has(candidate)) {
        return candidate;
      }
    }
  }

  const baseName = `${preferredName}-import`;
  if (!used.has(baseName) && !reservedStreamNames.has(baseName)) {
    return baseName;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${baseName}-${index}`;
    if (!used.has(candidate) && !reservedStreamNames.has(candidate)) {
      return candidate;
    }
  }

  throw new ApiError(`No available stream name for ${preferredName}`, 409);
}

async function availableRtspStreamName(preferredName, reservedStreamNames = new Set()) {
  return availableStreamName(preferredName, reservedStreamNames, { rtspOnly: true });
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

  const role = await requireProjectAccess(req, res, camera.project_id || 1);
  if (!role) {
    return null;
  }

  camera.permission_role = role;
  return camera;
}

async function assertRtspStreamNameAvailable(streamName, exceptId = 0) {
  const row = await getDb().get(
    "SELECT id FROM cameras WHERE source_type = 'rtsp' AND stream_name = ? AND id <> ?",
    streamName,
    exceptId,
  );

  if (row) {
    throw new ApiError('RTSP stream name already exists in shared gateway', 409);
  }
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

router.post('/auth/login', async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid login payload',
      details: parsed.error.flatten(),
    });
  }

  const { username, password } = parsed.data;
  const user = await getDb().get(
    'SELECT id, username, password_hash, display_name, role, enabled FROM users WHERE username = ?',
    username,
  );

  if (!user || !user.enabled || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const responseUser = publicUser(user);
  return res.json({
    token: createToken(responseUser),
    user: responseUser,
  });
});

router.get('/auth/me', async (req, res) => {
  res.json({ user: req.user });
});

router.put('/auth/password', async (req, res) => {
  const parsed = passwordChangeSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid password payload',
      details: parsed.error.flatten(),
    });
  }

  if (req.user?.is_service || !req.user?.id) {
    return res.status(403).json({ error: 'Service token cannot change password' });
  }

  const user = await getDb().get(
    'SELECT id, username, password_hash, display_name, role, enabled FROM users WHERE id = ?',
    req.user.id,
  );

  if (!user || !user.enabled) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!verifyPassword(parsed.data.old_password, user.password_hash)) {
    return res.status(400).json({ error: '当前密码不正确' });
  }

  await getDb().run(
    'UPDATE users SET password_hash = ? WHERE id = ?',
    hashPassword(parsed.data.new_password),
    user.id,
  );

  await recordAudit({
    action: 'user.password_change',
    targetType: 'user',
    targetName: user.username,
    detail: { user_id: user.id },
  });

  return res.json({ ok: true });
});

router.get('/users', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  try {
    const users = await getDb().all(
      `SELECT id, username, display_name, role, enabled, created_at
       FROM users
       ORDER BY role = 'admin' DESC, id ASC`,
    );
    res.json(users.map(publicUser));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post('/users', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  const parsed = userCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid user payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const payload = parsed.data;
    const result = await getDb().run(
      'INSERT INTO users (username, password_hash, display_name, role, enabled) VALUES (?, ?, ?, ?, ?)',
      payload.username,
      hashPassword(payload.password),
      payload.display_name || payload.username,
      payload.role,
      payload.enabled ? 1 : 0,
    );
    const user = await getDb().get(
      'SELECT id, username, display_name, role, enabled FROM users WHERE id = ?',
      result.lastID,
    );
    res.status(201).json(publicUser(user));
  } catch (error) {
    if (String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Username already exists' });
    }
    return errorResponse(res, error);
  }
});

router.put('/users/:id', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  const id = Number.parseInt(req.params.id, 10);
  const existing = await getDb().get('SELECT * FROM users WHERE id = ?', id);
  if (!existing) {
    return res.status(404).json({ error: 'User not found' });
  }

  const parsed = userUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid user payload',
      details: parsed.error.flatten(),
    });
  }

  const payload = parsed.data;
  const enabled = existing.role === 'admin' && existing.id === req.user.id ? 1 : (payload.enabled ? 1 : 0);
  const role = existing.id === req.user.id ? 'admin' : payload.role;
  const displayName = payload.display_name || existing.username;

  try {
    if (payload.password) {
      await getDb().run(
        'UPDATE users SET password_hash = ?, display_name = ?, role = ?, enabled = ? WHERE id = ?',
        hashPassword(payload.password),
        displayName,
        role,
        enabled,
        id,
      );
    } else {
      await getDb().run(
        'UPDATE users SET display_name = ?, role = ?, enabled = ? WHERE id = ?',
        displayName,
        role,
        enabled,
        id,
      );
    }

    const user = await getDb().get(
      'SELECT id, username, display_name, role, enabled FROM users WHERE id = ?',
      id,
    );
    res.json(publicUser(user));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/users/:id/projects', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  const id = Number.parseInt(req.params.id, 10);
  const user = await getDb().get(
    'SELECT id, username, display_name, role, enabled FROM users WHERE id = ?',
    id,
  );

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  try {
    const rows = await getDb().all(
      `SELECT
         p.id AS project_id,
         p.name AS project_name,
         p.rows,
         p.cols,
         p.prefix,
         CASE WHEN u.role = 'admin' THEN 'admin' ELSE pm.role END AS role
       FROM projects p
       CROSS JOIN users u
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
       WHERE u.id = ?
       ORDER BY p.id ASC`,
      user.id,
    );

    res.json({
      user: publicUser(user),
      projects: rows,
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.put('/users/:id/projects', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  const id = Number.parseInt(req.params.id, 10);
  const user = await getDb().get('SELECT id, username, display_name, role, enabled FROM users WHERE id = ?', id);

  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (user.role === 'admin') {
    return res.status(400).json({ error: 'Admin users already have access to all projects' });
  }

  const parsed = userProjectsSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid user projects payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const db = getDb();
    await db.run('DELETE FROM project_members WHERE user_id = ?', user.id);

    for (const project of parsed.data.projects) {
      const existingProject = await db.get('SELECT id FROM projects WHERE id = ?', project.project_id);
      if (!existingProject) {
        continue;
      }
      await db.run(
        'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
        existingProject.id,
        user.id,
        project.role,
      );
    }

    await recordAudit({
      action: 'user.projects_update',
      targetType: 'user',
      targetName: user.username,
      detail: {
        user_id: user.id,
        project_count: parsed.data.projects.length,
      },
    });

    const rows = await db.all(
      `SELECT
         p.id AS project_id,
         p.name AS project_name,
         p.rows,
         p.cols,
         p.prefix,
         pm.role
       FROM projects p
       LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       ORDER BY p.id ASC`,
      user.id,
    );

    res.json({
      user: publicUser(user),
      projects: rows,
    });
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/projects/:id/members', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  const project = await getProjectOr404(req, res);
  if (!project) return;

  try {
    const members = await getDb().all(
      `SELECT pm.project_id, pm.user_id, pm.role, u.username, u.display_name, u.enabled
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?
       ORDER BY u.username ASC`,
      project.id,
    );
    res.json(members);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.put('/projects/:id/members', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  const project = await getProjectOr404(req, res);
  if (!project) return;

  const parsed = projectMembersSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid project members payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const db = getDb();
    await db.run('DELETE FROM project_members WHERE project_id = ?', project.id);

    for (const member of parsed.data.members) {
      const user = await db.get('SELECT id, role FROM users WHERE id = ? AND enabled = 1', member.user_id);
      if (!user || user.role === 'admin') {
        continue;
      }
      await db.run(
        'INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)',
        project.id,
        user.id,
        member.role,
      );
    }

    await recordAudit({
      projectId: project.id,
      action: 'project.members_update',
      targetType: 'project',
      targetName: project.name,
      detail: {
        count: parsed.data.members.length,
      },
    });

    const members = await db.all(
      `SELECT pm.project_id, pm.user_id, pm.role, u.username, u.display_name, u.enabled
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       WHERE pm.project_id = ?
       ORDER BY u.username ASC`,
      project.id,
    );
    res.json(members);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/system/database-backup', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  try {
    res.json(await backupService.getBackupState());
  } catch (error) {
    errorResponse(res, error);
  }
});

router.put('/system/database-backup', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  const parsed = backupConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid backup config payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const saved = await backupService.saveBackupConfig(parsed.data, req.user);
    await recordAudit({
      action: 'system.backup_config_update',
      targetType: 'system',
      targetName: 'database_backup',
      detail: {
        enabled: saved.enabled,
        frequency: saved.frequency,
        backup_path: saved.backup_path,
        next_run_at: saved.next_run_at,
      },
    });
    return res.json(saved);
  } catch (error) {
    return res.status(400).json({ error: error.message || String(error) });
  }
});

router.post('/system/database-backup/run', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  try {
    const state = await backupService.runBackupNow({ reason: 'manual' });
    await recordAudit({
      action: 'system.backup_run',
      targetType: 'system',
      targetName: 'database_backup',
      detail: {
        last_file: state.last_file,
        last_run_at: state.last_run_at,
      },
    });
    return res.json(state);
  } catch (error) {
    const state = await backupService.getBackupState().catch(() => null);
    return res.status(500).json({
      error: error.message || String(error),
      state,
    });
  }
});

router.get('/system/database-backup/files', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  try {
    return res.json(await backupService.listBackupFiles());
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.post('/system/database-backup/restore', async (req, res) => {
  if (!assertSystemAdmin(req, res)) return;

  const parsed = backupRestoreSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid backup restore payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const result = await backupService.restoreBackupFile(parsed.data.file);
    await recordAudit({
      action: 'system.backup_restore',
      targetType: 'system',
      targetName: 'database_backup',
      detail: {
        restored_file: result.restored_file,
        safety_backup_file: result.safety_backup_file,
      },
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({ error: error.message || String(error) });
  }
});

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
    const projects = isSystemAdmin(req)
      ? await getDb().all("SELECT *, 'admin' AS permission_role FROM projects ORDER BY id ASC")
      : await getDb().all(
        `SELECT p.*, pm.role AS permission_role
         FROM projects p
         JOIN project_members pm ON pm.project_id = p.id
         WHERE pm.user_id = ?
         ORDER BY p.id ASC`,
        req.user.id,
      );
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
    const screenUrls = await getDb().all(
      `SELECT id, project_id, name, url, remark, created_at, updated_at
       FROM screen_urls
       WHERE project_id = ?
       ORDER BY id ASC`,
      project.id,
    );
    res.json({
      version: 1,
      exported_at: new Date().toISOString(),
      project,
      cameras: cameras.map(addUrls),
      screen_urls: screenUrls,
      summary: {
        camera_count: cameras.length,
        screen_url_count: screenUrls.length,
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
    const role = await requireProjectAccess(req, res, projectId);
    if (!role) return;

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
  if (!assertSystemAdmin(req, res)) return;

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
  if (!assertSystemAdmin(req, res)) return;

  const rawPayload = req.body?.project ? req.body : req.body?.config;
  const parsed = projectImportSchema.safeParse(rawPayload);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid import payload',
      details: parsed.error.flatten(),
    });
  }

  let createdProjectId = null;

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
    createdProjectId = project.id;
    const reservedIps = new Set();
    const reservedRtspStreamNames = new Set();
    const remappedIps = [];
    const remappedStreams = [];
    const occupiedTargets = new Set();
    const importedCameras = [];
    const importedScreenUrls = [];

    for (const screenUrl of payload.screen_urls) {
      const result = await db.run(
        `INSERT INTO screen_urls (project_id, name, url, remark)
         VALUES (?, ?, ?, ?)`,
        project.id,
        screenUrl.name,
        screenUrl.url,
        screenUrl.remark || '',
      );
      const createdScreenUrl = await db.get('SELECT * FROM screen_urls WHERE id = ?', result.lastID);
      importedScreenUrls.push(createdScreenUrl);
    }

    for (const camera of payload.cameras) {
      const assignment = resolveDisplayAssignment(camera.display_targets, camera.display_region, project);
      const overlap = assignment.displayTargets.find((target) => occupiedTargets.has(target));

      if (overlap) {
        throw new ApiError(`Imported camera bindings overlap at ${project.prefix}${String(overlap).padStart(2, '0')}`, 400);
      }

      assignment.displayTargets.forEach((target) => occupiedTargets.add(target));

      const sourceType = camera.source_type === 'rtsp' ? 'rtsp' : 'camera';
      const nextIp = sourceType === 'camera' ? await availableIp(camera.ip, reservedIps) : null;
      const nextStreamName = sourceType === 'rtsp'
        ? await availableRtspStreamName(camera.stream_name, reservedRtspStreamNames)
        : camera.stream_name;

      if (nextIp) {
        reservedIps.add(nextIp);
      }

      if (sourceType === 'rtsp') {
        reservedRtspStreamNames.add(nextStreamName);
      }

      if (nextIp && nextIp !== camera.ip) {
        remappedIps.push({
          name: camera.name,
          from: camera.ip,
          to: nextIp,
        });
      }

      if (nextStreamName !== camera.stream_name) {
        remappedStreams.push({
          name: camera.name,
          from: camera.stream_name,
          to: nextStreamName,
        });
      }

      const result = await db.run(
        `INSERT INTO cameras
          (name, ip, source_type, stream_name, web_url, width, height, fps, status, display_targets, display_region, project_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'stopped', ?, ?, ?)`,
        camera.name,
        nextIp,
        sourceType,
        nextStreamName,
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
        screen_url_count: importedScreenUrls.length,
        remapped_ips: remappedIps,
        remapped_streams: remappedStreams,
      },
    });

    return res.status(201).json({
      project,
      cameras: importedCameras,
      screen_urls: importedScreenUrls,
      remapped_ips: remappedIps,
      remapped_streams: remappedStreams,
    });
  } catch (error) {
    if (createdProjectId) {
      try {
        const db = getDb();
        await db.run('DELETE FROM cameras WHERE project_id = ?', createdProjectId);
        await db.run('DELETE FROM screen_urls WHERE project_id = ?', createdProjectId);
        await db.run('DELETE FROM project_members WHERE project_id = ?', createdProjectId);
        await db.run('DELETE FROM projects WHERE id = ?', createdProjectId);
      } catch (cleanupError) {
        console.warn('Failed to clean failed project import:', cleanupError.message);
      }
    }

    if (error instanceof ApiError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (String(error.message).includes('SQLITE_CONSTRAINT') || String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Imported project conflicts with existing data' });
    }
    return errorResponse(res, error);
  }
});

router.put('/projects/:id', async (req, res) => {
  const project = await getProjectOr404(req, res);
  if (!project) return;
  const role = await requireProjectAccess(req, res, project.id, { write: true });
  if (!role) return;

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
    const role = await requireProjectAccess(req, res, projectId);
    if (!role) return;

    const cameras = await syncCameraStatuses(projectId);
    res.json(cameras.map(addUrls));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/cameras/statuses', async (req, res) => {
  try {
    const projectId = projectIdFromRequest(req);
    const role = await requireProjectAccess(req, res, projectId);
    if (!role) return;

    const cameras = await syncCameraStatuses(projectId);
    res.json(cameras.map((camera) => ({
      id: camera.id,
      status: camera.status,
    })));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/resource-stats', async (req, res) => {
  try {
    const projectId = projectIdFromRequest(req);
    const role = await requireProjectAccess(req, res, projectId);
    if (!role) return;

    const cameras = await getDb().all('SELECT * FROM cameras WHERE project_id = ? ORDER BY id DESC', projectId);
    res.json(await dockerService.cameraResourceStats(cameras));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/screen-matrix', async (req, res) => {
  try {
    const projectId = projectIdFromRequest(req);
    const role = await requireProjectAccess(req, res, projectId);
    if (!role) return;

    res.json(await getScreenMatrix(projectId));
  } catch (error) {
    errorResponse(res, error);
  }
});

router.get('/screen-urls', async (req, res) => {
  try {
    const projectId = projectIdFromRequest(req);
    const role = await requireProjectAccess(req, res, projectId);
    if (!role) return;

    const rows = await getDb().all(
      `SELECT id, project_id, name, url, remark, created_at, updated_at
       FROM screen_urls
       WHERE project_id = ?
       ORDER BY id DESC`,
      projectId,
    );
    res.json(rows);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.post('/screen-urls', async (req, res) => {
  const parsed = screenUrlSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid screen URL payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const projectId = projectIdFromRequest(req);
    const role = await requireProjectAccess(req, res, projectId, { write: true });
    if (!role) return;

    const project = await getDb().get('SELECT id FROM projects WHERE id = ?', projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const payload = parsed.data;
    const result = await getDb().run(
      `INSERT INTO screen_urls (project_id, name, url, remark)
       VALUES (?, ?, ?, ?)`,
      projectId,
      payload.name,
      payload.url,
      payload.remark,
    );
    const created = await getDb().get('SELECT * FROM screen_urls WHERE id = ?', result.lastID);
    await recordAudit({
      projectId,
      action: 'screen_url.create',
      targetType: 'screen_url',
      targetName: created.name,
      detail: created,
    });
    res.status(201).json(created);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.put('/screen-urls/:id', async (req, res) => {
  const parsed = screenUrlSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid screen URL payload',
      details: parsed.error.flatten(),
    });
  }

  try {
    const id = Number.parseInt(req.params.id, 10);
    const existing = await getDb().get('SELECT * FROM screen_urls WHERE id = ?', id);

    if (!existing) {
      return res.status(404).json({ error: 'Screen URL not found' });
    }

    const role = await requireProjectAccess(req, res, existing.project_id, { write: true });
    if (!role) return;

    const payload = parsed.data;
    await getDb().run(
      `UPDATE screen_urls
       SET name = ?, url = ?, remark = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      payload.name,
      payload.url,
      payload.remark,
      id,
    );
    const updated = await getDb().get('SELECT * FROM screen_urls WHERE id = ?', id);
    await recordAudit({
      projectId: existing.project_id,
      action: 'screen_url.update',
      targetType: 'screen_url',
      targetName: updated.name,
      detail: {
        before: existing,
        after: updated,
      },
    });
    res.json(updated);
  } catch (error) {
    errorResponse(res, error);
  }
});

router.delete('/screen-urls/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const existing = await getDb().get('SELECT * FROM screen_urls WHERE id = ?', id);

    if (!existing) {
      return res.status(404).json({ error: 'Screen URL not found' });
    }

    const role = await requireProjectAccess(req, res, existing.project_id, { write: true });
    if (!role) return;

    await getDb().run('DELETE FROM screen_urls WHERE id = ?', id);
    await recordAudit({
      projectId: existing.project_id,
      action: 'screen_url.delete',
      targetType: 'screen_url',
      targetName: existing.name,
      detail: existing,
    });
    res.status(204).send();
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
    const projectId = projectIdFromRequest(req);
    const role = await requireProjectAccess(req, res, projectId, { write: true });
    if (!role) return;

    await setScreenMatrix(parsed.data, projectId);
    await recordAudit({
      projectId,
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
  const role = await requireProjectAccess(req, res, projectId, { write: true });
  if (!role) return;

  const project = await db.get('SELECT id FROM projects WHERE id = ?', projectId);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  try {
    const payload = parsed.data;
    const reservedIps = new Set();
    const reservedStreamNames = new Set();
    const created = [];
    const remappedIps = [];
    const remappedStreams = [];
    const sourceType = payload.source_type === 'rtsp' ? 'rtsp' : 'camera';

    for (let offset = 0; offset < payload.count; offset += 1) {
      const number = String(offset + 1).padStart(2, '0');
      let ip = null;
      let requestedIp = null;

      if (sourceType === 'camera') {
        const requestedIpParts = payload.start_ip.split('.');
        requestedIpParts[3] = String(Number.parseInt(requestedIpParts[3], 10) + offset);
        requestedIp = requestedIpParts.join('.');
        ip = await availableIp(requestedIp, reservedIps);
        reservedIps.add(ip);

        if (ip !== requestedIp) {
          remappedIps.push({
            index: offset + 1,
            from: requestedIp,
            to: ip,
          });
        }
      }

      const requestedStreamName = `${payload.stream_prefix}${number}`;
      const streamName = await availableStreamName(requestedStreamName, reservedStreamNames, {
        rtspOnly: sourceType === 'rtsp',
      });
      reservedStreamNames.add(streamName);

      if (streamName !== requestedStreamName) {
        remappedStreams.push({
          index: offset + 1,
          from: requestedStreamName,
          to: streamName,
        });
      }

      const result = await db.run(
        `INSERT INTO cameras (project_id, name, ip, source_type, stream_name, web_url, width, height, fps, display_targets, display_region, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', NULL, 'stopped')`,
        projectId,
        `${payload.name_prefix}${number}`,
        ip,
        sourceType,
        streamName,
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
        source_type: sourceType,
        start_ip: payload.start_ip,
        name_prefix: payload.name_prefix,
        stream_prefix: payload.stream_prefix,
        remapped_ips: remappedIps,
        remapped_streams: remappedStreams,
      },
    });

    return res.status(201).json({
      cameras: created,
      remapped_ips: remappedIps,
      remapped_streams: remappedStreams,
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
  const role = await requireProjectAccess(req, res, projectId, { write: true });
  if (!role) return;

  const project = await db.get('SELECT id, rows, cols, prefix FROM projects WHERE id = ?', projectId);

  if (!project) {
    return res.status(404).json({ error: 'Project not found' });
  }

  try {
    const { displayTargets, displayRegion } = resolveDisplayAssignment(camera.display_targets, camera.display_region, project);
    await assertDisplayTargetsAvailable(projectId, 0, displayTargets);
    if (camera.source_type === 'rtsp') {
      camera.stream_name = await availableRtspStreamName(camera.stream_name);
    }

    const result = await db.run(
      `INSERT INTO cameras (project_id, name, ip, source_type, stream_name, web_url, width, height, fps, display_targets, display_region, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stopped')`,
      projectId,
      camera.name,
      camera.source_type === 'rtsp' ? null : camera.ip,
      camera.source_type,
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
  const accessRole = await requireProjectAccess(req, res, camera.project_id || 1, { write: true });
  if (!accessRole) return;

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
    if (payload.source_type === 'rtsp') {
      await assertRtspStreamNameAvailable(payload.stream_name, camera.id);
    }

    const duplicateIp = payload.source_type === 'camera'
      ? await db.get('SELECT id FROM cameras WHERE ip = ? AND id <> ?', payload.ip, camera.id)
      : null;
    if (duplicateIp) {
      return res.status(409).json({ error: 'Camera IP already exists' });
    }

    await db.run(
      `UPDATE cameras
       SET name = ?, ip = ?, source_type = ?, stream_name = ?, web_url = ?, width = ?, height = ?, fps = ?
       WHERE id = ?`,
      payload.name,
      payload.source_type === 'rtsp' ? null : payload.ip,
      payload.source_type,
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

    if (camera.status === 'running' || camera.status === 'error') {
      try {
        await dockerService.recreateCamera(updated);
        nextStatus = 'running';
      } catch (error) {
        nextStatus = 'error';
        recreateError = dockerService.friendlyDockerError(error);
      }

      await setStatus(camera.id, nextStatus);
      updated.status = nextStatus;
    } else {
      try {
        await dockerService.removeCameraContainer(updated);
      } catch (error) {
        recreateError = dockerService.friendlyDockerError(error);
      }
      await setStatus(camera.id, 'stopped');
      updated.status = 'stopped';
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
    if (error instanceof ApiError) {
      return res.status(error.status).json({ error: error.message });
    }
    if (String(error.message).includes('SQLITE_CONSTRAINT') || String(error.message).includes('UNIQUE constraint failed')) {
      return res.status(409).json({ error: 'Camera IP already exists' });
    }
    return errorResponse(res, error);
  }
});

router.patch('/cameras/:id/display-targets', async (req, res) => {
  const camera = await getCameraOr404(req, res);
  if (!camera) return;
  const accessRole = await requireProjectAccess(req, res, camera.project_id || 1, { write: true });
  if (!accessRole) return;

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
  const accessRole = await requireProjectAccess(req, res, camera.project_id || 1, { write: true });
  if (!accessRole) return;

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
  const accessRole = await requireProjectAccess(req, res, camera.project_id || 1, { write: true });
  if (!accessRole) return;

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
  const accessRole = await requireProjectAccess(req, res, camera.project_id || 1, { write: true });
  if (!accessRole) return;

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
  const accessRole = await requireProjectAccess(req, res, camera.project_id || 1, { write: true });
  if (!accessRole) return;

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
