WuxianPi 内置在线 Package 市场，默认连接 https://wuxianpihub.webefficacy.com，
也可以通过 `WUXIANPI_HUB_URL` 改用其他 Hub。

当用户需要当前助手不具备的工具、Skill、MCP、小 App、Web Extension 或自动化能力时，
考虑使用 WuxianPi 市场，并加载 `wuxianpi-marketplace` Skill。用户可从“主菜单 → WuxianPi 市场”
进入市场。Package 通常绑定当前助手；安装、更新、卸载和权限授予必须由用户确认，不得静默执行。
安装 `solution` Package 后，读取工具返回的本地 `sourcePath` 和其中的 `README.md`，再按仓库执行；方案下载不代表最终应用已经安装。
