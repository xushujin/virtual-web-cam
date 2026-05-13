# VirtualWebCam 开发技术文档

版本：1.0  
适用项目：VirtualWebCam 网页转 RTSP + 虚拟 ONVIF 摄像头管理系统  
默认端口：前端 `5177`，后端 `8177`  
默认网络：`br0 = 192.168.5.111/24`，macvlan 网络 `onvif_macvlan`

## 1. 项目目标

VirtualWebCam 的目标是把任意可被 Chrome 渲染的网页转换为一路标准视频源，并让这一路视频源像真实网络摄像头一样被中控、ONVIF Device Manager 或播放器接入。

系统分为两层：

- 容器模板：构建通用 `virtualwebcam:latest` 镜像。镜像支持 ONVIF 独立 IP 摄像头、RTSP 发布器和共享 RTSP 网关三种运行角色。
- 管理后台：Node.js + Express + SQLite + Vue3。负责项目管理、视频源实例管理、Docker 容器生命周期、矩阵屏幕绑定、资源监控、日志和审计。

核心交付能力：

- 用户通过网页创建虚拟摄像头，不需要手写 Xvfb、Chrome、FFmpeg、MediaMTX、go2rtc 命令。
- 支持两类视频源：
  - ONVIF 摄像头：每一路拥有独立 IP，便于中控按 IP 或 ONVIF 设备区分摄像头。
  - RTSP 流源：多路共享宿主机 RTSP 网关 IP，通过不同 `/<stream_name>` 区分，适合 IP 资源不足的项目。
- ONVIF 摄像头输出地址稳定：
  - RTSP：`rtsp://<camera_ip>:554/<stream_name>`
  - ONVIF：`http://<camera_ip>/onvif/device_service`
  - go2rtc Web：`http://<camera_ip>`
- RTSP 流源输出地址稳定：
  - RTSP：`rtsp://<host_ip>:554/<stream_name>`
  - 不提供 ONVIF 和 go2rtc Web。
- 支持多项目、多矩阵规格和摄像头与矩阵屏幕区域绑定。

## 2. 总体架构

视频源由管理后台创建，按 `source_type` 分成两条链路。

ONVIF 摄像头一路对应一个 Docker 容器，挂在两个网络上：

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

RTSP 流源由一个共享网关容器和多路发布器容器组成：

```text
用户配置 WEB_URL + stream_name
    ↓
管理后台确保 virtualwebcam-rtsp-gateway 存在并运行
    ↓
网关容器以 OUTPUT_MODE=rtsp-gateway 启动 MediaMTX，映射宿主机 554/tcp
    ↓
每一路 RTSP 源容器以 OUTPUT_MODE=rtsp-publisher 启动 Chrome + Xvfb + FFmpeg
    ↓
FFmpeg 推送到 rtsp://virtualwebcam-rtsp-gateway:554/<stream_name>
    ↓
播放器/中控使用 rtsp://<host_ip>:554/<stream_name> 接入
```

容器内部端口：

```text
0.0.0.0:8556    MediaMTX RTSP 输入，FFmpeg/go2rtc 在容器内通过 127.0.0.1 使用
0.0.0.0:554   go2rtc RTSP 输出
0.0.0.0:80     go2rtc Web/API/ONVIF
0.0.0.0:8555   go2rtc WebRTC
3702/udp       ONVIF WS-Discovery 预留
```

RTSP 网关容器只启动 MediaMTX，默认监听：

```text
0.0.0.0:554   共享 RTSP 输入与输出
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
| `OUTPUT_MODE` | `onvif` | 运行角色：`onvif`、`rtsp-publisher`、`rtsp-gateway` |
| `DISPLAY_ID` | `99` | Xvfb display 编号，默认容器内固定即可 |
| `MEDIAMTX_RTSP_PORT` | `8556` | MediaMTX 内部 RTSP 端口 |
| `GO2RTC_RTSP_PORT` | `554` | go2rtc 对外 RTSP 端口 |
| `GO2RTC_API_PORT` | `80` | go2rtc HTTP/ONVIF 端口 |
| `GO2RTC_WEBRTC_PORT` | `8555` | go2rtc WebRTC 端口 |
| `RTSP_PUSH_URL` | 空 | `rtsp-publisher` 模式下 FFmpeg 推送目标 |
| `RTSP_HEALTHCHECK` | `0` | 设为 `1` 时健康检查会额外用 ffprobe 验证 RTSP 视频流 |

### 4.3 entrypoint 主流程

`container/entrypoint.sh` 通过 `OUTPUT_MODE` 控制角色：

| 模式 | 作用 | 主要进程 | 对外能力 |
| --- | --- | --- | --- |
| `onvif` | 默认独立 IP 摄像头 | Xvfb、openbox、Chrome、FFmpeg、MediaMTX、go2rtc | RTSP + ONVIF + go2rtc Web |
| `rtsp-gateway` | 共享 RTSP 网关 | MediaMTX | `rtsp://<host_ip>:554/<stream>` |
| `rtsp-publisher` | 网页转 RTSP 发布器 | Xvfb、openbox、Chrome、FFmpeg | 推送到共享网关 |

`onvif` 模式执行顺序：

1. 校验环境变量。
2. 清理 Chrome profile：避免容器重启后恢复旧页面。
3. 启动 Xvfb。
4. 启动 openbox。
5. 在 Xvfb 中启动 Chrome kiosk 窗口。
6. 写入 MediaMTX 配置并启动 MediaMTX。
7. 写入 go2rtc 配置并启动 go2rtc。
8. 启动 FFmpeg，把 Xvfb 画面推入 `rtsp://127.0.0.1:8556/<stream_name>`。
9. 监控子进程。任一关键进程退出时，容器退出，由 Docker `unless-stopped` 策略重启。

`rtsp-publisher` 模式不会启动 MediaMTX 和 go2rtc，FFmpeg 直接推送到 `RTSP_PUSH_URL`。
`rtsp-gateway` 模式不会启动 Xvfb、Chrome、FFmpeg 和 go2rtc，只启动 MediaMTX。

关键设计点：

- Chrome 使用 `--ozone-platform=x11`，保证网页进入 Xvfb，不进入真实桌面。
- FFmpeg 使用 `libx264 + baseline`，尽量兼容 ONVIF/RTSP 客户端。
- MediaMTX 监听 `0.0.0.0:8556`，但最终对接入口仍然是 go2rtc 的 `554` 和 `80`；FFmpeg/go2rtc 在容器内通过 `127.0.0.1:8556` 使用它。
- go2rtc 对外提供 RTSP 与 ONVIF，是最终对接入口。
- Chrome profile 每次启动都会重建，修改网页 URL 后重启容器即可看到新页面。
- FFmpeg 推流命令已移除 `-tune zerolatency`，当前保持 `libx264`、`veryfast`、`baseline`、`GOP=FPS*2`。

当前 FFmpeg 核心参数：

```bash
ffmpeg -hide_banner -loglevel info -re \
  -f x11grab \
  -draw_mouse 0 \
  -video_size "${WIDTH}x${HEIGHT}" \
  -framerate "$FPS" \
  -i ":${DISPLAY_ID}.0+0,0" \
  -c:v libx264 \
  -preset veryfast \
  -pix_fmt yuv420p \
  -profile:v baseline \
  -level 3.1 \
  -g "$((FPS * 2))" \
  -bf 0 \
  -an \
  -rtsp_transport tcp \
  -f rtsp "$FFMPEG_OUTPUT_URL"
```

### 4.4 健康检查

`container/healthcheck.sh` 按模式检查：

- `onvif`：检查 Xvfb、openbox、Chrome、FFmpeg、MediaMTX、go2rtc 进程，并检查 go2rtc HTTP、go2rtc RTSP、MediaMTX RTSP 端口。
- `rtsp-publisher`：检查 Xvfb、openbox、Chrome、FFmpeg 进程。
- `rtsp-gateway`：检查 MediaMTX 进程和 RTSP 端口。

如果 `OUTPUT_MODE=onvif` 且 `RTSP_HEALTHCHECK=1`，还会使用 ffprobe 验证本地 RTSP 是否能返回视频流。该检查更严格，但在网页加载慢或首帧慢的情况下可能造成误判，生产默认保持 `0`。

## 5. 后端设计

### 5.1 服务入口

`backend/src/server.js`：

- 加载 `.env`。
- 初始化 SQLite。
- 启用 CORS。
- 启用 JSON body parser。
- 使用 `morgan` 输出访问日志。
- 启用登录会话鉴权，并保留可选 `API_TOKEN` 服务令牌。
- 挂载 `/api` 路由。

后端默认端口：

```text
8177
```

### 5.2 Docker 编排

`backend/src/docker.js` 负责：

- 访问 Docker socket。
- 检查 Docker daemon、macvlan 网络和镜像是否存在。
- 创建 ONVIF 摄像头容器。
- 懒启动共享 RTSP 网关容器。
- 创建 RTSP 发布器容器。
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
virtualwebcam.sourceType=camera|rtsp
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

### 5.4 RTSP 共享网关策略

当 `source_type=rtsp` 时，后端不会分配 macvlan IP，而是：

1. 创建或复用 Docker bridge 网络 `RTSP_NETWORK`，默认 `virtualwebcam_rtsp`。
2. 创建或启动网关容器 `RTSP_GATEWAY_CONTAINER`，默认 `virtualwebcam-rtsp-gateway`。
3. 网关容器使用同一个 `virtualwebcam:latest` 镜像，并设置 `OUTPUT_MODE=rtsp-gateway`。
4. 网关容器把 `RTSP_GATEWAY_PORT` 映射到宿主机，默认 `554/tcp`。
5. 每一路 RTSP 源容器设置 `OUTPUT_MODE=rtsp-publisher`，并把 FFmpeg 推到 `rtsp://virtualwebcam-rtsp-gateway:554/<stream_name>`。
6. 后端返回的 RTSP 地址为 `rtsp://<RTSP_GATEWAY_HOST>:<RTSP_GATEWAY_PORT>/<stream_name>`。

RTSP 流源没有 ONVIF 地址，也没有 go2rtc Web 地址。`stream_name` 在所有 RTSP 流源中必须唯一，否则会覆盖共享网关里的同名路径。

### 5.5 数据库

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

### 5.6 数据表

#### cameras

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER | 主键 |
| `name` | TEXT | 摄像头名称 |
| `ip` | TEXT UNIQUE | 虚拟摄像头 IP |
| `source_type` | TEXT | `camera` 表示 ONVIF 独立 IP 摄像头；`rtsp` 表示共享网关 RTSP 流源 |
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

#### users

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER | 主键 |
| `username` | TEXT UNIQUE | 登录用户名 |
| `password_hash` | TEXT | PBKDF2-SHA256 密码哈希 |
| `display_name` | TEXT | 显示名称 |
| `role` | TEXT | `admin` 或 `user` |
| `enabled` | INTEGER | 是否启用 |
| `created_at` | DATETIME | 创建时间 |

#### project_members

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `project_id` | INTEGER | 项目 ID |
| `user_id` | INTEGER | 用户 ID |
| `role` | TEXT | `viewer` 仅查看，`operator` 可操作 |
| `created_at` | DATETIME | 创建时间 |

#### screen_urls

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER | 主键 |
| `project_id` | INTEGER | 所属项目 |
| `name` | TEXT | 地址名称，例如大厅信息屏 |
| `url` | TEXT | 大屏网页地址 |
| `remark` | TEXT | 备注 |
| `created_at` | DATETIME | 创建时间 |
| `updated_at` | DATETIME | 更新时间 |

### 5.7 业务规则

- 单屏绑定：`display_targets` 只能包含一个屏幕编号，`display_region` 为 `null`。
- 合并区域绑定：必须提供 `display_region`，后端根据矩形区域计算 `display_targets`。
- 一个屏幕槽位同一时间只能被一个摄像头占用。
- 大屏地址属于项目资源，普通用户只能读取授权项目的大屏地址；`operator` 或系统管理员才能新增、编辑、删除。
- 批量生成只写入数据库，状态为 `stopped`，不立即启动 Docker 容器。
- 单路创建会写入数据库，并尝试启动 Docker 容器。
- ONVIF 摄像头必须填写 `ip`，且 IP 在 `cameras.ip` 中唯一。
- RTSP 流源的 `ip` 为空，`stream_name` 在 RTSP 流源中必须唯一。
- 编辑运行中的摄像头会重建容器，使 URL、分辨率、FPS 和流名生效。
- 删除摄像头会删除数据库记录并强制删除对应容器。
- 系统管理员默认拥有全部项目权限。
- 普通用户只能看到 `project_members` 授权的项目。
- `viewer` 只能读取授权项目，`operator` 可以管理授权项目内的视频源、容器启停、矩阵绑定和项目设置。

## 6. API 说明

所有 API 以 `/api` 为前缀。

### 6.0 认证与用户

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/auth/login` | 用户名密码登录 |
| GET | `/api/auth/me` | 当前登录用户 |
| GET | `/api/users` | 用户列表，系统管理员可用 |
| POST | `/api/users` | 创建用户，系统管理员可用 |
| PUT | `/api/users/:id` | 更新用户，系统管理员可用 |
| GET | `/api/users/:id/projects` | 查询某个登录人的项目资源授权 |
| PUT | `/api/users/:id/projects` | 更新某个登录人的项目资源授权 |

登录成功返回会话 token，前端使用 `Authorization: Bearer <token>` 访问后续 API。`API_TOKEN` 仍可作为脚本调用的服务令牌，命中后按系统管理员权限处理。

### 6.1 健康检查

```http
GET /api/health
```

返回后端、Docker socket、macvlan 网络和镜像状态。

### 6.2 项目

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/projects` | 项目列表，普通用户只返回授权项目 |
| POST | `/api/projects` | 创建项目 |
| PUT | `/api/projects/:id` | 更新项目名称和矩阵规格 |
| GET | `/api/projects/:id/export` | 导出项目配置，包含项目、摄像头和大屏地址库 |
| POST | `/api/projects/import` | 导入项目配置，自动导入大屏地址库，处理 IP 和 RTSP 流名冲突 |

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
| GET | `/api/resource-stats?project_id=1` | 采集摄像头容器 CPU、内存、网络和磁盘读写 |
| POST | `/api/cameras?project_id=1` | 创建并启动一路摄像头 |
| POST | `/api/cameras/bulk?project_id=1` | 批量生成摄像头配置，不启动 |
| PUT | `/api/cameras/:id` | 编辑摄像头配置 |
| PATCH | `/api/cameras/:id/display-targets` | 更新屏幕绑定 |
| POST | `/api/cameras/:id/start` | 启动 |
| POST | `/api/cameras/:id/stop` | 停止 |
| POST | `/api/cameras/:id/restart` | 重启 |
| DELETE | `/api/cameras/:id` | 删除 |
| GET | `/api/cameras/:id/logs` | 获取容器日志 |

创建 ONVIF 摄像头请求：

```json
{
  "source_type": "camera",
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

创建 RTSP 流源请求：

```json
{
  "source_type": "rtsp",
  "name": "rtsp-screen-01",
  "ip": null,
  "stream_name": "screen01",
  "web_url": "https://www.baidu.com",
  "width": 1280,
  "height": 720,
  "fps": 15,
  "display_targets": [],
  "display_region": null
}
```

返回结果中：

- ONVIF 摄像头有 `rtsp_url`、`onvif_url`、`go2rtc_url`。
- RTSP 流源只有 `rtsp_url`，`onvif_url` 和 `go2rtc_url` 为 `null`。

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

资源监控返回：

```json
{
  "collected_at": "2026-05-11T12:59:00.792Z",
  "summary": {
    "cpuPercent": 69.48,
    "memoryUsageBytes": 618708992,
    "networkRxBytes": 2715308,
    "networkTxBytes": 792318,
    "blockReadBytes": 86016,
    "blockWriteBytes": 288608256,
    "running": 1,
    "total": 1
  },
  "items": [
    {
      "camera_id": 1,
      "status": "running",
      "cpu_percent": 69.48,
      "memory_usage_bytes": 618708992,
      "network_rx_bytes": 2715308,
      "network_tx_bytes": 792318,
      "block_read_bytes": 86016,
      "block_write_bytes": 288608256
    }
  ]
}
```

说明：网络和磁盘字段来自 Docker stats，属于容器启动后的累计值；前端会根据两次采样差值换算每秒速率，用于硬件规划。

### 6.4 矩阵

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/screen-matrix?project_id=1` | 获取项目矩阵规格 |
| PUT | `/api/screen-matrix?project_id=1` | 更新项目矩阵规格 |

### 6.5 大屏地址

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/screen-urls?project_id=1` | 查询项目大屏地址库 |
| POST | `/api/screen-urls?project_id=1` | 新增大屏地址 |
| PUT | `/api/screen-urls/:id` | 更新大屏地址 |
| DELETE | `/api/screen-urls/:id` | 删除大屏地址 |

请求体：

```json
{
  "name": "大厅信息屏",
  "url": "https://example.com/dashboard",
  "remark": "一楼大厅常用看板"
}
```

该地址库不直接创建容器，只作为项目内常用网页 URL 的管理资源。前端在新增、批量生成和编辑视频源时使用它做搜索选择。

### 6.6 审计

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
- 源类型展示：ONVIF 摄像头显示独立 IP；RTSP 流源显示共享网关。
- 列表字段显隐：默认精简展示名称、IP、网页 URL、状态、操作；可展开资源、投放屏幕、RTSP、ONVIF 等长字段。
- 资源监控：展示项目汇总和单路容器的 CPU、内存、网络、磁盘读写。
- 单行启动、停止、重启。
- 配置面板：日志、编辑、复制为新视频源、复制 RTSP、复制 ONVIF、复制 mpv 命令、打开 go2rtc、删除。
- 批量启动、停止、重启。
- 定时状态刷新。

运行中的摄像头不能再点击启动；已停止的摄像头不能点击停止；重启只对已存在配置的摄像头开放。
RTSP 流源没有 ONVIF 和 go2rtc 操作入口。

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
CAMERA_RTSP_PORT=554 \
RTSP_GATEWAY_HOST=192.168.5.111 \
RTSP_GATEWAY_PORT=554 \
RTSP_NETWORK=virtualwebcam_rtsp \
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
npm run test:api

cd ../frontend
npm run build
```

`npm run test:api` 会启动一个临时后端和临时 SQLite 数据库，不依赖 Docker，也不会修改当前业务数据。覆盖范围包括：登录失败、管理员登录、项目创建、项目授权、只读用户写入拦截、大屏地址库、批量生成摄像头配置、矩阵绑定冲突、项目导出、项目导入、RTSP 流名重映射和失败导入清理。

## 9. 关键配置

根目录 `.env.example`：

```env
DOCKER_NETWORK=onvif_macvlan
VIRTUALWEBCAM_IMAGE=virtualwebcam:latest
CONTAINER_PREFIX=virtualwebcam
CAMERA_RTSP_PORT=554
RTSP_GATEWAY_HOST=192.168.5.111
RTSP_GATEWAY_PORT=554
RTSP_NETWORK=virtualwebcam_rtsp
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
| `CAMERA_RTSP_PORT` | ONVIF 摄像头容器对外 RTSP 端口，默认 `554` |
| `RTSP_GATEWAY_HOST` | RTSP 流源对外展示的宿主机 IP |
| `RTSP_GATEWAY_PORT` | 共享 RTSP 网关宿主机端口，默认 `554` |
| `RTSP_GATEWAY_CONTAINER` | 共享 RTSP 网关容器名，默认 `virtualwebcam-rtsp-gateway` |
| `RTSP_NETWORK` | RTSP 网关和发布器之间的 Docker bridge 网络 |
| `ADMIN_USERNAME` | 首次初始化默认管理员用户名 |
| `ADMIN_PASSWORD` | 首次初始化默认管理员密码，上线必须修改 |
| `SESSION_SECRET` | 登录会话签名密钥，上线必须修改 |
| `API_TOKEN` | 可选服务令牌，命中后按系统管理员权限处理 |
| `CORS_ORIGIN` | 可选 CORS 白名单 |

`API_TOKEN` 只应供脚本、内网网关或自动化系统调用后端 API。前端构建不会注入服务令牌，网页用户应通过账号密码登录，避免把管理员级服务令牌暴露到浏览器。

开发调试时如果确实需要临时绕过登录，可以手动在浏览器 LocalStorage 写入服务令牌；该方式不建议用于生产环境：

```js
localStorage.setItem('virtualwebcam-api-token', 'change-me')
```

## 10. 扩展建议

### 10.1 增加 WS-Discovery

go2rtc 已提供 ONVIF 手动添加能力，但自动发现依赖网络广播、交换机和客户端实现。后续如果必须自动发现，需要专项验证 UDP 3702、组播、容器网络和 go2rtc ONVIF 行为。

### 10.2 大规模摄像头

几十路摄像头会消耗 CPU、内存和 Chrome 资源。建议：

- 优先使用 1280x720@15。
- 静态看板可降到 10 FPS。
- 每台宿主机按 CPU、内存、网页复杂度压测后确定路数。
- 对复杂 Web 页面启用页面自身的轻量化模式。

### 10.3 任务队列

当前后端直接调用 Docker API。后续如果要支持几百路实例、任务重试和排队，可以引入队列，把创建、重建、启动、停止做成异步任务。

## 11. 已知边界

- 宿主机直接访问 macvlan 容器 IP，需要额外配置 `macvlan-host` 辅助接口。
- RTSP 流源不占独立 IP，但需要宿主机 `554/tcp` 可用；如果端口已被其他服务占用，需要调整 `RTSP_GATEWAY_PORT`。
- 部分视频播放器在 RTSP 源重启后会停在历史画面，需要重新打开播放器。推荐验收命令使用 `mpv --rtsp-transport=tcp`。
- 网页自身加载失败时，RTSP 中会显示 Chrome 错误页，这属于网页网络或业务服务问题，不是 RTSP 管道错误。
- ONVIF 自动发现不保证成功，手动添加 ONVIF 地址已作为主要接入方式。
