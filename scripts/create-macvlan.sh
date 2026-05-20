#!/usr/bin/env bash
set -euo pipefail

NETWORK_NAME="${NETWORK_NAME:-onvif_macvlan}"
SUBNET="${SUBNET:-192.168.5.0/24}"
GATEWAY="${GATEWAY:-192.168.5.1}"
IP_RANGE="${IP_RANGE:-192.168.5.192/26}"
PARENT_IFACE="${PARENT_IFACE:-br0}"

if docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
  echo "Docker 网络已存在：${NETWORK_NAME}"
  exit 0
fi

docker network create -d macvlan \
  --subnet="$SUBNET" \
  --ip-range="$IP_RANGE" \
  --gateway="$GATEWAY" \
  -o parent="$PARENT_IFACE" \
  "$NETWORK_NAME"

echo "已创建 Docker macvlan 网络：${NETWORK_NAME}"
