#!/usr/bin/env bash
set -euo pipefail

GO2RTC_API_PORT="${GO2RTC_API_PORT:-80}"
GO2RTC_RTSP_PORT="${GO2RTC_RTSP_PORT:-554}"
MEDIAMTX_RTSP_PORT="${MEDIAMTX_RTSP_PORT:-8556}"
STREAM_NAME="${STREAM_NAME:-screen01}"
RTSP_HEALTHCHECK="${RTSP_HEALTHCHECK:-0}"

timeout 1 bash -c "</dev/tcp/127.0.0.1/${GO2RTC_API_PORT}"
timeout 1 bash -c "</dev/tcp/127.0.0.1/${GO2RTC_RTSP_PORT}"
timeout 1 bash -c "</dev/tcp/127.0.0.1/${MEDIAMTX_RTSP_PORT}"

pgrep -f "Xvfb" >/dev/null
pgrep -f "openbox" >/dev/null
pgrep -f "chrome|chromium" >/dev/null
pgrep -f "ffmpeg" >/dev/null
pgrep -f "mediamtx" >/dev/null
pgrep -f "go2rtc" >/dev/null

if [[ "$RTSP_HEALTHCHECK" == "1" ]]; then
  timeout 10 ffprobe \
    -v error \
    -rtsp_transport tcp \
    -select_streams v:0 \
    -show_entries stream=codec_type \
    -of csv=p=0 \
    "rtsp://127.0.0.1:${GO2RTC_RTSP_PORT}/${STREAM_NAME}" \
    | grep -q '^video'
fi
