# VirtualWebCam 部署运维文档

版本：1.0  
目标环境：Linux + Docker  
当前验证网络：`br0 = 192.168.5.198/24`  
虚拟摄像头地址池：`192.168.5.192/26`，建议摄像头从 `192.168.5.200` 开始使用  
管理后台端口：前端 `9528`，后端 `8177`

## 1. 部署目标

部署完成后，现场人员可以通过浏览器完成以下操作：

- 创建项目和矩阵屏幕规格。
- 创建、启动、停止、重启、删除网页视频源。
- 查看容器日志。
- 获取 RTSP、ONVIF 地址和播放测试命令。
- 维护摄像头和矩阵屏幕的绑定关系。

系统支持两类视频源：

- ONVIF 摄像头：每一路最终表现为一个独立 IP 的虚拟摄像头。
- RTSP 流源：多路共享宿主机 IP 和 `554/tcp`，通过不同 `/<stream_name>` 区分，不提供 ONVIF。

ONVIF 摄像头示例：

```text
RTSP:  rtsp://192.168.5.200:554/screen01
ONVIF: http://192.168.5.200/onvif/device_service
Web:   http://192.168.5.200
```

RTSP 流源示例：

```text
RTSP:  rtsp://192.168.5.198:554/screen01
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
br0: 192.168.5.198/24
default via 192.168.5.1
```

### 2.3 端口

宿主机需要保留：

```text
9528/tcp  前端管理页面
8177/tcp  后端 API
554/tcp   共享 RTSP 网关。只有创建 RTSP 流源时才会占用
```

ONVIF 摄像头容器使用独立 macvlan IP，不需要在宿主机映射 `80`、`554`。RTSP 流源使用共享网关容器，网关会把 `554/tcp` 映射到宿主机。

## 3. 快速部署

在项目根目录执行：

```bash
cp .env.example .env
docker compose --profile image build virtualwebcam-image
docker compose up -d --build manager-backend manager-frontend
```

访问管理后台：

```text
http://localhost:9528
http://192.168.5.198:9528
```

检查服务：

```bash
docker compose ps
TOKEN="$(curl -s -X POST http://localhost:8177/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<.env 中的 ADMIN_PASSWORD>"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
curl -H "Authorization: Bearer ${TOKEN}" http://localhost:8177/api/health
```

## 4. 创建 macvlan 网络

macvlan 网络由宿主机 Docker 管理。每个 ONVIF 摄像头容器会在该网络上获取一个独立局域网 IP。RTSP 流源不使用 macvlan 独立 IP。

### 4.1 使用脚本

```bash
sudo PARENT_IFACE=br0 \
  SUBNET=192.168.5.0/24 \
  GATEWAY=192.168.5.1 \
  IP_RANGE=192.168.5.192/26 \
  NETWORK_NAME=onvif_macvlan \
  ./scripts/create-macvlan.sh
```

### 4.2 手动命令

```bash
sudo docker network create -d macvlan \
  --subnet=192.168.5.0/24 \
  --ip-range=192.168.5.192/26 \
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
IPRange: 192.168.5.192/26
Gateway: 192.168.5.1
Parent: br0
```

## 5. 宿主机访问 macvlan 容器

macvlan 的常见限制是：宿主机默认不能访问同一宿主机上的 macvlan 容器 IP。其他局域网设备通常可以直接访问。

如果需要在宿主机本机打开：

```text
http://192.168.5.200
rtsp://192.168.5.200:554/screen01
```

需要创建宿主机侧辅助接口。

### 5.1 使用脚本

```bash
sudo HOST_IF=br0 \
  HOST_MACVLAN_IP=192.168.5.199 \
  ROUTE_CIDR=192.168.5.192/26 \
  ./scripts/setup-macvlan-host.sh
```

### 5.2 手动命令

```bash
sudo ip link delete macvlan-host 2>/dev/null || true
sudo ip link add macvlan-host link br0 type macvlan mode bridge
sudo ip addr add 192.168.5.199/32 dev macvlan-host
sudo ip link set macvlan-host up
sudo ip route replace 192.168.5.192/26 dev macvlan-host
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
ExecStart=/usr/bin/env HOST_IF=br0 HOST_MACVLAN_IP=192.168.5.199 ROUTE_CIDR=192.168.5.192/26 /mola/genai/src/virtual-web-cam/scripts/setup-macvlan-host.sh

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

不需要重新构建 `virtualwebcam:latest` 镜像。需要调整的是宿主机 Docker macvlan 网络、宿主机侧 `macvlan-host` 辅助接口，以及管理后台中 ONVIF 摄像头的虚拟 IP。RTSP 流源不依赖 macvlan 独立 IP，但需要把 `RTSP_GATEWAY_HOST` 改成新宿主机 IP，否则页面生成的 RTSP 地址会仍然指向旧网段。

以下示例假设新环境为：

```text
宿主机网卡：br0
宿主机 IP：192.168.9.198
网关：192.168.9.1
虚拟摄像头地址池：192.168.9.192/26
宿主机辅助 IP：192.168.9.199
摄像头起始 IP：192.168.9.200
Docker macvlan 网络名：onvif_macvlan
```

实际执行前先确认新网络参数：

```bash
ip -4 addr show br0
ip route | grep default
```

如果现场网关不是 `192.168.9.1`，后续命令里的 `GATEWAY` 必须替换成真实网关。

建议先确认地址池不会和路由器 DHCP、真实摄像头、中控、大屏控制器或其他设备冲突。`192.168.9.192/26` 只是示例，CIDR 实际主机范围是 `192.168.9.193 - 192.168.9.254`；业务上只从 `192.168.9.200 - 192.168.9.240` 分配摄像头 IP，并预留 `192.168.9.199` 给宿主机辅助接口。

#### 5.4.1 停止并移除旧摄像头容器

ONVIF 摄像头容器绑定了旧 macvlan 网络和旧 IP。迁移网段时建议先删除旧容器，数据库记录可以保留，后续在后台改 IP 后重新启动即可重新创建容器。RTSP 流源容器可以不删，但修改 `RTSP_GATEWAY_HOST` 后建议重启共享网关和发布器，保证验收环境干净。

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
  IP_RANGE=192.168.9.192/26 \
  NETWORK_NAME=onvif_macvlan \
  ./scripts/create-macvlan.sh
```

等价手动命令：

```bash
sudo docker network create -d macvlan \
  --subnet=192.168.9.0/24 \
  --ip-range=192.168.9.192/26 \
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
IPRange: 192.168.9.192/26
Gateway: 192.168.9.1
Parent: br0
```

#### 5.4.4 重建宿主机辅助接口

如果只需要局域网其他设备访问虚拟摄像头，可以跳过这一步。如果要在宿主机本机用浏览器、`mpv`、ODM 访问 `192.168.9.200` 这类 macvlan 容器 IP，则需要执行：

```bash
sudo HOST_IF=br0 \
  HOST_MACVLAN_IP=192.168.9.199 \
  ROUTE_CIDR=192.168.9.192/26 \
  ./scripts/setup-macvlan-host.sh
```

手动命令：

```bash
sudo ip link delete macvlan-host 2>/dev/null || true
sudo ip link add macvlan-host link br0 type macvlan mode bridge
sudo ip addr add 192.168.9.199/32 dev macvlan-host
sudo ip link set macvlan-host up
sudo ip route replace 192.168.9.192/26 dev macvlan-host
```

如果之前配置了 systemd 开机恢复，也要同步修改：

```ini
ExecStart=/usr/bin/env HOST_IF=br0 HOST_MACVLAN_IP=192.168.9.199 ROUTE_CIDR=192.168.9.192/26 /mola/genai/src/virtual-web-cam/scripts/setup-macvlan-host.sh
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
IP_RANGE=192.168.9.192/26
HOST_MACVLAN_IP=192.168.9.199
ROUTE_CIDR=192.168.9.192/26
RTSP_GATEWAY_HOST=192.168.9.198
```

后端真正创建摄像头容器时主要读取 `DOCKER_NETWORK`，只要网络名仍为 `onvif_macvlan`，通常不需要修改后端配置。
如果后台以开发模式运行，重启后端时也要带上新的 `RTSP_GATEWAY_HOST`。

#### 5.4.6 修改摄像头虚拟 IP

进入管理后台：

```text
http://192.168.9.198:9528
```

在摄像头管理页面逐个编辑摄像头，把旧 IP 改到新网段，例如：

```text
192.168.5.200 -> 192.168.9.200
192.168.5.201 -> 192.168.9.201
192.168.5.202 -> 192.168.9.202
```

保存后重新启动摄像头。因为旧容器已经删除，启动时后端会按新的 IP 创建容器。

如果是批量迁移且确认 IP 规则只是第三段变化，也可以先备份数据库后用 SQL 批量替换：

```bash
cp backend/data/virtualwebcam.db "backend/data/virtualwebcam.db.$(date +%Y%m%d%H%M%S).bak"
sqlite3 backend/data/virtualwebcam.db \
  "UPDATE cameras SET ip = REPLACE(ip, '192.168.5.', '192.168.9.') WHERE ip LIKE '192.168.5.%';"
```

执行 SQL 后刷新管理后台，再逐路启动或批量启动摄像头。

RTSP 流源的 `ip` 为空，不需要改摄像头 IP；只要后端的 `RTSP_GATEWAY_HOST` 已更新，列表中的 RTSP 地址会按新的宿主机 IP 生成。

#### 5.4.7 验证迁移结果

检查后台健康状态：

```bash
TOKEN="$(curl -s -X POST http://localhost:8177/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<管理员密码>"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
curl -H "Authorization: Bearer ${TOKEN}" http://localhost:8177/api/health
```

检查摄像头容器：

```bash
docker ps --filter label=virtualwebcam.managed=true
docker inspect <容器名或容器ID> | grep -A5 onvif_macvlan
```

从宿主机本机验证：

```bash
curl -I http://192.168.9.200
mpv --rtsp-transport=tcp rtsp://192.168.9.200:554/screen01
```

从 ONVIF Device Manager 或中控手动添加：

```text
ONVIF：http://192.168.9.200/onvif/device_service
RTSP：rtsp://192.168.9.200:554/screen01
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
http://192.168.5.198:9528
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
CAMERA_RTSP_PORT=554 \
RTSP_GATEWAY_HOST=192.168.5.198 \
RTSP_GATEWAY_PORT=554 \
RTSP_NETWORK=virtualwebcam_rtsp \
npm run dev
```

前端：

```bash
cd frontend
npm run dev -- --port 9528
```

## 8. 安全配置

管理后台后端挂载 Docker socket，权限很高。生产环境建议：

1. 只部署在内网。
2. 不直接暴露 `8177` 到公网。
3. 修改默认管理员密码和 `SESSION_SECRET`。
4. 按项目给普通用户授权。
5. 放到公司统一认证网关后面。
6. 限制能访问管理后台的 IP 段。

首次启动时如果数据库中没有用户，系统会自动创建管理员：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123456
SESSION_SECRET=change-this-session-secret
```

上线前请改成强密码：

```bash
ADMIN_USERNAME="admin" \
ADMIN_PASSWORD="replace-with-strong-password" \
SESSION_SECRET="$(openssl rand -hex 32)" \
docker compose up -d --build manager-backend manager-frontend
```

管理员登录后，打开系统级“用户管理”，可创建普通用户，并把项目资源授权为：

- `仅查看`：只能查看项目、摄像头、矩阵、日志和地址。
- `可操作`：可以管理授权项目内的视频源、容器启停、矩阵绑定和项目设置。

系统管理员还可以从首页进入“备份管理”，配置 SQLite 定时备份、立即备份、下载、删除、恢复和上传恢复。

`API_TOKEN` 仍可作为脚本或内网网关的服务令牌。启用后，请求带 `X-API-Token` 或 `Authorization: Bearer <token>` 会按系统管理员权限处理：

```bash
API_TOKEN="change-me" docker compose up -d --build manager-backend manager-frontend
```

服务令牌不会注入前端构建产物，前端运行时代码也不会从浏览器 LocalStorage 读取服务令牌。生产环境不要把 `API_TOKEN` 写入浏览器或公开页面，网页用户应使用账号密码登录，并通过“用户管理”授权项目资源。

## 9. 创建视频源

### 9.1 通过网页创建 ONVIF 摄像头

如果项目里已经维护了“大屏地址”，网页 URL 可以直接搜索选择；也可以手动输入任意合法的 `http://` 或 `https://` 地址。
从“大屏地址”候选中选择网页 URL 时，系统会自动把该地址的名称回填到视频源名称中。流名称由系统自动生成，用户不需要填写。

1. 打开 `http://192.168.5.198:9528`。
2. 进入项目。
3. 打开“摄像头管理”。
4. 点击“新增源”。
5. 源类型选择“ONVIF 摄像头（独立 IP）”。
6. 填写：
   - 名称：`web-cam-01`
   - 虚拟 IP：`192.168.5.200`
   - 网页 URL：业务网页地址
   - 分辨率：`1280 x 720`
   - FPS：`15`
7. 点击创建。

创建成功后，列表会显示：

```text
状态：运行中
RTSP：rtsp://192.168.5.200:554/screen01
ONVIF：http://192.168.5.200/onvif/device_service
```

### 9.2 通过网页创建 RTSP 流源

当现场 IP 地址不足，或者中控支持直接 RTSP 接入时，可以创建 RTSP 流源：

如果项目里已经维护了“大屏地址”，网页 URL 可以直接搜索选择；也可以手动输入。
流名称由系统自动生成，并会避免和已有 RTSP 流源冲突。

1. 打开 `http://192.168.5.198:9528`。
2. 进入项目。
3. 打开“摄像头管理”。
4. 点击“新增源”。
5. 源类型选择“RTSP 流源（共享 IP + 流路径）”。
6. 填写：
   - 名称：`rtsp-screen-01`
   - 网页 URL：业务网页地址
   - 分辨率：`1280 x 720`
   - FPS：`15`
7. 点击创建。

创建成功后，系统会自动创建或复用共享网关容器 `virtualwebcam-rtsp-gateway`，列表会显示：

```text
状态：运行中
RTSP：rtsp://192.168.5.198:554/screen01
ONVIF：无
```

### 9.3 通过 API 创建 ONVIF 摄像头

以下示例需要先准备登录令牌，或改用已配置的 `API_TOKEN`：

```bash
TOKEN="<登录接口返回的 token>"
```

```bash
curl -X POST 'http://localhost:8177/api/cameras?project_id=1' \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "source_type": "camera",
    "name": "web-cam-01",
    "ip": "192.168.5.200",
    "stream_name": "screen01",
    "web_url": "https://www.baidu.com",
    "width": 1280,
    "height": 720,
    "fps": 15
  }'
```

### 9.4 通过 API 创建 RTSP 流源

```bash
curl -X POST 'http://localhost:8177/api/cameras?project_id=1' \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{
    "source_type": "rtsp",
    "name": "rtsp-screen-01",
    "ip": null,
    "stream_name": "screen01",
    "web_url": "https://www.baidu.com",
    "width": 1280,
    "height": 720,
    "fps": 15
  }'
```

### 9.5 单容器手工验证 ONVIF 摄像头

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

docker network connect --ip 192.168.5.200 onvif_macvlan web-cam-01
docker start web-cam-01
```

管理后台创建容器时会自动完成类似动作。

### 9.6 手工验证 RTSP 网关模式

先创建共享 bridge 网络：

```bash
docker network create virtualwebcam_rtsp 2>/dev/null || true
```

共享 RTSP 网关：

```bash
docker run -d \
  --name virtualwebcam-rtsp-gateway \
  --network virtualwebcam_rtsp \
  -p 554:554 \
  -e OUTPUT_MODE=rtsp-gateway \
  -e MEDIAMTX_RTSP_PORT=554 \
  virtualwebcam:latest
```

一路 RTSP 发布器：

```bash
docker run -d \
  --name rtsp-screen-01 \
  --network virtualwebcam_rtsp \
  -e OUTPUT_MODE=rtsp-publisher \
  -e WEB_URL="https://www.baidu.com" \
  -e STREAM_NAME="screen01" \
  -e RTSP_PUSH_URL="rtsp://virtualwebcam-rtsp-gateway:554/screen01" \
  virtualwebcam:latest
```

## 10. 验证方法

### 10.1 容器状态

```bash
docker ps --filter label=virtualwebcam.managed=true
docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' virtualwebcam-1-web-cam-01
```

### 10.2 go2rtc Web

该验证只适用于 ONVIF 摄像头。

```bash
curl -I http://192.168.5.200
```

浏览器打开：

```text
http://192.168.5.200
```

### 10.3 RTSP

推荐使用 mpv：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.200:554/screen01
```

RTSP 流源使用宿主机共享网关地址：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.198:554/screen01
```

如果使用 ffplay：

```bash
ffplay -rtsp_transport tcp rtsp://192.168.5.200:554/screen01
```

注意：部分播放器在容器重启或网页 URL 切换后可能停留历史帧，需要关闭后重新打开。mpv 在源重启时通常会退出，更适合作为验收工具。

### 10.4 ONVIF

该验证只适用于 ONVIF 摄像头。RTSP 流源没有 ONVIF 地址。

ONVIF Device Manager 手动添加：

```text
地址：http://192.168.5.200/onvif/device_service
用户名：空
密码：空
```

预期：

```text
设备类型：NVT
Profile：screen01
Stream URI：rtsp://192.168.5.200:554/screen01
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
mpv --rtsp-transport=tcp rtsp://192.168.5.200:554/screen01
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

### 12.1 管理后台备份

推荐优先使用首页的“备份管理”，该入口仅系统管理员可见。默认备份路径是后端容器内 `/data/backups`，Docker Compose 部署时对应宿主机 `backend/data/backups`。

页面能力：

- 启用或停用定时备份。
- 设置备份频率：每小时、每天、每周、每月。
- 立即备份。
- 列出、下载、删除备份文件。
- 输入确认词 `RESTORE` 后恢复已有备份。
- 输入确认词 `RESTORE` 后上传本地 `.db` 文件并恢复。

恢复前系统会自动先备份当前数据库；上传恢复会先对上传的 SQLite 文件执行校验。

### 12.2 手工备份 SQLite

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

### 12.3 手工恢复 SQLite

```bash
docker compose stop manager-backend
cp backups/virtualwebcam-xxxx.db backend/data/virtualwebcam.db
docker compose start manager-backend
```

### 12.4 导出项目配置

网页端项目入口提供项目配置导出。导出内容包含：

- 项目名称。
- 矩阵规格。
- 摄像头配置。
- 大屏地址库。
- 屏幕绑定。
- RTSP 地址，以及 ONVIF 摄像头的 ONVIF 地址。

导入时会同时导入大屏地址库。ONVIF 摄像头 IP 冲突时，后端会在同网段内自动寻找可用 IP 并返回重映射结果；RTSP 流源路径冲突时会自动改名，例如 `screen01` 可能变成 `screen01-import`。如果导入过程中出现矩阵绑定冲突等校验错误，后端会清理已经临时创建的项目和资源，避免留下半成品数据。

如果只需要维护当前项目的大屏地址库，不必导入导出整个项目配置；在“大屏地址”页面使用 CSV 导入导出即可，CSV 列为 `name,url,remark`。

## 13. 升级流程

### 13.1 升级前

```bash
docker compose ps
docker ps --filter label=virtualwebcam.managed=true
mkdir -p backups
sqlite3 backend/data/virtualwebcam.db ".backup 'backups/pre-upgrade-$(date +%F-%H%M%S).db'"
```

### 13.2 保留数据重新部署

```bash
chmod +x ubuntu26.04-deploy.sh
./ubuntu26.04-deploy.sh --yes --keep-data --frontend-port 9528
```

如果旧版本目录里没有 `.env`，或者需要重新指定现场网络参数，应补全 `--host-if`、`--host-ip`、`--subnet`、`--gateway`、`--ip-range`、`--host-macvlan-ip` 等参数。

### 13.3 处理旧摄像头容器

如果只更新管理后台，不需要重建摄像头容器。

本版本创建的视频源容器不会随 Docker 开机自启动。旧版本已经创建的摄像头容器可能仍保留旧自启动策略，升级后建议执行一次：

```bash
docker ps -aq --filter "label=virtualwebcam.cameraId" | xargs -r docker update --restart=no
```

如果需要让旧摄像头容器完全使用新镜像，可以在业务允许中断时删除旧摄像头容器。数据库里的视频源配置会保留，后续在管理后台点击启动时会用新镜像重新创建：

```bash
docker ps -aq --filter "label=virtualwebcam.cameraId" | xargs -r docker rm -f
```

## 14. 清理

停止管理后台：

```bash
docker compose down
```

删除摄像头容器：

```bash
docker rm -f $(docker ps -aq --filter label=virtualwebcam.managed=true)
```

使用根目录 `ubuntu26.04-deploy.sh` 重新部署时，脚本会先备份现有 SQLite。需要清空测试数据可传入 `--clean-data`；需要明确保留现有数据可传入 `--keep-data`。

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
arp -a | grep 192.168.5.200
ping 192.168.5.200
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
ip route | grep 192.168.5.192
```

### 15.7 RTSP 播放器停留旧画面

容器重启后，部分播放器不会自动重新拉流，可能显示最后一帧。关闭播放器重新打开即可。

推荐验收：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.200:554/screen01
```

### 15.8 ONVIF 自动发现不到

手动添加：

```text
http://192.168.5.200/onvif/device_service
```

如果手动添加成功、Live Video 正常，说明 ONVIF 接入链路可用。自动发现依赖 UDP 3702 和网络广播策略，需要单独排查。

### 15.9 RTSP 网关 554 端口被占用

RTSP 流源会启动共享网关容器，并默认映射宿主机 `554/tcp`。如果创建 RTSP 流源失败，日志或接口返回端口冲突，需要检查：

```bash
ss -lntp | grep ':554'
docker ps --format 'table {{.Names}}\t{{.Ports}}' | grep 554
```

处理方式：

- 停掉占用 `554/tcp` 的无关服务。
- 或修改 `.env` 中的 `RTSP_GATEWAY_PORT`，例如改为 `8554`，然后重启管理后台。注意中控和播放器里的 RTSP 地址也要同步使用新端口。

### 15.10 RTSP 流源没有 ONVIF 地址

这是预期行为。RTSP 流源用于 IP 不足或中控支持 RTSP 直连的场景，只输出：

```text
rtsp://<宿主机IP>:554/<stream_name>
```

如果现场必须用 ONVIF Device Manager 或中控 ONVIF 协议添加，请创建 ONVIF 摄像头源。

## 16. 资源规划

估算原则：

- ONVIF 摄像头每一路包含一个 Chrome、一个 FFmpeg、一个 MediaMTX、一个 go2rtc。
- RTSP 流源每一路包含一个 Chrome 和一个 FFmpeg；所有 RTSP 流源共享一个 MediaMTX 网关。
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

管理后台“摄像头管理”页面内置资源监控，默认折叠为一行摘要，并持续自动刷新；展开后会按项目汇总 CPU、内存、网络速率和磁盘读写速率。开启列表“资源”字段后，每路摄像头行内会显示单路消耗。建议压测时记录以下数据：

- 单路真实网页在目标分辨率和 FPS 下的 CPU 平均值与峰值。
- 单路内存占用。
- 所有运行摄像头的网络发送速率。
- 磁盘写入速率和累计写入量。

硬件规划可先用少量真实页面得到单路均值，再乘以目标路数，并预留 30% 以上余量。

## 17. 验收清单

部署完成后逐项确认：

- `docker ps` 中管理后台容器运行正常。
- 登录后运行环境检测或带登录令牌访问 `/api/health`，显示 Docker、网络和镜像可用。
- `docker network inspect onvif_macvlan` 正确。
- 管理后台可创建项目。
- 管理后台可创建 ONVIF 摄像头。
- 管理后台可创建 RTSP 流源。
- 摄像头容器状态为 `running`。
- 摄像头容器健康状态为 `healthy`。
- 浏览器能打开 `http://<camera_ip>`。
- `mpv` 能播放 RTSP。
- ODM 手动添加 ONVIF 成功。
- RTSP 流源能通过 `rtsp://<host_ip>:554/<stream>` 播放。
- 摄像头列表状态刷新准确。
- 运行中的摄像头启动按钮禁用，停止/重启可用。
- 矩阵绑定不允许重复占用屏幕。
- 日志页面能读取容器日志。
