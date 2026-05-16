# VirtualWebCam 优化清单

记录日期：2026-05-13

详细说明：[VirtualWebCam 详细优化建议](./optimization-recommendations.md)

## 当前结论

本次代码熟悉与现有测试验证未发现必须立即修复的功能性阻断问题。已通过的验证包括：

- 后端语法检查：`npm run lint`
- 后端单元测试与 API 回归：`npm test`
- 前端单元测试：`npm run test:unit`
- 前端生产构建：`npm run build`

需要注意的是，生产部署前仍必须确认默认密码、会话密钥、Docker socket 暴露范围等安全配置。这类事项不一定是当前代码缺陷，但属于上线前检查项。

## P0：生产安全与上线前确认

- 修改默认 `ADMIN_PASSWORD` 和 `SESSION_SECRET`。
- 启动时检测默认弱配置，并在健康检查或日志中给出明显告警。
- 管理后台挂载 Docker socket，应只部署在可信内网；必要时增加反向代理鉴权、IP 白名单或 VPN 访问限制。
- 如果管理入口无法限制在可信内网、VPN 或统一认证网关后，登录失败限流应作为上线前完成项；否则可排入 P1。

## P1：安全加固

- `API_TOKEN` 拥有管理员权限，建议补充轮换说明、审计标记和明确的启用策略。
- 中长期评估将前端 token 从 `localStorage` 调整为 HttpOnly Cookie。

## P1：后端维护性

- 拆分 `backend/src/routes.js`，建议按 `auth`、`users`、`projects`、`cameras`、`screen-urls`、`audit` 分模块。
- 将业务编排从路由层下沉到 service 层，例如 `cameraService`、`projectService`、`permissionService`。
- 将 SQLite 兼容迁移从 `initDb` 中抽离为版本化 migration。
- 项目导入流程使用 SQLite transaction，替代当前手写补偿清理。
- Docker 操作增加超时控制和更明确的错误分类，避免 API 长时间等待。

## P1：前端维护性

- 拆分 `frontend/src/App.vue`，当前文件体积偏大，建议按页面和弹窗组件拆分。
- 将鉴权、项目、摄像头、矩阵、资源轮询抽为 composables。
- 矩阵拖拽绑定独立组件化，并补充交互测试。
- 区分表单错误、操作错误和系统错误，减少全局 `error` 状态承载过多含义。
- 表格列配置、主题配置、轮询逻辑可抽成独立模块。

## P1：运维可靠性

- 增加 `.nvmrc` 或 `.node-version`，固定本地和 CI Node 版本；后端 Dockerfile 已固定 Node 20，但本地开发仍可能遇到 `better-sqlite3` ABI 不匹配。
- 在现有备份文档基础上增加数据库备份和恢复脚本，覆盖 `backend/data/virtualwebcam.db`。
- RTSP 网关端口 `554` 占用失败时，在后端错误分类和前端展示中给出更明确的处理建议。
- 在现有 systemd 文档示例基础上，提供 macvlan host 辅助接口的一键安装和卸载脚本。
- 镜像构建后增加容器 smoke test，验证 Xvfb、Chrome、FFmpeg、MediaMTX、go2rtc 主流程可启动。

## P2：功能体验

- 批量创建支持 RTSP 流源批量生成。
- 摄像头复制时增加 IP、流名、屏幕绑定冲突预检查。
- 资源监控增加历史趋势。
- 日志抽屉支持自动刷新、关键字搜索和错误高亮。
- 项目导入前增加预览，展示即将创建的资源、IP 重映射和流名重映射。

## P2：测试覆盖

- 后端补充路由级测试，重点覆盖权限、导入事务、屏幕绑定冲突。
- 前端补充组件测试，重点覆盖矩阵区域选择和拖拽绑定。
- Docker service 层增加 mock 测试，减少 CI 对真实 Docker 环境的依赖。
- 增加端到端 smoke test：登录、创建项目、创建视频源、绑定屏幕、导出配置。
- 验证生产构建后的 Nginx `/api` 反代行为。

## 建议优先顺序

1. 生产启动安全检查，拦截默认密码和默认 `SESSION_SECRET`。
2. 明确 Docker socket 访问边界，避免管理后台暴露到不可信网络。
3. 固定本地和 CI Node 版本，减少原生依赖问题。
4. 项目导入使用数据库事务。
5. Docker 错误分类区分 IP 占用和 RTSP 网关端口占用。
6. 拆分后端 `routes.js`。
7. 拆分前端 `App.vue`。
