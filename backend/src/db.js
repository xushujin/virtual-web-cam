const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const databasePath = process.env.SQLITE_PATH || path.join(__dirname, '..', 'data', 'virtualwebcam.db');

let db;
let api;

function normalizeParams(params) {
  if (params.length === 1 && Array.isArray(params[0])) {
    return params[0];
  }

  return params;
}

function createApi() {
  return {
    async exec(sql) {
      db.exec(sql);
    },

    async run(sql, ...rawParams) {
      const params = normalizeParams(rawParams);
      const result = db.prepare(sql).run(...params);

      return {
        changes: result.changes,
        lastID: result.lastInsertRowid ? Number(result.lastInsertRowid) : 0,
      };
    },

    async get(sql, ...rawParams) {
      const params = normalizeParams(rawParams);
      return db.prepare(sql).get(...params);
    },

    async all(sql, ...rawParams) {
      const params = normalizeParams(rawParams);
      return db.prepare(sql).all(...params);
    },

    transaction(fn) {
      return db.transaction(fn);
    },
  };
}

async function initDb() {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });

  db = new Database(databasePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  api = createApi();

  await api.exec(`
    CREATE TABLE IF NOT EXISTS cameras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      ip TEXT UNIQUE,
      source_type TEXT DEFAULT 'camera' CHECK (source_type IN ('camera', 'rtsp')),
      stream_name TEXT,
      web_url TEXT,
      width INTEGER DEFAULT 1280,
      height INTEGER DEFAULT 720,
      fps INTEGER DEFAULT 15,
      status TEXT DEFAULT 'stopped' CHECK (status IN ('running', 'stopped', 'error')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      rows INTEGER DEFAULT 6,
      cols INTEGER DEFAULT 8,
      prefix TEXT DEFAULT '屏',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      camera_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_name TEXT,
      detail TEXT DEFAULT '{}',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_cameras_project_id ON cameras(project_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_project_id ON audit_logs(project_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_camera_id ON audit_logs(camera_id, id DESC);
  `);

  const cameraColumns = await api.all('PRAGMA table_info(cameras)');
  if (!cameraColumns.some((column) => column.name === 'display_targets')) {
    await api.exec("ALTER TABLE cameras ADD COLUMN display_targets TEXT DEFAULT '[]';");
  }

  if (!cameraColumns.some((column) => column.name === 'display_region')) {
    await api.exec('ALTER TABLE cameras ADD COLUMN display_region TEXT DEFAULT NULL;');
  }

  if (!cameraColumns.some((column) => column.name === 'source_type')) {
    await api.exec("ALTER TABLE cameras ADD COLUMN source_type TEXT DEFAULT 'camera';");
  }

  const matrixSetting = await api.get('SELECT value FROM settings WHERE key = ?', 'screen_matrix');
  const fallbackMatrix = { rows: 6, cols: 8, prefix: '屏' };
  let defaultMatrix = fallbackMatrix;

  if (matrixSetting) {
    try {
      defaultMatrix = { ...fallbackMatrix, ...JSON.parse(matrixSetting.value) };
    } catch {
      defaultMatrix = fallbackMatrix;
    }
  }

  if (!matrixSetting) {
    await api.run(
      'INSERT INTO settings (key, value) VALUES (?, ?)',
      'screen_matrix',
      JSON.stringify(defaultMatrix),
    );
  }

  const defaultProject = await api.get('SELECT id FROM projects WHERE id = 1');
  if (!defaultProject) {
    await api.run(
      'INSERT INTO projects (id, name, rows, cols, prefix) VALUES (1, ?, ?, ?, ?)',
      '默认项目',
      defaultMatrix.rows,
      defaultMatrix.cols,
      defaultMatrix.prefix,
    );
  }

  const refreshedCameraColumns = await api.all('PRAGMA table_info(cameras)');
  if (!refreshedCameraColumns.some((column) => column.name === 'project_id')) {
    await api.exec('ALTER TABLE cameras ADD COLUMN project_id INTEGER DEFAULT 1;');
  }

  await api.run('UPDATE cameras SET project_id = 1 WHERE project_id IS NULL');

  return api;
}

function getDb() {
  if (!api) {
    throw new Error('Database has not been initialized');
  }

  return api;
}

module.exports = {
  initDb,
  getDb,
};
