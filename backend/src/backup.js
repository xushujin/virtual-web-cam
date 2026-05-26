const fs = require('fs');
const path = require('path');
const {
  backupDatabase,
  getDatabasePath,
  getDb,
  restoreDatabaseFromBackup,
} = require('./db');

const BACKUP_SETTING_KEY = 'database_backup';
const DEFAULT_BACKUP_PATH = process.env.DB_BACKUP_PATH || path.join(path.dirname(getDatabasePath()), 'backups');
const rawSchedulerIntervalMs = Number.parseInt(process.env.DB_BACKUP_SCHEDULER_INTERVAL_MS || '60000', 10);
const SCHEDULER_INTERVAL_MS = Number.isFinite(rawSchedulerIntervalMs) ? rawSchedulerIntervalMs : 60000;

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
      backup_path: normalizeBackupPath(parsed.backup_path || DEFAULT_BACKUP_PATH),
    };
  } catch {
    return defaultBackupState();
  }
}

function nextRunAt(fromDate = new Date(), frequency = 'daily') {
  const next = new Date(fromDate.getTime());
  FREQUENCIES[normalizeFrequency(frequency)].add(next);
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
  const backupPath = normalizeBackupPath(payload.backup_path);
  const state = {
    ...current,
    enabled,
    frequency,
    backup_path: backupPath,
    next_run_at: enabled ? nextRunAt(savedAt, frequency) : null,
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
    next_run_at: state.enabled ? nextRunAt(runAt, frequency) : state.next_run_at,
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
      next_run_at: state.enabled ? nextRunAt(finishedAt, state.frequency) : state.next_run_at,
    };
    await writeBackupState(successState);
    return successState;
  } catch (error) {
    await markBackupFailure({ ...state, backup_path: backupPath }, error, runAt);
    throw error;
  }
}

async function restoreBackupFile(fileName) {
  const state = await getBackupState();
  const source = resolveBackupFile(state.backup_path, fileName);
  await fs.promises.access(source, fs.constants.R_OK);
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

async function maybeRunScheduledBackup(now = new Date()) {
  const state = await getBackupState();

  if (!state.enabled) {
    return false;
  }

  if (!state.next_run_at || Number.isNaN(new Date(state.next_run_at).getTime())) {
    await writeBackupState({
      ...state,
      next_run_at: nextRunAt(now, state.frequency),
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
  getBackupState,
  listBackupFiles,
  maybeRunScheduledBackup,
  nextRunAt,
  normalizeBackupPath,
  resolveBackupFile,
  restoreBackupFile,
  runBackupNow,
  saveBackupConfig,
  startBackupScheduler,
  stopBackupScheduler,
};
