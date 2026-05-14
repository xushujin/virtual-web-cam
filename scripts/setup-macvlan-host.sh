#!/usr/bin/env bash
set -euo pipefail

HOST_IF="${HOST_IF:-br0}"
HOST_MACVLAN_IF="${HOST_MACVLAN_IF:-macvlan-host}"
HOST_MACVLAN_IP="${HOST_MACVLAN_IP:-192.168.5.210}"
ROUTE_CIDR="${ROUTE_CIDR:-192.168.5.208/28}"

ip link delete "$HOST_MACVLAN_IF" 2>/dev/null || true

ip link add "$HOST_MACVLAN_IF" link "$HOST_IF" type macvlan mode bridge
ip addr add "${HOST_MACVLAN_IP}/32" dev "$HOST_MACVLAN_IF"
ip link set "$HOST_MACVLAN_IF" up
ip route replace "$ROUTE_CIDR" dev "$HOST_MACVLAN_IF"

echo "已配置宿主机辅助接口 ${HOST_MACVLAN_IF}: ${HOST_MACVLAN_IP}/32，经由 ${HOST_IF}"
echo "已配置路由：${ROUTE_CIDR} dev ${HOST_MACVLAN_IF}"
