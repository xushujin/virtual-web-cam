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
    schedule_minute: 15,
    backup_path: backupDir,
  }, { username: 'admin' });

  assert.equal(saved.enabled, true);
  assert.equal(saved.frequency, 'hourly');
  assert.equal(saved.schedule_minute, 15);
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

  await getDb().run(
    'INSERT INTO settings (key, value) VALUES (?, ?)',
    'upload_restore_test_marker',
    'dirty',
  );

  const uploaded = await backupService.restoreUploadedBackup('manual-copy.db', fs.readFileSync(result.last_file));
  assert.equal(uploaded.restored, true);
  assert.equal(fs.existsSync(uploaded.uploaded_file), true);
  assert.equal(
    await getDb().get('SELECT value FROM settings WHERE key = ?', 'upload_restore_test_marker'),
    undefined,
  );

  const deleted = await backupService.deleteBackupFile(path.basename(result.last_file));
  assert.equal(deleted.deleted, true);
  assert.equal(fs.existsSync(result.last_file), false);
});

test('backup paths must be absolute', () => {
  assert.throws(
    () => backupService.normalizeBackupPath('relative/backups'),
    /absolute path/,
  );
});

test('backup schedules calculate concrete next run times', () => {
  const base = new Date(2026, 4, 26, 10, 15, 30, 0);
  const hourly = new Date(backupService.nextRunAt(base, {
    frequency: 'hourly',
    schedule_minute: 20,
  }));
  assert.equal(hourly.getMinutes(), 20);
  assert.equal(hourly.getSeconds(), 0);
  assert.equal(hourly.getTime() > base.getTime(), true);

  const daily = new Date(backupService.nextRunAt(base, {
    frequency: 'daily',
    schedule_time: '09:30',
  }));
  assert.equal(daily.getHours(), 9);
  assert.equal(daily.getMinutes(), 30);
  assert.equal(daily.getDate(), 27);

  const weekly = new Date(backupService.nextRunAt(base, {
    frequency: 'weekly',
    schedule_time: '08:00',
    schedule_weekday: 1,
  }));
  assert.equal(weekly.getDay(), 1);
  assert.equal(weekly.getHours(), 8);
  assert.equal(weekly.getMinutes(), 0);

  const monthly = new Date(backupService.nextRunAt(base, {
    frequency: 'monthly',
    schedule_time: '03:45',
    schedule_month_day: 1,
  }));
  assert.equal(monthly.getDate(), 1);
  assert.equal(monthly.getHours(), 3);
  assert.equal(monthly.getMinutes(), 45);
  assert.equal(monthly.getMonth(), 5);
});
