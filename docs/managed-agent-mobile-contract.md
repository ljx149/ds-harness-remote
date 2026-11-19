# 手机端托管 Agent 协议适配（2026-11-19）

## 范围

基于插件 `0.7.0-xcodex.4`，补充 Android / iOS 的能力发现契约与直接续接修复。本次不修改远程登录、中继服务、Nginx、DNS 或任何服务启动配置。代码尚不代表已发布的新插件包。

- 手机 `managedAgent/agents` 读取已注册 Agent 的 id、name、icon、capabilities。`available` / `registered` 只表示注册；`availability: unverified` 不承诺 CLI 已安装或已登录。
- `managedAgent/create` 请求的 `request` 对象包含 `workspaceId`、`agentId`、`operationId`；客户端显式重试必须复用同一 operationId，不得回退原生 `session/create`。
- 列表及 follow 快照使用 `projections.values.managedAgent` 提供身份与能力；手机不能根据标题或模型名猜 Agent。
- 会话模型使用 `session/modelCatalog`，带 `request.sessionId`；无 sessionId 的原生全局目录不改变。
- 支持文本、模型选择、重命名、归档和恢复；Codex 推理强度由其目录提供。当前不支持托管附件、插话/排队、置顶、工作区移动、分叉、回退、压缩、线程目标及完整上下文用量。
- 非空附件收据明确返回 `MANAGED_ATTACHMENTS_NOT_SUPPORTED`，不能静默丢弃。
- Host 重启后，可信 owner 直接按会话 ID follow 时先恢复持久化会话归属，避免错误落到原生处理器。非 owner 不触发此发现，既有所有权检查保留。

## 验证与发布待办

- 后端与网关定向单测：36 项通过；`tsc --noEmit` 通过。
- 手机两仓库分支：`feat/xcodex-managed-agents`；各自 `docs/managed-agent-mobile.md` 记录基线、自动化结果和真机待办。
- 待构建/发布包含此协议的插件包，并与新 Android/iOS 安装包进行真实账号、双端消息、断线恢复、单设备撤销验收。
- 不将单测结果当成真机、真实 CLI 或线上部署通过。
