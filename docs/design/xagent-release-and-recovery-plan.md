# Xagent 发布、更新与跨平台恢复计划

2026-11-20，基于 `feat/orca-agent-management`。

## 已确认方向与发布阻塞

用户确认组织 Xcoder，最终包名 `@xcoder/xagent`、显示名 Xagent。公开 registry 查询未发现该包，本机 npm whoami 返回 ENEEDAUTH；这不代表已确认组织所有权。源码身份迁移至 0.8.1-xagent.1，发布需要组织的写权限。公共 xagent 属于第三方，绝不覆盖。

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

## Scoped 包迁移

新版本检查优先匿名读取 @xcoder/xagent 的 npm dist-tags，预览版允许 next，稳定版仅 latest；不可达时回退本 fork 的已上传 GitHub Release 资产。支持新旧资产名。显示更新通知不等于自动安装。已有 tgz 用户需一次迁移安装；发布完成后在 DSH 包安装器使用 `@xcoder/xagent@next`。保留 xcodex-remote 命令别名、Component、Cordis 实例、设置及凭据目录。

## 0.8.1-xagent.1 验证记录

- Linux，Node.js 24.9.0；插件全量 94 文件 / 801 tests 通过。新增 scoped 自保护场景后单独复验 bridge 37 tests 通过。
- 源码/测试类型检查、版本同步、bundle 构建/校验、git diff --check 通过。测试串行两核，受内存监控限制。
- `pnpm pack`：`/tmp/xagent-release-0.8.1-xagent.1/xcoder-xagent-0.8.1-xagent.1.tgz`。
- SHA-256：`2a0c863ecde38a39fb73e687374c47f123598c15a69982a89d118eef5198ede2`。
- 354 个包内文件；入口、独立 Claude SDK helper、许可文件存在；未发现 .env、.npmrc、凭据/状态文件名。
- 仓库外 npm 安装通过（ignore-scripts、legacy-peer-deps、omit=optional）；命令帮助与 Host import 通过。Host peer 来自隔离 Harness 安装，不依赖仓库；未验收原生可选 WebRTC 安装脚本。
- 同一 tgz 的 npm publish dry-run 通过，实际发布因 ENEEDAUTH 未执行。不能使用包名下载；未确认 npm 组织写权限。
- 未做真实 DSH 内升级/失败回滚、macOS/Windows、手机真机验收，未更改生产服务。
- 上游整套 release.yml 面向全仓统一版本（v 标签及移动端），本轮插件预览不触发它；后续应发布上述同一已验证 tgz，tag next。
