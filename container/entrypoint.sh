#!/usr/bin/env bash
set -Eeuo pipefail

WEB_URL="${WEB_URL:-https://www.baidu.com}"
STREAM_NAME="${STREAM_NAME:-screen01}"
WIDTH="${WIDTH:-1280}"
HEIGHT="${HEIGHT:-720}"
FPS="${FPS:-15}"
DISPLAY_ID="${DISPLAY_ID:-99}"
MEDIAMTX_RTSP_PORT="${MEDIAMTX_RTSP_PORT:-8556}"
GO2RTC_RTSP_PORT="${GO2RTC_RTSP_PORT:-8554}"
GO2RTC_API_PORT="${GO2RTC_API_PORT:-80}"
GO2RTC_WEBRTC_PORT="${GO2RTC_WEBRTC_PORT:-8555}"
CHROME_BIN="${CHROME_BIN:-}"

PIDS=()

log() {
  printf '[virtualwebcam] %s\n' "$*"
}

die() {
  log "ERROR: $*"
  exit 1
}

require_int() {
  local name="$1"
  local value="$2"
  [[ "$value" =~ ^[0-9]+$ ]] || die "${name} must be an integer, got '${value}'"
}

require_int WIDTH "$WIDTH"
require_int HEIGHT "$HEIGHT"
require_int FPS "$FPS"
require_int DISPLAY_ID "$DISPLAY_ID"
require_int MEDIAMTX_RTSP_PORT "$MEDIAMTX_RTSP_PORT"
require_int GO2RTC_RTSP_PORT "$GO2RTC_RTSP_PORT"
require_int GO2RTC_API_PORT "$GO2RTC_API_PORT"
require_int GO2RTC_WEBRTC_PORT "$GO2RTC_WEBRTC_PORT"

[[ "$STREAM_NAME" =~ ^[A-Za-z0-9._-]+$ ]] || die "STREAM_NAME may only contain letters, numbers, dot, underscore and dash"
[[ "$WEB_URL" =~ ^https?:// ]] || die "WEB_URL must start with http:// or https://"

if [[ -z "$CHROME_BIN" ]]; then
  CHROME_BIN="$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || true)"
fi
[[ -x "$CHROME_BIN" ]] || die "Chromium/Chrome binary not found"

XVFB_DISPLAY=":${DISPLAY_ID}"
CONFIG_DIR="/config"
RUNTIME_DIR="/run/virtualwebcam"
CHROME_PROFILE="/tmp/chrome-${STREAM_NAME}"
INTERNAL_RTSP="rtsp://127.0.0.1:${MEDIAMTX_RTSP_PORT}/${STREAM_NAME}"

rm -rf "$CHROME_PROFILE"
mkdir -p "$CONFIG_DIR" "$RUNTIME_DIR" "$CHROME_PROFILE"

cleanup() {
  local exit_code=$?
  trap - EXIT INT TERM
  log "stopping services"
  for pid in "${PIDS[@]:-}"; do
    pkill -TERM -P "$pid" >/dev/null 2>&1 || true
    kill "$pid" >/dev/null 2>&1 || true
  done
  wait >/dev/null 2>&1 || true
  return "$exit_code"
}
trap cleanup EXIT INT TERM

wait_for_display() {
  for _ in $(seq 1 50); do
    if xdpyinfo -display "$XVFB_DISPLAY" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

wait_for_port() {
  local host="$1"
  local port="$2"
  local name="$3"

  for _ in $(seq 1 100); do
    if timeout 1 bash -c "</dev/tcp/${host}/${port}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done

  die "${name} did not open ${host}:${port}"
}

wait_for_chrome_window() {
  local tree

  for _ in $(seq 1 180); do
    tree="$(DISPLAY="$XVFB_DISPLAY" xwininfo -root -tree 2>/dev/null || true)"
    if printf '%s\n' "$tree" | grep -Eiq 'chrome|chromium|google-chrome'; then
      return 0
    fi
    if printf '%s\n' "$tree" | grep -Eq "[[:space:]]${WIDTH}x${HEIGHT}\\+0\\+0"; then
      return 0
    fi
    sleep 0.25
  done

  DISPLAY="$XVFB_DISPLAY" xwininfo -root -tree 2>/dev/null | sed -n '1,80p' || true
  return 1
}

write_mediamtx_config() {
  cat > "${CONFIG_DIR}/mediamtx.yml" <<EOF
logLevel: info
logDestinations: [stdout]
rtsp: true
rtspAddress: 127.0.0.1:${MEDIAMTX_RTSP_PORT}
rtspTransports: [tcp]
rtmp: false
hls: false
webrtc: false
srt: false
pathDefaults:
  source: publisher
  overridePublisher: true
paths:
  all_others:
EOF
}

write_go2rtc_config() {
  cat > "${CONFIG_DIR}/go2rtc.yaml" <<EOF
api:
  listen: ":${GO2RTC_API_PORT}"
  origin: "*"
rtsp:
  listen: ":${GO2RTC_RTSP_PORT}"
webrtc:
  listen: ":${GO2RTC_WEBRTC_PORT}"
streams:
  ${STREAM_NAME}:
    - ${INTERNAL_RTSP}
EOF
}

start_xvfb() {
  log "starting Xvfb on ${XVFB_DISPLAY} (${WIDTH}x${HEIGHT}, ${FPS} fps target)"
  Xvfb "$XVFB_DISPLAY" -screen 0 "${WIDTH}x${HEIGHT}x24" -ac +extension GLX +render -noreset &
  PIDS+=("$!")
  wait_for_display || die "Xvfb did not become ready"
}

start_openbox() {
  log "starting openbox"
  DISPLAY="$XVFB_DISPLAY" openbox >/tmp/openbox.log 2>&1 &
  PIDS+=("$!")
}

chrome_loop() {
  while true; do
    DISPLAY="$XVFB_DISPLAY" "$CHROME_BIN" \
      --no-sandbox \
      --disable-dev-shm-usage \
      --disable-gpu \
      --disable-background-networking \
      --disable-component-update \
      --disable-default-apps \
      --disable-features=Translate,MediaRouter,OptimizationHints,InterestFeedContentSuggestions \
      --ozone-platform=x11 \
      --autoplay-policy=no-user-gesture-required \
      --ignore-certificate-errors \
      --metrics-recording-only \
      --no-default-browser-check \
      --disable-session-crashed-bubble \
      --user-data-dir="$CHROME_PROFILE" \
      --password-store=basic \
      --use-mock-keychain \
      --no-first-run \
      --disable-extensions \
      --window-size="${WIDTH},${HEIGHT}" \
      --window-position=0,0 \
      --start-fullscreen \
      --kiosk \
      --new-window \
      "$WEB_URL"
    log "Chrome exited, restarting in 2 seconds"
    sleep 2
  done
}

start_chrome() {
  log "starting Chrome for ${WEB_URL}"
  chrome_loop &
  PIDS+=("$!")
  wait_for_chrome_window || die "Chrome did not create a window on ${XVFB_DISPLAY}"
}

start_mediamtx() {
  write_mediamtx_config
  log "starting MediaMTX on 127.0.0.1:${MEDIAMTX_RTSP_PORT}"
  mediamtx "${CONFIG_DIR}/mediamtx.yml" &
  PIDS+=("$!")
  wait_for_port 127.0.0.1 "$MEDIAMTX_RTSP_PORT" "MediaMTX"
}

start_go2rtc() {
  write_go2rtc_config
  log "starting go2rtc: RTSP :${GO2RTC_RTSP_PORT}, HTTP/ONVIF :${GO2RTC_API_PORT}"
  go2rtc -config "${CONFIG_DIR}/go2rtc.yaml" &
  PIDS+=("$!")
  wait_for_port 127.0.0.1 "$GO2RTC_API_PORT" "go2rtc API"
  wait_for_port 127.0.0.1 "$GO2RTC_RTSP_PORT" "go2rtc RTSP"
}

ffmpeg_loop() {
  local gop=$((FPS * 2))
  if (( gop < 1 )); then
    gop=30
  fi

  while true; do
    ffmpeg -hide_banner -loglevel info -re \
      -f x11grab \
      -draw_mouse 0 \
      -video_size "${WIDTH}x${HEIGHT}" \
      -framerate "$FPS" \
      -i "${XVFB_DISPLAY}.0+0,0" \
      -c:v libx264 \
      -preset veryfast \
      -tune zerolatency \
      -pix_fmt yuv420p \
      -profile:v baseline \
      -level 3.1 \
      -g "$gop" \
      -bf 0 \
      -an \
      -rtsp_transport tcp \
      -f rtsp "$INTERNAL_RTSP"
    log "FFmpeg exited, restarting in 2 seconds"
    sleep 2
  done
}

start_ffmpeg() {
  log "starting FFmpeg publisher to ${INTERNAL_RTSP}"
  ffmpeg_loop &
  PIDS+=("$!")
}

monitor_services() {
  log "ready: rtsp://<container_ip>:${GO2RTC_RTSP_PORT}/${STREAM_NAME}"
  log "ready: http://<container_ip>:${GO2RTC_API_PORT}/onvif/device_service"
  log "ready: http://<container_ip>:${GO2RTC_API_PORT}"

  while true; do
    for pid in "${PIDS[@]}"; do
      if ! kill -0 "$pid" >/dev/null 2>&1; then
        wait "$pid"
        die "service process ${pid} stopped"
      fi
    done
    sleep 5
  done
}

start_xvfb
start_openbox
start_chrome
start_mediamtx
start_go2rtc
start_ffmpeg
monitor_services
