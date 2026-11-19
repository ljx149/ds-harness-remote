# Orca Agent 管理能力迁移与验收计划

记录日期：2026-11-19。开发分支 `feat/orca-agent-management`。
参考 Orca 提交 `81c1f25fe98647365d226aed0254e888d2aa2a98`，不是通过 Orca 桌面进程桥接。
前次已发布差距审计见 [orca-agent-management-gap-audit.md](orca-agent-management-gap-audit.md)。
本文记录本轮进行中的迁移契约；“写了代码”“接口贯通”“真实 CLI 验证”是三种状态，不互相代替。

## 目标和约束

电脑插件持有、管理 Agent 进程，原生 DSH 工作区列表呈现这些会话；插件设置页继续负责登录和设备管理。手机/平板订阅同一会话，不另建 Agent。撤销查看设备、关闭管理面板、离开聊天页不应停止 Host 正在执行的任务。
只管理插件自己创建或登记的会话，不扫描导入用户全部 Agent 历史。工作目录、账号、provider handle 的归属由 Host 校验。

所有真实可用能力必须同时满足：provider 实现、Host 授权/持久化/幂等、原生入口、协议一致、回归检查。单纯把 capabilities 改成 true 不算完成。

## Orca 源码库存

主要接口：`src/main/native-chat/agent-session-wire/providers/structured-agent-session-adapter.ts`。
Agent 声明：`src/main/claude/structured/claude-structured-agent-definition.ts`、`src/main/codex/structured/launch/codex-structured-agent-definition.ts`。

| 能力层 | Orca 具体职责 | 本轮实现/验收边界 |
| --- | --- | --- |
| Provider 生命周期 | acquire/open/releaseAcquisition；spawn token、fence、acquisition generation、子进程退出证据 | 现有插件有单 Host runtime、opening singleflight、旧回调隔离；不是完整持久租约和崩溃恢复。需逐项迁移启动、关闭与异常恢复语义 |
| 调度和投递 | dispatch、heldSends、admitFreshInput、beforeDispatch、执行选项快照；拒绝与未知投递不同 | 已有基础去重回执；本轮追加 steering/queue 等时必须保留 unknown 不自动重发，不能把传输队列当用户队列 |
| 会话操作 | prepareRewind/recoverRewind/rewind/forkForRewind/copyConversation | 本轮接管理接口和真实检查点选择。落地必须同步 provider 历史、插件 journal 与新会话归属；CLI ACK 不能代替恢复验收 |
| 上下文 | compact、压缩摘要要求、后台任务协调、context usage | 按 provider 能力开放。Claude 声明支持 instructions/background，Codex 未声明额外摘要要求；不能把两者共用为一个无条件按钮 |
| 线程目标 | changeThreadGoal，替换规则和执行选项 | Orca Codex 支持，Claude 不支持。只按 operations 开放目标读取/设置/清除 |
| 消息交互 | 流式 translator、工具事件、审批和结构化 question answer | 本轮应接问题选择/多选/文本回答；流式仍走原生 DSH 消息链路，管理页不能替代聊天 |
| 选项和权限 | setOption、projectOptions、permission transition、requiresModelTransitionRestart | 真实 options/choices 决定界面；不能从模型名推断权限和推理强度。会话执行中转换还需独立验证 |
| 账号和用量 | accountHome、accountRecipe、账号额度/限流读取 | 不默认读取或展示凭据；配置选择必须是 Host 提供的命名 profile。已有会话不能无提示改账号归属 |
| 执行环境 | supportsLocation、执行位置路由、远端进程 ownership | 本机是现有基础；Orca SSH/WSL/daemon 不能因 UI 有位置选择而视为已支持 |
| MCP | manageMcp，读取、重连、开关、授权、配置重载 | 本轮接真实 provider 管理结果和结构化列表；认证回跳要独立验证，URL 不等于 OAuth 已完成 |
| 后台工作 | 任务列表/子任务、定向停止、转后台、idle confirmation | 只能停止当前会话拥有的 task/tool；停止请求确认与进程/任务已停止应区分 |
| 维护和恢复 | lease renewer、idle sweep、startup recovery、taking over、退出证据 | 后续必须明确测试进程被杀、Host 重启、未知子进程状态、旧 generation 迟到事件；超时本身不是空闲/退出证据 |
| 辅助能力 | 原生命令、名称同步、独立 generateText、自动审查拒绝确认 | 独立命名已存在；命令发现/名称同步等本轮按实际实现补全。自动审查拒绝的确认不能默认为允许 |

## 原生电脑入口及协议

新增 `packages/plugin/src/client/managed-agent-management.ts`，注册官方实际存在的
`conversation.session.header.utilities` slot（官方 session-log-export 也使用它）。
从 `retainedBy.mainView` 的当前原生会话定位；用 managed 投影或权威 catalog 识别，原生 DSH 会话不显示。
使用可滚动原生 dialog，关闭只结束界面，不调用 stop/close。

发现：`managedAgent/management`，请求 `{request:{sessionId}}`。
返回 `{operations:string[],busy:boolean,state:{checkpoints,questions,lifecycle,...}}`。
每个功能只按 operations 显示，额外字段缺失不编造为 0、未安装或已完成。

调用：`managedAgent/manage`，请求 `{request:{sessionId,operation,operationId?,payload:{...}}}`。
读取无需 operationId；修改必须稳定 UUID。界面收到不确定结果后，相同 session/operation/payload 重试复用 UUID，成功确认后才能结束该次意图。Host 仍必须持久化校验和幂等。
界面将 canonical(session/operation/payload) 的 SHA-256 作为 sessionStorage 键，仅保存 operation UUID；不保存答案、授权 code 或原 payload。刷新后相同意图恢复 UUID，成功清除。存储不可用时降级为内存并提示不要刷新后重复提交。Host 返回 unresolvedOperations 时，界面拒绝新的修改意图，仅允许匹配原回执的重试；关闭浏览器后恢复及跨设备回执接管仍需单独验收。

结构化数据约定：

- `state.checkpoints: [{id,title,turnId?,messageId?}]`；回退/分叉传 `{checkpointId}`，Host 转换真实 provider 标识。tip fork 由 Host 判断是否允许空 payload。
- `context: {usedTokens?,contextWindow?,remainingTokens?,percent?}`。
- `accountUsage: {windows:[{name,usedPercent,resetsAt?}],message?}`；未知值不显示假零。
- `commands: {commands:[{name,description?,argumentHint?}]}`；列表展示不冒充已执行命令。
- `settings: {model?,reasoningEffort?,permissionMode?,options?:[{key,label,value,choices:[{value,label}]}]}`；只有真实 choices 才显示设置选择，下发 `option.set {key,value}`。
- `goal.read: {goal:{objective,status,tokenBudget?}}`；`goal.set {objective}`、`goal.clear {}`。
- `mcp.list: {servers:[{name,status,enabled?,authUrl?}]}`；授权 URL 仅允许 http(s) 链接，不执行任意 scheme。
- `tasks.list: {tasks:[{id,title,status,toolUseId?}]}`；停止传 taskId，转后台仅对明确有 toolUseId 的项目提供。
- `state.questions: [{requestId,title,questions:[{id,question,options:[{label,description}],multiSelect}]}]`；回答 `{requestId,answers:{[questionId]:string[]}}`，Host 映射 provider 原问题标识。
- 空会话发现不自动启动 CLI，先提供 `launch.options/launch.select/launch.open`；点击“启动 Agent 并读取能力”才执行 `launch.open` 并重新发现。
- `launch.options: {profiles:[{id,name}],locations:[{id,name}],selectedProfileId?,selectedLocationId?,canSelect}`；只有明确 `canSelect:true` 且有 `launch.select` 才可保存。已有会话默认保留账号与执行位置。

## 分阶段完成标准

1. **契约和 provider 管理**：每个 operation 对应真实 SDK/app-server 调用，旧 CLI 不支持时不宣告；问题、任务、MCP、用量等标准化，拒绝任意 task/thread ID。
2. **Host 管理语义**：归属检查、稳定修改回执、串行/忙碌规则、断线恢复；回退/分叉后更新 journal/provider handle；账号/位置选择不跨既有归属。
3. **原生界面**：当前会话入口、能力门控、结构化表单、可理解错误；真实 checkpoint 与配置选项，不做原始 JSON 调试页。
4. **生命周期完整迁移**：逐项补 lease/fence、启动恢复、退出证据、空闲回收、后台任务协调；不要把本轮管理 UI 完成等同此层完成。
5. **验收发布**：定向自动化、隔离真实 Claude/Codex、电脑原生 UI、手机/平板双端、断线与设备撤权。明确每个 Agent/平台支持矩阵，再发布新版。

## 当前验证记录

本轮实现及最终验收见 [orca-management-0.8-validation.md](orca-management-0.8-validation.md)。下文保留设计过程和边界，不以早期“待检查”代替最终结果。
不得据此标记“完整 Orca 管理框架已迁移”。线上服务、Nginx、证书和 DNS 不在本轮变更范围。

## 本轮生命周期补强（源码已写，运行结果待补）

`managed-agents/runtime.ts` 新增内存 Host owner/generation fence 与 `status(sessionId)`：starting、ready、closing、blocked、absent。
关闭只有 provider 的 close Promise 成功后才释放 route；失败或截止时间超时保留 blocked，不允许同 session 再启动另一子进程。unavailable 回调先发起清理，再等待清理完成后恢复。旧 connection 的发送/审批/管理入口受 generation guard 限制。

`cleanupIdle(sessionId,idleForMs)` 仅供 Host 显式维护调用，不挂接 viewer 数量或前端页面生命周期；必须得到当前 provider 明确的 idle，并确认等待期间无新活动，才进行有界清理。未知、忙碌、读取失败均不回收。

当前 open 失败没有携带“从未 spawn / 已确认清理”的结构化证据，保守进入 blocked。后续需要 provider 返回可核验的启动/退出结果，才能安全自动重试；不以错误文案或 PID 推断。
这些是当前进程内的防重入保护，不是已完成 Orca 的持久租约、跨进程 fence、遗留子进程领养或 SSH/WSL 进程监管。Linux 进程重启证据见后面的 ownership 实现；macOS/Windows 和活进程重新接管仍未完成。

回退成功后，电脑界面对当前 retained binding 的原生 Session.resync() 做能力检测并刷新历史，再刷新 projections；不是刷新整页或仅刷新目录。当前 DSH 0.2.2 具体实现提供此方法，但公共 SessionFace 未声明，后续版本若缺失会明确提示重新打开会话而不重复执行回退。

## Linux 持久进程 ownership（后续本轮新增，待统一检查）

新增 `managed-agents/process-ownership.ts`：在 ManagedSessionStore 排他锁范围内创建独立私有子目录。
`forSession({sessionId,agent})` 装饰本机 spawn，在调用 spawn 前 fsync reservation（fence/spawn marker），spawn 事件后记录 Linux PID/start ticks/boot ID/UID。仅保存随机标记及身份元数据，不保存命令参数、对话、凭据或完整环境。

重启恢复先核对 incarnation 和继承标记，再检查存活后代；根进程 exit 不能独自证明整棵任务树已退出。
结果区分 absent/exited/live-owned/blocked，只有有退出/不存在证据才允许重新启动。记录损坏、扫描不完整、同 incarnation 变更 UID、标记不匹配均阻断。
模块不会 signal/kill PID：纯 Node 没有原子 pidfd 信号接口，不能把 check-then-kill 当成无 PID 复用风险的安全回收。存在仍活跃旧进程时报告 blocked，等待拥有句柄的执行者完成清理。

当前证据实现仅 Linux `/proc`，宿主入口只在 Linux 注入；macOS 等平台保留已有 Host 生命周期运行能力，明确缺少跨进程 ownership 恢复，而不是假装复用 Linux 证据。变更身份/清除继承 marker 的任意后台后代、不完整 `/proc` 可见性不能宣称可完整恢复，仍需更强执行树隔离支持。
未运行真实 kill/spawn 检查；单测使用 fake ChildProcess 和 fake evidence，不会触碰当前服务。
