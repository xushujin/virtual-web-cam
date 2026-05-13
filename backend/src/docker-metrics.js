function appStatusFromState(state = {}) {
  if (state.Running) {
    return 'running';
  }

  if (state.Status === 'exited' || state.Status === 'created' || state.Status === 'dead') {
    return state.ExitCode === 0 ? 'stopped' : 'error';
  }

  return 'stopped';
}

function sumNetwork(networks = {}) {
  return Object.values(networks || {}).reduce((total, item) => ({
    rxBytes: total.rxBytes + (item.rx_bytes || 0),
    txBytes: total.txBytes + (item.tx_bytes || 0),
  }), { rxBytes: 0, txBytes: 0 });
}

function sumBlockIo(entries = []) {
  return (entries || []).reduce((total, item) => {
    const op = String(item.op || '').toLowerCase();
    const value = item.value || 0;

    if (op === 'read') {
      total.readBytes += value;
    } else if (op === 'write') {
      total.writeBytes += value;
    }

    return total;
  }, { readBytes: 0, writeBytes: 0 });
}

function cpuPercent(stats = {}) {
  const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage || 0) - (stats.precpu_stats?.cpu_usage?.total_usage || 0);
  const systemDelta = (stats.cpu_stats?.system_cpu_usage || 0) - (stats.precpu_stats?.system_cpu_usage || 0);
  const onlineCpus = stats.cpu_stats?.online_cpus || stats.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;

  if (cpuDelta <= 0 || systemDelta <= 0) {
    return 0;
  }

  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

function memoryStats(stats = {}) {
  const rawUsage = stats.memory_stats?.usage || 0;
  const cache = stats.memory_stats?.stats?.cache || 0;
  const usage = Math.max(rawUsage - cache, 0);
  const limit = stats.memory_stats?.limit || 0;

  return {
    usageBytes: usage,
    limitBytes: limit,
    percent: limit > 0 ? (usage / limit) * 100 : 0,
  };
}

module.exports = {
  appStatusFromState,
  cpuPercent,
  memoryStats,
  sumBlockIo,
  sumNetwork,
};
