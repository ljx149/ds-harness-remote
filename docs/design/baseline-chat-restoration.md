# 旧版会话能力恢复：评审与实施

基线 f2ea2826 / 0.7.0-xcodex.6；分支 release/baseline-0.7.0-xcodex.5。
用户要求保留旧版体验，重新评审后恢复五项能力，不整笔移植高级管理框架。

## 实施顺序与边界

1. 重启目录：仅在认证恢复后通知会话目录刷新，读取历史不启动 Provider。
2. 流式：明确 delta/final 与稳定 itemId；Host 保持 accumulator，follow 原子快照+订阅；finish 在 durable 之前，工具边界递增 Step；真实 rc.5 页面验收首轮、工具、结束与重连。无后台全局探测。
3. 队列：会话范围 FIFO，持久化入队/取消/消费标记；请求 ID 幂等，未知投递不重发；忙时排队须明确反馈，停止不触发意外自动执行；保留原生消息输入方式。
4. 结构化问题：只接 Agent 请求用户回答的最小接口，不恢复管理面板；问题按会话/账号归属，超时/结束清理，重复回答不可重复发给 Agent；电脑界面必须能看见并回答，移动端协议兼容单独记录。
5. 启动与生命周期：默认继续使用本机环境；自定义配置由 Host 本地定义，仅 ID 跨接口，绑定首次启动后不静默换账号；进程退出确认后才允许重开；空闲回收默认关闭，运行/审批/问题/队列/未知结果不回收。

## 评审发现

- 旧 Codex 仅累计 delta，item/completed 才显示；Claude includePartialMessages=false。这是旧版无流式的直接原因，不能仅加后端 accumulator。
- 之前成功的 fold 单测漏掉浏览器 ConversationAssembler 序号要求，本轮必须对精确 rc.5 原生界面验证。
- 旧业务模块没有高级管理依赖；新恢复功能应作为窄模块加入，禁止引入回退/分叉/目标/MCP 操作。
- 多配置默认不增加用户操作，不在打开历史/列模型时恢复所有会话。

## 验收记录

- [x] 重启登录恢复后 CC/Codex 会话列表可见，读取不额外启动 Agent，账号切换隔离测试通过。
- [x] 精确 DSH `0.2.2-rc.5` 原生网页：受控 Codex 首轮流式、工具、结束即时显示；运行中刷新与结束后刷新；下一轮 FIFO；提问与回答继续执行。
- [x] Claude SDK partial/final 稳定块标识、根会话过滤、AskUserQuestion 回答与取消的适配器测试。
- [x] FIFO、幂等提交、取消/编辑、归档暂停、重启显式恢复、未知投递防重发。
- [x] 本机默认环境、自定义配置隔离、启动字段收窄、关闭失败禁止重复启动、空闲回收护栏。
- [x] TypeScript 检查；插件全量 92 文件 / 757 测试通过。后续集成修复后重跑相关 8 文件 / 84 测试、类型检查、构建与包校验通过。
- [x] Linux / Node.js 24.9.0；仓库外 npm 安装、Host import 与 CLI help；隔离 DSH 试装的 Host 文件逐字节匹配最终 tarball。
- [x] 包扫描 343 个条目，没有 `.env`、`.npmrc`、凭据文件或 `.git`；保留 Orca MIT 许可。
- [ ] 用户 macOS/Windows 实机、真实 Codex/Claude 模型、手机/平板验证。受控 Provider 的回复不代表真实模型验收。

所有测试/构建串行运行于资源硬限制检查组；不停止或修改生产服务。

## 配置与使用

安装包仍使用 `xcodex-remote`，不与 `@xcoder/xagent` 同时启用。沿用插件 ID 和会话目录，不清空已有聊天。新版本为 `0.7.0-xcodex.7`。

- 聊天保持原生输入框。运行中按原生队列方式发送，进入下一轮 FIFO；停止、失败、重启后暂停，点击会话顶部“待发送消息”明确继续。未知投递不自动重发。
- Agent 请求结构化回答时，会话顶部出现“需要你回答”；结束/取消后清除，不永久新增管理面板。
- 本机默认启动不变。仅管理员配置多套本地目录时，新会话菜单显示配置选择；一个会话绑定首次启动目录，不静默换账号。
- `managedAgents.idleTimeoutMs` 默认为 `0`（关闭）。启用后仍须 Provider 明确空闲、Host 没有运行/审批/问题/排队/未知操作才回收。断开查看者不会杀任务。

本机插件配置示例（目录替换为本机绝对路径；这里不存密码或 token）：

```yaml
managedAgents:
  enabled: true
  idleTimeoutMs: 0
  profiles:
    - id: work
      label: 工作账号
      codexHome: /absolute/path/to/codex-work
      claudeConfigDir: /absolute/path/to/claude-work
```

Linux 使用进程启动标记/存活证明，确认退出后才允许重开；macOS/Windows 当前只有进程内防重开与退出确认，跨 Host 崩溃的持久进程身份保护未验证。Host 崩溃不能保证正在执行的模型任务继续运行；历史与队列恢复不等同运行任务恢复。

手机已有原生流和会话接口继续兼容；本轮新增的结构化问答与暂停队列按钮只实现电脑插件 UI，手机对应入口及真机验证待客户端完成。没有修改服务端、Android 或 iOS 代码。

## 本轮集成检查发现并修复的问题

- 进程保护的严格 schema 不能接受整个启动对象；显式传入会话 ID 与 Agent 类型，避免启动模型目录时因额外字段被拒绝。
- 原生 DSH `api-session/added` 不改变已经打开的 Session 的运行状态；同时发布 `api-session/status`，使回合结束恢复发送按钮。
- 新建会话的模型目录必须从已有投影初始化，先恢复保存的选择，刷新后模型菜单仍可加载和切换；目录尚未请求时不把模型判为不可用。
- 模型目录按会话配置读取，Codex 分页读全，不在枚举历史时批量启动 Provider。

本轮多配置仅包含本机 `CODEX_HOME` / `CLAUDE_CONFIG_DIR`，没有引入 SSH / WSL / 容器启动框架。

最终安装包：`xcodex-remote-0.7.0-xcodex.7.tgz`。
SHA-256：`3185b4db367f35ddb313a95bb363ca38f5577ccfab1ae3a4a73b8f6ce6176d33`。
安装时在 DSH 插件管理中使用新包 URL；保持单个 xcodex 插件启用，不与 `@xcoder/xagent` 并行启用。不更改生产服务配置。

隔离页面最后复验包括刷新后模型菜单再次加载/选择；所有检查组已停止，资源已释放。
