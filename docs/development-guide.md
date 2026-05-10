# VirtualWebCam 开发技术文档

版本：1.0  
适用项目：VirtualWebCam 网页转 RTSP + 虚拟 ONVIF 摄像头管理系统  
默认端口：前端 `5177`，后端 `8177`  
默认网络：`br0 = 192.168.5.111/24`，macvlan 网络 `onvif_macvlan`

## 1. 项目目标

VirtualWebCam 的目标是把任意可被 Chrome 渲染的网页转换为一路标准视频源，并让这一路视频源像真实网络摄像头一样被中控、ONVIF Device Manager 或播放器接入。

系统分为两层：

- 容器模板：构建 `virtualwebcam:latest` 镜像。一个容器对应一路虚拟摄像头，容器内部完成网页渲染、屏幕采集、RTSP 推流、ONVIF 输出。
- 管理后台：Node.js + Express + SQLite + Vue3。负责项目管理、摄像头实例管理、Docker 容器生命周期、矩阵屏幕绑定、日志和审计。

核心交付能力：

- 用户通过网页创建虚拟摄像头，不需要手写 Xvfb、Chrome、FFmpeg、MediaMTX、go2rtc 命令。
- 每一路摄像头拥有独立 IP，便于中控按 IP 区分摄像头。
- 输出地址稳定：
  - RTSP：`rtsp://<camera_ip>:8554/<stream_name>`
  - ONVIF：`http://<camera_ip>/onvif/device_service`
  - go2rtc Web：`http://<camera_ip>`
- 支持多项目、多矩阵规格和摄像头与矩阵屏幕区域绑定。

## 2. 总体架构

每一路摄像头对应一个 Docker 容器。容器由管理后台创建，挂在两个网络上：

- `bridge`：用于容器访问外网或内网 Web 页面。
- `onvif_macvlan`：用于让容器获得独立虚拟摄像头 IP，对外提供 RTSP、ONVIF 和 go2rtc Web。

运行链路：

```text
用户配置 WEB_URL
    ↓
管理后台创建/启动 virtualwebcam 容器
    ↓
容器内 Chrome 在 Xvfb 虚拟屏幕中打开网页
    ↓
FFmpeg 采集 Xvfb 屏幕画面
    ↓
FFmpeg 推送到容器内部 MediaMTX
    ↓
go2rtc 从 MediaMTX 拉流
    ↓
go2rtc 对外输出 RTSP + ONVIF + Web UI
    ↓
中控/ODM/mpv 使用 camera_ip 接入
```

容器内部端口：

```text
127.0.0.1:8556  MediaMTX RTSP 输入，仅容器内部使用
0.0.0.0:8554   go2rtc RTSP 输出
0.0.0.0:80     go2rtc Web/API/ONVIF
0.0.0.0:8555   go2rtc WebRTC
3702/udp       ONVIF WS-Discovery 预留
```

## 3. 源码结构

```text
.
├── container/
│   ├── Dockerfile          # virtualwebcam:latest 镜像定义
│   ├── entrypoint.sh       # 容器主流程：Xvfb/Chrome/FFmpeg/MediaMTX/go2rtc
│   └── healthcheck.sh      # 容器健康检查
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── server.js       # Express 服务入口、CORS、API Token
│       ├── routes.js       # REST API、校验、审计、业务编排
│       ├── db.js           # SQLite 初始化与兼容迁移
│       └── docker.js       # Docker 容器编排
├── frontend/
│   ├── Dockerfile
│   ├── package.json
│   ├── nginx/default.conf
│   └── src/
│       ├── App.vue         # 管理后台主界面
│       ├── api.js          # API 客户端封装
│       ├── main.js
│       └── styles.css      # 标准主题和科技主题
├── scripts/
│   ├── create-macvlan.sh
│   ├── setup-macvlan-host.sh
│   └── seed-demo-cameras.sh
├── examples/
│   └── multi-camera.compose.yml
├── docker-compose.yml
└── docs/
```

## 4. 容器模板设计

### 4.1 镜像内容

`container/Dockerfile` 基于 `nginx:1.29.4`，安装以下运行组件：

- Xvfb：提供虚拟 X11 屏幕。
- openbox：窗口管理器，保证 Chrome 窗口进入虚拟屏幕。
- Google Chrome stable：打开目标网页。
- FFmpeg：采集 X11 屏幕并编码为 H.264。
- MediaMTX：容器内部 RTSP 接收服务。
- go2rtc：对外输出 RTSP、ONVIF、Web UI。
- dumb-init：处理 PID 1 和信号转发。
- 中文字体、emoji 字体和基础调试工具。

镜像构建完成后标签为：

```text
virtualwebcam:latest
```

### 4.2 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `WEB_URL` | `https://www.baidu.com` | 要渲染的网页地址，必须是 `http://` 或 `https://` |
| `STREAM_NAME` | `screen01` | RTSP 路径名，只允许字母、数字、点、下划线、短横线 |
| `WIDTH` | `1280` | 采集宽度 |
| `HEIGHT` | `720` | 采集高度 |
| `FPS` | `15` | 采集帧率 |
| `DISPLAY_ID` | `99` | Xvfb display 编号，默认容器内固定即可 |
| `MEDIAMTX_RTSP_PORT` | `8556` | MediaMTX 内部 RTSP 端口 |
| `GO2RTC_RTSP_PORT` | `8554` | go2rtc 对外 RTSP 端口 |
| `GO2RTC_API_PORT` | `80` | go2rtc HTTP/ONVIF 端口 |
| `GO2RTC_WEBRTC_PORT` | `8555` | go2rtc WebRTC 端口 |
| `RTSP_HEALTHCHECK` | `0` | 设为 `1` 时健康检查会额外用 ffprobe 验证 RTSP 视频流 |

### 4.3 entrypoint 主流程

`container/entrypoint.sh` 的执行顺序：

1. 校验环境变量。
2. 清理 Chrome profile：避免容器重启后恢复旧页面。
3. 启动 Xvfb。
4. 启动 openbox。
5. 在 Xvfb 中启动 Chrome kiosk 窗口。
6. 写入 MediaMTX 配置并启动 MediaMTX。
7. 写入 go2rtc 配置并启动 go2rtc。
8. 启动 FFmpeg，把 Xvfb 画面推入 `rtsp://127.0.0.1:8556/<stream_name>`。
9. 监控子进程。任一关键进程退出时，容器退出，由 Docker `unless-stopped` 策略重启。

关键设计点：

- Chrome 使用 `--ozone-platform=x11`，保证网页进入 Xvfb，不进入真实桌面。
- FFmpeg 使用 `libx264 + baseline + zerolatency`，尽量兼容 ONVIF/RTSP 客户端。
- MediaMTX 只监听 `127.0.0.1:8556`，不暴露给外部。
- go2rtc 对外提供 RTSP 与 ONVIF，是最终对接入口。
- Chrome profile 每次启动都会重建，修改网页 URL 后重启容器即可看到新页面。

### 4.4 健康检查

`container/healthcheck.sh` 默认检查：

- go2rtc HTTP 端口可连接。
- go2rtc RTSP 端口可连接。
- MediaMTX 内部 RTSP 端口可连接。
- Xvfb、openbox、Chrome、FFmpeg、MediaMTX、go2rtc 进程存在。

如果 `RTSP_HEALTHCHECK=1`，还会使用 ffprobe 验证本地 RTSP 是否能返回视频流。该检查更严格，但在网页加载慢或首帧慢的情况下可能造成误判，生产默认保持 `0`。

## 5. 后端设计

### 5.1 服务入口

`backend/src/server.js`：

- 加载 `.env`。
- 初始化 SQLite。
- 启用 CORS。
- 启用 JSON body parser。
- 使用 `morgan` 输出访问日志。
- 可选启用 `API_TOKEN` 鉴权。
- 挂载 `/api` 路由。

后端默认端口：

```text
8177
```

### 5.2 Docker 编排

`backend/src/docker.js` 负责：

- 访问 Docker socket。
- 检查 Docker daemon、macvlan 网络和镜像是否存在。
- 创建摄像头容器。
- 启动、停止、重启、删除容器。
- 根据 Docker 状态同步摄像头状态。
- 读取容器日志。
- 把 Docker 原始错误转换为中文友好提示。

容器命名规则：

```text
<CONTAINER_PREFIX>-<camera_id>-<slug(name)>
```

默认示例：

```text
virtualwebcam-1-web-cam-01
```

容器标签：

```text
virtualwebcam.managed=true
virtualwebcam.cameraId=<camera_id>
```

后端通过标签查找容器，避免依赖易变的容器名。

### 5.3 双网络策略

创建容器时默认连接：

- `DOCKER_EGRESS_NETWORK=bridge`
- `DOCKER_NETWORK=onvif_macvlan`

原因：

- 只挂 macvlan 时，容器可能无法访问互联网或部分内网路由。
- 加上 bridge 后，Chrome 可以通过 bridge 出网打开网页。
- macvlan 仍然提供独立摄像头 IP，供中控、ODM、播放器访问。

该策略解决了“go2rtc 可以访问，但 Chrome 页面打不开”的常见问题。

### 5.4 数据库

SQLite 数据库默认路径：

```text
backend/data/virtualwebcam.db
```

Docker Compose 部署时挂载到：

```text
/data/virtualwebcam.db
```

初始化和轻量迁移在 `backend/src/db.js` 中完成。启用：

- `journal_mode = WAL`
- `foreign_keys = ON`
- `busy_timeout = 5000`

### 5.5 数据表

#### cameras

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER | 主键 |
| `name` | TEXT | 摄像头名称 |
| `ip` | TEXT UNIQUE | 虚拟摄像头 IP |
| `stream_name` | TEXT | RTSP 路径名 |
| `web_url` | TEXT | 网页地址 |
| `width` | INTEGER | 分辨率宽 |
| `height` | INTEGER | 分辨率高 |
| `fps` | INTEGER | 帧率 |
| `status` | TEXT | `running`、`stopped`、`error` |
| `display_targets` | TEXT | JSON 数组，绑定的屏幕编号 |
| `display_region` | TEXT | JSON 对象，矩形围栏区域 |
| `project_id` | INTEGER | 所属项目 |
| `created_at` | DATETIME | 创建时间 |

#### projects

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER | 主键 |
| `name` | TEXT UNIQUE | 项目名称 |
| `rows` | INTEGER | 矩阵行数 |
| `cols` | INTEGER | 矩阵列数 |
| `prefix` | TEXT | 屏幕编号前缀，默认 `屏` |
| `created_at` | DATETIME | 创建时间 |

#### settings

兼容历史全局配置，目前保留 `screen_matrix` 作为默认矩阵配置。

#### audit_logs

记录项目、摄像头和矩阵绑定的关键操作。

### 5.6 业务规则

- 单屏绑定：`display_targets` 只能包含一个屏幕编号，`display_region` 为 `null`。
- 合并区域绑定：必须提供 `display_region`，后端根据矩形区域计算 `display_targets`。
- 一个屏幕槽位同一时间只能被一个摄像头占用。
- 批量生成只写入数据库，状态为 `stopped`，不立即启动 Docker 容器。
- 单路创建会写入数据库，并尝试启动 Docker 容器。
- 编辑运行中的摄像头会重建容器，使 URL、分辨率、FPS 和流名生效。
- 删除摄像头会删除数据库记录并强制删除对应容器。

## 6. API 说明

所有 API 以 `/api` 为前缀。

### 6.1 健康检查

```http
GET /api/health
```

返回后端、Docker socket、macvlan 网络和镜像状态。

### 6.2 项目

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects` | 项目列表 |
| POST | `/api/projects` | 创建项目 |
| PUT | `/api/projects/:id` | 更新项目名称和矩阵规格 |
| GET | `/api/projects/:id/export` | 导出项目配置 |
| POST | `/api/projects/import` | 导入项目配置 |

项目创建请求：

```json
{
  "name": "默认项目",
  "rows": 6,
  "cols": 8,
  "prefix": "屏"
}
```

### 6.3 摄像头

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/cameras?project_id=1` | 摄像头列表，并同步 Docker 状态 |
| GET | `/api/cameras/statuses?project_id=1` | 轻量刷新状态 |
| POST | `/api/cameras?project_id=1` | 创建并启动一路摄像头 |
| POST | `/api/cameras/bulk?project_id=1` | 批量生成摄像头配置，不启动 |
| PUT | `/api/cameras/:id` | 编辑摄像头配置 |
| PATCH | `/api/cameras/:id/display-targets` | 更新屏幕绑定 |
| POST | `/api/cameras/:id/start` | 启动 |
| POST | `/api/cameras/:id/stop` | 停止 |
| POST | `/api/cameras/:id/restart` | 重启 |
| DELETE | `/api/cameras/:id` | 删除 |
| GET | `/api/cameras/:id/logs` | 获取容器日志 |

创建摄像头请求：

```json
{
  "name": "web-cam-01",
  "ip": "192.168.5.211",
  "stream_name": "screen01",
  "web_url": "https://www.baidu.com",
  "width": 1280,
  "height": 720,
  "fps": 15,
  "display_targets": [],
  "display_region": null
}
```

合并区域绑定请求：

```json
{
  "display_targets": [1, 2, 3, 9, 10, 11],
  "display_region": {
    "row": 1,
    "col": 1,
    "row_span": 2,
    "col_span": 3
  }
}
```

### 6.4 矩阵

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/screen-matrix?project_id=1` | 获取项目矩阵规格 |
| PUT | `/api/screen-matrix?project_id=1` | 更新项目矩阵规格 |

### 6.5 审计

```http
GET /api/audit-logs?project_id=1&limit=80
```

记录的典型动作：

```text
project.create
project.update
project.import
matrix.update
camera.create
camera.create_failed
camera.bulk_create
camera.update
camera.update_failed
camera.bind
camera.start
camera.stop
camera.restart
camera.delete
```

## 7. 前端设计

前端是 Vue3 + Vite 单页应用，但业务层级上拆为：

1. 项目入口页。
2. 项目内摄像头管理。
3. 项目内矩阵绑定。
4. 项目设置。
5. 操作审计。

### 7.1 项目入口

项目入口展示所有项目卡片。每个项目卡片包含：

- 项目名称。
- 矩阵规格。
- 屏幕编号范围。
- 摄像头管理入口。
- 矩阵绑定入口。
- 项目设置入口。

### 7.2 摄像头管理

主要用于查看摄像头详情列表。新增摄像头和批量生成使用弹窗，避免占用主页面空间。

列表能力：

- 状态统计。
- 搜索。
- 按状态筛选。
- 单行启动、停止、重启。
- 配置面板：日志、编辑、复制、复制 RTSP、复制 ONVIF、打开 go2rtc、删除。
- 批量启动、停止、重启。
- 定时状态刷新。

运行中的摄像头不能再点击启动；已停止的摄像头不能点击停止；重启只对已存在配置的摄像头开放。

### 7.3 矩阵绑定

矩阵绑定页用于维护摄像头与屏幕的管理映射，不直接改变视频流。

交互规则：

- 未画围栏时，每块屏幕是一个单屏区域。
- 用户可用鼠标在矩阵上框选连续矩形区域，形成合并区域。
- 摄像头拖入某个单屏或围栏后完成绑定。
- 绑定成功后，该摄像头从未绑定摄像头列表移除，避免重复拖拽。
- 一个屏幕槽位不能被多个摄像头同时占用。
- 围栏内保持透明，能看到被圈住的屏幕编号；摄像头信息根据围栏大小自适应展示。

## 8. 本地开发

### 8.1 准备依赖

```bash
cd backend
npm install

cd ../frontend
npm install
```

### 8.2 启动后端

```bash
cd backend
PORT=8177 \
DOCKER_NETWORK=onvif_macvlan \
DOCKER_EGRESS_NETWORK=bridge \
VIRTUALWEBCAM_IMAGE=virtualwebcam:latest \
npm run dev
```

### 8.3 启动前端

```bash
cd frontend
npm run dev -- --port 5177
```

访问：

```text
http://localhost:5177
```

### 8.4 构建镜像

```bash
docker build -t virtualwebcam:latest ./container
```

或：

```bash
docker compose --profile image build virtualwebcam-image
```

### 8.5 代码校验

```bash
cd backend
npm run lint

cd ../frontend
npm run build
```

## 9. 关键配置

根目录 `.env.example`：

```env
DOCKER_NETWORK=onvif_macvlan
VIRTUALWEBCAM_IMAGE=virtualwebcam:latest
CONTAINER_PREFIX=virtualwebcam
BACKEND_PORT=8177
FRONTEND_PORT=5177
HOST_IF=br0
SUBNET=192.168.5.0/24
GATEWAY=192.168.5.1
IP_RANGE=192.168.5.208/28
HOST_MACVLAN_IP=192.168.5.210
ROUTE_CIDR=192.168.5.208/28
```

后端可用环境变量：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 后端监听端口，默认 `8177` |
| `SQLITE_PATH` | SQLite 文件路径 |
| `DOCKER_SOCKET` | Docker socket 路径 |
| `DOCKER_NETWORK` | 对外 macvlan 网络 |
| `DOCKER_EGRESS_NETWORK` | 出网网络，默认 `bridge` |
| `VIRTUALWEBCAM_IMAGE` | 摄像头镜像 |
| `CONTAINER_PREFIX` | 摄像头容器名前缀 |
| `API_TOKEN` | 可选 API 令牌 |
| `CORS_ORIGIN` | 可选 CORS 白名单 |

前端可用环境变量：

| 变量 | 说明 |
| --- | --- |
| `VITE_API_TOKEN` | 构建期注入 API Token |

如果不想在构建时注入，也可以在浏览器 LocalStorage 写入：

```js
localStorage.setItem('virtualwebcam-api-token', 'change-me')
```

## 10. 扩展建议

### 10.1 增加认证

当前内置 `API_TOKEN` 是轻量保护。生产建议放到公司统一认证网关后面，例如 Nginx、Traefik、OAuth2 Proxy 或内部 SSO。

### 10.2 增加 WS-Discovery

go2rtc 已提供 ONVIF 手动添加能力，但自动发现依赖网络广播、交换机和客户端实现。后续如果必须自动发现，需要专项验证 UDP 3702、组播、容器网络和 go2rtc ONVIF 行为。

### 10.3 大规模摄像头

几十路摄像头会消耗 CPU、内存和 Chrome 资源。建议：

- 优先使用 1280x720@15。
- 静态看板可降到 10 FPS。
- 每台宿主机按 CPU、内存、网页复杂度压测后确定路数。
- 对复杂 Web 页面启用页面自身的轻量化模式。

### 10.4 任务队列

当前后端直接调用 Docker API。后续如果要支持几百路实例、任务重试和排队，可以引入队列，把创建、重建、启动、停止做成异步任务。

### 10.5 权限模型

当前项目没有用户、角色和项目级权限。后续可增加：

- 管理员。
- 项目管理员。
- 只读用户。
- 操作审计绑定用户身份。

## 11. 已知边界

- 宿主机直接访问 macvlan 容器 IP，需要额外配置 `macvlan-host` 辅助接口。
- 部分视频播放器在 RTSP 源重启后会停在历史画面，需要重新打开播放器。推荐验收命令使用 `mpv --rtsp-transport=tcp`。
- 网页自身加载失败时，RTSP 中会显示 Chrome 错误页，这属于网页网络或业务服务问题，不是 RTSP 管道错误。
- ONVIF 自动发现不保证成功，手动添加 ONVIF 地址已作为主要接入方式。

