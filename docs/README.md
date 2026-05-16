# VirtualWebCam 文档中心

本目录保存 VirtualWebCam 项目的正式交付文档。Markdown 是源文档，HTML 是面向验收、交付和离线阅读的发布格式。

## 文档清单

- [简明部署文档](./quick-deployment.md)：面向客户主机现场部署，保留最短部署路径、验收命令和常见失败点。
- [详细部署文档](./detailed-deployment.md)：面向实施和运维，完整说明环境规划、安装、网络、权限、安全、验证、升级和故障处理。
- [开发技术文档](./development-guide.md)：面向研发，说明系统架构、代码分层、容器运行模式、API、数据库、RTSP 网关和扩展方式。
- [部署运维文档](./deployment-ops-guide.md)：面向部署和运维，说明 Docker、macvlan、共享 RTSP 网关、管理后台、验证、升级、备份和故障处理。
- [用户使用指南](./user-guide.md)：面向业务用户和现场实施人员，说明登录、项目授权、ONVIF 摄像头、RTSP 流源、矩阵绑定和日常操作。
- [优化清单](./optimization-checklist.md)：记录后续可优化事项、优先级和上线前安全检查点。
- [详细优化建议](./optimization-recommendations.md)：按安全、后端、前端、运维、性能、测试和文档拆分优化项，包含现状、风险、方案和验收标准。

## HTML 版本

- [简明部署文档 HTML](./quick-deployment.html)
- [详细部署文档 HTML](./detailed-deployment.html)
- [开发技术文档 HTML](./development-guide.html)
- [部署运维文档 HTML](./deployment-ops-guide.html)
- [用户使用指南 HTML](./user-guide.html)
- [优化清单 HTML](./optimization-checklist.html)
- [详细优化建议 HTML](./optimization-recommendations.html)

## 重新生成 HTML

在项目根目录执行：

```bash
node scripts/generate-docs-html.mjs
```

生成结果会覆盖 `docs/*.html`。
