# Xagent 当前范围与安装

更新：2026-11-20。测试版 `@xcoder/xagent@0.8.1-xagent.3`；分支 `feat/orca-agent-management`，源码提交以 Release 标签为准。

## 现在做什么

Xagent 是 DSH 的多 Agent 会话中间层，不是另一套 Agent 控制台，也不需要运行 Orca 桌面应用。

- 当前工作目录新建和继续 Claude Code/Codex 会话，与 DSH 会话并列，按 Agent 显示标识。
- 会话按工作区隔离，不导入插件之外的历史；支持自动命名、重命名、归档/恢复。
- 使用电脑上的 CLI 配置，保留原生模型/推理强度选择、发送、停止及权限审批接口。
- 保存 Provider 会话身份、消息和操作回执；队列、去重、防重复启动和身份隔离继续保留。
- 沿用账号登录、设备管理和多端通信；保留重启后登录恢复触发会话目录刷新的修复。

## 这版回退了什么

删除 Agent 管理面板，收回手动上下文/额度/命令查询、压缩、回退/分叉、线程目标、MCP 和后台任务管理等对外操作。Agent 自身仍可执行其内部行为。

不是整笔撤销混合提交：聊天依赖的底层适配与持久化兼容保留。详见 [逐提交拆分说明](design/xagent-conversation-scope-rollback.md)。

## 仍需完成

- 用户电脑真实安装升级、退出重开后旧会话显示及继续聊天验证；本机测试不等于用户数据已恢复。
- 手机/电脑同会话双向消息、断网恢复、单设备撤权真实联调。
- 跨平台进程恢复及未知操作结果的安全核对流程。
- npm 发布及 DSH 内更新。当前只有版本检测，不能保证点一下完成安装。
- 结构化问题回答协议保留，但本轮没有新增专用问题界面或完成其真机验收。

此前 Linux Node 24.9.0 上的 Claude/Codex 真实启动/回复已通过；不等于 macOS/Windows 和全部多端场景通过。高级面板不再作为后续待补全目标。

## 安装测试版

[发行页](https://github.com/ljx149/ds-harness-remote/releases/tag/xagent-0.8.1-xagent.3)

[下载 tgz](https://github.com/ljx149/ds-harness-remote/releases/download/xagent-0.8.1-xagent.3/xcoder-xagent-0.8.1-xagent.3.tgz)

先结束本机正在运行的 Agent 任务，再更新插件；不要清理账号和会话数据。若仍使用旧包名 Xcodex Remote，先停用旧测试插件，避免同时加载。

```sh
dsh plugin --profile web add -w /完整路径/xcoder-xagent-0.8.1-xagent.3.tgz
```

自定义 profile 请替换 `web`；更新后必要时重开对应 DSH 实例。此包还未发布 npm，不能按 npm 包名下载。单独 npm 全局安装也不等于注册进 DSH。

本轮测试、校验值及发布记录见上述拆分文档；历史验收见 [0.8 记录](design/orca-management-0.8-validation.md) 和 [重启修复记录](design/xagent-restart-catalog-fix.md)。
