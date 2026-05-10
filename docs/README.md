# VirtualWebCam 文档中心

本目录保存 VirtualWebCam 项目的正式交付文档。Markdown 是源文档，HTML 是面向验收、交付和离线阅读的发布格式。

## 文档清单

- [开发技术文档](./development-guide.md)：面向研发，说明系统架构、代码分层、容器内部流程、API、数据库和扩展方式。
- [部署运维文档](./deployment-ops-guide.md)：面向部署和运维，说明 Docker、macvlan、管理后台、验证、升级、备份和故障处理。
- [用户使用指南](./user-guide.md)：面向业务用户和现场实施人员，说明项目、摄像头、矩阵绑定和日常操作。

## HTML 版本

- [开发技术文档 HTML](./development-guide.html)
- [部署运维文档 HTML](./deployment-ops-guide.html)
- [用户使用指南 HTML](./user-guide.html)

## 重新生成 HTML

在项目根目录执行：

```bash
node scripts/generate-docs-html.mjs
```

生成结果会覆盖 `docs/*.html`。

