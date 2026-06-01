# VirtualWebCam 简明部署文档

版本：1.0  
适用对象：客户主机现场快速部署  
默认端口：前端 `9528`，后端 `8177`，RTSP `554`  
默认网络示例：`br0 = 192.168.5.198/24`

## 1. 部署结果

部署完成后，客户通过浏览器访问：

```text
http://<客户主机IP>:9528
```

系统可以创建两类视频源：

- ONVIF 摄像头：每路使用一个独立局域网 IP，提供 RTSP + ONVIF。
- RTSP 流源：多路共享宿主机 IP，通过不同流路径区分，适合现场 IP 不足的项目。

新增和批量生成视频源时，流名称由系统自动生成，现场用户只需要关注名称、网页 URL、ONVIF 虚拟 IP、分辨率和 FPS。

典型地址：

```text
ONVIF 摄像头 RTSP：rtsp://192.168.5.200:554/screen01
ONVIF 摄像头入口：http://192.168.5.200/onvif/device_service
RTSP 流源地址：rtsp://192.168.5.198:554/screen01
```

## 2. 部署前确认

客户主机已经安装 Ubuntu 26.04 时，推荐先使用根目录部署脚本：

```bash
chmod +x ubuntu26.04-deploy.sh
./ubuntu26.04-deploy.sh
```

脚本会按提示确认现场网卡、主机 IP、网关、ONVIF 摄像头地址池、管理员账号和端口，并自动完成 Docker 检查或安装、`.env` 生成、macvlan 配置、镜像构建和服务启动。检测到已有 SQLite 时会先备份；需要清理测试数据重新部署时使用 `--clean-data`，需要明确保留现有数据时使用 `--keep-data`。

在客户主机上执行：

```bash
ip -4 addr
ip route | grep default
docker version
docker ps
```

确认三件事：

- Docker 已安装并运行。
- 当前登录用户能执行 `docker ps`。
- 明确客户主机网卡、IP、网关，例如 `br0`、`192.168.5.198`、`192.168.5.1`。

如果 `docker ps` 提示无权限：

```bash
sudo usermod -aG docker "$USER"
```

然后退出重新登录。

## 3. 配置现场环境

复制示例配置：

```bash
cp .env.example .env
```

按客户主机实际网络修改 `.env`。以下是 `192.168.5.198/24` 示例：

```env
DOCKER_NETWORK=onvif_macvlan
VIRTUALWEBCAM_IMAGE=virtualwebcam:latest
CONTAINER_PREFIX=virtualwebcam
CAMERA_RTSP_PORT=554
RTSP_GATEWAY_HOST=192.168.5.198
RTSP_GATEWAY_PORT=554
RTSP_NETWORK=virtualwebcam_rtsp
ADMIN_USERNAME=admin
ADMIN_PASSWORD=请改成强密码
SESSION_SECRET=请改成长随机字符串
BACKEND_PORT=8177
FRONTEND_PORT=9528
HOST_IF=br0
SUBNET=192.168.5.0/24
GATEWAY=192.168.5.1
IP_RANGE=192.168.5.192/26
HOST_MACVLAN_IP=192.168.5.199
ROUTE_CIDR=192.168.5.192/26
```

如果客户现场是 `192.168.9.xxx`，把上面的 `192.168.5` 全部替换成客户真实网段，并把 `RTSP_GATEWAY_HOST` 改成客户主机 IP。

## 4. 创建 macvlan 网络

只有 ONVIF 摄像头需要 macvlan 独立 IP。RTSP 流源不依赖 macvlan，但建议仍先配置好，方便后续混合使用。

```bash
sudo PARENT_IFACE=br0 \
  SUBNET=192.168.5.0/24 \
  GATEWAY=192.168.5.1 \
  IP_RANGE=192.168.5.192/26 \
  NETWORK_NAME=onvif_macvlan \
  ./scripts/create-macvlan.sh
```

检查：

```bash
docker network inspect onvif_macvlan
```

## 5. 配置宿主机访问 macvlan 容器

如果只让同网段其他电脑、中控或 ODM 访问虚拟摄像头，可以跳过本步骤。  
如果要在客户主机本机访问 `192.168.5.200`，必须创建辅助接口：

```bash
sudo HOST_IF=br0 \
  HOST_MACVLAN_IP=192.168.5.199 \
  ROUTE_CIDR=192.168.5.192/26 \
  ./scripts/setup-macvlan-host.sh
```

重启主机后该接口会丢失，生产环境请参考详细部署文档配置 systemd 开机恢复。

## 6. 构建镜像和启动后台

在项目根目录执行：

```bash
docker compose --profile image build virtualwebcam-image
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
http://<客户主机IP>:9528
```

## 7. 登录和初始化

使用 `.env` 中配置的管理员登录：

```text
用户名：admin
密码：.env 中的 ADMIN_PASSWORD
```

首次登录后建议立即完成：

- 修改管理员密码。
- 创建普通登录人员。
- 给登录人员授权可见项目。
- 在“备份管理”中确认数据库备份路径和定时备份策略。
- 创建管理项目并设置矩阵规格。
- 维护项目内的大屏地址库；地址较多时可在“大屏地址”页面通过 CSV 导入导出，列为 `name,url,remark`。

## 8. 创建视频源

### 8.1 创建 ONVIF 摄像头

进入项目 -> 摄像头管理 -> 新增源：

```text
源类型：ONVIF 摄像头（独立 IP）
名称：web-cam-01
虚拟 IP：192.168.5.200
网页 URL：业务网页地址
分辨率：1280 x 720
FPS：15
```

验收：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.200:554/screen01
```

ONVIF Device Manager 手动添加：

```text
http://192.168.5.200/onvif/device_service
```

### 8.2 创建 RTSP 流源

现场 IP 不足时，使用 RTSP 流源：

```text
源类型：RTSP 流源（共享 IP + 流路径）
名称：rtsp-screen-01
网页 URL：业务网页地址
分辨率：1280 x 720
FPS：15
```

验收：

```bash
mpv --rtsp-transport=tcp rtsp://192.168.5.198:554/screen01
```

## 9. 常用验收命令

```bash
docker ps
docker compose ps
docker logs --tail=100 virtualwebcam-manager-backend
docker logs --tail=100 virtualwebcam-manager-frontend
docker ps --filter label=virtualwebcam.managed=true
```

查看摄像头容器日志：

```bash
docker logs --tail=200 <摄像头容器名>
```

查看 RTSP 网关：

```bash
docker ps --filter label=virtualwebcam.rtspGateway=true
```

## 10. 最常见问题

### 10.1 后台提示 Docker 不可访问

检查 Docker socket 是否挂载、Docker 是否运行：

```bash
docker ps
docker compose logs --tail=100 manager-backend
```

### 10.2 客户主机打不开 ONVIF 摄像头 IP

大概率没有配置 `macvlan-host` 辅助接口。执行：

```bash
sudo HOST_IF=br0 HOST_MACVLAN_IP=192.168.5.199 ROUTE_CIDR=192.168.5.192/26 ./scripts/setup-macvlan-host.sh
```

### 10.3 RTSP 播放器显示旧画面

修改网页 URL 或重启容器后，关闭播放器重新打开。推荐验收使用：

```bash
mpv --rtsp-transport=tcp <RTSP地址>
```

### 10.4 更换客户现场网段

不需要重建镜像。需要改：

- `.env` 里的 `RTSP_GATEWAY_HOST`、`SUBNET`、`GATEWAY`、`IP_RANGE`、`HOST_MACVLAN_IP`、`ROUTE_CIDR`。
- Docker macvlan 网络。
- 后台中 ONVIF 摄像头的虚拟 IP。

详细步骤见 `docs/detailed-deployment.html`。
