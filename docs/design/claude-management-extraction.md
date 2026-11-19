# Claude 管理能力抽取记录

日期：2026-11-19。来源：Orca `81c1f25fe98647365d226aed0254e888d2aa2a98`；保留 MIT 归属，插件不依赖 Orca 桌面进程。

## 来源与落点

- `claude/structured/journal/claude-streamed-block-identity.ts` → `claude-projection.ts`：按 provider session／parent tool／Anthropic message ID／block index 对齐增量和最终块，不以不同的 envelope UUID 建立重复消息。
- `claude/structured/permissions`、`claude-structured-prompt-replies.ts` → adapter：问答与授权分开；稳定 q1/q2 编号，结构化答案转回 SDK 原始问题键；已完成／取消请求不能复用。
- `claude/structured/turns`、`claude-session-state-turn-over.ts` → adapter：正在压缩、未完成问题、真实 provider 状态、后台任务都参与 idle 判定。`result` 不覆盖 SDK 仍为 running 的状态；显式 idle 可结束缺失 result 的轮次。
- `claude/context-usage` → 统一 token/context window 报告；subscription `rate_limit_event` 才可作为额度事件。`accountInfo()` 不是额度查询，不用于冒充额度。
- `claude-structured-options.ts`、原有 `claude-controls.ts` → model／effort／fastMode／permissionMode，MCP 连接、启停、认证回调、命名、后台任务停止和转后台。控制超时不证明失败，不自动重发。
- `claude-command-turn.ts` → `/compact` 独立命令流程，命令期间的隐藏 assistant 内容不混进聊天。排队成功不代表压缩完成，必须等真实 boundary/result。
- `claude-rewind-fork.ts`／`claude-conversation-copy.ts` 的 provider handle 替换语义 → 本机已安装 SDK 的 `forkSession`：只对当前插件拥有的 provider ID 和 workspace 操作。回退为 inclusive checkpoint fork，由 backend CAS 替换 provider ID，旧连接冻结后关闭／重开；绝不使用 `rewindFiles` 冒充对话回退。

## 能力边界

能力按当前 SDK 实际方法和 CLI 命令目录发现；没有方法不发布支持。当前查询只读取本条已拥有的 provider session，不枚举电脑 Agent 历史。检查点需要对应插件 journal，backend 才能暴露／提交；原始 SDK transcript 不能绕开归属。

后台 stop ACK 只回报 requested，不伪装已完成；任务真实事件或完整 membership snapshot 决定终态。原生 Claude 不支持的线程目标没有伪造；没有 quota 事件时不显示 accountUsage。MCP reload 没有可靠 SDK 对应控制，因此不发布。

## 启动配置与限制

`launch.ts` 提供 Host 白名单 profile/home/env 路由，只有名称跨 RPC；凭据不复制、不写日志。会话恢复要求创建时账号和执行位置一致，缺失配置失败关闭，不回退到当前账号。新会话冻结 ownerFingerprint（账号 home、执行位置、工作目录、可执行路径及路由环境的摘要）；同名配置改指向时拒绝恢复。摘要不包含默认继承的轮换 access token，也不暴露给 RPC。旧 host/native 会话允许首次冻结；自定义账号缺绑定不恢复。目录内原地换账号仍需要 Host 正确管理 profile，单纯路径摘要不能证明凭据主体身份。Native 使用真实 `spawn`、独立 cwd/env、`shell:false`；Claude SDK 的 forwarded termination signal 保留其 stdin EOF 宽限路径。

SSH/WSL 的参数构建抽取了 Orca POSIX quoting、SSH option boundary、WSL --exec。仅构造命令**不等于**已迁移 Orca 的远端进程所有权／退出证明。SSH、WSL、daemon 必须有 Host 注册的真实 `process-tree` transport 和精确工作区映射才会暴露；目前未自带 Orca daemon 协议、WSL guest 安装器或 SSH owner lease，因此默认不开放这些位置，不能宣称全套异地执行已完成。

自定义 Claude profile 的 SDK history helpers 在独立 Node 子进程运行，只给该子进程设置对应 CLAUDE_CONFIG_DIR；JSON 请求走 stdin，argv 无凭据，stderr 不记录，仅输出检查点元数据／新 session ID。SDK 仅从插件和 Host 安装路径解析，不从工作区 node_modules 加载。若 bundle-only 安装没有可独立导入的 SDK，则不发布该 profile 的 fork/rewind，不能回退到默认 home。未改全局 process.env。helper 有 30 秒和 2 MiB 输出上限，超时按结果未知处理。

## 验证状态

新增管理和启动测试覆盖流式去重身份、图片、问答、MCP／context schema、任务状态、compact、拥有的 checkpoint、未知写入禁止重试、账号归属及环境隔离、参数转义。此文档编写阶段未运行测试／真实 CLI；由主 agent 在生产机资源上限内串行验证。真实 Claude/Codex、Windows/SSH/WSL/daemon 均需分别记录验收，不能以 mock 结果代替。

## 复核：management adapter 与 execution-host 的边界

直接检查上述 Orca commit 的实际代码，而非根据产品目录推断：

- `src/main/claude/structured/launch/claude-structured-location-support.ts` 的 `supportsClaudeStructuredLocation()` 返回 `isNativeLocalLocation(location)`。
- `src/main/codex/structured/session-lifecycle/codex-structured-session-adapter.ts` 将同一函数别名作为 `supportsLocation`。
- `src/shared/execution-host/execution-host.ts` 的判定严格为 `executionHostId === 'local' && wslDistro === null`。因此两个 structured adapter 原生声明均不接受 SSH、runtime host 或 WSL location。
- 默认 Claude 集成在 `runtime/agent-session/installation/structured-claude-runtime-adapter.ts`，默认连接为 `claude-stream-json-connection.ts`，使用 SDK query、`@orca/process-host` 和 child-tree exit proof。Codex 默认集成在 `structured-agent-runtime-registrations.ts:createCodexAdapter`，通过 `composeStructuredLaunch`、账号 home、CLI 检测及默认 app-server connection 装配；注入 openConnection 是测试／Host 接缝，不等于自带远端 transport。

所以，“抽取 Claude/Codex 管理能力”本身不要求将 Orca 整个 SSH/WSL/daemon 产品复制进插件。若“整个管理框架”还包括远端执行位置、跨平台进程监管，则需要单独迁移下面的基础设施；当前命令构建器和 transport 注册接口绝不计为这部分完成。

### 可完整抽取的模块边界与依赖

| 模块 | 源码边界 | 迁移依赖／现状 |
| --- | --- | --- |
| 管理与投影 | `claude/structured/{journal,turns,permissions}`、`claude/sdk-transport`，Codex `structured` 与 app-server control | 依赖 provider SDK/schema、插件 journal/ownership、统一事件；本轮已接选定控制，真实 Agent 仍需验收 |
| 账号与 launch | `managed-data-accounts/launch-environment.ts`、provider structured launch | 依赖可信账号 home、workspace resolver、可执行文件发现；本轮命名 profile + owner fingerprint 已接，不能代替 Orca 全部账号导入/UI |
| 本机跨平台 spawn | `src/packages/process-host/src` 的 process-spec、spawn-resolution、Windows shim/command-line、termination barrier | Node child_process、Windows shim 检测、WSL allowlist、平台退出证明；当前 shell:false spawn 不是该完整包的替代，Windows 尚未验收 |
| 可靠 provider ownership | `main/provider-process` 的 spawn/supervisor、direct/legacy child、ownership journal、input ownership、retirement proof；Claude `child-process` exit-proof ladder/tree snapshot | 依赖 boot/process identity、原生 supervisor/平台证据、持久 journal、进程组和 descendant proof；本轮模块采用保守阻断，尚非整个 Orca supervisor 迁移 |
| 异地主机／daemon | `main/ssh`、`main/wsl`、`main/orcad`、execution-host 路由与运行环境 | 需要真实连接认证、远端安装/版本协议、workspace mapping、owner lease/重连/retirement、平台打包；未迁移，不开放空 transport |

### 辅助进程及边界复核

图片同时限制数量、单图编码长度和整轮总长度；stream/final 使用同一 provider block identity，失败 result 不生成可用 checkpoint。history helper 的请求在 spawn **之前**完成序列化和 64 KiB 限制，避免编码异常留下子进程。输出以 UTF-8 字节限额 2 MiB，越界后不再累积；超时/越界先 SIGKILL，再等 close。若 2 秒内没有 close，则报告退出与操作结果均未证明，保持禁止自动重试，不声称已回收。Node 无法保证 SIGKILL 在所有系统状态下立即完成，这个限制显式保留；helper 只运行 SDK 文件历史 API，不启动聊天或递归 Agent 任务。helper 自带 32 秒 watchdog，父进程消失时也约束尚未退出的 SDK I/O；主进程崩溃后的持久退出证明仍不是本轮 process ownership ledger 的覆盖范围。

Claude 关闭现在还等待 launch 层跟踪的所有 child root 的 `exit`／`close`（或 Node 已记录的 exitCode/signalCode），不把 `killed=true` 当退出证明。reader 与进程退出共同受 5 秒限制，超时拒绝；关闭观察开始后该 launch plan 禁止再次 spawn。未创建进程的测试 query factory 仍可关闭。这只证明直接 child root，不替代 descendant tree 的完整证明，ownership 恢复仍必须保守阻断未证明的任务。

## 统一验收补充

真实 CLI 结果与兼容降级见 [0.8 验收记录](orca-management-0.8-validation.md)。发布包新增独立 `dist/claude-history-sdk.js`，profile helper 优先加载随包 SDK；上述 bundle-only 缺少外置 SDK 的限制已解决。旧 Claude 不响应 getSettings/getContextUsage 时有短超时及明确不可用状态，不阻塞整个管理页面。
