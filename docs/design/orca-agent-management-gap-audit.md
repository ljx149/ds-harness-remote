# Orca Agent 管理层接入差距

核对日期：2026-11-19。Orca 源码基线 `81c1f25fe98647365d226aed0254e888d2aa2a98`；插件基线 `528462c5` / `0.7.0-xcodex.3`，分支 `feat/orca-agent-management`。本记录是源码对照，不代表真机验收。

## 目标与当前定位

将 Orca 的 Agent 管理能力抽取到插件内，使用 DSH 当前工作区的原生会话列表；不桥接 Orca 桌面应用，不导入插件之外的 Agent 历史。当前实现了基础聊天执行部分和 DSH 集成，尚未完成整个中间层迁移。函数已复制、接口有声明、用户可实际使用是三个不同状态。

## 已有基础实现

Agent 注册和能力校验；Host 持有进程；Claude SDK/Codex app-server 创建与按已登记 ID 恢复；文本消息、工具事件、基础审批、取消；会话归属、消息事件、投递回执和去重；工作区侧栏、模型选择、标题和归档恢复。Claude 实际回复和摘要命名通过；当前服务器 Codex 真实执行仍被本机启动环境阻断。

## 差距清单

| 能力 | 当前插件差距 |
| --- | --- |
| 对话回退、按检查点分叉 | 只有可选接口占位，适配器和 DSH 操作未接通 |
| 上下文压缩 | 未接，包括压缩指令和后台任务协调 |
| 线程目标 | 未接；Orca Codex 声明支持，Claude 声明不支持，不能一概开放 |
| 上下文用量、账号额度/限流状态 | 未接完整读取和展示 |
| 图片输入 | 托管会话输入目前仅文本 |
| 执行中追加指令、消息排队 | 未接完整；忙时拒绝发送，不能把内部传输队列当作用户消息排队 |
| 逐段流式输出 | 部分接入，主要发布完整消息块，未完整迁移增量投影 |
| Agent 主动提问 | 基础允许/拒绝审批已有，问题、选项和回答流程不完整 |
| 权限和执行选项 | 模型、Codex 推理强度已有；Claude 推理强度切换、权限模式转换未完整接入 |
| 后台任务、子 Agent 管理 | 未接任务列表、状态追踪、转后台、定向停止 |
| MCP 管理 | Claude 控制函数已复制但未贯通插件接口/UI；Codex 管理未迁移 |
| 账号目录和配置切换 | 沿用电脑现有配置，未迁移 Orca 账号隔离和路由 |
| 生命周期和恢复 | 有基础持久化和关闭；缺完整租约/进程所有权、启动恢复、崩溃状态核对、空闲回收等 |
| 执行位置 | 本机执行为主；守护进程、SSH、WSL 等未迁移 |
| 原生命令和名称同步 | 命令发现未完整接入；插件重命名未同步到底层 Agent 会话名称 |

## 源码依据

Orca：`src/main/native-chat/agent-session-wire/providers/structured-agent-session-adapter.ts`、`src/main/claude/structured/claude-structured-agent-definition.ts`、`src/main/codex/structured/launch/codex-structured-agent-definition.ts`，以及同层 startup、delivery、recovery、termination、observations 模块。

插件：`packages/plugin/src/managed-agents/{types,runtime,claude-adapter,codex-adapter,claude-controls}.ts`、`managed-agent-backend.ts`、`managed-session-store/index.ts`。迁移出处和 MIT 声明见 `packages/plugin/src/managed-agents/EXTRACTION.md`。

## 建议顺序与待验收

1. 先补逐段输出、执行中交互、主动提问和生命周期恢复。
2. 再补用量、压缩、回退/分叉；按 Agent 的真实能力声明开放。
3. 再接 MCP、后台任务、账号配置和不同执行位置。
4. 每项需要适配器、持久化/授权、DSH 原生入口和测试贯通，不能只修改能力标志。

手机/平板同会话互通、断线去重、单设备撤权、macOS/Windows 真机及真实 Codex 仍待验收。后续完成项应同时更新本表和 docs/TODO.md。
