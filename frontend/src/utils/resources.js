export function formatPercent(value, digits = 1) {
  const number = Number(value || 0);
  return `${number.toFixed(digits)}%`;
}

export function formatBytes(value) {
  const number = Number(value || 0);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = number;
  let index = 0;

  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }

  return `${current >= 10 || index === 0 ? current.toFixed(0) : current.toFixed(1)} ${units[index]}`;
}

export function formatByteRate(value) {
  return `${formatBytes(value)}/s`;
}

export function bytesDelta(current = 0, previous = 0) {
  return Math.max(Number(current || 0) - Number(previous || 0), 0);
}

export function calculateResourceRates(previous, current) {
  if (!previous?.collected_at || !current?.collected_at) return null;

  const seconds = (new Date(current.collected_at).getTime() - new Date(previous.collected_at).getTime()) / 1000;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  const previousById = new Map((previous.items || []).map((item) => [item.camera_id, item]));
  const items = new Map();

  for (const item of current.items || []) {
    const before = previousById.get(item.camera_id);
    if (!before) continue;
    items.set(item.camera_id, {
      network_rx_bps: bytesDelta(item.network_rx_bytes, before.network_rx_bytes) / seconds,
      network_tx_bps: bytesDelta(item.network_tx_bytes, before.network_tx_bytes) / seconds,
      block_read_bps: bytesDelta(item.block_read_bytes, before.block_read_bytes) / seconds,
      block_write_bps: bytesDelta(item.block_write_bytes, before.block_write_bytes) / seconds,
    });
  }

  return {
    seconds,
    summary: {
      network_rx_bps: bytesDelta(current.summary?.networkRxBytes, previous.summary?.networkRxBytes) / seconds,
      network_tx_bps: bytesDelta(current.summary?.networkTxBytes, previous.summary?.networkTxBytes) / seconds,
      block_read_bps: bytesDelta(current.summary?.blockReadBytes, previous.summary?.blockReadBytes) / seconds,
      block_write_bps: bytesDelta(current.summary?.blockWriteBytes, previous.summary?.blockWriteBytes) / seconds,
    },
    items,
  };
}

export function resourceStatusText(stats, statusLabel) {
  if (!stats) return '未采集';
  if (stats.status !== 'running') return statusLabel(stats.status);
  return `${formatPercent(stats.cpu_percent)} / ${formatBytes(stats.memory_usage_bytes)}`;
}

export function resourceNetworkText(stats, rate) {
  if (!stats || stats.status !== 'running') return '-';
  if (rate) {
    return `网络 ↓${formatByteRate(rate.network_rx_bps)} ↑${formatByteRate(rate.network_tx_bps)}`;
  }
  return `网络累计 ↓${formatBytes(stats.network_rx_bytes)} ↑${formatBytes(stats.network_tx_bytes)}`;
}

export function resourceDiskText(stats, rate) {
  if (!stats || stats.status !== 'running') return '-';
  if (rate) {
    return `磁盘 读 ${formatByteRate(rate.block_read_bps)} / 写 ${formatByteRate(rate.block_write_bps)}`;
  }
  return `磁盘累计 读 ${formatBytes(stats.block_read_bytes)} / 写 ${formatBytes(stats.block_write_bytes)}`;
}
