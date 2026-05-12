# VirtualWebCam

VirtualWebCam 是一个项目模板，分为两层：

- `container/`：构建通用镜像 `virtualwebcam:latest`。同一镜像支持独立 IP 的 ONVIF 摄像头，也支持共享网关的纯 RTSP 流源。
- `backend/` + `frontend/`：Web 管理后台，用 Node.js、Express、SQLite、Vue3 管理项目、视频源容器、矩阵绑定、资源监控和日志。

## 交付文档

完整文档已整理到 `docs/`：

- [开发技术文档](docs/development-guide.md)
- [部署运维文档](docs/deployment-ops-guide.md)
- [用户使用指南](docs/user-guide.md)

对应 HTML 版本可直接用浏览器打开：

- [开发技术文档 HTML](docs/development-guide.html)
- [部署运维文档 HTML](docs/deployment-ops-guide.html)
- [用户使用指南 HTML](docs/user-guide.html)

## 架构

镜像是通用模板，运行时通过 `OUTPUT_MODE` 决定角色：

- `onvif`：默认模式。一路视频源对应一个 macvlan 独立 IP，对外提供 RTSP + ONVIF + go2rtc Web。
- `rtsp-gateway`：共享 RTSP 网关模式。只启动 MediaMTX，对宿主机映射 `554/tcp`。
- `rtsp-publisher`：纯 RTSP 发布模式。渲染网页并用 FFmpeg 推送到共享 RTSP 网关，不占用独立 IP，不提供 ONVIF。

ONVIF 摄像头容器内部启动：

1. Xvfb 虚拟屏幕
2. openbox 窗口管理器
3. Google Chrome stable 打开目标网页
4. FFmpeg 采集 Xvfb 屏幕并推到内部 MediaMTX
5. go2rtc 从 MediaMTX 拉流并对外提供 RTSP、ONVIF、Web UI

容器内部端口划分：

- MediaMTX：`0.0.0.0:8556`，FFmpeg/go2rtc 在容器内通过 `127.0.0.1:8556` 使用
- go2rtc RTSP：`0.0.0.0:554`
- go2rtc HTTP/ONVIF：`0.0.0.0:80`
- go2rtc WebRTC：`0.0.0.0:8555`

对外地址：

- RTSP：`rtsp://<container_ip>:554/<stream_name>`
- ONVIF：`http://<container_ip>/onvif/device_service`
- go2rtc Web：`http://<container_ip>`

RTSP 流源使用共享网关，对外地址为：

- RTSP：`rtsp://<host_ip>:554/<stream_name>`
- 无 ONVIF 地址
- 无 go2rtc Web 页面

当现场 IP 资源不足时，优先使用 RTSP 流源；当中控必须按 ONVIF 设备或独立 IP 接入时，使用 ONVIF 摄像头。

## 目录

```text
.
├── container/                 # VirtualWebCam 镜像
│   ├── Dockerfile
│   ├── entrypoint.sh
│   └── healthcheck.sh
├── backend/                   # Node.js + Express + SQLite API
│   └── src/
├── frontend/                  # Vue3 + Vite 管理后台
│   └── src/
├── examples/
│   └── multi-camera.compose.yml
├── scripts/
│   └── create-macvlan.sh
└── docker-compose.yml
```

## 构建镜像

```bash
docker compose --profile image build virtualwebcam-image
```

或直接构建：

```bash
docker build -t virtualwebcam:latest ./container
```

## 创建 macvlan 网络

本项目当前按宿主机实际网络 `br0 = 192.168.5.111/24` 配置。默认虚拟摄像头地址池为 `192.168.5.208/28`，可分配 `192.168.5.209-192.168.5.222`。其中 `192.168.5.210` 预留给宿主机侧 `macvlan-host` 辅助接口，建议从 `192.168.5.211` 开始给摄像头使用。

创建 Docker macvlan 网络：

```bash
sudo PARENT_IFACE=br0 \
  SUBNET=192.168.5.0/24 \
  GATEWAY=192.168.5.1 \
  IP_RANGE=192.168.5.208/28 \
  NETWORK_NAME=onvif_macvlan \
  ./scripts/create-macvlan.sh
```

等价手动命令：

```bash
sudo docker network create -d macvlan \
  --subnet=192.168.5.0/24 \
  --ip-range=192.168.5.208/28 \
  --gateway=192.168.5.1 \
  -o parent=br0 \
  onvif_macvlan
```

## 宿主机访问 macvlan 容器

macvlan 的常见限制是宿主机默认不能直接访问同一块物理网卡下的 macvlan 容器。如果只从局域网其他机器或中控访问虚拟摄像头，可以不做这一步；如果要在宿主机本机访问 `192.168.5.211`、`192.168.5.212`，需要创建宿主机侧辅助接口：

```bash
sudo ip link delete macvlan-host 2>/dev/null || true
sudo ip link add macvlan-host link br0 type macvlan mode bridge
sudo ip addr add 192.168.5.210/32 dev macvlan-host
sudo ip link set macvlan-host up
sudo ip route add 192.168.5.208/28 dev macvlan-host
```

也可以使用内置脚本：

```bash
sudo HOST_IF=br0 \
  HOST_MACVLAN_IP=192.168.5.210 \
  ROUTE_CIDR=192.168.5.208/28 \
  ./scripts/setup-macvlan-host.sh
```

如果当前登录用户不能免密 `sudo`，管理后台仍然可以创建和管理 macvlan 摄像头容器；只是宿主机本机无法直接访问 `192.168.5.211` 这类 macvlan 容器 IP。同网段其他设备、中控、ODM 通常可以直接访问。要让宿主机本机也能访问，需要由有 sudo 权限的用户执行上面的辅助接口命令。

这个 all-in-one 镜像里的 MediaMTX 运行在摄像头容器内部，FFmpeg 推到容器内 `127.0.0.1:8556`，go2rtc 再对外输出 `554` 和 `80`。因此不再需要宿主机单独运行 `mediamtx`，也不需要让 go2rtc 从宿主机 `192.168.5.210:554` 拉流。

## 单容器运行

```bash
docker run -d \
  --name web-cam-01 \
  --network onvif_macvlan \
  --ip 192.168.5.211 \
  -e WEB_URL="https://www.baidu.com" \
  -e STREAM_NAME="screen01" \
  -e WIDTH=1280 \
  -e HEIGHT=720 \
  -e FPS=15 \
  virtualwebcam:latest
```

验证：

```bash
docker logs --tail=80 web-cam-01
docker inspect -f '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}' web-cam-01
```

同网段其他机器或中控可访问：

```text
RTSP:  rtsp://192.168.5.211:554/screen01
ONVIF: http://192.168.5.211/onvif/device_service
Web:   http://192.168.5.211
```

## 启动管理后台

管理后台通过 Docker socket 创建、启动、停止和删除摄像头容器。

```bash
docker compose up -d --build manager-backend manager-frontend
```

开发模式：

```bash
cd backend
PORT=8177 \
DOCKER_NETWORK=onvif_macvlan \
VIRTUALWEBCAM_IMAGE=virtualwebcam:latest \
CAMERA_RTSP_PORT=554 \
RTSP_GATEWAY_HOST=192.168.5.111 \
RTSP_GATEWAY_PORT=554 \
npm run dev

cd ../frontend
npm run dev -- --port 5177
```

访问：

```text
http://<host_ip>:5177
```

后台 API 默认监听：

```text
http://<host_ip>:8177/api
```

管理后台内置简单登录与项目授权：

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123456
SESSION_SECRET=change-this-session-secret
```

首次启动时如果 `users` 表为空，系统会创建默认管理员。生产环境必须修改 `ADMIN_PASSWORD` 和 `SESSION_SECRET`。管理员登录后可在系统级“用户管理”页面创建登录人员，并把项目资源授权为“仅查看”或“可操作”；普通用户登录后只能看到被授权项目。

`API_TOKEN` 仍保留为自动化脚本或内网网关调用的服务令牌。配置后，后端会继续接受 `X-API-Token` 或 `Authorization: Bearer <token>`，并按系统管理员权限处理。

生产环境建议继续放到公司内网认证网关后面，避免直接暴露挂载了 Docker socket 的管理后台。

## 多项目与屏幕矩阵映射

管理后台支持多个项目。每个项目都有独立的矩阵规格，例如总部项目可以是 `6 x 8`，门店项目可以是 `2 x 8`。每一路摄像头可以绑定一块屏，也可以绑定连续的合并区域，用于现场快速判断：

- 哪块屏正在显示哪一路网页摄像头
- 哪一路摄像头投向了哪些屏幕
- 哪些相邻屏幕被合并给同一路摄像头使用

页面入口按层级拆分为登录页、项目列表、系统级用户管理和项目内功能页。`用户管理` 用于管理员维护登录人员，并给登录人员分配可访问项目；进入项目后，`摄像头管理` 用于创建、编辑、复制、批量生成、启动、停止、重启、删除和查看日志；`矩阵绑定` 用于维护摄像头和矩阵屏幕的映射关系；`项目设置` 用于调整项目矩阵；`操作审计` 用于查看关键变更记录。

矩阵绑定页支持直接在屏幕矩阵上拖拽框选连续矩形区域，形成类似电子围栏的合并区域；没有框选时，每块屏幕就是一个单屏区域。把左侧未绑定摄像头源拖到围栏或单屏区域内即可完成绑定。绑定后该摄像头会从未绑定列表移除；一个屏幕槽位同一时间只允许被一路摄像头占用。

绑定关系只作为管理元数据保存，不改变视频源输出地址；真实投屏或中控接入仍然使用列表中生成的 RTSP 地址，ONVIF 摄像头还可以使用 ONVIF 地址。

## 管理后台能力

- 项目管理：创建不同矩阵规格的项目，导出项目配置 JSON，也可以把导出的 JSON 导入为新项目。
- 摄像头录入：单路创建会尝试启动容器；批量生成只写入配置，默认 `stopped`，适合先录入几十路摄像头。
- 视频源类型：支持 ONVIF 摄像头和 RTSP 流源。ONVIF 摄像头需要独立 IP；RTSP 流源使用共享网关和不同流路径。
- 摄像头列表：支持搜索名称、IP、流名、网页 URL、RTSP、ONVIF 和投放屏幕，支持按运行状态筛选。
- 列表字段：默认精简显示名称、IP、网页 URL、状态和操作；用户可手动显示资源、投放屏幕、RTSP、ONVIF 等长字段。
- 概览统计：显示总数、运行中、已停止、异常、已绑定和未绑定数量，点击统计卡片可联动筛选。
- 批量运维：勾选摄像头后可批量启动、停止和重启；表头全选只作用于当前筛选结果。
- 状态刷新：可只刷新摄像头运行状态，避免每次都重新加载完整列表。
- 资源监控：按项目显示 CPU、内存、网络和磁盘读写；每路视频源也显示单路资源消耗。
- 矩阵绑定：支持鼠标框选连续矩形区域，围栏内绑定一路摄像头；未框选时每块屏幕就是独立区域。
- 操作审计：记录项目创建/修改/导入、矩阵修改、摄像头创建/批量创建/编辑/绑定/启动/停止/重启/删除等关键动作。

## API

- `GET /api/cameras`：摄像头列表
- `GET /api/cameras/statuses?project_id=1`：只同步并返回摄像头状态，用于轻量刷新
- `GET /api/resource-stats?project_id=1`：采集视频源容器 CPU、内存、网络和磁盘读写
- `GET /api/health`：管理后台、Docker socket、macvlan 网络、镜像状态
- `POST /api/auth/login`：用户名密码登录，返回会话令牌
- `GET /api/auth/me`：当前登录人信息
- `GET /api/users` / `POST /api/users` / `PUT /api/users/:id`：管理员维护系统登录人员
- `GET /api/users/:id/projects` / `PUT /api/users/:id/projects`：管理员维护某个登录人的项目资源授权
- `GET /api/projects`：项目列表，普通用户只返回授权项目
- `POST /api/projects`：创建项目
- `GET /api/projects/:id/export`：导出项目配置 JSON，包含项目、摄像头、绑定、RTSP 地址，以及 ONVIF 摄像头的 ONVIF 地址
- `POST /api/projects/import`：导入项目配置 JSON 为新项目，IP 冲突时自动重映射到同网段可用地址
- `PUT /api/projects/:id`：更新项目名称和矩阵规格
- `GET /api/audit-logs?project_id=1`：查询项目操作审计日志
- `GET /api/screen-matrix?project_id=1`：指定项目的屏幕矩阵配置
- `PUT /api/screen-matrix?project_id=1`：更新指定项目的屏幕矩阵
- `POST /api/cameras`：创建并启动一路视频源容器
- `POST /api/cameras/bulk?project_id=1`：批量生成摄像头配置，不启动容器
- `PUT /api/cameras/:id`：编辑摄像头名称、IP、网页 URL、流名称、分辨率和 FPS；运行中的摄像头会尝试重建容器使配置生效
- `PATCH /api/cameras/:id/display-targets`：更新摄像头投放到哪些屏幕，可携带 `display_region` 表示连续合并区域
- `POST /api/cameras/:id/start`：启动
- `POST /api/cameras/:id/stop`：停止
- `POST /api/cameras/:id/restart`：重启
- `DELETE /api/cameras/:id`：删除数据库记录和容器
- `GET /api/cameras/:id/logs`：读取容器日志

关键操作会写入 `audit_logs` 表。日志接口默认最多返回最近 80 条，可通过 `limit` 调整，最大 300 条。

创建 ONVIF 摄像头请求示例：

```bash
curl -X POST http://localhost:8177/api/cameras \
  -H 'Content-Type: application/json' \
  -d '{
    "source_type": "camera",
    "name": "web-cam-01",
    "ip": "192.168.5.211",
    "stream_name": "screen01",
    "web_url": "https://www.baidu.com",
    "width": 1280,
    "height": 720,
    "fps": 15
  }'
```

创建共享 RTSP 流源请求示例：

```bash
curl -X POST 'http://localhost:8177/api/cameras?project_id=1' \
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

RTSP 流源创建成功后会自动启动共享网关容器 `virtualwebcam-rtsp-gateway`，输出地址类似：

```text
rtsp://192.168.5.111:554/screen01
```

## 验证口径

本项目当前验证重点：

- Docker macvlan：`onvif_macvlan`，`192.168.5.0/24`，`ip-range=192.168.5.208/28`，`parent=br0`
- 镜像：`virtualwebcam:latest`
- 管理后台健康检查：Docker socket 可访问、macvlan 网络存在、镜像存在
- ONVIF 摄像头：`rtsp://192.168.5.211:554/screen01`、`http://192.168.5.211/onvif/device_service`
- RTSP 流源：`rtsp://192.168.5.111:554/<stream_name>`
- 播放器验收：推荐复制页面内的 mpv 测试命令，格式为 `mpv --rtsp-transport=tcp <rtsp_url>`
- ffprobe 验收：RTSP 返回 H.264 视频流
- ODM 验收：ONVIF 手动添加成功即可，自动发现不作为核心验收项

## 演示数据

没有 Docker 环境时，也可以先灌入演示摄像头记录用于验收前端列表、日志抽屉、复制按钮和地址展示：

```bash
./scripts/seed-demo-cameras.sh
```

默认请求 `http://127.0.0.1:8177/api`。如果后端不在本机：

```bash
API_BASE=http://<host_ip>:8177/api ./scripts/seed-demo-cameras.sh
```

没有 Docker 时，这些记录状态会显示为 `异常`，这是预期行为；有 Docker、macvlan 网络和镜像后再启动即可变成真实容器实例。

演示脚本只创建项目和摄像头源，不预置屏幕绑定，方便在页面中自行拖拽验收矩阵映射。

## SQLite 数据库

后端使用 `better-sqlite3` 直接读写 SQLite 文件，默认路径是 `backend/data/virtualwebcam.db`，容器部署时映射到 `/data/virtualwebcam.db`。`backend/src/db.js` 初始化 `cameras` 表：

```sql
CREATE TABLE IF NOT EXISTS cameras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ip TEXT UNIQUE,
  source_type TEXT DEFAULT 'camera' CHECK (source_type IN ('camera', 'rtsp')),
  stream_name TEXT,
  web_url TEXT,
  width INTEGER DEFAULT 1280,
  height INTEGER DEFAULT 720,
  fps INTEGER DEFAULT 15,
  display_targets TEXT DEFAULT '[]',
  display_region TEXT DEFAULT NULL,
  project_id INTEGER DEFAULT 1,
  status TEXT DEFAULT 'stopped' CHECK (status IN ('running', 'stopped', 'error')),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## 多路 compose 示例

不经过管理后台，也可以用示例文件直接启动多路容器：

```bash
docker compose -f examples/multi-camera.compose.yml up -d
```

## 运行约束

- 宿主机必须能访问 Docker daemon。
- 管理后台容器挂载 `/var/run/docker.sock`，只建议放在可信内网；上线前必须修改默认管理员密码和 `SESSION_SECRET`，并按项目授权普通用户。
- 摄像头容器使用 macvlan 固定 IP 时，IP 不要和局域网内现有设备冲突。
- go2rtc ONVIF 服务对 RTSP 使用 TCP 传输。
