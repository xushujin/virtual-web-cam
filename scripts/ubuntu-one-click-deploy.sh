#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd -P)"
ENV_FILE="${PROJECT_ROOT}/.env"

ASSUME_YES=0
FORCE_ENV=0
SKIP_DOCKER_INSTALL=0
SKIP_MACVLAN=0
ENABLE_HOST_MACVLAN=1
ENABLE_SYSTEMD_HOST_MACVLAN=1

NETWORK_NAME_INPUT=""
HOST_IF_INPUT=""
HOST_IP_INPUT=""
SUBNET_INPUT=""
GATEWAY_INPUT=""
IP_RANGE_INPUT=""
HOST_MACVLAN_IP_INPUT=""
ROUTE_CIDR_INPUT=""
ADMIN_USERNAME_INPUT=""
ADMIN_PASSWORD_INPUT=""
BACKEND_PORT_INPUT=""
FRONTEND_PORT_INPUT=""
RTSP_GATEWAY_PORT_INPUT=""

USE_SUDO_DOCKER=0
COMPOSE_IMPL=""
GENERATED_ADMIN_PASSWORD=0
EXISTING_DB=0

log() {
  printf '[部署] %s\n' "$*"
}

warn() {
  printf '[部署][警告] %s\n' "$*" >&2
}

die() {
  printf '[部署][错误] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法:
  ./scripts/ubuntu-one-click-deploy.sh [options]

通用选项:
  -y, --yes                         使用自动检测值，不逐项询问
      --force-env                   按检测值或命令行参数重写 .env
      --skip-docker-install         Docker 不存在时也不自动安装

网络选项:
      --host-if IFACE               宿主机父网卡，例如 br0/ens33
      --host-ip IP                  宿主机局域网 IP，用作 RTSP 共享网关地址
      --subnet CIDR                 客户现场网段，例如 192.168.5.0/24
      --gateway IP                  客户现场网关，例如 192.168.5.1
      --ip-range CIDR               ONVIF 虚拟摄像头 macvlan 地址池
      --host-macvlan-ip IP          宿主机 macvlan 辅助接口 IP
      --route-cidr CIDR             宿主机访问虚拟摄像头地址池的路由
      --network-name NAME           Docker macvlan 网络名称
      --skip-macvlan                跳过 Docker macvlan 网络创建
      --no-host-macvlan             不创建宿主机 macvlan 辅助接口
      --no-systemd-host-macvlan     不配置 systemd 开机恢复辅助接口

服务选项:
      --admin-username NAME         初始管理员用户名
      --admin-password PASSWORD     初始管理员密码
      --backend-port PORT           后端宿主机端口，默认 8177
      --frontend-port PORT          前端宿主机端口，默认 9528
      --rtsp-port PORT              RTSP 共享网关宿主机端口，默认 554

示例:
  ./scripts/ubuntu-one-click-deploy.sh
  ./scripts/ubuntu-one-click-deploy.sh --yes --host-if br0 --host-ip 192.168.5.198
  ./scripts/ubuntu-one-click-deploy.sh --yes --host-if ens33 --subnet 192.168.9.0/24 --gateway 192.168.9.1 --ip-range 192.168.9.192/26 --host-macvlan-ip 192.168.9.199
EOF
}

require_arg() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "${option} 缺少参数值。"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -y|--yes)
      ASSUME_YES=1
      shift
      ;;
    --force-env)
      FORCE_ENV=1
      shift
      ;;
    --skip-docker-install)
      SKIP_DOCKER_INSTALL=1
      shift
      ;;
    --skip-macvlan)
      SKIP_MACVLAN=1
      shift
      ;;
    --no-host-macvlan)
      ENABLE_HOST_MACVLAN=0
      ENABLE_SYSTEMD_HOST_MACVLAN=0
      shift
      ;;
    --no-systemd-host-macvlan)
      ENABLE_SYSTEMD_HOST_MACVLAN=0
      shift
      ;;
    --host-if)
      require_arg "$1" "${2:-}"
      HOST_IF_INPUT="${2:-}"
      shift 2
      ;;
    --host-ip)
      require_arg "$1" "${2:-}"
      HOST_IP_INPUT="${2:-}"
      shift 2
      ;;
    --subnet)
      require_arg "$1" "${2:-}"
      SUBNET_INPUT="${2:-}"
      shift 2
      ;;
    --gateway)
      require_arg "$1" "${2:-}"
      GATEWAY_INPUT="${2:-}"
      shift 2
      ;;
    --ip-range)
      require_arg "$1" "${2:-}"
      IP_RANGE_INPUT="${2:-}"
      shift 2
      ;;
    --host-macvlan-ip)
      require_arg "$1" "${2:-}"
      HOST_MACVLAN_IP_INPUT="${2:-}"
      shift 2
      ;;
    --route-cidr)
      require_arg "$1" "${2:-}"
      ROUTE_CIDR_INPUT="${2:-}"
      shift 2
      ;;
    --network-name)
      require_arg "$1" "${2:-}"
      NETWORK_NAME_INPUT="${2:-}"
      shift 2
      ;;
    --admin-username)
      require_arg "$1" "${2:-}"
      ADMIN_USERNAME_INPUT="${2:-}"
      shift 2
      ;;
    --admin-password)
      require_arg "$1" "${2:-}"
      ADMIN_PASSWORD_INPUT="${2:-}"
      shift 2
      ;;
    --backend-port)
      require_arg "$1" "${2:-}"
      BACKEND_PORT_INPUT="${2:-}"
      shift 2
      ;;
    --frontend-port)
      require_arg "$1" "${2:-}"
      FRONTEND_PORT_INPUT="${2:-}"
      shift 2
      ;;
    --rtsp-port)
      require_arg "$1" "${2:-}"
      RTSP_GATEWAY_PORT_INPUT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数: $1"
      ;;
  esac
done

trap 'die "第 ${LINENO} 行附近命令执行失败，请查看上方日志。"' ERR

run_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

sudo_refresh() {
  if [[ "${EUID}" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "安装 Docker、配置 macvlan 和 systemd 需要 sudo。"
    sudo -v
  fi
}

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
    return
  fi

  od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
  printf '\n'
}

detect_default_iface() {
  ip route show default 2>/dev/null | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }'
}

detect_default_gateway() {
  ip route show default 2>/dev/null | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "via") { print $(i + 1); exit } }'
}

detect_host_ip() {
  local iface="$1"
  local ip_addr=""

  if [[ -n "$iface" ]]; then
    ip_addr="$(ip -o -4 addr show dev "$iface" scope global 2>/dev/null | awk 'NR == 1 { split($4, a, "/"); print a[1] }')"
  fi

  if [[ -z "$ip_addr" ]]; then
    ip_addr="$(hostname -I 2>/dev/null | awk '{ print $1 }')"
  fi

  printf '%s\n' "$ip_addr"
}

detect_host_cidr() {
  local iface="$1"
  if [[ -z "$iface" ]]; then
    return 0
  fi

  ip -o -4 addr show dev "$iface" scope global 2>/dev/null | awk 'NR == 1 { print $4 }'
}

cidr_network() {
  local cidr="$1"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$cidr" <<'PY'
import ipaddress
import sys

print(ipaddress.ip_interface(sys.argv[1]).network)
PY
    return
  fi

  local ip_part="${cidr%/*}"
  local prefix="${cidr#*/}"
  if [[ "$prefix" == "24" ]]; then
    IFS=. read -r a b c _ <<<"$ip_part"
    printf '%s.%s.%s.0/24\n' "$a" "$b" "$c"
    return
  fi

  printf '%s\n' "$cidr"
}

suggest_ip_range() {
  local subnet="$1"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$subnet" <<'PY'
import ipaddress
import sys

net = ipaddress.ip_network(sys.argv[1], strict=False)
if net.version != 4:
    raise SystemExit(1)

candidate = None
if net.prefixlen <= 24 and net.num_addresses >= 256:
    possible = ipaddress.ip_network(f"{net.network_address + 192}/26", strict=False)
    if possible.subnet_of(net):
        candidate = possible

if candidate is None:
    if net.prefixlen <= 26:
        pools = list(net.subnets(new_prefix=26))
        candidate = pools[-2] if len(pools) > 1 else pools[0]
    else:
        candidate = net

print(candidate)
PY
    return
  fi

  local base="${subnet%.*}"
  printf '%s.192/26\n' "$base"
}

suggest_host_macvlan_ip() {
  local ip_range="$1"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$ip_range" <<'PY'
import ipaddress
import sys

net = ipaddress.ip_network(sys.argv[1], strict=False)
hosts = list(net.hosts())
preferred = ipaddress.ip_address(int(net.network_address) + 7)
if preferred in hosts:
    print(preferred)
elif len(hosts) >= 2:
    print(hosts[1])
elif hosts:
    print(hosts[0])
else:
    print(net.network_address + 1)
PY
    return
  fi

  local ip_part="${ip_range%/*}"
  local base="${ip_part%.*}"
  printf '%s.210\n' "$base"
}

first_camera_ip() {
  local ip_range="$1"
  local host_macvlan_ip="$2"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$ip_range" "$host_macvlan_ip" <<'PY'
import ipaddress
import sys

net = ipaddress.ip_network(sys.argv[1], strict=False)
reserved = ipaddress.ip_address(sys.argv[2])
for host in net.hosts():
    if host > reserved:
        print(host)
        break
else:
    for host in net.hosts():
        if host != reserved:
            print(host)
            break
PY
    return
  fi

  local ip_part="${ip_range%/*}"
  local base="${ip_part%.*}"
  printf '%s.211\n' "$base"
}

prompt_value() {
  local label="$1"
  local current="$2"
  local input=""

  if [[ "$ASSUME_YES" -eq 1 || ! -t 0 ]]; then
    printf '%s\n' "$current"
    return
  fi

  read -r -p "${label} [${current}]: " input
  if [[ -n "$input" ]]; then
    printf '%s\n' "$input"
  else
    printf '%s\n' "$current"
  fi
}

prompt_password() {
  local label="$1"
  local current="$2"
  local input=""

  if [[ "$ASSUME_YES" -eq 1 || ! -t 0 || -n "$ADMIN_PASSWORD_INPUT" ]]; then
    printf '%s\n' "$current"
    return
  fi

  printf '%s [直接回车则保留当前值/自动生成值]: ' "$label" >&2
  IFS= read -r -s input
  printf '\n' >&2

  if [[ -n "$input" ]]; then
    printf '%s\n' "$input"
  else
    printf '%s\n' "$current"
  fi
}

valid_admin_username() {
  local value="$1"
  [[ "$value" =~ ^[A-Za-z0-9._-]{3,60}$ ]]
}

valid_admin_password() {
  local value="$1"
  [[ ${#value} -ge 8 && "$value" =~ ^[A-Za-z0-9._@%+=:-]+$ ]]
}

valid_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] && [[ "$value" -ge 1 && "$value" -le 65535 ]]
}

validate_ip_or_cidr() {
  local value="$1"
  local mode="$2"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$value" "$mode" <<'PY'
import ipaddress
import sys

value, mode = sys.argv[1], sys.argv[2]
if mode == "cidr":
    ipaddress.ip_network(value, strict=False)
else:
    ipaddress.ip_address(value)
PY
  fi
}

load_existing_env() {
  if [[ -f "$ENV_FILE" && "$FORCE_ENV" -eq 0 ]]; then
    # shellcheck disable=SC1090
    set -a
    source "$ENV_FILE"
    set +a
    log "已读取现有配置文件：${ENV_FILE}"
  elif [[ -f "$ENV_FILE" && "$FORCE_ENV" -eq 1 ]]; then
    log "已指定 --force-env，现有 ${ENV_FILE} 将被重写。"
  fi
}

is_placeholder_secret() {
  local value="$1"
  [[ -z "$value" || "$value" == "change-this-session-secret" || "$value" == "replace-with-long-random-secret" ]]
}

is_placeholder_password() {
  local value="$1"
  [[ -z "$value" || "$value" == "admin123456" || "$value" == "replace-with-strong-password" ]]
}

prepare_config() {
  local detected_iface detected_host_ip detected_host_cidr detected_subnet detected_gateway suggested_range suggested_host_macvlan

  detected_iface="$(detect_default_iface)"
  detected_host_ip="$(detect_host_ip "${HOST_IF_INPUT:-$detected_iface}")"
  detected_host_cidr="$(detect_host_cidr "${HOST_IF_INPUT:-$detected_iface}")"
  detected_gateway="$(detect_default_gateway)"

  if [[ -n "$detected_host_cidr" ]]; then
    detected_subnet="$(cidr_network "$detected_host_cidr")"
  else
    detected_subnet="192.168.5.0/24"
  fi

  suggested_range="$(suggest_ip_range "${SUBNET_INPUT:-${SUBNET:-$detected_subnet}}")"
  suggested_host_macvlan="$(suggest_host_macvlan_ip "${IP_RANGE_INPUT:-${IP_RANGE:-$suggested_range}}")"

  DOCKER_NETWORK="${NETWORK_NAME_INPUT:-${DOCKER_NETWORK:-onvif_macvlan}}"
  VIRTUALWEBCAM_IMAGE="${VIRTUALWEBCAM_IMAGE:-virtualwebcam:latest}"
  CONTAINER_PREFIX="${CONTAINER_PREFIX:-virtualwebcam}"
  CAMERA_RTSP_PORT="${CAMERA_RTSP_PORT:-554}"
  RTSP_GATEWAY_HOST="${HOST_IP_INPUT:-${RTSP_GATEWAY_HOST:-$detected_host_ip}}"
  RTSP_GATEWAY_PORT="${RTSP_GATEWAY_PORT_INPUT:-${RTSP_GATEWAY_PORT:-554}}"
  RTSP_NETWORK="${RTSP_NETWORK:-virtualwebcam_rtsp}"
  ADMIN_USERNAME="${ADMIN_USERNAME_INPUT:-${ADMIN_USERNAME:-admin}}"
  BACKEND_PORT="${BACKEND_PORT_INPUT:-${BACKEND_PORT:-8177}}"
  FRONTEND_PORT="${FRONTEND_PORT_INPUT:-${FRONTEND_PORT:-9528}}"
  HOST_IF="${HOST_IF_INPUT:-${HOST_IF:-$detected_iface}}"
  SUBNET="${SUBNET_INPUT:-${SUBNET:-$detected_subnet}}"
  GATEWAY="${GATEWAY_INPUT:-${GATEWAY:-$detected_gateway}}"
  IP_RANGE="${IP_RANGE_INPUT:-${IP_RANGE:-$suggested_range}}"
  HOST_MACVLAN_IP="${HOST_MACVLAN_IP_INPUT:-${HOST_MACVLAN_IP:-$suggested_host_macvlan}}"
  ROUTE_CIDR="${ROUTE_CIDR_INPUT:-${ROUTE_CIDR:-$IP_RANGE}}"

  if [[ -n "$ADMIN_PASSWORD_INPUT" ]]; then
    ADMIN_PASSWORD="$ADMIN_PASSWORD_INPUT"
  elif is_placeholder_password "${ADMIN_PASSWORD:-}"; then
    ADMIN_PASSWORD="$(random_hex 12)"
    GENERATED_ADMIN_PASSWORD=1
  fi

  if is_placeholder_secret "${SESSION_SECRET:-}"; then
    SESSION_SECRET="$(random_hex 32)"
  fi

  if [[ -z "${API_TOKEN:-}" ]]; then
    API_TOKEN="$(random_hex 24)"
  fi

  if [[ "$ASSUME_YES" -eq 0 && -t 0 ]]; then
    log "下面请确认或修改现场部署参数，直接回车使用方括号中的默认值。"
  fi

  HOST_IF="$(prompt_value "宿主机父网卡，例如 br0/ens33" "$HOST_IF")"
  RTSP_GATEWAY_HOST="$(prompt_value "宿主机局域网 IP，也是 RTSP 共享网关地址" "$RTSP_GATEWAY_HOST")"
  SUBNET="$(prompt_value "客户现场网段 CIDR" "$SUBNET")"
  GATEWAY="$(prompt_value "客户现场网关 IP" "$GATEWAY")"
  IP_RANGE="$(prompt_value "ONVIF 虚拟摄像头 IP 地址池" "$IP_RANGE")"
  HOST_MACVLAN_IP="$(prompt_value "宿主机 macvlan 辅助接口 IP" "$HOST_MACVLAN_IP")"
  ROUTE_CIDR="$(prompt_value "宿主机访问虚拟摄像头地址池的路由" "$ROUTE_CIDR")"
  DOCKER_NETWORK="$(prompt_value "Docker macvlan 网络名称" "$DOCKER_NETWORK")"
  FRONTEND_PORT="$(prompt_value "管理前端端口" "$FRONTEND_PORT")"
  BACKEND_PORT="$(prompt_value "管理后端 API 端口" "$BACKEND_PORT")"
  RTSP_GATEWAY_PORT="$(prompt_value "RTSP 共享网关端口" "$RTSP_GATEWAY_PORT")"
  ADMIN_USERNAME="$(prompt_value "初始管理员用户名（3-60 位，支持字母数字和 ._-）" "$ADMIN_USERNAME")"
  if [[ -z "$ADMIN_PASSWORD_INPUT" ]]; then
    local password_before="$ADMIN_PASSWORD"
    ADMIN_PASSWORD="$(prompt_password "初始管理员密码（输入时不回显，至少 8 位；支持字母数字和 ._@%+=:-）" "$ADMIN_PASSWORD")"
    if [[ "$ADMIN_PASSWORD" != "$password_before" ]]; then
      GENERATED_ADMIN_PASSWORD=0
    fi
  fi

  [[ -n "$HOST_IF" ]] || die "无法自动识别宿主机网卡，请使用 --host-if 指定。"
  [[ -n "$RTSP_GATEWAY_HOST" ]] || die "无法自动识别宿主机 IP，请使用 --host-ip 指定。"
  [[ -n "$GATEWAY" ]] || die "无法自动识别网关，请使用 --gateway 指定。"

  valid_port "$FRONTEND_PORT" || die "前端端口无效：$FRONTEND_PORT"
  valid_port "$BACKEND_PORT" || die "后端端口无效：$BACKEND_PORT"
  valid_port "$RTSP_GATEWAY_PORT" || die "RTSP 端口无效：$RTSP_GATEWAY_PORT"
  [[ -n "$ADMIN_USERNAME" ]] || die "初始管理员用户名不能为空。"
  [[ -n "$ADMIN_PASSWORD" ]] || die "初始管理员密码不能为空。"
  valid_admin_username "$ADMIN_USERNAME" || die "初始管理员用户名只能使用 3-60 位字母、数字、点、下划线或短横线。"
  valid_admin_password "$ADMIN_PASSWORD" || die "初始管理员密码至少 8 位，只能使用字母、数字和这些安全符号：._@%+=:-"

  validate_ip_or_cidr "$RTSP_GATEWAY_HOST" ip
  validate_ip_or_cidr "$GATEWAY" ip
  validate_ip_or_cidr "$HOST_MACVLAN_IP" ip
  validate_ip_or_cidr "$SUBNET" cidr
  validate_ip_or_cidr "$IP_RANGE" cidr
  validate_ip_or_cidr "$ROUTE_CIDR" cidr

  ip link show "$HOST_IF" >/dev/null 2>&1 || die "宿主机网卡不存在：$HOST_IF"
}

confirm_config() {
  if [[ "$ASSUME_YES" -eq 1 || ! -t 0 ]]; then
    return
  fi

  cat <<EOF

部署配置确认:
  项目目录:              ${PROJECT_ROOT}
  管理前端访问地址:      http://${RTSP_GATEWAY_HOST}:${FRONTEND_PORT}
  后端 API 地址:         http://${RTSP_GATEWAY_HOST}:${BACKEND_PORT}/api
  初始管理员用户名:      ${ADMIN_USERNAME}
  Docker macvlan 网络:   ${DOCKER_NETWORK}
  宿主机父网卡:          ${HOST_IF}
  客户现场网段/网关:     ${SUBNET} / ${GATEWAY}
  ONVIF 摄像头地址池:    ${IP_RANGE}
  宿主机辅助接口:        ${HOST_MACVLAN_IP}，路由 ${ROUTE_CIDR}
  RTSP 共享网关:         ${RTSP_GATEWAY_HOST}:${RTSP_GATEWAY_PORT}

请确认 ONVIF 摄像头地址池不在 DHCP 自动分配范围内，并且没有和真实设备 IP 冲突。
EOF

  local answer=""
  read -r -p "确认开始部署？[Y/n]: " answer
  case "$answer" in
    ""|y|Y|yes|YES|是|好|确认)
      ;;
    *)
      die "已取消部署。"
      ;;
  esac
}

write_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    local backup="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -a "$ENV_FILE" "$backup"
    log "已备份现有 .env：${backup}"
  fi

  local old_umask
  old_umask="$(umask)"
  umask 077
  cat >"$ENV_FILE" <<EOF
DOCKER_NETWORK=${DOCKER_NETWORK}
VIRTUALWEBCAM_IMAGE=${VIRTUALWEBCAM_IMAGE}
CONTAINER_PREFIX=${CONTAINER_PREFIX}
CAMERA_RTSP_PORT=${CAMERA_RTSP_PORT}
RTSP_GATEWAY_HOST=${RTSP_GATEWAY_HOST}
RTSP_GATEWAY_PORT=${RTSP_GATEWAY_PORT}
RTSP_NETWORK=${RTSP_NETWORK}
ADMIN_USERNAME=${ADMIN_USERNAME}
ADMIN_PASSWORD=${ADMIN_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
API_TOKEN=${API_TOKEN}
BACKEND_PORT=${BACKEND_PORT}
FRONTEND_PORT=${FRONTEND_PORT}
HOST_IF=${HOST_IF}
SUBNET=${SUBNET}
GATEWAY=${GATEWAY}
IP_RANGE=${IP_RANGE}
HOST_MACVLAN_IP=${HOST_MACVLAN_IP}
ROUTE_CIDR=${ROUTE_CIDR}
EOF
  umask "$old_umask"

  if [[ "${EUID}" -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    local sudo_group
    sudo_group="$(id -gn "$SUDO_USER" 2>/dev/null || printf '%s' "$SUDO_USER")"
    chown "$SUDO_USER:$sudo_group" "$ENV_FILE" 2>/dev/null || true
  fi

  log "已写入配置文件：${ENV_FILE}"
}

install_docker() {
  if [[ "$SKIP_DOCKER_INSTALL" -eq 1 ]]; then
    return
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi

  log "正在安装 Docker Engine 和 Docker Compose 插件。"
  sudo_refresh

  run_root apt-get update
  run_root apt-get install -y ca-certificates curl gnupg lsb-release
  run_root install -m 0755 -d /etc/apt/keyrings

  local key_tmp os_id os_codename arch
  key_tmp="$(mktemp)"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key_tmp"
  run_root gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg "$key_tmp"
  rm -f "$key_tmp"
  run_root chmod a+r /etc/apt/keyrings/docker.gpg

  # shellcheck disable=SC1091
  source /etc/os-release
  os_id="${ID:-ubuntu}"
  os_codename="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"
  arch="$(dpkg --print-architecture)"

  [[ "$os_id" == "ubuntu" ]] || warn "当前系统标识为 ${os_id}，脚本主要按 Ubuntu 适配。"
  [[ -n "$os_codename" ]] || die "无法从 /etc/os-release 识别 Ubuntu 版本代号。"

  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "$arch" "$os_codename" \
    | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null

  run_root apt-get update
  run_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run_root systemctl enable --now docker
}

setup_docker_access() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker 命令。请去掉 --skip-docker-install 重新运行，或先手动安装 Docker。"

  if docker ps >/dev/null 2>&1; then
    USE_SUDO_DOCKER=0
  else
    sudo_refresh
    run_root systemctl enable --now docker
    run_root docker ps >/dev/null
    USE_SUDO_DOCKER=1

    if [[ "${EUID}" -ne 0 && -n "${USER:-}" ]]; then
      run_root usermod -aG docker "$USER" || true
      warn "当前终端将通过 sudo 执行 Docker。稍后重新登录系统后，当前用户可直接使用 Docker。"
    fi
  fi

  if docker_cmd compose version >/dev/null 2>&1; then
    COMPOSE_IMPL="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_IMPL="docker-compose"
  else
    die "未找到 Docker Compose 插件或 docker-compose 命令。"
  fi
}

docker_cmd() {
  if [[ "$USE_SUDO_DOCKER" -eq 1 ]]; then
    run_root docker "$@"
  else
    docker "$@"
  fi
}

compose_cmd() {
  if [[ "$COMPOSE_IMPL" == "docker compose" ]]; then
    docker_cmd compose --env-file "$ENV_FILE" "$@"
  else
    if [[ "$USE_SUDO_DOCKER" -eq 1 ]]; then
      run_root docker-compose --env-file "$ENV_FILE" "$@"
    else
      docker-compose --env-file "$ENV_FILE" "$@"
    fi
  fi
}

inspect_macvlan_network() {
  docker_cmd network inspect "$DOCKER_NETWORK" >/dev/null 2>&1
}

ensure_macvlan_network() {
  if [[ "$SKIP_MACVLAN" -eq 1 ]]; then
    warn "已按参数要求跳过 Docker macvlan 网络创建。"
    return
  fi

  if inspect_macvlan_network; then
    local driver parent subnet gateway ip_range
    driver="$(docker_cmd network inspect --format '{{.Driver}}' "$DOCKER_NETWORK")"
    parent="$(docker_cmd network inspect --format '{{ index .Options "parent" }}' "$DOCKER_NETWORK")"
    subnet="$(docker_cmd network inspect --format '{{ (index .IPAM.Config 0).Subnet }}' "$DOCKER_NETWORK")"
    gateway="$(docker_cmd network inspect --format '{{ (index .IPAM.Config 0).Gateway }}' "$DOCKER_NETWORK")"
    ip_range="$(docker_cmd network inspect --format '{{ (index .IPAM.Config 0).IPRange }}' "$DOCKER_NETWORK")"

    if [[ "$driver" != "macvlan" || "$parent" != "$HOST_IF" || "$subnet" != "$SUBNET" || "$gateway" != "$GATEWAY" || "$ip_range" != "$IP_RANGE" ]]; then
      die "现有 Docker 网络 ${DOCKER_NETWORK} 与当前 macvlan 配置不一致。请先停止依赖该网络的摄像头容器，再删除并重建网络。"
    fi

    log "Docker macvlan 网络已存在：${DOCKER_NETWORK}"
    return
  fi

  log "正在创建 Docker macvlan 网络：${DOCKER_NETWORK}"
  run_root env \
    PARENT_IFACE="$HOST_IF" \
    SUBNET="$SUBNET" \
    GATEWAY="$GATEWAY" \
    IP_RANGE="$IP_RANGE" \
    NETWORK_NAME="$DOCKER_NETWORK" \
    "${SCRIPT_DIR}/create-macvlan.sh"
}

setup_host_macvlan() {
  if [[ "$ENABLE_HOST_MACVLAN" -eq 0 ]]; then
    warn "已按参数要求跳过宿主机 macvlan 辅助接口。"
    return
  fi

  log "正在配置宿主机 macvlan 辅助接口。"
  run_root env \
    HOST_IF="$HOST_IF" \
    HOST_MACVLAN_IP="$HOST_MACVLAN_IP" \
    ROUTE_CIDR="$ROUTE_CIDR" \
    "${SCRIPT_DIR}/setup-macvlan-host.sh"

  if [[ "$ENABLE_SYSTEMD_HOST_MACVLAN" -eq 1 ]]; then
    local service_file="/etc/systemd/system/virtualwebcam-macvlan-host.service"
    local tmp_service
    tmp_service="$(mktemp)"
    cat >"$tmp_service" <<EOF
[Unit]
Description=VirtualWebCam macvlan host interface
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${PROJECT_ROOT}
ExecStart=/usr/bin/env HOST_IF=${HOST_IF} HOST_MACVLAN_IP=${HOST_MACVLAN_IP} ROUTE_CIDR=${ROUTE_CIDR} ${SCRIPT_DIR}/setup-macvlan-host.sh

[Install]
WantedBy=multi-user.target
EOF
    run_root cp "$tmp_service" "$service_file"
    rm -f "$tmp_service"
    run_root systemctl daemon-reload
    run_root systemctl enable --now virtualwebcam-macvlan-host.service
    log "已启用开机恢复服务：virtualwebcam-macvlan-host.service"
  fi
}

backup_existing_db() {
  local db_path="${PROJECT_ROOT}/backend/data/virtualwebcam.db"
  if [[ ! -f "$db_path" ]]; then
    return
  fi

  EXISTING_DB=1
  local backup_dir="${PROJECT_ROOT}/backups"
  local backup_path="${backup_dir}/virtualwebcam-$(date +%Y%m%d-%H%M%S).db"
  mkdir -p "$backup_dir"

  if command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$db_path" ".backup '${backup_path}'"
  else
    cp -a "$db_path" "$backup_path"
    cp -a "${db_path}-wal" "$backup_dir/" 2>/dev/null || true
    cp -a "${db_path}-shm" "$backup_dir/" 2>/dev/null || true
  fi

  log "已备份现有 SQLite 数据库：${backup_path}"
}

warn_port_if_listening() {
  local port="$1"
  local label="$2"
  if ss -ltn 2>/dev/null | awk '{ print $4 }' | grep -Eq "[:.]${port}$"; then
    warn "${label} 端口 ${port} 当前已有监听。如果是已有部署重复执行通常没问题；如果被其他服务占用，Compose 启动可能失败。"
  fi
}

build_and_start() {
  cd "$PROJECT_ROOT"
  mkdir -p backend/data

  warn_port_if_listening "$FRONTEND_PORT" "管理前端"
  warn_port_if_listening "$BACKEND_PORT" "管理后端"
  warn_port_if_listening "$RTSP_GATEWAY_PORT" "RTSP"

  log "正在构建 virtualwebcam 镜像。"
  compose_cmd --profile image build virtualwebcam-image

  log "正在启动管理后端和管理前端。"
  compose_cmd up -d --build manager-backend manager-frontend
}

wait_for_health() {
  local url="http://127.0.0.1:${BACKEND_PORT}/api/health"

  if ! command -v curl >/dev/null 2>&1; then
    warn "未安装 curl，跳过 API 健康检查。"
    return
  fi

  log "等待后端健康检查通过：${url}"
  for _ in $(seq 1 30); do
    if curl -fsS -H "X-API-Token: ${API_TOKEN}" "$url" >/dev/null 2>&1; then
      log "后端健康检查通过。"
      return
    fi
    sleep 2
  done

  warn "后端健康检查超时，下面输出最近的后端日志。"
  compose_cmd logs --tail=120 manager-backend || true
  return 1
}

print_summary() {
  cat <<EOF

部署完成。

访问地址:
  http://${RTSP_GATEWAY_HOST}:${FRONTEND_PORT}

管理员账号:
  用户名: ${ADMIN_USERNAME}
  密码:   ${ADMIN_PASSWORD}

网络信息:
  ONVIF 摄像头地址池: ${IP_RANGE}
  建议第一路摄像头 IP: $(first_camera_ip "$IP_RANGE" "$HOST_MACVLAN_IP")
  RTSP 共享网关地址: rtsp://${RTSP_GATEWAY_HOST}:${RTSP_GATEWAY_PORT}/<stream_name>

常用检查命令:
  docker compose --env-file .env ps
  curl -H "X-API-Token: ${API_TOKEN}" http://127.0.0.1:${BACKEND_PORT}/api/health
EOF

  if [[ "$EXISTING_DB" -eq 1 ]]; then
    cat <<'EOF'

注意:
  已检测到现有 backend/data/virtualwebcam.db。如果数据库里已经有用户，
  .env 里的 ADMIN_PASSWORD 不会重置这些用户的密码。
EOF
  elif [[ "$GENERATED_ADMIN_PASSWORD" -eq 1 ]]; then
    cat <<'EOF'

注意:
  脚本已自动生成随机初始管理员密码，并保存到 .env。
EOF
  fi
}

main() {
  [[ -f "${PROJECT_ROOT}/docker-compose.yml" ]] || die "请在项目代码目录中运行脚本；未找到 docker-compose.yml。"

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    if [[ "${ID:-}" != "ubuntu" ]]; then
      warn "检测到当前系统为 '${ID:-unknown}'，该脚本主要按 Ubuntu 适配。"
    fi
  fi

  load_existing_env
  prepare_config
  confirm_config
  write_env_file

  install_docker
  setup_docker_access
  ensure_macvlan_network
  setup_host_macvlan
  backup_existing_db
  build_and_start
  wait_for_health
  print_summary
}

main "$@"
