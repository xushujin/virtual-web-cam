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
  printf '[deploy] %s\n' "$*"
}

warn() {
  printf '[deploy][warn] %s\n' "$*" >&2
}

die() {
  printf '[deploy][error] %s\n' "$*" >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage:
  ./scripts/ubuntu-one-click-deploy.sh [options]

Common:
  -y, --yes                         Use detected defaults without prompts
      --force-env                   Rewrite .env from detected/flag values
      --skip-docker-install         Do not install Docker if missing

Network:
      --host-if IFACE               Parent interface, for example br0/ens33
      --host-ip IP                  Host LAN IP used by RTSP gateway
      --subnet CIDR                 LAN subnet, for example 192.168.5.0/24
      --gateway IP                  LAN gateway, for example 192.168.5.1
      --ip-range CIDR               macvlan camera IP pool
      --host-macvlan-ip IP          Host-side macvlan helper IP
      --route-cidr CIDR             Route to camera IP pool
      --network-name NAME           Docker macvlan network name
      --skip-macvlan                Skip Docker macvlan network creation
      --no-host-macvlan             Do not create host-side macvlan interface
      --no-systemd-host-macvlan     Do not persist host-side macvlan via systemd

Service:
      --admin-username NAME         Initial admin username
      --admin-password PASSWORD     Initial admin password
      --backend-port PORT           Backend host port, default 8177
      --frontend-port PORT          Frontend host port, default 5177
      --rtsp-port PORT              Shared RTSP gateway host port, default 554

Examples:
  ./scripts/ubuntu-one-click-deploy.sh
  ./scripts/ubuntu-one-click-deploy.sh --yes --host-if br0 --host-ip 192.168.5.111
  ./scripts/ubuntu-one-click-deploy.sh --yes --host-if ens33 --subnet 192.168.9.0/24 --gateway 192.168.9.1 --ip-range 192.168.9.208/28 --host-macvlan-ip 192.168.9.210
EOF
}

require_arg() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" ]] || die "Missing value for ${option}."
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
      die "Unknown option: $1"
      ;;
  esac
done

trap 'die "Command failed near line ${LINENO}. Check the log above."' ERR

run_root() {
  if [[ "${EUID}" -eq 0 ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

sudo_refresh() {
  if [[ "${EUID}" -ne 0 ]]; then
    command -v sudo >/dev/null 2>&1 || die "sudo is required for Docker install, macvlan, and systemd setup."
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
    possible = ipaddress.ip_network(f"{net.network_address + 208}/28", strict=False)
    if possible.subnet_of(net):
        candidate = possible

if candidate is None:
    if net.prefixlen <= 28:
        pools = list(net.subnets(new_prefix=28))
        candidate = pools[-2] if len(pools) > 1 else pools[0]
    else:
        candidate = net

print(candidate)
PY
    return
  fi

  local base="${subnet%.*}"
  printf '%s.208/28\n' "$base"
}

suggest_host_macvlan_ip() {
  local ip_range="$1"

  if command -v python3 >/dev/null 2>&1; then
    python3 - "$ip_range" <<'PY'
import ipaddress
import sys

net = ipaddress.ip_network(sys.argv[1], strict=False)
hosts = list(net.hosts())
if len(hosts) >= 2:
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
    log "Loaded existing ${ENV_FILE}."
  elif [[ -f "$ENV_FILE" && "$FORCE_ENV" -eq 1 ]]; then
    log "Existing ${ENV_FILE} will be rewritten because --force-env was used."
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
  FRONTEND_PORT="${FRONTEND_PORT_INPUT:-${FRONTEND_PORT:-5177}}"
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

  DOCKER_NETWORK="$(prompt_value "Docker macvlan network name" "$DOCKER_NETWORK")"
  HOST_IF="$(prompt_value "Parent network interface" "$HOST_IF")"
  RTSP_GATEWAY_HOST="$(prompt_value "Host LAN IP / RTSP gateway host" "$RTSP_GATEWAY_HOST")"
  SUBNET="$(prompt_value "LAN subnet CIDR" "$SUBNET")"
  GATEWAY="$(prompt_value "LAN gateway" "$GATEWAY")"
  IP_RANGE="$(prompt_value "ONVIF camera IP pool" "$IP_RANGE")"
  HOST_MACVLAN_IP="$(prompt_value "Host macvlan helper IP" "$HOST_MACVLAN_IP")"
  ROUTE_CIDR="$(prompt_value "Host macvlan route CIDR" "$ROUTE_CIDR")"
  FRONTEND_PORT="$(prompt_value "Frontend port" "$FRONTEND_PORT")"
  BACKEND_PORT="$(prompt_value "Backend port" "$BACKEND_PORT")"
  RTSP_GATEWAY_PORT="$(prompt_value "Shared RTSP gateway port" "$RTSP_GATEWAY_PORT")"

  [[ -n "$HOST_IF" ]] || die "Cannot detect host network interface. Use --host-if."
  [[ -n "$RTSP_GATEWAY_HOST" ]] || die "Cannot detect host IP. Use --host-ip."
  [[ -n "$GATEWAY" ]] || die "Cannot detect gateway. Use --gateway."

  valid_port "$FRONTEND_PORT" || die "Invalid frontend port: $FRONTEND_PORT"
  valid_port "$BACKEND_PORT" || die "Invalid backend port: $BACKEND_PORT"
  valid_port "$RTSP_GATEWAY_PORT" || die "Invalid RTSP port: $RTSP_GATEWAY_PORT"

  validate_ip_or_cidr "$RTSP_GATEWAY_HOST" ip
  validate_ip_or_cidr "$GATEWAY" ip
  validate_ip_or_cidr "$HOST_MACVLAN_IP" ip
  validate_ip_or_cidr "$SUBNET" cidr
  validate_ip_or_cidr "$IP_RANGE" cidr
  validate_ip_or_cidr "$ROUTE_CIDR" cidr

  ip link show "$HOST_IF" >/dev/null 2>&1 || die "Network interface does not exist: $HOST_IF"
}

confirm_config() {
  if [[ "$ASSUME_YES" -eq 1 || ! -t 0 ]]; then
    return
  fi

  cat <<EOF

Deployment config:
  Project root:          ${PROJECT_ROOT}
  Frontend URL:          http://${RTSP_GATEWAY_HOST}:${FRONTEND_PORT}
  Backend API:           http://${RTSP_GATEWAY_HOST}:${BACKEND_PORT}/api
  Docker network:        ${DOCKER_NETWORK}
  Parent interface:      ${HOST_IF}
  LAN subnet/gateway:    ${SUBNET} / ${GATEWAY}
  Camera IP pool:        ${IP_RANGE}
  Host macvlan helper:   ${HOST_MACVLAN_IP} route ${ROUTE_CIDR}
  RTSP shared gateway:   ${RTSP_GATEWAY_HOST}:${RTSP_GATEWAY_PORT}

Make sure the camera IP pool is outside DHCP and does not conflict with real devices.
EOF

  local answer=""
  read -r -p "Continue deployment? [Y/n]: " answer
  case "$answer" in
    ""|y|Y|yes|YES)
      ;;
    *)
      die "Deployment cancelled."
      ;;
  esac
}

write_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    local backup="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
    cp -a "$ENV_FILE" "$backup"
    log "Backed up existing .env to ${backup}."
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

  log "Wrote ${ENV_FILE}."
}

install_docker() {
  if [[ "$SKIP_DOCKER_INSTALL" -eq 1 ]]; then
    return
  fi

  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return
  fi

  log "Installing Docker Engine and Compose plugin."
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

  [[ "$os_id" == "ubuntu" ]] || warn "OS ID is ${os_id}; this script is optimized for Ubuntu."
  [[ -n "$os_codename" ]] || die "Cannot detect Ubuntu codename from /etc/os-release."

  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu %s stable\n' "$arch" "$os_codename" \
    | run_root tee /etc/apt/sources.list.d/docker.list >/dev/null

  run_root apt-get update
  run_root apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  run_root systemctl enable --now docker
}

setup_docker_access() {
  command -v docker >/dev/null 2>&1 || die "docker command not found. Re-run without --skip-docker-install or install Docker first."

  if docker ps >/dev/null 2>&1; then
    USE_SUDO_DOCKER=0
  else
    sudo_refresh
    run_root systemctl enable --now docker
    run_root docker ps >/dev/null
    USE_SUDO_DOCKER=1

    if [[ "${EUID}" -ne 0 && -n "${USER:-}" ]]; then
      run_root usermod -aG docker "$USER" || true
      warn "Current shell will use sudo for Docker. Re-login later to use Docker without sudo."
    fi
  fi

  if docker_cmd compose version >/dev/null 2>&1; then
    COMPOSE_IMPL="docker compose"
  elif command -v docker-compose >/dev/null 2>&1; then
    COMPOSE_IMPL="docker-compose"
  else
    die "Docker Compose plugin is not available."
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
    warn "Skipping Docker macvlan network creation."
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
      die "Existing Docker network ${DOCKER_NETWORK} does not match desired macvlan config. Remove/recreate it after stopping dependent camera containers."
    fi

    log "Docker macvlan network already exists: ${DOCKER_NETWORK}."
    return
  fi

  log "Creating Docker macvlan network: ${DOCKER_NETWORK}."
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
    warn "Skipping host-side macvlan interface."
    return
  fi

  log "Configuring host-side macvlan interface."
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
    log "Enabled systemd service: virtualwebcam-macvlan-host.service."
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

  log "Backed up existing SQLite DB to ${backup_path}."
}

warn_port_if_listening() {
  local port="$1"
  local label="$2"
  if ss -ltn 2>/dev/null | awk '{ print $4 }' | grep -Eq "[:.]${port}$"; then
    warn "${label} port ${port} is already listening. Re-run may be fine if it is the existing deployment; otherwise Compose can fail."
  fi
}

build_and_start() {
  cd "$PROJECT_ROOT"
  mkdir -p backend/data

  warn_port_if_listening "$FRONTEND_PORT" "Frontend"
  warn_port_if_listening "$BACKEND_PORT" "Backend"
  warn_port_if_listening "$RTSP_GATEWAY_PORT" "RTSP"

  log "Building virtualwebcam image."
  compose_cmd --profile image build virtualwebcam-image

  log "Starting manager backend and frontend."
  compose_cmd up -d --build manager-backend manager-frontend
}

wait_for_health() {
  local url="http://127.0.0.1:${BACKEND_PORT}/api/health"

  if ! command -v curl >/dev/null 2>&1; then
    warn "curl is not installed; skipping API health check."
    return
  fi

  log "Waiting for backend health: ${url}"
  for _ in $(seq 1 30); do
    if curl -fsS -H "X-API-Token: ${API_TOKEN}" "$url" >/dev/null 2>&1; then
      log "Backend health check passed."
      return
    fi
    sleep 2
  done

  warn "Backend health check did not pass in time. Showing recent backend logs."
  compose_cmd logs --tail=120 manager-backend || true
  return 1
}

print_summary() {
  cat <<EOF

Deployment finished.

Open:
  http://${RTSP_GATEWAY_HOST}:${FRONTEND_PORT}

Admin:
  username: ${ADMIN_USERNAME}
  password: ${ADMIN_PASSWORD}

Network:
  ONVIF camera pool: ${IP_RANGE}
  First typical camera IP: $(first_camera_ip "$IP_RANGE" "$HOST_MACVLAN_IP")
  RTSP shared gateway: rtsp://${RTSP_GATEWAY_HOST}:${RTSP_GATEWAY_PORT}/<stream_name>

Checks:
  docker compose --env-file .env ps
  curl -H "X-API-Token: ${API_TOKEN}" http://127.0.0.1:${BACKEND_PORT}/api/health
EOF

  if [[ "$EXISTING_DB" -eq 1 ]]; then
    cat <<'EOF'

Note:
  Existing backend/data/virtualwebcam.db was found. If it already has users,
  the ADMIN_PASSWORD in .env does not reset their passwords.
EOF
  elif [[ "$GENERATED_ADMIN_PASSWORD" -eq 1 ]]; then
    cat <<'EOF'

Note:
  A random initial admin password was generated and saved in .env.
EOF
  fi
}

main() {
  [[ -f "${PROJECT_ROOT}/docker-compose.yml" ]] || die "Run this script from the project checkout; docker-compose.yml was not found."

  if [[ -r /etc/os-release ]]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    if [[ "${ID:-}" != "ubuntu" ]]; then
      warn "Detected OS '${ID:-unknown}'. This script is intended for Ubuntu."
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
