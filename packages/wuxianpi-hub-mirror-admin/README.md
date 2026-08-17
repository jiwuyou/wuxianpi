# WuxianPi Hub 镜像管理助手

这个 Package 提供一个 Skill，用于管理 WuxianPi Hub 的 OpenHouse Git Mirror。

它不包含 GitHub Token、Hub Admin Token 或 Mirror Token，也不会在 Package 文件中保存任何凭据。

Skill 覆盖：

- 使用当前 GitHub CLI 身份换取 Hub Session Token
- 验证当前 Hub 用户和全局管理员角色
- 列出、创建和修改 Mirror Target
- 立即同步、暂停、恢复和查看同步记录
- 操作完成后撤销 Hub Session

所有新增、修改、同步、暂停、恢复和删除类操作都必须先取得用户明确确认。
