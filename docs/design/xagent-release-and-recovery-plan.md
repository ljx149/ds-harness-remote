# Xagent 发布、更新与跨平台恢复计划

2026-11-20，基于 `feat/orca-agent-management`。

## 已确认方向与发布阻塞

用户指定新包名 xagent，并要求完善更新与剩余 Agent 管理能力。2026-11-20 只读查询公共 npm 返回：xagent 已存在，latest=0.0.0，维护者 hyj1991。本机 npm whoami 未成功，自建 registry.xcodex.vip 也未连接成功。不得覆盖第三方包。待用户确认自有 scope、自建 registry 或现有 xagent 的发布权后，再确定最终 package.name、模块名和更新地址；不能擅自改为其他名称。

迁移要保留原 Component 身份、账号/设备密钥、数据目录和会话归属。旧 xcodex-remote 安装来源不能仅靠改 package.name 自动变成 registry 安装。需要旧来源迁移指引、同机防重复加载、一次迁移安装，再使用 DSH 原生 registry 更新。无需悄悄卸载官方插件或重置配对。

## 单包与系统适配

优先一个 npm 包供 Windows、macOS、Linux 使用，不设仅 Linux 的 os 限制。JS/界面/协议代码共用；进程启动、CLI 查找、Windows shim、退出证明和恢复分别实现。原生可选依赖交给其平台分发机制，不能把 Linux 编译产物当跨平台产物。支持声明必须分别记录真实系统和 Node 版本。

现阶段 Linux 已有真实 Claude/Codex 对话及分叉验证；macOS/Windows 的完整持久恢复尚未完成。统一包不等于跨系统验收通过。

## 本轮独立完成的维护改进

新增 `managedAgents.idleTimeoutMs`，0 为关闭（默认，保持升级行为），可配置 1..86400000 毫秒。Host 每分钟串行检查自己的 route，不按设备在线数/页面开关回收任务。检查 provider 前后均验证 Host 无队列、审批、结构化问题、在途或未知操作；provider 必须明确 idle 且 generation/activity 未变。provider 检查最多三秒，超时跳过而非强杀；关闭失败保留 ownership 阻断重复启动。Host 关闭或维护取消会停止定时器。

Codex 的空闲回收额外核对后台终端、拥有的子 Agent、线程目标。没有足够 CLI 查询能力返回 unknown；前台空闲不能证明目标任务已完成。此限制不影响普通检查点/状态查询。

## 接下来的实现与验收顺序

1. 确认 registry/package 发布权；迁移包身份、发行工作流、更新源、文档，保留现有数据身份。
2. 生成同一份可审计 tgz；隔离安装后以发布账号上传，再用匿名环境下载；验收 DSH 内更新、失败回滚与任务保护。GitHub 更新提示与 registry 安装更新分别测试。
3. 先补跨平台身份/进程退出证明，再设计崩溃接管。没有可信身份不能依据复用 PID 或一条过期记录杀进程；无法接回现有 stdio 时不能假装已恢复仍在运行的任务。
4. 为未知操作提供有证据的核对流程；没有 provider/journal 证据不能直接清除 unknown 并重发。必须区分已执行、明确未执行和无法判定。
5. 真实 macOS/Windows、桌面/手机/平板、审批/MCP/后台任务/目标矩阵验收。无目标系统或测试设备的项目保持待验收。

本轮不改生产服务、Nginx、DNS或证书。测试串行两核、进程树最多4GiB且不超过启动时空闲内存三分之一。

## 2026-11-20 本轮检查

94 个插件测试文件、798 项测试通过（含定时维护取消、在途 probe 竞态、probe 超时、Codex 后台任务/目标保护）。源码/测试类型检查、版本同步、插件 bundle 构建/校验及 git diff --check 通过。未生成新 Release，未改最终包名；旧 0.8 tgz 仍对应此前 40a5448a，不含本轮后续维护改进。
