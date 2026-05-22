const assert = require('node:assert/strict');
const test = require('node:test');

process.env.VIRTUALWEBCAM_IMAGE = 'virtualwebcam:test';
process.env.DOCKER_SOCKET = '/tmp/docker.sock';

const dockerService = require('../src/docker');
const {
  appStatusFromState,
  cpuPercent,
  memoryStats,
  sumBlockIo,
  sumNetwork,
} = require('../src/docker-metrics');

test('friendlyDockerError explains common runtime failures', () => {
  assert.match(
    dockerService.friendlyDockerError({ message: 'No such image: virtualwebcam:test' }),
    /Docker 镜像不存在/,
  );
  assert.match(
    dockerService.friendlyDockerError({ message: 'network onvif_macvlan not found' }),
    /Docker 网络不存在/,
  );
  assert.match(
    dockerService.friendlyDockerError({ message: 'permission denied while trying to connect' }),
    /无权访问 Docker socket/,
  );
  assert.match(
    dockerService.friendlyDockerError({ message: 'connect ENOENT /tmp/docker.sock' }),
    /无法访问 Docker socket/,
  );
  assert.equal(
    dockerService.friendlyDockerError({ message: 'unexpected failure' }),
    'unexpected failure',
  );
});

test('formatDockerLogsChinaTime converts Docker timestamps to China time', () => {
  assert.equal(
    dockerService.formatDockerLogsChinaTime('2026-05-22T14:30:01.123456789Z starting service'),
    '2026-05-22 22:30:01.123 +08:00 starting service',
  );
  assert.equal(
    dockerService.formatDockerLogsChinaTime('2026-05-22T14:30:01+00:00 starting service'),
    '2026-05-22 22:30:01.000 +08:00 starting service',
  );
  assert.equal(
    dockerService.formatDockerLogsChinaTime('plain log line'),
    'plain log line',
  );
});

test('appStatusFromState maps Docker states to app states', () => {
  assert.equal(appStatusFromState({ Running: true }), 'running');
  assert.equal(appStatusFromState({ Status: 'exited', ExitCode: 0 }), 'stopped');
  assert.equal(appStatusFromState({ Status: 'exited', ExitCode: 1 }), 'error');
  assert.equal(appStatusFromState({ Status: 'created', ExitCode: 0 }), 'stopped');
  assert.equal(appStatusFromState({ Status: 'unknown' }), 'stopped');
});

test('cpuPercent follows Docker stats delta formula', () => {
  const percent = cpuPercent({
    cpu_stats: {
      cpu_usage: { total_usage: 1500, percpu_usage: [1, 2] },
      system_cpu_usage: 5000,
      online_cpus: 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: 1000 },
      system_cpu_usage: 4000,
    },
  });

  assert.equal(percent, 100);
  assert.equal(cpuPercent({}), 0);
});

test('memoryStats subtracts cache and calculates percent', () => {
  assert.deepEqual(memoryStats({
    memory_stats: {
      usage: 900,
      limit: 2000,
      stats: { cache: 100 },
    },
  }), {
    usageBytes: 800,
    limitBytes: 2000,
    percent: 40,
  });

  assert.equal(memoryStats({}).percent, 0);
});

test('network and block IO summaries aggregate Docker stats', () => {
  assert.deepEqual(sumNetwork({
    eth0: { rx_bytes: 100, tx_bytes: 50 },
    eth1: { rx_bytes: 25, tx_bytes: 75 },
  }), {
    rxBytes: 125,
    txBytes: 125,
  });

  assert.deepEqual(sumBlockIo([
    { op: 'Read', value: 1000 },
    { op: 'Write', value: 2500 },
    { op: 'Sync', value: 999 },
  ]), {
    readBytes: 1000,
    writeBytes: 2500,
  });
});
