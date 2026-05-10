#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:8177/api}"

api_json() {
  local method="$1"
  local path="$2"
  local data="${3:-}"

  if [[ -n "$data" ]]; then
    curl -sS -X "$method" "${API_BASE}${path}" -H 'Content-Type: application/json' -d "$data"
  else
    curl -sS -X "$method" "${API_BASE}${path}"
  fi
}

project_id_by_name() {
  local name="$1"
  api_json GET /projects | node -e '
    const fs = require("fs");
    const name = process.argv[1];
    const projects = JSON.parse(fs.readFileSync(0, "utf8"));
    const project = projects.find((item) => item.name === name);
    if (project) process.stdout.write(String(project.id));
  ' "$name"
}

ensure_project() {
  local name="$1"
  local rows="$2"
  local cols="$3"
  local prefix="$4"
  local project_id

  project_id="$(project_id_by_name "$name")"

  if [[ -z "$project_id" ]]; then
    api_json POST /projects "{
      \"name\": \"${name}\",
      \"rows\": ${rows},
      \"cols\": ${cols},
      \"prefix\": \"${prefix}\"
    }" >/tmp/virtualwebcam-project-response.json
    project_id="$(project_id_by_name "$name")"
    echo "Created project: ${name}"
  else
    api_json PUT "/projects/${project_id}" "{
      \"name\": \"${name}\",
      \"rows\": ${rows},
      \"cols\": ${cols},
      \"prefix\": \"${prefix}\"
    }" >/dev/null
    echo "Updated project: ${name}"
  fi

  echo "$project_id"
}

camera_id_by_ip() {
  local project_id="$1"
  local ip="$2"
  api_json GET "/cameras?project_id=${project_id}" | node -e '
    const fs = require("fs");
    const ip = process.argv[1];
    const cameras = JSON.parse(fs.readFileSync(0, "utf8"));
    const camera = cameras.find((item) => item.ip === ip);
    if (camera) process.stdout.write(String(camera.id));
  ' "$ip"
}

seed_camera() {
  local project_id="$1"
  local name="$2"
  local ip="$3"
  local stream_name="$4"
  local web_url="$5"
  local width="$6"
  local height="$7"
  local fps="$8"
  local camera_id

  camera_id="$(camera_id_by_ip "$project_id" "$ip")"

  if [[ -z "$camera_id" ]]; then
    api_json POST "/cameras?project_id=${project_id}" "{
      \"name\": \"${name}\",
      \"ip\": \"${ip}\",
      \"stream_name\": \"${stream_name}\",
      \"web_url\": \"${web_url}\",
      \"width\": ${width},
      \"height\": ${height},
      \"fps\": ${fps},
      \"display_targets\": [],
      \"display_region\": null
    }" >/tmp/virtualwebcam-seed-response.json || true
    camera_id="$(camera_id_by_ip "$project_id" "$ip")"
    echo "Seeded camera: ${name} (${ip})"
  else
    echo "Skipped existing camera: ${name} (${ip})"
  fi

  if [[ -n "$camera_id" ]]; then
    api_json PATCH "/cameras/${camera_id}/display-targets" '{"display_targets": [], "display_region": null}' >/dev/null
    echo "Cleared display targets: ${ip}"
  fi
}

DEFAULT_PROJECT_ID="$(ensure_project "默认项目" 6 8 "屏" | tail -n 1)"
SHOP_PROJECT_ID="$(ensure_project "门店窄屏项目" 2 8 "屏" | tail -n 1)"

seed_camera "$DEFAULT_PROJECT_ID" "大厅信息屏" "192.168.5.211" "screen01" "https://www.baidu.com" 1280 720 15
seed_camera "$DEFAULT_PROJECT_ID" "生产看板" "192.168.5.212" "screen02" "https://gitee.com" 1280 720 15
seed_camera "$DEFAULT_PROJECT_ID" "会议室日程" "192.168.5.213" "screen03" "https://example.com" 1920 1080 10

seed_camera "$SHOP_PROJECT_ID" "门店左屏" "192.168.5.214" "shop01" "https://www.baidu.com" 1280 720 15
seed_camera "$SHOP_PROJECT_ID" "门店右屏" "192.168.5.215" "shop02" "https://example.com" 1280 720 15

echo
echo "Projects:"
api_json GET /projects
echo
echo
echo "Default project cameras:"
api_json GET "/cameras?project_id=${DEFAULT_PROJECT_ID}"
echo
