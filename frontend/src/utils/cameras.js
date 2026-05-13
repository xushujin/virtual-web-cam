export function mpvCommand(camera) {
  return `mpv --rtsp-transport=tcp ${camera.rtsp_url}`;
}

export function statusLabel(status) {
  const map = {
    running: '运行中',
    stopped: '已停止',
    error: '异常',
  };
  return map[status] || status;
}

export function sourceTypeLabel(camera) {
  return camera.source_type === 'rtsp' ? 'RTSP流' : 'ONVIF';
}

export function sourceAddress(camera) {
  return camera.source_type === 'rtsp' ? '共享网关' : (camera.ip || '-');
}
