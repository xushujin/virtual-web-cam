import { describe, expect, it } from 'vitest';
import {
  bytesDelta,
  calculateResourceRates,
  formatByteRate,
  formatBytes,
  formatPercent,
  resourceDiskText,
  resourceNetworkText,
  resourceStatusText,
} from '../src/utils/resources.js';
import { mpvCommand, sourceAddress, sourceTypeLabel, statusLabel } from '../src/utils/cameras.js';
import { matchScreenUrls } from '../src/utils/screen-urls.js';

describe('resource utilities', () => {
  it('formats resource values for camera rows', () => {
    expect(formatPercent(12.345)).toBe('12.3%');
    expect(formatBytes(590 * 1024 * 1024)).toBe('590 MB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatByteRate(1024)).toBe('1.0 KB/s');
  });

  it('calculates non-negative network and disk rates', () => {
    const previous = {
      collected_at: '2026-05-13T10:00:00.000Z',
      summary: {
        networkRxBytes: 100,
        networkTxBytes: 200,
        blockReadBytes: 300,
        blockWriteBytes: 400,
      },
      items: [{
        camera_id: 1,
        network_rx_bytes: 100,
        network_tx_bytes: 200,
        block_read_bytes: 300,
        block_write_bytes: 400,
      }],
    };
    const current = {
      collected_at: '2026-05-13T10:00:10.000Z',
      summary: {
        networkRxBytes: 1100,
        networkTxBytes: 700,
        blockReadBytes: 100,
        blockWriteBytes: 900,
      },
      items: [{
        camera_id: 1,
        network_rx_bytes: 1100,
        network_tx_bytes: 700,
        block_read_bytes: 100,
        block_write_bytes: 900,
      }],
    };

    const rates = calculateResourceRates(previous, current);
    expect(rates.seconds).toBe(10);
    expect(rates.summary.network_rx_bps).toBe(100);
    expect(rates.summary.block_read_bps).toBe(0);
    expect(rates.items.get(1)).toMatchObject({
      network_rx_bps: 100,
      network_tx_bps: 50,
      block_read_bps: 0,
      block_write_bps: 50,
    });
    expect(bytesDelta(1, 10)).toBe(0);
    expect(calculateResourceRates(null, current)).toBeNull();
    expect(calculateResourceRates(previous, { ...current, collected_at: previous.collected_at })).toBeNull();
  });

  it('renders resource text with rates or cumulative counters', () => {
    const stats = {
      camera_id: 1,
      status: 'running',
      cpu_percent: 98.7,
      memory_usage_bytes: 590 * 1024 * 1024,
      network_rx_bytes: 84,
      network_tx_bytes: 2048,
      block_read_bytes: 0,
      block_write_bytes: 4096,
    };

    expect(resourceStatusText(stats, statusLabel)).toBe('98.7% / 590 MB');
    expect(resourceNetworkText(stats)).toBe('网络累计 ↓84 B ↑2.0 KB');
    expect(resourceDiskText(stats, {
      block_read_bps: 0,
      block_write_bps: 409.6,
    })).toBe('磁盘 读 0 B/s / 写 410 B/s');
    expect(resourceNetworkText(stats, {
      network_rx_bps: 10,
      network_tx_bps: 20,
    })).toBe('网络 ↓10 B/s ↑20 B/s');
    expect(resourceDiskText(stats)).toBe('磁盘累计 读 0 B / 写 4.0 KB');
    expect(resourceStatusText({ status: 'stopped' }, statusLabel)).toBe('已停止');
    expect(resourceStatusText(null, statusLabel)).toBe('未采集');
    expect(resourceNetworkText({ status: 'stopped' })).toBe('-');
    expect(resourceDiskText(null)).toBe('-');
  });
});

describe('camera and screen URL utilities', () => {
  it('formats camera source metadata and mpv command', () => {
    expect(mpvCommand({ rtsp_url: 'rtsp://192.168.5.211:554/screen01' }))
      .toBe('mpv --rtsp-transport=tcp rtsp://192.168.5.211:554/screen01');
    expect(sourceTypeLabel({ source_type: 'rtsp' })).toBe('RTSP流');
    expect(sourceTypeLabel({ source_type: 'camera' })).toBe('ONVIF');
    expect(sourceAddress({ source_type: 'rtsp' })).toBe('共享网关');
    expect(sourceAddress({ source_type: 'camera', ip: '192.168.5.211' })).toBe('192.168.5.211');
    expect(sourceAddress({ source_type: 'camera' })).toBe('-');
    expect(statusLabel('unknown')).toBe('unknown');
  });

  it('matches screen URLs by name url or remark', () => {
    const items = [
      { name: '大厅信息屏', url: 'https://example.com/hall', remark: '一楼' },
      { name: '托尔斯泰', url: 'https://example.com/tolstoy', remark: '会议室' },
    ];

    expect(matchScreenUrls(items, '会议')).toEqual([items[1]]);
    expect(matchScreenUrls(items, 'hall')).toEqual([items[0]]);
    expect(matchScreenUrls(items, '')).toBe(items);
  });
});
