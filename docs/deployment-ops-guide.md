# VirtualWebCam 部署运维文档

版本：1.0  
目标环境：Linux + Docker  
当前验证网络：`br0 = 192.168.5.111/24`  
虚拟摄像头地址池：`192.168.5.208/28`，建议摄像头从 `192.168.5.211` 开始使用  
管理后台端口：前端 `5177`，后端 `8177`

## 1. 部署目标

部署完成后，现场人员可以通过浏览器完成以下操作：

- 创建项目和矩阵屏幕规格。
- 创建、启动、停止、重启、删除网页摄像头。
- 查看容器日志。
- 获取 RTSP、ONVIF、go2rtc 地址。
- 维护摄像头和矩阵屏幕的绑定关系。

每一路摄像头最终表现为一个独立 IP 的虚拟摄像头：

```text
RTSP:  rtsp://192.168.5.211:554/screen01
ONVIF: http://192.168.5.211/onvif/device_service
Web:   http://192.168.5.211
```

## 2. 部署前检查

### 2.1 Docker

```bash
docker version
docker ps
```

当前用户需要能访问 Docker：

```bash
groups
```

如果用户不在 `docker` 组：

```bash
sudo usermod -aG docker "$USER"
```

重新登录后生效。

### 2.2 主网卡

当前项目按 `br0` 部署：

```bash
ip addr show br0
ip route
```

期望能看到：

```text
br0: 192.168.5.111/24
default via 192.168.5.1
```

### 2.3 端口

宿主机需要保留：

```text
5177/tcp  前端管理页面
8177/tcp  后端 API
```

摄像头容器使用独立 macvlan IP，不需要在宿主机映射 `80`、`554`。

## 3. 快速部署

在项目根目录执行：

```bash
cp .env.example .env
docker compose --profile image build virtualwebcam-image
docker compose up -d --build manager-backend manager-frontend
```

访问管理后台：

```text
http://localhost:5177
http://192.168.5.111:5177
```

检查服务：

```bash
docker compose ps
curl http://localhost:8177/api/health
```

## 4. 创建 macvlan 网络

macvlan 网络由宿主机 Docker 管理。每个摄像头容器会在该网络上获取一个独立局域网 IP。

### 4.1 使用脚本

```bash
sudo PARENT_IFACE=br0 \
  SUBNET=192.168.5.0/24 \
  GATEWAY=192.168.5.1 \
  IP_RANGE=192.168.5.208/28 \
  NETWORK_NAME=onvif_macvlan \
  ./scripts/create-macvlan.sh
```

### 4.2 手动命令

```bash
sudo docker network create -d macvlan \
  --subnet=192.168.5.0/24 \
  --ip-range=192.168.5.208/28 \
  --gateway=192.168.5.1 \
  -o parent=br0 \
  onvif_macvlan
```

### 4.3 检查网络

```bash
docker network inspect onvif_macvlan
```

重点检查：

```text
Driver: macvlan
Subnet: 192.168.5.0/24
IPRange: 192.168.5.208/28
Gateway: 192.168.5.1
Parent: br0
```

## 5. 宿主机访问 macvlan 容器

macvlan 的常见限制是：宿主机默认不能访问同一宿主机上的 macvlan 容器 IP。其他局域网设备通常可以直接访问。

如果需要在宿主机本机打开：

```text
http://192.168.5.211
rtsp://192.168.5.211:554/screen01
```

需要创建宿主机侧辅助接口。

### 5.1 使用脚本

```bash
sudo HOST_IF=br0 \
  HOST_MACVLAN_IP=192.168.5.210 \
  ROUTE_CIDR=192.168.5.208/28 \
  ./scripts/setup-macvlan-host.sh
```

### 5.2 手动命令

```bash
sudo ip link delete macvlan-host 2>/dev/null || true
sudo ip link add macvlan-host link br0 type macvlan mode bridge
sudo ip addr add 192.168.5.210/32 dev macvlan-host
sudo ip link set macvlan-host up
sudo ip route replace 192.168.5.208/28 dev macvlan-host
```

### 5.3 开机恢复

该辅助接口重启后会丢失。生产环境建议用 systemd 固化：

```ini
[Unit]
Description=VirtualWebCam macvlan host interface
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/mola/genai/src/virtual-web-cam
ExecStart=/usr/bin/env HOST_IF=br0 HOST_MACVLAN_IP=192.168.5.210 ROUTE_CIDR=192.168.5.208/28 /mola/genai/src/virtual-web-cam/scripts/setup-macvlan-host.sh

[Install]
WantedBy=multi-user.target
```

保存为：

```text
/etc/systemd/system/virtualwebcam-macvlan-host.service
```

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now virtualwebcam-macvlan-host.service
```

### 5.4 更换网络环境 / 网段迁移

如果现场网络从一个网段切换到另一个网段，例如从：

```text
192.168.5.0/24
```

切换到：

```text
192.168.9.0/24
```

不需要重新构建 `virtualwebcam:latest` 镜像。需要调整的是宿主机 Docker macvlan 网络、宿主机侧 `macvlan-host` 辅助接口，以及管理后台中每路摄像头的虚拟 IP。

以下示例假设新环境为：

```text
宿主机网卡：br0
宿主机 IP：192.168.9.111
网关：192.168.9.1
虚拟摄像头地址池：192.168.9.208/28
宿主机辅助 IP：192.168.9.210
摄像头起始 IP：192.168.9.211
Docker macvlan 网络名：onvif_macvlan
```

实际执行前先确认新网络参数：

```bash
ip -4 addr show br0
ip route | grep default
```

如果现场网关不是 `192.168.9.1`，后续命令里的 `GATEWAY` 必须替换成真实网关。

建议先确认地址池不会和路由器 DHCP、真实摄像头、中控、大屏控制器或其他设备冲突。`192.168.9.208/28` 只是示例，可用地址范围通常为 `192.168.9.209-192.168.9.222`，其中建议预留 `192.168.9.210` 给宿主机辅助接口，摄像头从 `192.168.9.211` 开始。

#### 5.4.1 停止并移除旧摄像头容器

摄像头容器绑定了旧 macvlan 网络和旧 IP。迁移网段时建议先删除旧容器，数据库记录可以保留，后续在后台改 IP 后重新启动即可重新创建容器。

```bash
docker ps -aq --filter label=virtualwebcam.managed=true | xargs -r docker rm -f
```

#### 5.4.2 删除旧 macvlan 网络

```bash
docker network rm onvif_macvlan 2>/dev/null || true
```

如果提示网络仍在使用，说明还有容器挂在该网络上，先检查并移除：

```bash
docker network inspect onvif_macvlan
docker ps -a
```

#### 5.4.3 按新网段创建 macvlan 网络

使用脚本：

```bash
sudo PARENT_IFACE=br0 \
  SUBNET=192.168.9.0/24 \
  GATEWAY=192.168.9.1 \
  IP_RANGE=192.168.9.208/28 \
  NETWORK_NAME=onvif_macvlan \
  ./scripts/create-macvlan.sh
```

等价手动命令：

```bash
sudo docker network create -d macvlan \
  --subnet=192.168.9.0/24 \
  --ip-range=192.168.9.208/28 \
  --gateway=192.168.9.1 \
  -o parent=br0 \
  onvif_macvlan
```

检查结果：

```bash
docker network inspect onvif_macvlan
```

重点确认：

```text
Subnet: 192.168.9.0/24
IPRange: 192.168.9.208/28
Gateway: 192.168.9.1
Parent: br0
```

#### 5.4.4 重建宿主机辅助接口

如果只需要局域网其他设备访问虚拟摄像头，可以跳过这一步。如果要在宿主机本机用浏览器、`mpv`、ODM 访问 `192.168.9.211` 这类 macvlan 容器 IP，则需要执行：

```bash
sudo HOST_IF=br0 \
  HOST_MACVLAN_IP=192.168.9.210 \
  ROUTE_CIDR=192.168.9.208/28 \
  ./scripts/setup-macvlan-host.sh
```

手动命令：

```bash
sudo ip link delete macvlan-host 2>/dev/null || true
sudo ip link add macvlan-host link br0 type macvlan mode bridge
sudo ip addr add 192.168.9.210/32 dev macvlan-host
sudo ip link set macvlan-host up
sudo ip route replace 192.168.9.208/28 dev macvlan-host
```

如果之前配置了 systemd 开机恢复，也要同步修改：

```ini
ExecStart=/usr/bin/env HOST_IF=br0 HOST_MACVLAN_IP=192.168.9.210 ROUTE_CIDR=192.168.9.208/28 /mola/genai/src/virtual-web-cam/scripts/setup-macvlan-host.sh
```

修改后执行：

```bash
sudo systemctl daemon-reload
sudo systemctl restart virtualwebcam-macvlan-host.service
```

#### 5.4.5 更新项目配置文件

如果项目根目录 `.env` 用于记录现场网络参数，建议同步更新：

```env
HOST_IF=br0
SUBNET=192.168.9.0/24
GATEWAY=192.168.9.1
IP_RANGE=192.168.9.208/28
HOST_MACVLAN_IP=192.168.9.210
ROUTE_CIDR=192.168.9.208/28
```

后端真正创建摄像头容器时主要读取 `DOCKER_NETWORK`，只要网络名仍为 `onvif_macvlan`，通常不需要修改后端配置。

#### 5.4.6 修改摄像头虚拟 IP

进入管理后台：

```text
http://192.168.9.111:5177
```

在摄像头管理页面逐个编辑摄像头，把旧 IP 改到新网段，例如：

```text
192.168.5.211 -> 192.168.9.211
192.168.5.212 -> 192.168.9.212
192.168.5.213 -> 192.168.9.213
```

保存后重新启动摄像头。因为旧容器已经删除，启动时后端会按新的 IP 创建容器。

如果是批量迁移且确认 IP 规则只是第三段变化，也可以先备份数据库后用 SQL 批量替换：

```bash
cp backend/data/virtualwebcam.db "backend/data/virtualwebcam.db.$(date +%Y%m%d%H%M%S).bak"
sqlite3 backend/data/virtualwebcam.db \
  "UPDATE cameras SET ip = REPLACE(ip, '192.168.5.', '192.168.9.') WHERE ip LIKE '192.168.5.%';"
```

执行 SQL 后刷新管理后台，再逐路启动或批量启动摄像头。

#### 5.4.7 验证迁移结果

检查后台健康状态：

```bash
curl http://localhost:8177/api/health
```

检查摄像头容器：

```bash
docker ps --filter label=virtualwebcam.managed=true
docker inspect <容器名或容器ID> | grep -A5 onvif_macvlan
```

从宿主机本机验证：

```bash
curl -I http://192.168.9.211
mpv --rtsp-transport=tcp rtsp://192.168.9.211:554/screen01
```

从 ONVIF Device Manager 或中控手动添加：

```text
ONVIF：http://192.168.9.211/onvif/device_service
RTSP：rtsp://192.168.9.211:554/screen01
```

迁移完成后，旧地址 `192.168.5.xxx` 不应再出现在摄像头列表、RTSP 地址、ONVIF 地址和中控配置中。

## 6. 构建摄像头镜像

```bash
docker build -t virtualwebcam:latest ./container
```

或：

```bash
docker compose --profile image build virtualwebcam-image
```

检查镜像：

```bash
docker image inspect virtualwebcam:latest >/dev/null && echo ok
```

## 7. 部署管理后台

### 7.1 Docker Compose 部署

```bash
docker compose up -d --build manager-backend manager-frontend
```

检查：

```bash
docker compose ps
docker logs --tail=80 virtualwebcam-manager-backend
docker logs --tail=80 virtualwebcam-manager-frontend
```

访问：

```text
http://192.168.5.111:5177
```

### 7.2 开发模式部署

后端：

```bash
cd backend
PORT=8177 \
SQLITE_PATH=./data/virtualwebcam.db \
DOCKER_NETWORK=onvif_macvlan \
DOCKER_EGRESS_NETWORK=bridge \
VIRTUALWEBCAM_IMAGE=virtualwebcam:latest \
npm run dev
```

前端：

```bash
cd frontend
npm run dev -- --port 5177
```

## 8. 安全配置

管理后台后端挂载 Docker socket，权限很高。生产环境建议：

1. 只部署在内网。
2. 不直接暴露 `8177` 到公网。
3. 启用 `API_TOKEN`。
4. 放到公司统一认证网关后面。
5. 限制能访问管理后台的 IP 段。

启用令牌：

```bash
API_TOKEN="change-me" docker compose up -d --build manager-backend manager-frontend
```

前端构建时会通过 `VITE_API_TOKEN` 注入同一个令牌。如果前端已经构建，也可在浏览器控制台写入：

```js
localStorage.setItem('virtualwebcam-api-token', 'change-me')
```

## 9. 创建摄像头

### 9.1 通过网页创建

1. 打开 `http://192.168.5.111:5177`。
2. 进入项目。
3. 打开“摄像头管理”。
4. 点击“新增摄像头”。
5. 填写：
   - 名称：`web-cam-01`
   - 虚拟 IP：`192.168.5.211`
   - 网页 URL：业务网页地址
   - 流名称：`screen01`
   - 分辨率：`1280 x 720`
   - FPS：`15`
6. 点击创建。

创建成功后，列表会显示：

```text
状态：运行中
RTSP：rtsp://192.168.5.211:554/screen01
ONVIF：http://192.168.5.211/onvif/device_service
```

### 9.2 通过 API 创建

```bash
curl -X POST 'http://localhost:8177/api/cameras?project_id=1' \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "web-cam-01",
    "ip": "192.168.5.211",
    "stream_name": "screen01",
    "web_url": "https://www.baidu.com",
    "width": 1280,
    "height": 720,
    "fps": 15
  }'
```

### 9.3 单容器手工验证

绕过管理后台直接运行：

```bash
docker run -d \
  --name web-cam-01 \
  --network bridge \
  virtualwebcam:latest
```

正式 macvlan 单容器需要固定 IP：

```bash
docker create \
  --name web-cam-01 \
  --network bridge \
  -e WEB_URL="https://www.baidu.com" \
  -e STREAM_NAME="screen01" \
  -e WIDTH=1280 \
  -e HEIGHT=720 \
  -e FPS=15 \
  virtualwebcam:latest

docker network connect --ip 192.168.5.211 onvif_macvlan web-cam-01
docker start web-cam-01
```

管理后台创建容器时会自动完成类似动作。

## 10. 验证方法

### 10.1 容器状态

```bash
docker ps --filter label=virtualwebcam.managed=true
docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' virtualwebcam-1-web-cam-01
```

### 10.2 go2rtc Web

```bash
curl -I http://192.168.5.211
```

浏览器打开：

```text
http://192.168.5.211
```

### 10.3 RTSP

推荐使用 mpv：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.211:554/screen01
```

如果使用 ffplay：

```bash
ffplay -rtsp_transport tcp rtsp://192.168.5.211:554/screen01
```

注意：部分播放器在容器重启或网页 URL 切换后可能停留历史帧，需要关闭后重新打开。mpv 在源重启时通常会退出，更适合作为验收工具。

### 10.4 ONVIF

ONVIF Device Manager 手动添加：

```text
地址：http://192.168.5.211/onvif/device_service
用户名：空
密码：空
```

预期：

```text
设备类型：NVT
Profile：screen01
Stream URI：rtsp://192.168.5.211:554/screen01
Live Video：显示网页画面
```

自动发现依赖 UDP 3702、组播、交换机和客户端实现，不作为本项目核心验收项。手动添加成功即可满足当前接入方式。

## 11. 日常运维

### 11.1 查看管理后台日志

```bash
docker logs --tail=200 virtualwebcam-manager-backend
docker logs --tail=200 virtualwebcam-manager-frontend
```

### 11.2 查看摄像头日志

网页端：摄像头列表 -> 配置 -> 查看日志。

命令行：

```bash
docker logs --tail=300 virtualwebcam-1-web-cam-01
```

### 11.3 启动、停止、重启摄像头

网页端优先。

命令行：

```bash
docker start virtualwebcam-1-web-cam-01
docker stop virtualwebcam-1-web-cam-01
docker restart virtualwebcam-1-web-cam-01
```

### 11.4 修改网页地址

在管理后台编辑摄像头 URL。如果摄像头正在运行，后端会重建容器让配置生效。

验证时请重新打开播放器：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.211:554/screen01
```

### 11.5 状态同步

摄像头列表会定时刷新状态，也可点击“刷新状态”。后端状态以 Docker 容器状态为准：

```text
running  -> 运行中
exited 0 -> 已停止
exited 非 0 / dead -> 异常
missing -> 已停止
```

## 12. 数据备份与恢复

### 12.1 备份 SQLite

Docker Compose 部署默认数据库：

```text
backend/data/virtualwebcam.db
```

建议停写后备份：

```bash
mkdir -p backups
sqlite3 backend/data/virtualwebcam.db ".backup 'backups/virtualwebcam-$(date +%F-%H%M%S).db'"
```

如果没有 sqlite3：

```bash
cp backend/data/virtualwebcam.db "backups/virtualwebcam-$(date +%F-%H%M%S).db"
cp backend/data/virtualwebcam.db-wal "backups/" 2>/dev/null || true
cp backend/data/virtualwebcam.db-shm "backups/" 2>/dev/null || true
```

### 12.2 恢复 SQLite

```bash
docker compose stop manager-backend
cp backups/virtualwebcam-xxxx.db backend/data/virtualwebcam.db
docker compose start manager-backend
```

### 12.3 导出项目配置

网页端项目入口提供项目配置导出。导出内容包含：

- 项目名称。
- 矩阵规格。
- 摄像头配置。
- 屏幕绑定。
- RTSP/ONVIF 地址。

导入时如果 IP 冲突，后端会在同网段内自动寻找可用 IP 并返回重映射结果。

## 13. 升级流程

### 13.1 升级前

```bash
docker compose ps
docker ps --filter label=virtualwebcam.managed=true
mkdir -p backups
sqlite3 backend/data/virtualwebcam.db ".backup 'backups/pre-upgrade-$(date +%F-%H%M%S).db'"
```

### 13.2 重新构建

```bash
docker compose --profile image build virtualwebcam-image
docker compose build manager-backend manager-frontend
docker compose up -d manager-backend manager-frontend
```

### 13.3 重建摄像头容器

如果只更新管理后台，不需要重建摄像头容器。  
如果更新了 `container/` 镜像，需要逐路重启或编辑保存触发重建。

批量方式：

```bash
docker ps --filter label=virtualwebcam.managed=true --format '{{.Names}}' \
  | xargs -r -n1 docker restart
```

更推荐在网页端按项目分批重启，便于观察影响。

## 14. 清理

停止管理后台：

```bash
docker compose down
```

删除摄像头容器：

```bash
docker rm -f $(docker ps -aq --filter label=virtualwebcam.managed=true)
```

删除 macvlan 网络：

```bash
docker network rm onvif_macvlan
```

删除宿主机辅助接口：

```bash
sudo ip link delete macvlan-host
```

## 15. 故障处理

### 15.1 管理后台提示无法访问 Docker socket

现象：

```text
无法访问 Docker socket: /var/run/docker.sock
```

处理：

```bash
docker ps
ls -l /var/run/docker.sock
groups
```

如果当前用户没有 Docker 权限，把用户加入 `docker` 组并重新登录：

```bash
sudo usermod -aG docker "$USER"
```

Docker Compose 部署还要确认挂载：

```yaml
volumes:
  - /var/run/docker.sock:/var/run/docker.sock
```

### 15.2 Docker 网络不存在

现象：

```text
Docker 网络不存在：onvif_macvlan
```

处理：

```bash
sudo ./scripts/create-macvlan.sh
docker network inspect onvif_macvlan
```

### 15.3 虚拟 IP 被占用

现象：

```text
Address already in use
already allocated
Camera IP already exists
```

处理：

```bash
docker network inspect onvif_macvlan
arp -a | grep 192.168.5.211
ping 192.168.5.211
```

换一个未使用的 IP，或删除旧容器。

### 15.4 容器无限重启

查看日志：

```bash
docker logs --tail=200 virtualwebcam-1-web-cam-01
docker inspect -f '{{.State.ExitCode}} {{.State.Error}}' virtualwebcam-1-web-cam-01
```

常见原因：

- Chrome 没有成功进入 Xvfb。
- 网页加载极慢导致窗口检测超时。
- stream_name 不合法。
- 容器内无法访问目标网页。
- FFmpeg 无法采集 Xvfb。

处理建议：

- 先换成简单网页，例如 `https://www.baidu.com`。
- 降低分辨率和 FPS 验证。
- 检查容器是否同时挂了 `bridge` 和 `onvif_macvlan`。

### 15.5 容器运行但画面是 Chrome 错误页

这说明 RTSP 管道正常，但 Chrome 访问网页失败。

进入容器检查网络：

```bash
docker exec -it virtualwebcam-1-web-cam-01 bash
curl -I https://目标网页
```

如果业务网页需要内网 DNS、VPN、证书或登录态，需要单独解决网页访问条件。

### 15.6 宿主机打不开摄像头 IP

其他机器能访问，宿主机不能访问，通常是 macvlan 默认限制。

处理：

```bash
sudo ./scripts/setup-macvlan-host.sh
ip route | grep 192.168.5.208
```

### 15.7 RTSP 播放器停留旧画面

容器重启后，部分播放器不会自动重新拉流，可能显示最后一帧。关闭播放器重新打开即可。

推荐验收：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.211:554/screen01
```

### 15.8 ONVIF 自动发现不到

手动添加：

```text
http://192.168.5.211/onvif/device_service
```

如果手动添加成功、Live Video 正常，说明 ONVIF 接入链路可用。自动发现依赖 UDP 3702 和网络广播策略，需要单独排查。

## 16. 资源规划

估算原则：

- 每一路至少一个 Chrome、一个 FFmpeg、一个 MediaMTX、一个 go2rtc。
- 网页越复杂，CPU 和内存越高。
- 分辨率越高、FPS 越高，FFmpeg 编码压力越大。

建议初始规格：

```text
1280x720 @ 15 FPS
H.264 baseline
GOP = FPS * 2
```

矩阵大屏看板通常不需要 30 FPS。静态数据屏可降至 10 FPS。

上线前建议按真实网页压测：

```bash
docker stats
top
mpv --rtsp-transport=tcp rtsp://<ip>:554/<stream>
```

管理后台“摄像头管理”页面内置资源监控，会按项目汇总 CPU、内存、网络速率和磁盘读写速率，并在每路摄像头行内显示单路消耗。建议压测时记录以下数据：

- 单路真实网页在目标分辨率和 FPS 下的 CPU 平均值与峰值。
- 单路内存占用。
- 所有运行摄像头的网络发送速率。
- 磁盘写入速率和累计写入量。

硬件规划可先用少量真实页面得到单路均值，再乘以目标路数，并预留 30% 以上余量。

## 17. 验收清单

部署完成后逐项确认：

- `docker ps` 中管理后台容器运行正常。
- `/api/health` 显示 Docker、网络和镜像可用。
- `docker network inspect onvif_macvlan` 正确。
- 管理后台可创建项目。
- 管理后台可创建摄像头。
- 摄像头容器状态为 `running`。
- 摄像头容器健康状态为 `healthy`。
- 浏览器能打开 `http://<camera_ip>`。
- `mpv` 能播放 RTSP。
- ODM 手动添加 ONVIF 成功。
- 摄像头列表状态刷新准确。
- 运行中的摄像头启动按钮禁用，停止/重启可用。
- 矩阵绑定不允许重复占用屏幕。
- 日志页面能读取容器日志。
