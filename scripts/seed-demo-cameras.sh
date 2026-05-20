#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:8177/api}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123456}"
DEMO_USER_PASSWORD="${DEMO_USER_PASSWORD:-demo123456}"

TOKEN=""

log() {
  printf '[VirtualWebCam 演示数据] %s\n' "$*"
}

api_json() {
  local method="$1"
  local path="$2"
  local data="${3:-}"
  local args=(-fsS -X "$method" "${API_BASE}${path}" -H 'Content-Type: application/json')

  if [[ -n "$TOKEN" ]]; then
    args+=(-H "Authorization: Bearer ${TOKEN}")
  fi

  if [[ -n "$data" ]]; then
    args+=(-d "$data")
  fi

  curl "${args[@]}"
}

json_get() {
  local expr="$1"
  node -e '
    const fs = require("fs");
    const data = JSON.parse(fs.readFileSync(0, "utf8"));
    const fn = new Function("data", process.argv[1]);
    const value = fn(data);
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$expr"
}

login() {
  log "登录 ${API_BASE}"
  TOKEN="$(
    api_json POST /auth/login "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
      | json_get 'return data.token'
  )"

  [[ -n "$TOKEN" ]] || {
    printf '无法登录。请通过 ADMIN_USERNAME / ADMIN_PASSWORD 指定管理员账号。\n' >&2
    exit 1
  }
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
    }" >/dev/null
    project_id="$(project_id_by_name "$name")"
    log "创建项目：${name}"
  else
    api_json PUT "/projects/${project_id}" "{
      \"name\": \"${name}\",
      \"rows\": ${rows},
      \"cols\": ${cols},
      \"prefix\": \"${prefix}\"
    }" >/dev/null
    log "更新项目：${name}"
  fi

  printf '%s\n' "$project_id"
}

ensure_screen_url() {
  local project_id="$1"
  local name="$2"
  local url="$3"
  local remark="$4"
  local exists

  exists="$(
    api_json GET "/screen-urls?project_id=${project_id}" | node -e '
      const fs = require("fs");
      const name = process.argv[1];
      const rows = JSON.parse(fs.readFileSync(0, "utf8"));
      process.stdout.write(rows.some((item) => item.name === name) ? "1" : "");
    ' "$name"
  )"

  if [[ -n "$exists" ]]; then
    log "跳过已有大屏地址：${name}"
    return
  fi

  api_json POST "/screen-urls?project_id=${project_id}" "{
    \"name\": \"${name}\",
    \"url\": \"${url}\",
    \"remark\": \"${remark}\"
  }" >/dev/null
  log "添加大屏地址：${name}"
}

camera_count_by_prefix() {
  local project_id="$1"
  local prefix="$2"
  api_json GET "/cameras?project_id=${project_id}" | node -e '
    const fs = require("fs");
    const prefix = process.argv[1];
    const cameras = JSON.parse(fs.readFileSync(0, "utf8"));
    process.stdout.write(String(cameras.filter((item) => item.name.startsWith(prefix)).length));
  ' "$prefix"
}

ensure_bulk_cameras() {
  local project_id="$1"
  local count="$2"
  local start_ip="$3"
  local name_prefix="$4"
  local stream_prefix="$5"
  local web_url="$6"
  local width="$7"
  local height="$8"
  local fps="$9"
  local existing

  existing="$(camera_count_by_prefix "$project_id" "$name_prefix")"
  if [[ "$existing" -ge "$count" ]]; then
    log "跳过已有视频源：${name_prefix}* (${existing} 路)"
    return
  fi

  api_json POST "/cameras/bulk?project_id=${project_id}" "{
    \"count\": ${count},
    \"start_ip\": \"${start_ip}\",
    \"name_prefix\": \"${name_prefix}\",
    \"stream_prefix\": \"${stream_prefix}\",
    \"web_url\": \"${web_url}\",
    \"width\": ${width},
    \"height\": ${height},
    \"fps\": ${fps}
  }" >/dev/null
  log "批量生成视频源：${name_prefix}* (${count} 路，默认停止)"
}

user_id_by_username() {
  local username="$1"
  api_json GET /users | node -e '
    const fs = require("fs");
    const username = process.argv[1];
    const users = JSON.parse(fs.readFileSync(0, "utf8"));
    const user = users.find((item) => item.username === username);
    if (user) process.stdout.write(String(user.id));
  ' "$username"
}

ensure_user() {
  local username="$1"
  local display_name="$2"
  local role="$3"
  local user_id

  user_id="$(user_id_by_username "$username")"
  if [[ -n "$user_id" ]]; then
    log "跳过已有用户：${username}"
    printf '%s\n' "$user_id"
    return
  fi

  api_json POST /users "{
    \"username\": \"${username}\",
    \"display_name\": \"${display_name}\",
    \"password\": \"${DEMO_USER_PASSWORD}\",
    \"role\": \"${role}\",
    \"enabled\": true
  }" >/dev/null
  user_id="$(user_id_by_username "$username")"
  log "创建用户：${username} / ${DEMO_USER_PASSWORD}"
  printf '%s\n' "$user_id"
}

grant_user_projects() {
  local user_id="$1"
  shift
  local payload='{"projects":['
  local first=1

  while [[ $# -gt 0 ]]; do
    local project_id="$1"
    local role="$2"
    shift 2
    if [[ "$first" -eq 0 ]]; then
      payload+=','
    fi
    payload+="{\"project_id\":${project_id},\"role\":\"${role}\"}"
    first=0
  done

  payload+=']}'
  api_json PUT "/users/${user_id}/projects" "$payload" >/dev/null
  log "更新用户授权：user_id=${user_id}"
}

login

DEFAULT_PROJECT_ID="$(ensure_project "验收演示项目" 4 6 "屏" | tail -n 1)"
SHOP_PROJECT_ID="$(ensure_project "门店横屏演示" 2 8 "店" | tail -n 1)"

ensure_screen_url "$DEFAULT_PROJECT_ID" "大厅信息屏" "https://example.com" "稳定测试页"
ensure_screen_url "$DEFAULT_PROJECT_ID" "生产看板" "https://www.baidu.com" "中文页面测试"
ensure_screen_url "$DEFAULT_PROJECT_ID" "会议室日程" "https://gitee.com" "复杂页面测试"
ensure_screen_url "$SHOP_PROJECT_ID" "门店活动页" "https://example.com" "门店横屏测试"

ensure_bulk_cameras "$DEFAULT_PROJECT_ID" 6 "192.168.5.200" "大厅屏-" "demo-screen-" "https://example.com" 1280 720 15
ensure_bulk_cameras "$SHOP_PROJECT_ID" 4 "192.168.5.221" "门店屏-" "shop-screen-" "https://example.com" 1920 1080 10

VIEWER_ID="$(ensure_user "viewer01" "只读验收员" "user" | tail -n 1)"
OPERATOR_ID="$(ensure_user "operator01" "现场操作员" "user" | tail -n 1)"

grant_user_projects "$VIEWER_ID" "$DEFAULT_PROJECT_ID" viewer
grant_user_projects "$OPERATOR_ID" "$DEFAULT_PROJECT_ID" operator "$SHOP_PROJECT_ID" operator

cat <<EOF

演示数据已准备完成。

管理员:
  ${ADMIN_USERNAME} / ${ADMIN_PASSWORD}

演示用户:
  viewer01 / ${DEMO_USER_PASSWORD}     仅查看“验收演示项目”
  operator01 / ${DEMO_USER_PASSWORD}   可操作两个演示项目

项目:
  验收演示项目: ${DEFAULT_PROJECT_ID}
  门店横屏演示: ${SHOP_PROJECT_ID}
EOF
