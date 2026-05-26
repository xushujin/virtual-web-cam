const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'virtualwebcam-backup-test-'));
const backupDir = path.join(tempDir, 'backups');

process.env.SQLITE_PATH = path.join(tempDir, 'virtualwebcam-test.db');
process.env.DB_BACKUP_PATH = backupDir;
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'admin123456';

const { getDb, initDb } = require('../src/db');
const backupService = require('../src/backup');

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('database backup config persists and manual backup creates a copy', async () => {
  await initDb();
  await getDb().run(
    'INSERT INTO settings (key, value) VALUES (?, ?)',
    'backup_test_marker',
    'ok',
  );

  const saved = await backupService.saveBackupConfig({
    enabled: true,
    frequency: 'hourly',
    backup_path: backupDir,
  }, { username: 'admin' });

  assert.equal(saved.enabled, true);
  assert.equal(saved.frequency, 'hourly');
  assert.equal(saved.backup_path, backupDir);
  assert.match(saved.next_run_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(saved.updated_by, 'admin');

  const result = await backupService.runBackupNow({ reason: 'unit-test' });
  assert.equal(result.last_status, 'success');
  assert.equal(result.last_error, '');
  assert.match(path.basename(result.last_file), /^virtualwebcam-\d{8}T\d{9}Z\.db$/);
  assert.equal(fs.existsSync(result.last_file), true);
  assert.ok(fs.statSync(result.last_file).size > 0);

  const listed = await backupService.listBackupFiles();
  assert.equal(listed.files.some((file) => file.name === path.basename(result.last_file)), true);

  await getDb().run(
    'INSERT INTO settings (key, value) VALUES (?, ?)',
    'restore_test_marker',
    'dirty',
  );

  const restored = await backupService.restoreBackupFile(path.basename(result.last_file));
  assert.equal(restored.restored, true);
  assert.equal(restored.restored_file, result.last_file);
  assert.equal(fs.existsSync(restored.safety_backup_file), true);
  assert.equal(
    await getDb().get('SELECT value FROM settings WHERE key = ?', 'restore_test_marker'),
    undefined,
  );
  assert.deepEqual(
    await getDb().get('SELECT value FROM settings WHERE key = ?', 'backup_test_marker'),
    { value: 'ok' },
  );
});

test('backup paths must be absolute', () => {
  assert.throws(
    () => backupService.normalizeBackupPath('relative/backups'),
    /absolute path/,
  );
});
