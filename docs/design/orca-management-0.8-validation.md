# Orca 管理能力迁移：0.8.0-xcodex.1

日期：2026-11-19；分支 `feat/orca-agent-management`；Orca 来源 `81c1f25fe98647365d226aed0254e888d2aa2a98`。

## 交付边界

此前入口/Logo 修复已通过 `c92b8444` 推送并发布 `0.7.0-xcodex.5`。本轮继续将 Agent 管理代码放进插件，不启动或桥接 Orca 桌面应用。服务端、Nginx、DNS、证书、生产进程保持原样。`0.8.0-xcodex.1` 为开发测试版本，Git 提交或本地打包不等于已发布给所有用户。

当前已具备下面的管理路径，但**不能把本轮交付称为完整 Orca 框架迁移验收完成**。跨平台崩溃恢复、真实手机/平板及全部高级动作的验收仍有明确待办。

## 实现清单

| 层级 | 已实现 | 使用限制 |
| --- | --- | --- |
| 原生界面 | 当前会话标题区管理入口；能力门控、滚动表单、问题回答、目标暂停/继续、MCP 授权 | 插件设置页仍负责登录和设备管理；原生 DSH 会话不加管理入口 |
| Provider | Claude SDK / Codex app-server；上下文、配置、压缩、检查点、回退/分叉、命名、目标、MCP、后台任务 | 按实际 SDK/CLI 暴露；不同 Agent 不假装支持相同功能 |
| 消息投递 | 稳定增量/最终块去重、图片、steering、持久队列、断线后重放 journal | 未知投递禁止自动重发；文件上传仍不冒充图片支持 |
| 归属 | 工作区/账号/会话校验、同一 provider ID 续接、只操作插件拥有的历史/子任务 | 不扫描导入其他 Agent 历史 |
| 数据一致性 | fork 身份+历史+回执原子发布；rewind 身份+历史标记+回执原子提交 | 回退改变 Agent 上下文，原消息保留为审计历史，界面明确说明 |
| 启动配置 | 本机 profile、Claude/Codex home、身份指纹、会话建立后禁止换账号 | 原 Orca 这两个 structured adapter 本身仅支持 native-local；SSH/WSL/daemon 属于外围设施 |
| 生命周期 | singleflight、generation fence、过期连接拒绝、关闭等待真实 exit/close、Linux 持久 ownership | 无退出证据时阻断新启动，不按 PID 猜测或误杀；非完整跨平台进程接管 |
| 安装包 | Host/client bundle、独立 Claude history SDK、Orca MIT 许可 | 仓库外包入口只依赖 DSH 提供的共享 peer；历史 helper 不依赖仓库外置 SDK |

## 自动化与构建

最终全量 **94 个文件、794 项测试通过**。源码/测试 TypeScript 检查、版本同步、bundles 构建、DSH package 校验和 git diff --check 通过。新增用例覆盖原子 fork/rewind、Provider 返回值规范化、旧 Claude 控制请求兼容、进程退出与租用边界。

最终 tgz 在仓库外解包，Host 入口和独立 history SDK 成功导入；仅借用已有 DSH 安装的共享 connection peer，未借用仓库 node_modules。包内 23 个文件，白名单中无 .env、凭据或本机配置。不是完整 DSH 真机安装验收。
资源限制：两核、nice 15、进程树内存不超过 4 GiB 或启动时空闲内存三分之一；空闲内存不足 4 GiB 时仅停止测试进程组。没有重启或停止现有服务。

## 真实 Agent 验证

环境：Linux x86_64，Node.js 24.9.0；Claude Code 2.1.179；Codex 0.153.4。
每次创建独立临时工作区和新会话，只发送要求回复 OK、不得使用工具或修改文件的测试消息；没有对已有会话进行回退、分叉或中断。

- **Claude**：真实启动、发送、完整回复、检查点读取、命令列表、设置、任务列表（空列表）、新测试会话的分叉通过；close 完成并正常退出。
- **Claude 版本兼容**：此机 CLI 不响应 SDK 的新 getContextUsage/getSettings 控制请求。已增加短超时与会话内兼容降级：上下文显示 unavailable，设置继续使用实际模型列表和已知默认值。不将累计计费 token 伪装成上下文用量。降级后管理流程和分叉通过。
- **Codex**：真实启动、发送、完整回复、检查点、上下文、命令列表、设置、新测试会话分叉通过；close 完成并正常退出。
- **Codex 初次失败解释**：受限执行环境将其运行目录设为只读，app-server 在握手前退出（stderr 分类为 read-only file system）。允许独立测试进程写 CLI 自身运行状态后复验通过。未改 Codex 配置，未以空 CODEX_HOME 绕过真实配置。
- **不是已验收**：回退后的多端显示/续聊、实际图片、工具审批、目标自主执行、MCP 真实 OAuth、带运行任务的停止/后台化、额度限制触发、全部平台。单测与上述单轮 smoke 不替代这些场景。

## 后续必须完成

1. macOS/Windows 持久进程证据、活进程崩溃后接管、自动空闲维护策略。目前提供显式 cleanupIdle，并要求 provider 新鲜 idle 确认；未接自动定时回收。
2. 未知操作的用户核对/恢复流程。当前严格保留未知回执、防重复投递，不提供猜测成功或清空锁按钮。
3. 用户电脑原生 DSH 页面、手机/平板同会话、跨工作区隔离、断网重连和单设备撤权真实验收。
4. 对各 CLI 版本跑完整高级管理矩阵。Codex 当前 schema 不提供的操作不宣告；不支持 token budget 或自定义压缩指令时明确拒绝。
5. 此版本的下载发布/安装升级验收与服务端上线分别记录；本轮未触碰生产服务。

设计与协议见 [completion plan](orca-management-completion-plan.md)，Claude 详细来源见 [extraction](claude-management-extraction.md)，Codex 见 `packages/plugin/src/managed-agents/CODEX-MANAGEMENT.md`。

## 本地测试包

- 路径：`/tmp/xcodex-plugin-release-0.8.0-xcodex.1/xcodex-remote-0.8.0-xcodex.1.tgz`
- SHA-256：`c693e220252ca2618b28a6f6a63f3abdcb5c0dddbf15208b3a8958f1037ba953`
- 尚未创建 0.8 GitHub Release，未改变用户安装的版本或生产服务。
