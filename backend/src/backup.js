const fs = require('fs');
const path = require('path');
const {
  backupDatabase,
  getDatabasePath,
  getDb,
  restoreDatabaseFromBackup,
  verifyBackupFile,
} = require('./db');

const BACKUP_SETTING_KEY = 'database_backup';
const DEFAULT_BACKUP_PATH = process.env.DB_BACKUP_PATH || path.join(path.dirname(getDatabasePath()), 'backups');
const rawSchedulerIntervalMs = Number.parseInt(process.env.DB_BACKUP_SCHEDULER_INTERVAL_MS || '60000', 10);
const SCHEDULER_INTERVAL_MS = Number.isFinite(rawSchedulerIntervalMs) ? rawSchedulerIntervalMs : 60000;
const DEFAULT_SCHEDULE_TIME = '02:00';
const DEFAULT_SCHEDULE_MINUTE = 0;
const DEFAULT_SCHEDULE_WEEKDAY = 1;
const DEFAULT_SCHEDULE_MONTH_DAY = 1;

const FREQUENCIES = {
  hourly: {
    label: '每小时',
    add(date) {
      date.setHours(date.getHours() + 1);
    },
  },
  daily: {
    label: '每天',
    add(date) {
      date.setDate(date.getDate() + 1);
    },
  },
  weekly: {
    label: '每周',
    add(date) {
      date.setDate(date.getDate() + 7);
    },
  },
  monthly: {
    label: '每月',
    add(date) {
      date.setMonth(date.getMonth() + 1);
    },
  },
};

let schedulerTimer = null;
let scheduledRunInProgress = false;

function defaultBackupState() {
  return {
    enabled: false,
    frequency: 'daily',
    schedule_time: DEFAULT_SCHEDULE_TIME,
    schedule_minute: DEFAULT_SCHEDULE_MINUTE,
    schedule_weekday: DEFAULT_SCHEDULE_WEEKDAY,
    schedule_month_day: DEFAULT_SCHEDULE_MONTH_DAY,
    backup_path: DEFAULT_BACKUP_PATH,
    next_run_at: null,
    last_run_at: null,
    last_status: 'never',
    last_file: '',
    last_error: '',
    updated_at: null,
    updated_by: '',
  };
}

function normalizeFrequency(frequency) {
  return Object.prototype.hasOwnProperty.call(FREQUENCIES, frequency) ? frequency : 'daily';
}

function normalizeInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeScheduleTime(value) {
  const raw = String(value || DEFAULT_SCHEDULE_TIME).trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);

  if (!match) {
    return DEFAULT_SCHEDULE_TIME;
  }

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return DEFAULT_SCHEDULE_TIME;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function normalizeSchedule(value = {}) {
  return {
    schedule_time: normalizeScheduleTime(value.schedule_time),
    schedule_minute: normalizeInteger(value.schedule_minute, DEFAULT_SCHEDULE_MINUTE, 0, 59),
    schedule_weekday: normalizeInteger(value.schedule_weekday, DEFAULT_SCHEDULE_WEEKDAY, 1, 7),
    schedule_month_day: normalizeInteger(value.schedule_month_day, DEFAULT_SCHEDULE_MONTH_DAY, 1, 28),
  };
}

function normalizeBackupPath(backupPath) {
  const normalized = String(backupPath || DEFAULT_BACKUP_PATH).trim();

  if (!normalized) {
    throw new Error('Backup path is required');
  }

  if (!path.isAbsolute(normalized)) {
    throw new Error('Backup path must be an absolute path');
  }

  return path.normalize(normalized);
}

function parseBackupState(value) {
  if (!value) {
    return defaultBackupState();
  }

  try {
    const parsed = JSON.parse(value);
    return {
      ...defaultBackupState(),
      ...parsed,
      enabled: Boolean(parsed.enabled),
      frequency: normalizeFrequency(parsed.frequency),
      ...normalizeSchedule(parsed),
      backup_path: normalizeBackupPath(parsed.backup_path || DEFAULT_BACKUP_PATH),
    };
  } catch {
    return defaultBackupState();
  }
}

function nextRunAt(fromDate = new Date(), frequency = 'daily') {
  const from = new Date(fromDate.getTime());
  const state = typeof frequency === 'object' && frequency !== null
    ? { frequency: normalizeFrequency(frequency.frequency), ...normalizeSchedule(frequency) }
    : { frequency: normalizeFrequency(frequency), ...normalizeSchedule() };
  let next;

  if (state.frequency === 'hourly') {
    next = new Date(from.getTime());
    next.setMinutes(state.schedule_minute, 0, 0);
    if (next.getTime() <= from.getTime()) {
      next.setHours(next.getHours() + 1);
    }
  } else if (state.frequency === 'daily') {
    const [hours, minutes] = state.schedule_time.split(':').map((item) => Number.parseInt(item, 10));
    next = new Date(from.getTime());
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= from.getTime()) {
      next.setDate(next.getDate() + 1);
    }
  } else if (state.frequency === 'weekly') {
    const [hours, minutes] = state.schedule_time.split(':').map((item) => Number.parseInt(item, 10));
    const targetDay = state.schedule_weekday % 7;
    const daysUntilTarget = (targetDay - from.getDay() + 7) % 7;
    next = new Date(from.getTime());
    next.setDate(next.getDate() + daysUntilTarget);
    next.setHours(hours, minutes, 0, 0);
    if (next.getTime() <= from.getTime()) {
      next.setDate(next.getDate() + 7);
    }
  } else {
    const [hours, minutes] = state.schedule_time.split(':').map((item) => Number.parseInt(item, 10));
    next = new Date(from.getTime());
    next.setDate(1);
    next.setHours(hours, minutes, 0, 0);
    next.setDate(state.schedule_month_day);
    if (next.getTime() <= from.getTime()) {
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setDate(state.schedule_month_day);
    }
  }

  return next.toISOString();
}

function compactTimestamp(date = new Date()) {
  return date.toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.(\d{3})Z$/, '$1Z');
}

async function writeBackupState(state) {
  const db = getDb();
  await db.run(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
    BACKUP_SETTING_KEY,
    JSON.stringify(state),
  );
  return state;
}

async function getBackupState() {
  const row = await getDb().get('SELECT value FROM settings WHERE key = ?', BACKUP_SETTING_KEY);
  return parseBackupState(row?.value);
}

function resolveBackupFile(backupPath, fileName) {
  const basePath = normalizeBackupPath(backupPath);
  const resolved = path.resolve(basePath, String(fileName || '').trim());
  const relative = path.relative(basePath, resolved);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Backup file must be inside the configured backup path');
  }

  if (!resolved.endsWith('.db')) {
    throw new Error('Backup file must be a .db file');
  }

  return resolved;
}

async function listBackupFiles() {
  const state = await getBackupState();
  const backupPath = normalizeBackupPath(state.backup_path);

  let entries = [];
  try {
    entries = await fs.promises.readdir(backupPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {
        backup_path: backupPath,
        files: [],
      };
    }
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.db')) {
      continue;
    }

    const fullPath = path.join(backupPath, entry.name);
    const stat = await fs.promises.stat(fullPath);
    files.push({
      name: entry.name,
      path: fullPath,
      size_bytes: stat.size,
      modified_at: stat.mtime.toISOString(),
    });
  }

  files.sort((left, right) => new Date(right.modified_at).getTime() - new Date(left.modified_at).getTime());

  return {
    backup_path: backupPath,
    files,
  };
}

async function saveBackupConfig(payload, user = null) {
  const current = await getBackupState();
  const savedAt = new Date();
  const enabled = Boolean(payload.enabled);
  const frequency = normalizeFrequency(payload.frequency);
  const schedule = normalizeSchedule(payload);
  const backupPath = normalizeBackupPath(payload.backup_path);
  const state = {
    ...current,
    enabled,
    frequency,
    ...schedule,
    backup_path: backupPath,
    next_run_at: enabled ? nextRunAt(savedAt, { frequency, ...schedule }) : null,
    updated_at: savedAt.toISOString(),
    updated_by: user?.username || user?.display_name || '',
  };

  return writeBackupState(state);
}

async function markBackupFailure(state, error, runAt, frequency = state.frequency) {
  const failedState = {
    ...state,
    last_run_at: runAt.toISOString(),
    last_status: 'error',
    last_error: error.message || String(error),
    next_run_at: state.enabled ? nextRunAt(runAt, { ...state, frequency }) : state.next_run_at,
  };
  await writeBackupState(failedState);
  return failedState;
}

async function runBackupNow(options = {}) {
  const state = await getBackupState();
  const runAt = new Date();
  const backupPath = normalizeBackupPath(options.backup_path || state.backup_path);
  const destination = path.join(backupPath, `virtualwebcam-${compactTimestamp(runAt)}.db`);

  try {
    fs.mkdirSync(backupPath, { recursive: true });
    await backupDatabase(destination);
    const finishedAt = new Date();
    const successState = {
      ...state,
      backup_path: backupPath,
      last_run_at: finishedAt.toISOString(),
      last_status: 'success',
      last_file: destination,
      last_error: '',
      next_run_at: state.enabled ? nextRunAt(finishedAt, state) : state.next_run_at,
    };
    await writeBackupState(successState);
    return successState;
  } catch (error) {
    await markBackupFailure({ ...state, backup_path: backupPath }, error, runAt);
    throw error;
  }
}

function assertNotActiveDatabase(filePath) {
  if (path.resolve(filePath) === path.resolve(getDatabasePath())) {
    throw new Error('Backup file cannot be the active database file');
  }
}

async function getBackupFilePath(fileName) {
  const state = await getBackupState();
  const source = resolveBackupFile(state.backup_path, fileName);
  assertNotActiveDatabase(source);
  await fs.promises.access(source, fs.constants.R_OK);
  return source;
}

async function restoreBackupSource(source) {
  const safetyBackup = await runBackupNow({ reason: 'pre-restore' });
  await restoreDatabaseFromBackup(source);
  const restoredState = await getBackupState();

  return {
    restored: true,
    restored_file: source,
    safety_backup_file: safetyBackup.last_file,
    state: restoredState,
  };
}

async function restoreBackupFile(fileName) {
  return restoreBackupSource(await getBackupFilePath(fileName));
}

async function deleteBackupFile(fileName) {
  const state = await getBackupState();
  const source = resolveBackupFile(state.backup_path, fileName);
  assertNotActiveDatabase(source);
  const stat = await fs.promises.stat(source);

  if (!stat.isFile()) {
    throw new Error('Backup file is not a regular file');
  }

  await fs.promises.unlink(source);

  let nextState = state;
  if (path.resolve(state.last_file || '') === path.resolve(source)) {
    nextState = {
      ...state,
      last_file: '',
    };
    await writeBackupState(nextState);
  }

  return {
    deleted: true,
    file: path.basename(source),
    path: source,
    state: nextState,
  };
}

function sanitizeUploadedBackupName(fileName) {
  const baseName = path.basename(String(fileName || 'uploaded.db')).replace(/[^A-Za-z0-9._-]/g, '_');

  if (!baseName || !baseName.endsWith('.db')) {
    throw new Error('Uploaded backup file must be a .db file');
  }

  return baseName;
}

async function restoreUploadedBackup(fileName, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error('Uploaded backup file is empty');
  }

  const state = await getBackupState();
  const backupPath = normalizeBackupPath(state.backup_path);
  const safeName = sanitizeUploadedBackupName(fileName);
  const stem = safeName.replace(/\.db$/, '') || 'uploaded';
  const destination = path.join(backupPath, `uploaded-${compactTimestamp(new Date())}-${stem}.db`);

  fs.mkdirSync(backupPath, { recursive: true });
  await fs.promises.writeFile(destination, buffer, { flag: 'wx' });

  try {
    verifyBackupFile(destination);
  } catch (error) {
    await fs.promises.unlink(destination).catch(() => {});
    throw error;
  }

  const result = await restoreBackupSource(destination);

  return {
    ...result,
    uploaded_file: destination,
  };
}

async function maybeRunScheduledBackup(now = new Date()) {
  const state = await getBackupState();

  if (!state.enabled) {
    return false;
  }

  if (!state.next_run_at || Number.isNaN(new Date(state.next_run_at).getTime())) {
    await writeBackupState({
      ...state,
      next_run_at: nextRunAt(now, state),
    });
    return false;
  }

  if (new Date(state.next_run_at).getTime() > now.getTime()) {
    return false;
  }

  await runBackupNow({ reason: 'scheduled' });
  return true;
}

function startBackupScheduler() {
  if (schedulerTimer || SCHEDULER_INTERVAL_MS <= 0) {
    return;
  }

  const tick = async () => {
    if (scheduledRunInProgress) {
      return;
    }

    scheduledRunInProgress = true;
    try {
      await maybeRunScheduledBackup();
    } catch (error) {
      console.warn('Scheduled database backup failed:', error.message);
    } finally {
      scheduledRunInProgress = false;
    }
  };

  schedulerTimer = setInterval(tick, SCHEDULER_INTERVAL_MS);
  schedulerTimer.unref?.();
  tick();
}

function stopBackupScheduler() {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

module.exports = {
  BACKUP_SETTING_KEY,
  FREQUENCIES,
  DEFAULT_BACKUP_PATH,
  deleteBackupFile,
  getBackupFilePath,
  getBackupState,
  listBackupFiles,
  maybeRunScheduledBackup,
  nextRunAt,
  normalizeBackupPath,
  normalizeSchedule,
  resolveBackupFile,
  restoreBackupFile,
  restoreUploadedBackup,
  runBackupNow,
  saveBackupConfig,
  startBackupScheduler,
  stopBackupScheduler,
};
