# Xcodex Remote 0.7.0-xcodex.1 测试版

在 DSH 原生侧栏按工作区创建和继续 Codex / Claude 会话，区分 Agent Logo，使用本机 CLI 模型目录。插件页面仅保留登录相关内容。新功能默认开启；显式 managedAgents.enabled=false 仍生效。

验证：原生 DSH 0.2.2 隔离界面、测试 Provider 聊天、模型菜单和目录隔离通过；真实 Claude 回复通过。真实 Codex 在当前测试机启动失败；手机/平板真机、原生审批 UI 和 Orca 高级管理迁移仍未完成。

安装：在 DSH 插件管理页使用附件 tgz 地址安装 xcodex-remote。同名旧版若提示已安装，需先移除旧插件再安装新版（会停止电脑插件的任务，请等会话结束再操作）。本次不更换插件标识，不修改官方插件。

DSH 原生更新按钮只支持 registry 来源。当前包尚未发布 npm；之前 tgz 安装不会自动出现更新按钮。后续需发布 npm 并一次性切换安装来源。

SHA-256: e09f0fffc01777a5cf42f8d0b2a3dbdcb84e821d812656b32918cd73ecc7ce3a

发布目标：用户 fork 的 feat/orca-agent-management 分支及同名版本 GitHub prerelease。生产服务不在本次变更范围。
