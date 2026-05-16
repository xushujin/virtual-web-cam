#!/usr/bin/env bash
set -Eeuo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_FILE="${PROJECT_ROOT}/.env"

ASSUME_YES=0
FORCE_ENV=0
SKIP_DOCKER_INSTALL=0
SKIP_MACVLAN=0
SKIP_HOST_MACVLAN=0
SKIP_SYSTEMD_MACVLAN=0

HOST_IF_INPUT=""
HOST_IP_INPUT=""
SUBNET_INPUT=""
GATEWAY_INPUT=""
IP_RANGE_INPUT=""
HOST_MACVLAN_IP_INPUT=""
ROUTE_CIDR_INPUT=""
DOCKER_NETWORK_INPUT=""
ADMIN_USERNAME_INPUT=""
ADMIN_PASSWORD_INPUT=""
FRONTEND_PORT_INPUT=""
BACKEND_PORT_INPUT=""
RTSP_PORT_INPUT=""

USE_SUDO_DOCKER=0
COMPOSE_IMPL=""
EXISTING_DB=0
GENERATED_PASSWORD=0

log() {
  printf '[VirtualWebCam 部署] %s\n' "$*"
}

warn() {
  printf '[VirtualWebCam 部署][警告] %s\n' "$*" >&2
}

die() {
  printf '[VirtualWebCam 部署][错误] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
用法:
  ./ubuntu26.04-deploy.sh [options]

推荐交互式部署:
  ./ubuntu26.04-deploy.sh

无人值守部署示例:
  ./ubuntu26.04-deploy.sh --yes \
    --host-if br0 \
    --host-ip 192.168.5.111 \
    --subnet 192.168.5.0/24 \
    --gateway 192.168.5.1 \
    --ip-range 192.168.5.208/28 \
    --host-macvlan-ip 192.168.5.210

选项:
  -y, --yes                         使用检测值和参数值，不逐项询问
      --force-env                   重写现有 .env；默认会读取现有 .env 后再确认
      --skip-docker-install         不自动安装 Docker
      --skip-macvlan                跳过 ONVIF macvlan 网络创建
      --skip-host-macvlan           跳过宿主机 macvlan-host 辅助接口
      --skip-systemd-macvlan        不配置 macvlan-host 开机恢复
      --host-if IFACE               宿主机父网卡，例如 br0/ens33/enp3s0
      --host-ip IP                  宿主机局域网 IP，也是 RTSP 共享网关地址
      --subnet CIDR                 客户现场网段，例如 192.168.5.0/24
      --gateway IP                  客户现场网关，例如 192.168.5.1
      --ip-range CIDR               ONVIF 虚拟摄像头 IP 地址池
      --host-macvlan-ip IP          宿主机 macvlan-host 辅助接口 IP
      --route-cidr CIDR             宿主机访问 ONVIF 地址池的路由
      --docker-network NAME         Docker macvlan 网络名称，默认 onvif_macvlan
      --admin-username NAME         初始管理员用户名
      --admin-password PASSWORD     初始管理员密码
      --frontend-port PORT          前端端口，默认 5177
      --backend-port PORT           后端端口，默认 8177
      --rtsp-port PORT              RTSP 端口，默认 554
  -h, --help                        显示帮助
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
    --skip-host-macvlan|--no-host-macvlan)
      SKIP_HOST_MACVLAN=1
      SKIP_SYSTEMD_MACVLAN=1
      shift
      ;;
    --skip-systemd-macvlan|--no-systemd-host-macvlan)
      SKIP_SYSTEMD_MACVLAN=1
      shift
      ;;
    --host-if)
      require_arg "$1" "${2:-}"
      HOST_IF_INPUT="$2"
      shift 2
      ;;
    --host-ip)
      require_arg "$1" "${2:-}"
      HOST_IP_INPUT="$2"
      shift 2
      ;;
    --subnet)
      require_arg "$1" "${2:-}"
      SUBNET_INPUT="$2"
      shift 2
      ;;
    --gateway)
      require_arg "$1" "${2:-}"
      GATEWAY_INPUT="$2"
      shift 2
      ;;
    --ip-range)
      require_arg "$1" "${2:-}"
      IP_RANGE_INPUT="$2"
      shift 2
      ;;
    --host-macvlan-ip)
      require_arg "$1" "${2:-}"
      HOST_MACVLAN_IP_INPUT="$2"
      shift 2
      ;;
    --route-cidr)
      require_arg "$1" "${2:-}"
      ROUTE_CIDR_INPUT="$2"
      shift 2
      ;;
    --docker-network|--network-name)
      require_arg "$1" "${2:-}"
      DOCKER_NETWORK_INPUT="$2"
      shift 2
      ;;
    --admin-username)
      require_arg "$1" "${2:-}"
      ADMIN_USERNAME_INPUT="$2"
      shift 2
      ;;
    --admin-password)
      require_arg "$1" "${2:-}"
      ADMIN_PASSWORD_INPUT="$2"
      shift 2
      ;;
    --frontend-port)
      require_arg "$1" "${2:-}"
      FRONTEND_PORT_INPUT="$2"
      shift 2
      ;;
    --backend-port)
      require_arg "$1" "${2:-}"
      BACKEND_PORT_INPUT="$2"
      shift 2
      ;;
    --rtsp-port)
      require_arg "$1" "${2:-}"
      RTSP_PORT_INPUT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "未知参数：$1"
      ;;
  esac
done

trap 'die "第 ${LINENO} 行附近执行失败，请查看上方日志。"' ERR

run_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

sudo_refresh() {
  if [[ "${EUID}" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "安装 Docker 和配置网络需要 sudo。"
    sudo -v
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
    return
  fi

  if [[ "$USE_SUDO_DOCKER" -eq 1 ]]; then
    run_root docker-compose --env-file "$ENV_FILE" "$@"
  else
    docker-compose --env-file "$ENV_FILE" "$@"
  fi
}

random_hex() {
  local bytes="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex "$bytes"
  else
    od -An -N "$bytes" -tx1 /dev/urandom | tr -d ' \n'
    printf '\n'
  fi
}

detect_default_iface() {
  ip route show default 2>/dev/null | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }'
}

detect_default_gateway() {
  ip route show default 2>/dev/null | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "via") { print $(i + 1); exit } }'
}

detect_host_cidr() {
  local iface="$1"
  [[ -n "$iface" ]] || return 0
  ip -o -4 addr show dev "$iface" scope global 2>/dev/null | awk 'NR == 1 { print $4 }'
}

detect_host_ip() {
  local iface="$1"
  local cidr=""
  cidr="$(detect_host_cidr "$iface")"
  if [[ -n "$cidr" ]]; then
    printf '%s\n' "${cidr%/*}"
    return
  fi
  hostname -I 2>/dev/null | awk '{ print $1 }'
}

cidr_network() {
  python3 - "$1" <<'PY'
import ipaddress
import sys

print(ipaddress.ip_interface(sys.argv[1]).network)
PY
}

suggest_ip_range() {
  python3 - "$1" <<'PY'
import ipaddress
import sys

net = ipaddress.ip_network(sys.argv[1], strict=False)
candidate = None

if net.version == 4 and net.prefixlen <= 24 and net.num_addresses >= 256:
    start = int(net.network_address) + 208
    candidate = ipaddress.ip_network(f"{ipaddress.ip_address(start)}/28", strict=False)
    if not candidate.subnet_of(net):
        candidate = None

if candidate is None:
    if net.prefixlen <= 28:
        pools = list(net.subnets(new_prefix=28))
        candidate = pools[-2] if len(pools) > 1 else pools[0]
    else:
        candidate = net

print(candidate)
PY
}

suggest_host_macvlan_ip() {
  python3 - "$1" <<'PY'
import ipaddress
import sys

net = ipaddress.ip_network(sys.argv[1], strict=False)
hosts = list(net.hosts())
if len(hosts) >= 2:
    print(hosts[1])
elif hosts:
    print(hosts[0])
else:
    print(ipaddress.ip_address(int(net.network_address) + 1))
PY
}

first_camera_ip() {
  python3 - "$1" "$2" <<'PY'
import ipaddress
import sys

net = ipaddress.ip_network(sys.argv[1], strict=False)
reserved = ipaddress.ip_address(sys.argv[2])
for host in net.hosts():
    if host != reserved and host > reserved:
        print(host)
        break
else:
    for host in net.hosts():
        if host != reserved:
            print(host)
            break
PY
}

validate_ip() {
  python3 - "$1" <<'PY'
import ipaddress
import sys

ipaddress.ip_address(sys.argv[1])
PY
}

validate_cidr() {
  python3 - "$1" <<'PY'
import ipaddress
import sys

ipaddress.ip_network(sys.argv[1], strict=False)
PY
}

validate_network_relation() {
  python3 - "$SUBNET" "$IP_RANGE" "$ROUTE_CIDR" "$HOST_MACVLAN_IP" "$RTSP_GATEWAY_HOST" <<'PY'
import ipaddress
import sys

subnet = ipaddress.ip_network(sys.argv[1], strict=False)
ip_range = ipaddress.ip_network(sys.argv[2], strict=False)
route_cidr = ipaddress.ip_network(sys.argv[3], strict=False)
host_macvlan_ip = ipaddress.ip_address(sys.argv[4])
host_ip = ipaddress.ip_address(sys.argv[5])

if not ip_range.subnet_of(subnet):
    raise SystemExit(f"ONVIF 地址池 {ip_range} 不属于客户现场网段 {subnet}")
if not route_cidr.subnet_of(subnet):
    raise SystemExit(f"宿主机 macvlan 路由 {route_cidr} 不属于客户现场网段 {subnet}")
if host_macvlan_ip not in subnet:
    raise SystemExit(f"宿主机 macvlan IP {host_macvlan_ip} 不属于客户现场网段 {subnet}")
if host_ip not in subnet:
    raise SystemExit(f"宿主机 IP {host_ip} 不属于客户现场网段 {subnet}")
if host_macvlan_ip == host_ip:
    raise SystemExit(f"宿主机 macvlan IP {host_macvlan_ip} 不能等于宿主机 IP")
PY
}

valid_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] && [[ "$value" -ge 1 && "$value" -le 65535 ]]
}

valid_admin_username() {
  [[ "$1" =~ ^[A-Za-z0-9._-]{3,60}$ ]]
}

valid_admin_password() {
  local value="$1"
  [[ "${#value}" -ge 8 && "$value" =~ ^[A-Za-z0-9._@%+=:-]+$ ]]
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

  printf '%s [直接回车使用自动生成/现有密码]: ' "$label" >&2
  IFS= read -r -s input
  printf '\n' >&2

  if [[ -n "$input" ]]; then
    printf '%s\n' "$input"
  else
    printf '%s\n' "$current"
  fi
}

is_placeholder_password() {
  [[ -z "${1:-}" || "$1" == "admin123456" || "$1" == "replace-with-strong-password" ]]
}

is_placeholder_secret() {
  [[ -z "${1:-}" || "$1" == "change-this-session-secret" || "$1" == "replace-with-long-random-secret" ]]
}

load_existing_env() {
  if [[ -f "$ENV_FILE" && "$FORCE_ENV" -eq 0 ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
    log "已读取现有 .env，后续会让你确认关键参数。"
  elif [[ -f "$ENV_FILE" && "$FORCE_ENV" -eq 1 ]]; then
    log "已指定 --force-env，现有 .env 会先备份再重写。"
  fi
}

install_base_packages() {
  local missing=()
  for cmd in ip awk sed grep curl python3 openssl; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      missing+=("$cmd")
    fi
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    return
  fi

  log "安装部署所需基础工具：${missing[*]}"
  sudo_refresh
  run_root apt-get update
  run_root apt-get install -y ca-certificates curl gnupg lsb-release iproute2 openssl python3 sqlite3
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && { docker compose version >/dev/null 2>&1 || command -v docker-compose >/dev/null 2>&1; }; then
    log "Docker 和 Docker Compose 已安装。"
    return
  fi

  if [[ "$SKIP_DOCKER_INSTALL" -eq 1 ]]; then
    die "Docker 或 Docker Compose 不可用，且已指定 --skip-docker-install。"
  fi

  sudo_refresh
  log "安装 Docker Engine 和 Docker Compose。"

  run_root apt-get update
  run_root apt-get install -y ca-certificates curl gnupg lsb-release
  run_root install -m 0755 -d /etc/apt/keyrings

  local key_tmp os_codename arch
  key_tmp="$(mktemp)"
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o "$key_tmp"
  run_root gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg "$key_tmp"
  rm -f "$key_tmp"
  run_root chmod a+r /etc/apt/keyrings/docker.gpg

  # shellcheck disable=SC1091
  source /etc/os-release
  os_codename="${VERSION_CODENAME:-${UBUNTU_CODENAME:-}}"
  arch="$(dpkg --print-architecture)"

  if [[ -n "$os_codename" ]]; then
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "$arch" "$os_codename" \
      | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null
  fi

  if [[ -n "$os_codename" ]] && run_root apt-get update && run_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin; then
    run_root systemctl enable --now docker
    return
  fi

  warn "Docker 官方源安装失败，回退到 Ubuntu 软件源。"
  run_root rm -f /etc/apt/sources.list.d/docker.list
  run_root apt-get update
  run_root apt-get install -y docker.io

  if ! docker compose version >/dev/null 2>&1 && ! run_root docker compose version >/dev/null 2>&1; then
    run_root apt-get install -y docker-compose-v2 \
      || run_root apt-get install -y docker-compose-plugin \
      || run_root apt-get install -y docker-compose
  fi

  run_root systemctl enable --now docker
}

setup_docker_access() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker 命令。"

  if docker ps >/dev/null 2>&1; then
    USE_SUDO_DOCKER=0
  else
    sudo_refresh
    run_root systemctl enable --now docker
    run_root docker ps >/dev/null
    USE_SUDO_DOCKER=1

    if [[ "${EUID}" -ne 0 && -n "${USER:-}" ]]; then
      run_root usermod -aG docker "$USER" || true
      warn "当前终端会通过 sudo 执行 Docker；重新登录后，${USER} 可直接使用 docker。"
    fi
  fi

  if docker_cmd compose version >/dev/null 2>&1; then
    COMPOSE_IMPL="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_IMPL="docker-compose"
  else
    die "Docker 可用，但 Docker Compose 不可用。"
  fi
}

prepare_config() {
  local detected_iface detected_gateway detected_host_cidr detected_host_ip detected_subnet suggested_range suggested_host_macvlan

  detected_iface="$(detect_default_iface)"
  detected_gateway="$(detect_default_gateway)"
  detected_host_cidr="$(detect_host_cidr "${HOST_IF_INPUT:-${HOST_IF:-$detected_iface}}")"
  detected_host_ip="$(detect_host_ip "${HOST_IF_INPUT:-${HOST_IF:-$detected_iface}}")"

  if [[ -n "$detected_host_cidr" ]]; then
    detected_subnet="$(cidr_network "$detected_host_cidr")"
  else
    detected_subnet="192.168.5.0/24"
  fi

  suggested_range="$(suggest_ip_range "${SUBNET_INPUT:-${SUBNET:-$detected_subnet}}")"
  suggested_host_macvlan="$(suggest_host_macvlan_ip "${IP_RANGE_INPUT:-${IP_RANGE:-$suggested_range}}")"

  DOCKER_NETWORK="${DOCKER_NETWORK_INPUT:-${DOCKER_NETWORK:-onvif_macvlan}}"
  VIRTUALWEBCAM_IMAGE="${VIRTUALWEBCAM_IMAGE:-virtualwebcam:latest}"
  CONTAINER_PREFIX="${CONTAINER_PREFIX:-virtualwebcam}"
  CAMERA_RTSP_PORT="${RTSP_PORT_INPUT:-${CAMERA_RTSP_PORT:-554}}"
  RTSP_GATEWAY_HOST="${HOST_IP_INPUT:-${RTSP_GATEWAY_HOST:-$detected_host_ip}}"
  RTSP_GATEWAY_PORT="${RTSP_PORT_INPUT:-${RTSP_GATEWAY_PORT:-554}}"
  RTSP_NETWORK="${RTSP_NETWORK:-virtualwebcam_rtsp}"
  ADMIN_USERNAME="${ADMIN_USERNAME_INPUT:-${ADMIN_USERNAME:-admin}}"
  FRONTEND_PORT="${FRONTEND_PORT_INPUT:-${FRONTEND_PORT:-5177}}"
  BACKEND_PORT="${BACKEND_PORT_INPUT:-${BACKEND_PORT:-8177}}"
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
    GENERATED_PASSWORD=1
  fi

  if is_placeholder_secret "${SESSION_SECRET:-}"; then
    SESSION_SECRET="$(random_hex 32)"
  fi

  if [[ -z "${API_TOKEN:-}" ]]; then
    API_TOKEN="$(random_hex 24)"
  fi

  cat <<EOF

检测到的网络信息:
  默认网卡: ${detected_iface:-未识别}
  默认网关: ${detected_gateway:-未识别}
  主机地址: ${detected_host_cidr:-未识别}
EOF

  if [[ "$ASSUME_YES" -eq 0 && -t 0 ]]; then
    log "请确认客户现场参数，直接回车使用默认值。"
  fi

  HOST_IF="$(prompt_value "宿主机父网卡" "$HOST_IF")"
  RTSP_GATEWAY_HOST="$(prompt_value "宿主机局域网 IP / RTSP 共享网关 IP" "$RTSP_GATEWAY_HOST")"
  SUBNET="$(prompt_value "客户现场网段 CIDR" "$SUBNET")"
  GATEWAY="$(prompt_value "客户现场网关 IP" "$GATEWAY")"
  IP_RANGE="$(prompt_value "ONVIF 虚拟摄像头 IP 地址池" "$IP_RANGE")"
  HOST_MACVLAN_IP="$(prompt_value "宿主机 macvlan-host 辅助接口 IP" "$HOST_MACVLAN_IP")"
  ROUTE_CIDR="$(prompt_value "宿主机访问虚拟摄像头地址池路由" "$ROUTE_CIDR")"
  DOCKER_NETWORK="$(prompt_value "Docker macvlan 网络名称" "$DOCKER_NETWORK")"
  FRONTEND_PORT="$(prompt_value "管理后台前端端口" "$FRONTEND_PORT")"
  BACKEND_PORT="$(prompt_value "管理后台后端端口" "$BACKEND_PORT")"
  RTSP_GATEWAY_PORT="$(prompt_value "RTSP 端口" "$RTSP_GATEWAY_PORT")"
  CAMERA_RTSP_PORT="$RTSP_GATEWAY_PORT"
  ADMIN_USERNAME="$(prompt_value "初始管理员用户名" "$ADMIN_USERNAME")"
  ADMIN_PASSWORD="$(prompt_password "初始管理员密码" "$ADMIN_PASSWORD")"

  [[ -n "$HOST_IF" ]] || die "宿主机父网卡不能为空。"
  [[ -n "$RTSP_GATEWAY_HOST" ]] || die "宿主机 IP 不能为空。"
  [[ -n "$GATEWAY" ]] || die "网关不能为空。"

  ip link show "$HOST_IF" >/dev/null 2>&1 || die "宿主机网卡不存在：$HOST_IF"
  validate_ip "$RTSP_GATEWAY_HOST"
  validate_ip "$GATEWAY"
  validate_ip "$HOST_MACVLAN_IP"
  validate_cidr "$SUBNET"
  validate_cidr "$IP_RANGE"
  validate_cidr "$ROUTE_CIDR"
  validate_network_relation

  valid_port "$FRONTEND_PORT" || die "前端端口无效：$FRONTEND_PORT"
  valid_port "$BACKEND_PORT" || die "后端端口无效：$BACKEND_PORT"
  valid_port "$RTSP_GATEWAY_PORT" || die "RTSP 端口无效：$RTSP_GATEWAY_PORT"
  valid_admin_username "$ADMIN_USERNAME" || die "管理员用户名只能使用 3-60 位字母、数字、点、下划线或短横线。"
  valid_admin_password "$ADMIN_PASSWORD" || die "管理员密码至少 8 位，只能使用字母、数字和符号 ._@%+=:-"
}

confirm_config() {
  if [[ "$ASSUME_YES" -eq 1 || ! -t 0 ]]; then
    return
  fi

  cat <<EOF

即将部署 VirtualWebCam:
  项目目录:             ${PROJECT_ROOT}
  前端访问地址:         http://${RTSP_GATEWAY_HOST}:${FRONTEND_PORT}
  后端 API:             http://${RTSP_GATEWAY_HOST}:${BACKEND_PORT}/api
  管理员用户名:         ${ADMIN_USERNAME}
  Docker macvlan 网络:  ${DOCKER_NETWORK}
  父网卡:               ${HOST_IF}
  现场网段 / 网关:      ${SUBNET} / ${GATEWAY}
  ONVIF 地址池:         ${IP_RANGE}
  macvlan-host IP:      ${HOST_MACVLAN_IP}
  RTSP 共享地址:        rtsp://${RTSP_GATEWAY_HOST}:${RTSP_GATEWAY_PORT}/<stream_name>

请确认 ${IP_RANGE} 不在客户 DHCP 自动分配范围内，且没有和真实设备 IP 冲突。
EOF

  local answer=""
  read -r -p "确认开始部署？[Y/n]: " answer
  case "$answer" in
    ""|y|Y|yes|YES|是|确认)
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
CORS_ORIGIN=
EOF
  umask "$old_umask"

  if [[ "${EUID}" -eq 0 && -n "${SUDO_USER:-}" && "$SUDO_USER" != "root" ]]; then
    local sudo_group
    sudo_group="$(id -gn "$SUDO_USER" 2>/dev/null || printf '%s' "$SUDO_USER")"
    chown "$SUDO_USER:$sudo_group" "$ENV_FILE" 2>/dev/null || true
  fi

  log "已写入 .env。"
}

backup_database() {
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

  log "已备份现有数据库：${backup_path}"
}

warn_if_port_listening() {
  local port="$1"
  local label="$2"
  if ss -ltn 2>/dev/null | awk '{ print $4 }' | grep -Eq "[:.]${port}$"; then
    warn "${label} 端口 ${port} 当前已有监听，后续启动可能失败。"
  fi
}

ensure_macvlan_network() {
  if [[ "$SKIP_MACVLAN" -eq 1 ]]; then
    warn "已跳过 Docker macvlan 网络创建。ONVIF 独立 IP 摄像头会不可用，RTSP 流源仍可使用。"
    return
  fi

  if docker_cmd network inspect "$DOCKER_NETWORK" >/dev/null 2>&1; then
    local driver parent subnet gateway ip_range
    driver="$(docker_cmd network inspect --format '{{.Driver}}' "$DOCKER_NETWORK")"
    parent="$(docker_cmd network inspect --format '{{ index .Options "parent" }}' "$DOCKER_NETWORK")"
    subnet="$(docker_cmd network inspect --format '{{ (index .IPAM.Config 0).Subnet }}' "$DOCKER_NETWORK")"
    gateway="$(docker_cmd network inspect --format '{{ (index .IPAM.Config 0).Gateway }}' "$DOCKER_NETWORK")"
    ip_range="$(docker_cmd network inspect --format '{{ (index .IPAM.Config 0).IPRange }}' "$DOCKER_NETWORK")"

    if [[ "$driver" != "macvlan" || "$parent" != "$HOST_IF" || "$subnet" != "$SUBNET" || "$gateway" != "$GATEWAY" || "$ip_range" != "$IP_RANGE" ]]; then
      die "现有 Docker 网络 ${DOCKER_NETWORK} 与当前配置不一致。请先确认是否有旧容器依赖它，再手动删除旧网络后重跑脚本。"
    fi

    log "Docker macvlan 网络已存在：${DOCKER_NETWORK}"
    return
  fi

  log "创建 Docker macvlan 网络：${DOCKER_NETWORK}"
  docker_cmd network create -d macvlan \
    --subnet "$SUBNET" \
    --ip-range "$IP_RANGE" \
    --gateway "$GATEWAY" \
    --aux-address "virtualwebcam-host=${HOST_MACVLAN_IP}" \
    -o parent="$HOST_IF" \
    "$DOCKER_NETWORK"
}

setup_host_macvlan() {
  if [[ "$SKIP_HOST_MACVLAN" -eq 1 ]]; then
    warn "已跳过宿主机 macvlan-host 辅助接口。客户机本机可能无法直接访问 ONVIF 摄像头 IP。"
    return
  fi

  sudo_refresh
  log "配置宿主机 macvlan-host 辅助接口。"

  run_root ip link delete macvlan-host 2>/dev/null || true
  run_root ip link add macvlan-host link "$HOST_IF" type macvlan mode bridge
  run_root ip addr add "${HOST_MACVLAN_IP}/32" dev macvlan-host
  run_root ip link set macvlan-host up
  run_root ip route replace "$ROUTE_CIDR" dev macvlan-host

  if [[ "$SKIP_SYSTEMD_MACVLAN" -eq 1 ]]; then
    return
  fi

  local helper_tmp service_tmp
  helper_tmp="$(mktemp)"
  service_tmp="$(mktemp)"

  cat >"$helper_tmp" <<EOF
#!/usr/bin/env bash
set -euo pipefail

ip link delete macvlan-host 2>/dev/null || true
ip link add macvlan-host link ${HOST_IF} type macvlan mode bridge
ip addr add ${HOST_MACVLAN_IP}/32 dev macvlan-host
ip link set macvlan-host up
ip route replace ${ROUTE_CIDR} dev macvlan-host
EOF

  cat >"$service_tmp" <<'EOF'
[Unit]
Description=VirtualWebCam macvlan host interface
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/virtualwebcam-macvlan-host

[Install]
WantedBy=multi-user.target
EOF

  run_root install -m 0755 "$helper_tmp" /usr/local/sbin/virtualwebcam-macvlan-host
  run_root install -m 0644 "$service_tmp" /etc/systemd/system/virtualwebcam-macvlan-host.service
  rm -f "$helper_tmp" "$service_tmp"

  run_root systemctl daemon-reload
  run_root systemctl enable --now virtualwebcam-macvlan-host.service
  log "已配置 macvlan-host 开机恢复服务。"
}

build_and_start() {
  cd "$PROJECT_ROOT"
  mkdir -p backend/data

  warn_if_port_listening "$FRONTEND_PORT" "前端"
  warn_if_port_listening "$BACKEND_PORT" "后端"
  warn_if_port_listening "$RTSP_GATEWAY_PORT" "RTSP"

  log "校验 docker-compose.yml。"
  compose_cmd config >/dev/null

  log "构建通用容器模板镜像：${VIRTUALWEBCAM_IMAGE}"
  compose_cmd --profile image build virtualwebcam-image
  docker_cmd image inspect "$VIRTUALWEBCAM_IMAGE" >/dev/null

  log "启动管理后台：manager-backend / manager-frontend"
  compose_cmd up -d --build manager-backend manager-frontend
}

wait_for_services() {
  local api_url="http://127.0.0.1:${BACKEND_PORT}/api/health"
  local frontend_url="http://127.0.0.1:${FRONTEND_PORT}"

  log "等待后端 API 就绪。"
  for _ in $(seq 1 45); do
    if curl -fsS -H "X-API-Token: ${API_TOKEN}" "$api_url" >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  curl -fsS -H "X-API-Token: ${API_TOKEN}" "$api_url" >/dev/null || {
    warn "后端健康检查失败，输出最近日志。"
    compose_cmd logs --tail=120 manager-backend || true
    die "后端 API 未就绪。"
  }

  log "等待前端页面就绪。"
  for _ in $(seq 1 30); do
    if curl -fsS "$frontend_url" >/dev/null 2>&1; then
      return
    fi
    sleep 2
  done

  warn "前端健康检查超时，输出最近日志。"
  compose_cmd logs --tail=80 manager-frontend || true
}

print_summary() {
  local first_ip
  first_ip="$(first_camera_ip "$IP_RANGE" "$HOST_MACVLAN_IP")"

  cat <<EOF

============================================================
VirtualWebCam 部署完成
============================================================

管理后台:
  http://${RTSP_GATEWAY_HOST}:${FRONTEND_PORT}

初始管理员:
  用户名: ${ADMIN_USERNAME}
  密码:   ${ADMIN_PASSWORD}

真实部署参数:
  前端端口: ${FRONTEND_PORT}
  后端端口: ${BACKEND_PORT}
  RTSP 端口: ${RTSP_GATEWAY_PORT}
  ONVIF macvlan 网络: ${DOCKER_NETWORK}
  ONVIF 地址池: ${IP_RANGE}
  macvlan-host IP: ${HOST_MACVLAN_IP}

建议第一路 ONVIF 摄像头:
  虚拟 IP: ${first_ip}
  流名称: screen01
  RTSP:  rtsp://${first_ip}:${CAMERA_RTSP_PORT}/screen01
  ONVIF: http://${first_ip}/onvif/device_service

RTSP 流源共享地址格式:
  rtsp://${RTSP_GATEWAY_HOST}:${RTSP_GATEWAY_PORT}/<stream_name>

常用验收命令:
  docker compose --env-file .env ps
  curl -H "X-API-Token: ${API_TOKEN}" http://127.0.0.1:${BACKEND_PORT}/api/health
  mpv --rtsp-transport=tcp rtsp://${first_ip}:${CAMERA_RTSP_PORT}/screen01
  mpv --rtsp-transport=tcp rtsp://${RTSP_GATEWAY_HOST}:${RTSP_GATEWAY_PORT}/screen01
EOF

  if [[ "$EXISTING_DB" -eq 1 ]]; then
    cat <<'EOF'

注意:
  检测到已有 SQLite 数据库，本次没有清空数据。
  如果系统里已经存在管理员，.env 里的 ADMIN_PASSWORD 不会强制覆盖该管理员密码。
EOF
  elif [[ "$GENERATED_PASSWORD" -eq 1 ]]; then
    cat <<'EOF'

注意:
  管理员密码由脚本自动生成，已写入 .env。请现场妥善保存，并登录后及时修改。
EOF
  fi
}

check_project() {
  [[ -f "${PROJECT_ROOT}/docker-compose.yml" ]] || die "请在 VirtualWebCam 项目根目录运行脚本。"
  [[ -f "${PROJECT_ROOT}/container/entrypoint.sh" ]] || die "缺少容器模板入口脚本：container/entrypoint.sh"
  [[ -f "${PROJECT_ROOT}/backend/src/docker.js" ]] || die "缺少后端 Docker 管理模块：backend/src/docker.js"
  [[ -f "${PROJECT_ROOT}/frontend/nginx/default.conf" ]] || die "缺少前端 Nginx 配置：frontend/nginx/default.conf"
}

check_os() {
  if [[ ! -r /etc/os-release ]]; then
    warn "无法读取 /etc/os-release，将继续部署。"
    return
  fi

  # shellcheck disable=SC1091
  source /etc/os-release
  if [[ "${ID:-}" != "ubuntu" ]]; then
    warn "当前系统是 ${ID:-unknown}，不是 Ubuntu；脚本仍会继续。"
    return
  fi

  if [[ "${VERSION_ID:-}" != "26.04" ]]; then
    warn "当前 Ubuntu 版本是 ${VERSION_ID:-unknown}，不是 26.04；脚本仍会继续。"
  else
    log "检测到 Ubuntu 26.04。"
  fi
}

main() {
  check_project
  check_os
  install_base_packages
  load_existing_env
  prepare_config
  confirm_config
  write_env_file
  install_docker
  setup_docker_access
  ensure_macvlan_network
  setup_host_macvlan
  backup_database
  build_and_start
  wait_for_services
  print_summary
}

main "$@"
