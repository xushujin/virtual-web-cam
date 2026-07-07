# VirtualWebCam 详细部署文档

版本：1.0  
适用对象：实施工程师、运维工程师、客户现场管理员  
部署方式：Docker Compose + Docker macvlan  
管理端口：前端 `9528`，后端 `8177`  
视频端口：RTSP `554/tcp`，ONVIF HTTP `80/tcp`

## 1. 系统说明

VirtualWebCam 用于把网页渲染成视频源，并通过管理后台统一创建、启停、删除、查看日志、复制地址和绑定矩阵屏幕。

项目分为两层：

- 容器模板：`virtualwebcam:latest`，内部运行 Xvfb、openbox、Google Chrome、FFmpeg、MediaMTX、go2rtc。
- 管理后台：Node.js + Express + SQLite + Vue3，通过 Docker socket 管理视频源容器。

系统支持两种视频源：

| 类型 | 网络模型 | 对外能力 | 适用场景 |
| --- | --- | --- | --- |
| ONVIF 摄像头 | 每路一个 macvlan 独立 IP | RTSP + ONVIF + go2rtc Web | 中控按摄像头 IP 或 ONVIF 接入 |
| RTSP 流源 | 多路共享宿主机 IP | RTSP | 现场 IP 地址不足，或中控支持直接 RTSP |

ONVIF 摄像头地址示例：

```text
RTSP:  rtsp://192.168.5.200:554/screen01
ONVIF: http://192.168.5.200/onvif/device_service
Web:   http://192.168.5.200
```

RTSP 流源地址示例：

```text
RTSP: rtsp://192.168.5.198:554/screen01
```

## 2. 现场规划

### 2.1 确认客户主机网络

执行：

```bash
ip -4 addr
ip route | grep default
```

记录以下信息：

```text
主网卡或桥接接口：br0
客户主机 IP：192.168.5.198
网段：192.168.5.0/24
网关：192.168.5.1
```

如果客户主机使用 `ens33`、`eno1`、`bond0` 等接口，后续命令中的 `br0` 要替换成真实接口。

### 2.2 规划 ONVIF 摄像头 IP 池

ONVIF 摄像头需要独立 IP。建议从客户网络里划出一段不被 DHCP 分配的地址池。

示例：

```text
客户网段：192.168.5.0/24
宿主机 IP：192.168.5.198
虚拟摄像头地址池：192.168.5.192/26
CIDR 实际主机范围：192.168.5.193 - 192.168.5.254
业务预留地址：192.168.5.200 - 192.168.5.240
宿主机 macvlan 辅助 IP：192.168.5.199
摄像头起始 IP：192.168.5.200
```

注意：

- 地址池不能和路由器 DHCP、真实摄像头、中控、大屏控制器、服务器等冲突。
- `HOST_MACVLAN_IP` 必须使用同网段未被占用的辅助 IP，不能分配给摄像头容器。
- 摄像头从业务预留段开始分配，例如 `.200`，便于现场识别。
- 如果客户现场 IP 不足，优先使用 RTSP 流源。

### 2.3 规划端口

| 端口 | 所属 | 说明 |
| --- | --- | --- |
| `9528/tcp` | 管理前端 | 浏览器访问入口 |
| `8177/tcp` | 管理后端 | API，建议只内网访问 |
| `554/tcp` | ONVIF 摄像头容器 | 每个独立 IP 内部监听，不占宿主机端口 |
| `80/tcp` | ONVIF 摄像头容器 | go2rtc Web 和 ONVIF 手动添加入口 |
| `554/tcp` | RTSP 共享网关 | 创建 RTSP 流源时映射到宿主机 |
| `3702/udp` | go2rtc | ONVIF WS-Discovery，自动发现不作为核心验收项 |

生产环境不要把 `8177` 和 Docker socket 暴露到公网。

## 3. 部署前检查

### 3.0 Ubuntu 26.04 推荐部署脚本

客户电脑已经安装 Ubuntu 26.04 时，优先使用根目录脚本：

```bash
chmod +x ubuntu26.04-deploy.sh
./ubuntu26.04-deploy.sh
```

该脚本不是旧手工流程的简单封装，而是按当前软件真实运行方式部署：

- 管理后台通过 Docker Compose 启动 `manager-backend` 和 `manager-frontend`。
- 后端挂载 `/var/run/docker.sock`，后续由后台创建、启动、停止和删除视频源容器。
- ONVIF 摄像头使用 `onvif_macvlan`，每路一个独立 IP，对外提供 `80/tcp` 和 `554/tcp`。
- RTSP 流源不占独立 IP，由后台按需创建共享 RTSP 网关容器，并通过 `rtsp://<宿主机IP>:554/<stream_name>` 区分多路。
- 容器模板统一构建为 `virtualwebcam:latest`，内部 FFmpeg 推流不再使用 `-tune zerolatency`。
- 检测到已有 SQLite 数据库时会先备份；如需清理测试数据重新部署，使用 `--clean-data`；如需明确保留现有数据，使用 `--keep-data`。

无人值守部署示例：

```bash
./ubuntu26.04-deploy.sh --yes \
  --host-if br0 \
  --host-ip 192.168.5.198 \
  --subnet 192.168.5.0/24 \
  --gateway 192.168.5.1 \
  --ip-range 192.168.5.192/26 \
  --host-macvlan-ip 192.168.5.199
```

脚本完成后会输出管理后台地址、管理员账号、建议第一路 ONVIF 摄像头 IP、ONVIF/RTSP 验收命令。

### 3.1 Docker

```bash
docker version
docker ps
```

如果当前用户不能访问 Docker：

```bash
sudo usermod -aG docker "$USER"
```

退出终端重新登录后再次执行：

```bash
docker ps
```

### 3.2 端口占用

```bash
ss -ltnp | grep -E ':(9528|8177|554)\b' || true
```

如果 `554` 已被其他服务占用：

- 不影响 ONVIF 摄像头独立 IP 模式。
- 会影响 RTSP 流源共享网关模式，需要释放 `554` 或修改 `RTSP_GATEWAY_PORT`。

### 3.3 项目文件

确认项目根目录存在：

```bash
ls
```

应包含：

```text
container/
backend/
frontend/
docs/
scripts/
docker-compose.yml
.env.example
```

## 4. 配置 `.env`

复制配置：

```bash
cp .env.example .env
```

按客户现场修改 `.env`。以下是当前验证环境示例：

```env
DOCKER_NETWORK=onvif_macvlan
VIRTUALWEBCAM_IMAGE=virtualwebcam:latest
CONTAINER_PREFIX=virtualwebcam
CAMERA_RTSP_PORT=554
RTSP_GATEWAY_HOST=192.168.5.198
RTSP_GATEWAY_PORT=554
RTSP_NETWORK=virtualwebcam_rtsp
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-strong-password
SESSION_SECRET=replace-with-long-random-secret
BACKEND_PORT=8177
FRONTEND_PORT=9528
HOST_IF=br0
SUBNET=192.168.5.0/24
GATEWAY=192.168.5.1
IP_RANGE=192.168.5.192/26
HOST_MACVLAN_IP=192.168.5.199
ROUTE_CIDR=192.168.5.192/26
```

生成随机 `SESSION_SECRET`：

```bash
openssl rand -hex 32
```

建议上线前修改管理员默认密码。后续也可以登录系统后在右上角修改密码。

## 5. 创建 Docker macvlan 网络

macvlan 网络在宿主机 Docker 上创建，用于给每个 ONVIF 摄像头容器分配局域网独立 IP。

### 5.1 脚本方式

```bash
sudo PARENT_IFACE=br0 \
  SUBNET=192.168.5.0/24 \
  GATEWAY=192.168.5.1 \
  IP_RANGE=192.168.5.192/26 \
  NETWORK_NAME=onvif_macvlan \
  ./scripts/create-macvlan.sh
```

### 5.2 手动方式

```bash
sudo docker network create -d macvlan \
  --subnet=192.168.5.0/24 \
  --ip-range=192.168.5.192/26 \
  --gateway=192.168.5.1 \
  -o parent=br0 \
  onvif_macvlan
```

### 5.3 检查

```bash
docker network inspect onvif_macvlan
```

确认：

```text
Driver: macvlan
Subnet: 192.168.5.0/24
IPRange: 192.168.5.192/26
Gateway: 192.168.5.1
Parent: br0
```

如果网络已经存在但参数不对，需要先停止并删除挂在旧网络上的摄像头容器，再删除旧网络重建。

## 6. 配置宿主机 macvlan 辅助接口

macvlan 的常见限制：宿主机默认不能直接访问同一宿主机上的 macvlan 容器 IP。局域网其他机器通常可以访问。

如果需要在客户主机本机访问：

```text
http://192.168.5.200
rtsp://192.168.5.200:554/screen01
```

执行：

```bash
sudo HOST_IF=br0 \
  HOST_MACVLAN_IP=192.168.5.199 \
  ROUTE_CIDR=192.168.5.192/26 \
  ./scripts/setup-macvlan-host.sh
```

手动命令：

```bash
sudo ip link delete macvlan-host 2>/dev/null || true
sudo ip link add macvlan-host link br0 type macvlan mode bridge
sudo ip addr add 192.168.5.199/32 dev macvlan-host
sudo ip link set macvlan-host up
sudo ip route replace 192.168.5.192/26 dev macvlan-host
```

检查：

```bash
ip addr show macvlan-host
ip route | grep 192.168.5.192
```

## 7. 配置开机恢复辅助接口

辅助接口重启后会丢失。生产环境建议创建 systemd 服务。

创建文件：

```bash
sudo vi /etc/systemd/system/virtualwebcam-macvlan-host.service
```

写入：

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

把 `WorkingDirectory` 和 `ExecStart` 中的项目路径改成客户主机真实路径。

启用：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now virtualwebcam-macvlan-host.service
sudo systemctl status virtualwebcam-macvlan-host.service
```

## 8. 构建镜像

构建通用容器模板：

```bash
docker compose --profile image build virtualwebcam-image
```

或直接构建：

```bash
docker build -t virtualwebcam:latest ./container
```

检查镜像：

```bash
docker images | grep virtualwebcam
docker image inspect virtualwebcam:latest >/dev/null && echo ok
```

说明：

- `virtualwebcam:latest` 是通用镜像。
- 换客户网段不需要重新构建镜像。
- 修改 FFmpeg 参数、容器端口、entrypoint 脚本后需要重新构建镜像。

## 9. 启动管理后台

```bash
docker compose up -d --build manager-backend manager-frontend
```

检查：

```bash
docker compose ps
TOKEN="$(curl -s -X POST http://localhost:8177/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"<.env 中的 ADMIN_PASSWORD>"}' \
  | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')"
curl -H "Authorization: Bearer ${TOKEN}" http://localhost:8177/api/health
```

访问：

```text
http://localhost:9528
http://192.168.5.198:9528
```

如果管理后台打不开：

```bash
docker logs --tail=100 virtualwebcam-manager-backend
docker logs --tail=100 virtualwebcam-manager-frontend
ss -ltnp | grep -E ':(9528|8177)\b' || true
```

## 10. 登录和权限

默认管理员来自 `.env`：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-strong-password
```

首次启动且数据库没有用户时，系统会自动创建管理员。

管理员能力：

- 创建项目。
- 进入项目管理视频源和矩阵绑定。
- 维护大屏地址库。
- 系统级用户管理。
- 系统级数据库备份管理。
- 给用户授权项目。
- 修改密码。

普通用户只能看到授权给自己的项目。项目授权分为：

- 仅查看：查看项目、视频源、地址、日志、矩阵绑定。
- 可操作：可以启停容器、编辑视频源、绑定矩阵、维护项目配置。

## 11. 创建项目

登录后在项目入口创建项目：

```text
项目名称：默认项目
矩阵行数：6
矩阵列数：8
屏幕前缀：屏
```

进入项目后有主要入口：

- 摄像头管理：管理 ONVIF 摄像头和 RTSP 流源。
- 矩阵绑定：用围栏方式圈选屏幕区域，并把视频源绑定到区域。
- 项目设置：维护项目矩阵规格，导入导出项目配置。
- 操作审计：查看关键操作记录。

## 12. 维护大屏地址

项目内“大屏地址”页面维护大屏地址库。建议提前录入业务网页地址，例如：

```text
名称：大厅信息屏
URL：https://example.com/screen/lobby
备注：一楼大厅
```

新增视频源时，网页 URL 可以：

- 手动输入。
- 搜索选择已维护的大屏地址。

如果大屏地址很多，使用搜索框按名称、URL、备注筛选后选择。

大屏地址页支持独立 CSV 导入导出，适合现场批量维护地址库。CSV 列为：

```csv
name,url,remark
大厅信息屏,https://example.com/screen/lobby,一楼大厅
```

导入 CSV 会把记录新增到当前项目；项目配置 JSON 导入导出仍在“项目设置”中处理，二者互不混用。

## 13. 创建 ONVIF 摄像头

进入项目 -> 摄像头管理 -> 新增源：

```text
源类型：ONVIF 摄像头（独立 IP）
名称：web-cam-01
虚拟 IP：192.168.5.200
网页 URL：https://example.com/screen/lobby
宽度：1280
高度：720
FPS：15
```

流名称由系统自动生成，用于 RTSP 路径和 ONVIF Profile，新增时用户不需要填写。

创建后，后端会通过 Docker 创建容器，容器启动流程为：

```text
Xvfb -> openbox -> Chrome -> FFmpeg -> MediaMTX -> go2rtc
```

对外地址：

```text
RTSP：rtsp://192.168.5.200:554/screen01
ONVIF：http://192.168.5.200/onvif/device_service
go2rtc：http://192.168.5.200
```

推荐验收：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.200:554/screen01
```

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

## 14. 创建 RTSP 流源

当客户现场 IP 不足，或者系统只需要 RTSP 地址时，创建 RTSP 流源。

进入项目 -> 摄像头管理 -> 新增源：

```text
源类型：RTSP 流源（共享 IP + 流路径）
名称：rtsp-screen-01
网页 URL：https://example.com/screen/lobby
宽度：1280
高度：720
FPS：15
```

流名称由系统自动生成，并会避免和已有 RTSP 流源冲突。

系统会自动创建或复用共享网关容器：

```text
virtualwebcam-rtsp-gateway
```

对外地址：

```text
rtsp://192.168.5.198:554/screen01
```

验收：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.198:554/screen01
```

RTSP 流源不提供 ONVIF，不占用独立摄像头 IP。

## 15. 矩阵绑定

进入项目 -> 矩阵绑定。

推荐操作：

1. 从左侧拖拽未绑定视频源到屏幕区域。
2. 单屏投放时，直接绑定到一个屏幕。
3. 多屏合并展示时，用鼠标在矩阵上拖拽画矩形围栏。
4. 把视频源绑定到围栏区域。
5. 围栏内会显示视频源名称、地址、流名称和覆盖屏幕。

已经绑定到矩阵围栏的视频源可以直接点击打开编辑窗口，快速修改视频源名称和网页 URL。围栏内的打开按钮会打开该视频源配置的网页 URL，便于现场核对大屏页面。

没有画围栏的屏幕默认是单屏区域。围栏表示一组屏幕合并展示，类似电子围栏。

## 16. 状态和资源监控

摄像头列表会展示：

- 状态：运行中、已停止、异常。
- RTSP、ONVIF 地址。

开启列表“资源”字段后，摄像头列表还会展示：

- CPU 使用率。
- 内存使用量。
- 网络上行/下行速率。
- 磁盘读写速率。

资源监控默认折叠为一行摘要，仍会自动刷新；需要查看 CPU、内存、网络和磁盘读写详情时点击“展开”。

状态以 Docker 容器状态为准：

```text
running -> 运行中
exited 0 -> 已停止
exited 非 0 / dead -> 异常
missing -> 已停止
```

CPU 百分比来自 Docker stats 的容器 CPU 统计，不等同于 `top` 里单进程显示值。多核机器上，Docker 的容器 CPU 百分比可能按核数归一化，适合做容量趋势参考。

## 17. 常用命令

### 17.1 管理后台

```bash
docker compose ps
docker logs --tail=200 virtualwebcam-manager-backend
docker logs --tail=200 virtualwebcam-manager-frontend
docker compose restart manager-backend manager-frontend
```

### 17.2 视频源容器

```bash
docker ps --filter label=virtualwebcam.managed=true
docker logs --tail=300 <容器名>
docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' <容器名>
```

### 17.3 RTSP 网关

```bash
docker ps --filter label=virtualwebcam.rtspGateway=true
docker logs --tail=200 virtualwebcam-rtsp-gateway
```

### 17.4 播放测试

ONVIF 摄像头：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.200:554/screen01
```

RTSP 流源：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.198:554/screen01
```

也可以使用：

```bash
ffplay -rtsp_transport tcp rtsp://192.168.5.200:554/screen01
```

修改网页 URL 或重启容器后，建议关闭播放器重新打开，避免播放器缓存历史帧造成误判。

## 18. 备份和恢复

### 18.1 SQLite 数据库位置

Docker Compose 部署默认数据库：

```text
backend/data/virtualwebcam.db
```

管理后台的系统级“备份管理”页面只对系统管理员可见。该页面调用后端 SQLite backup API，默认备份目录为后端容器内 `/data/backups`，在 Docker Compose 部署下对应宿主机 `backend/data/backups`。

### 18.2 网页备份和恢复

推荐优先使用管理后台：

1. 首页点击“备份管理”。
2. 设置备份路径，默认 `/data/backups`。
3. 按需启用定时备份，频率支持每小时、每天、每周、每月。
4. 点击“立即备份”生成 `.db` 备份文件。
5. 需要恢复时，输入确认词 `RESTORE`，选择备份文件后点击“恢复数据”。

恢复前后端会自动先备份当前数据库；上传恢复会先对上传的 SQLite 文件执行 `quick_check` 校验。

### 18.3 手工备份

```bash
mkdir -p backups
sqlite3 backend/data/virtualwebcam.db ".backup 'backups/virtualwebcam-$(date +%F-%H%M%S).db'"
```

如果客户主机没有 `sqlite3`：

```bash
mkdir -p backups
cp backend/data/virtualwebcam.db "backups/virtualwebcam-$(date +%F-%H%M%S).db"
cp backend/data/virtualwebcam.db-wal backups/ 2>/dev/null || true
cp backend/data/virtualwebcam.db-shm backups/ 2>/dev/null || true
```

### 18.4 手工恢复

```bash
docker compose stop manager-backend
cp backups/virtualwebcam-xxxx.db backend/data/virtualwebcam.db
docker compose start manager-backend
```

### 18.5 项目导入导出

项目入口支持配置导入导出。导出内容包含：

- 项目基本信息。
- 矩阵规格。
- 视频源配置。
- 大屏地址库。
- 矩阵绑定关系。
- RTSP / ONVIF 地址。

导入时如果 ONVIF 摄像头 IP 冲突，系统会在同网段自动寻找可用 IP 并返回重映射信息；RTSP 流名冲突时会自动改名。

## 19. 升级

### 19.1 升级前备份

```bash
docker compose ps
docker ps --filter label=virtualwebcam.managed=true
mkdir -p backups
sqlite3 backend/data/virtualwebcam.db ".backup 'backups/pre-upgrade-$(date +%F-%H%M%S).db'"
```

### 19.2 升级管理后台

```bash
chmod +x ubuntu26.04-deploy.sh
./ubuntu26.04-deploy.sh --yes --keep-data --frontend-port 9528
```

如果旧版本目录里没有 `.env`，或者需要重新指定现场网络参数，应补全 `--host-if`、`--host-ip`、`--subnet`、`--gateway`、`--ip-range`、`--host-macvlan-ip` 等部署参数。

### 19.3 升级容器模板

如果修改了 `container/`：

```bash
docker compose --profile image build virtualwebcam-image
```

本版本创建的视频源容器不会随 Docker 开机自启动。旧版本已经创建的摄像头容器可能仍保留旧自启动策略，升级后建议执行一次：

```bash
docker ps -aq --filter "label=virtualwebcam.cameraId" | xargs -r docker update --restart=no
```

如果希望旧视频源也完全使用新镜像，可以在业务允许中断时删除旧摄像头容器。数据库中的视频源配置会保留，后续在管理后台点击启动时会按新镜像重新创建容器：

```bash
docker ps -aq --filter "label=virtualwebcam.cameraId" | xargs -r docker rm -f
```

## 20. 更换网络环境

假设客户从 `192.168.5.0/24` 迁移到 `192.168.9.0/24`：

```text
旧宿主机 IP：192.168.5.198
新宿主机 IP：192.168.9.198
旧地址池：192.168.5.192/26
新地址池：192.168.9.192/26
```

不需要重建 `virtualwebcam:latest` 镜像。需要改的是：

- `.env` 中的网络参数。
- Docker macvlan 网络。
- 宿主机 macvlan 辅助接口。
- 管理后台里 ONVIF 摄像头的虚拟 IP。
- RTSP 流源的 `RTSP_GATEWAY_HOST`。

执行步骤：

```bash
docker ps -aq --filter label=virtualwebcam.managed=true | xargs -r docker rm -f
docker network rm onvif_macvlan 2>/dev/null || true
```

重建 macvlan：

```bash
sudo PARENT_IFACE=br0 \
  SUBNET=192.168.9.0/24 \
  GATEWAY=192.168.9.1 \
  IP_RANGE=192.168.9.192/26 \
  NETWORK_NAME=onvif_macvlan \
  ./scripts/create-macvlan.sh
```

重建辅助接口：

```bash
sudo HOST_IF=br0 \
  HOST_MACVLAN_IP=192.168.9.199 \
  ROUTE_CIDR=192.168.9.192/26 \
  ./scripts/setup-macvlan-host.sh
```

更新 `.env`：

```env
RTSP_GATEWAY_HOST=192.168.9.198
SUBNET=192.168.9.0/24
GATEWAY=192.168.9.1
IP_RANGE=192.168.9.192/26
HOST_MACVLAN_IP=192.168.9.199
ROUTE_CIDR=192.168.9.192/26
```

重启管理后台：

```bash
docker compose up -d --build manager-backend manager-frontend
```

进入后台，把 ONVIF 摄像头 IP 从旧网段改成新网段，例如：

```text
192.168.5.200 -> 192.168.9.200
```

然后启动视频源并验证：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.9.200:554/screen01
```

## 21. 安全建议

管理后台挂载 Docker socket，权限很高。生产环境必须注意：

- 只部署在客户内网。
- 不开放 `8177` 到公网。
- 修改默认管理员密码。
- 修改 `SESSION_SECRET`。
- 给普通用户按项目授权。
- 不把 `API_TOKEN` 写进浏览器或前端代码。
- 尽量放在公司统一认证网关或 VPN 后面。
- 定期备份 SQLite。

如果需要自动化脚本调用 API，可配置 `API_TOKEN`，请求头使用：

```text
X-API-Token: <token>
```

或：

```text
Authorization: Bearer <token>
```

服务令牌按系统管理员权限处理，必须妥善保管。

## 22. 故障处理

### 22.1 管理后台提示无法访问 Docker socket

检查：

```bash
docker ps
docker compose logs --tail=100 manager-backend
ls -l /var/run/docker.sock
```

处理：

- 确认 Docker 正在运行。
- 确认 `docker-compose.yml` 挂载了 `/var/run/docker.sock:/var/run/docker.sock`。
- 确认当前用户能访问 Docker。

### 22.2 ONVIF 摄像头容器反复重启

查看日志：

```bash
docker logs --tail=300 <容器名>
```

重点看：

- Chrome 是否能启动。
- 网页是否可访问。
- FFmpeg 是否推流成功。
- MediaMTX/go2rtc 是否监听成功。

如果网页在客户主机网络里访问很慢或无法访问，容器里 Chrome 也会显示错误页。先确认客户主机本身能打开该 URL。

### 22.3 宿主机打不开 `http://192.168.5.200`

检查辅助接口：

```bash
ip addr show macvlan-host
ip route | grep 192.168.5.192
```

如果没有，重新执行：

```bash
sudo HOST_IF=br0 HOST_MACVLAN_IP=192.168.5.199 ROUTE_CIDR=192.168.5.192/26 ./scripts/setup-macvlan-host.sh
```

### 22.4 局域网其他设备打不开摄像头 IP

检查：

```bash
docker inspect <容器名> | grep -A8 onvif_macvlan
docker network inspect onvif_macvlan
```

排查：

- 摄像头 IP 是否和其他设备冲突。
- macvlan `parent` 是否是正确网卡。
- 交换机或网络策略是否限制 macvlan/MAC。
- 客户端是否和虚拟摄像头在同一可达网段。

### 22.5 RTSP 流源无法播放

检查共享网关：

```bash
docker ps --filter label=virtualwebcam.rtspGateway=true
docker logs --tail=200 virtualwebcam-rtsp-gateway
ss -ltnp | grep ':554' || true
```

检查发布器：

```bash
docker ps --filter label=virtualwebcam.managed=true
docker logs --tail=200 <RTSP发布器容器名>
```

常见原因：

- `554` 端口被占用。
- `.env` 里的 `RTSP_GATEWAY_HOST` 不是客户主机真实 IP。
- 流名称重复或客户端播放的是旧地址。

### 22.6 ONVIF Device Manager 搜不到设备

自动发现依赖 UDP 3702、组播、交换机和客户端实现。当前核心验收项是手动添加：

```text
http://192.168.5.200/onvif/device_service
```

只要手动添加后能看到 Profile 和 Live Video，即认为 ONVIF 接入链路可用。

### 22.7 修改网页地址后播放器还是旧画面

修改 URL 后容器会重建或重启，但部分播放器会保留旧连接或历史帧。关闭播放器重新打开：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.200:554/screen01
```

## 23. 交付验收清单

部署完成后建议逐项确认：

- `docker compose ps` 中管理后台正常。
- 使用登录令牌访问 `GET /api/health` 正常，返回 Docker、网络和镜像状态。
- 浏览器能打开 `http://客户主机IP:9528`。
- 管理员可登录。
- 可创建项目。
- 可创建 ONVIF 摄像头并播放 RTSP。
- ONVIF Device Manager 可手动添加并看到 Live Video。
- 可创建 RTSP 流源并播放 RTSP。
- 可查看容器日志。
- 可复制 RTSP、ONVIF、mpv 命令。
- 摄像头列表状态、资源监控正常刷新。
- 大屏地址 CSV 可导入导出。
- 矩阵绑定可拖拽和画围栏。
- 普通用户只能看到授权项目。
- SQLite 已做初始备份。
- 如需宿主机本机访问 macvlan 容器，systemd 辅助接口已配置并重启验证。
