# DSH rc.5 模型目录与实时消息回归排查

日期：2026-11-20。用户环境：DSH 0.2.2-rc.5、插件 0.8.1-xagent.3。
分支：feat/orca-agent-management。本文保留最初检查点，并在末尾记录继续验证的结果。

## 已定位

1. 全局模型目录跳过未绑定 providerSessionId 的新会话，并遍历恢复其他历史会话。导致新会话缺少模型，以及 Claude 的全局下拉目录混入 Codex 探测失败。
2. 流式回复在工具前提交后，又在相同 Step 开启下一次 attempt。DSH 原生 ClientAssistantStream 在上一个成功 attempt 尚未遇到 step/end 时要求 rebaseline。插件此前固定使用 step=1，不满足此契约。

## 当前源码修改

- 使用 DSH 原生模型选择 UI 的 directoryFor 接口，为受管会话提供独立目录；读取当前会话模型及推理强度。普通 DSH 会话仍使用原生目录。
- 新增受认证控制入口 managedAgent.models / managedAgent.selectModel，服务端依旧验证账号、工作区和会话归属，不暴露配置内容或凭据。
- 全局目录只合并已经读取过的目录缓存，不再为了列模型恢复所有历史会话；新会话通过明确的 sessionId 加载。
- 保留 Codex supportedReasoningEfforts，兼容 Claude supportedEffortLevels。
- 成功结算流后关闭对应 Step，下一段输出使用新 Step，避免重复同步。
- 本仓库 git 提交身份设为 ljx149 及该账号的 GitHub noreply 邮箱。历史提交尚未改写，已发行标签保持不变。

## 实际验证

- 定向测试：managed-agent-backend 33 项通过，managed-model-directory 4 项通过。
- 流式契约测试使用从 npm 下载的 0.2.2-rc.5 dsh-api-session-controller 原生 ClientAssistantStream；覆盖首轮增量、工具开始/结果、后续回复、实时结算，没有 rebaseline。模型/Agent 使用测试替身，不等于真实模型或桌面 UI 验收。
- 新模型目录模块独立严格 TypeScript 检查通过。
- 完整类型检查和全量插件测试均被资源保护器中断，不能标记通过。全量测试启动后仅部分文件完成。
- 原全量保护器阈值：两核、RSS 不超过启动可用内存三分之一且最多 4 GiB，可用内存低于 4 GiB 停止。
- 小范围检查进一步限制为单核、RSS 不超过启动可用内存三分之一且最多 512 MiB；可用内存低于 2 GiB 停止。未停止任何生产服务。
- 本轮服务器可用内存最低观察到约 1.6 GiB，已停止继续构建和测试。无新包、无新版本发布、未更新线上服务。

## 后续必须完成

- [ ] 完整源码及测试类型检查、插件全量测试、构建和包外试装。
- [ ] DSH 0.2.2-rc.5 原生页面验证目录接线，确认 Claude 只加载 Claude、新 Codex 会话加载本机目录；跨工作区与重连验证。
- [ ] 真实 Codex / Claude 首轮与后续轮：逐字输出、工具显示、完成后直接可见，无需切换会话。
- [ ] 排查仍可能存在的首次订阅/页面刷新问题；当前仅证实流式 Step 问题，不声称已解释用户所有症状。
- [ ] 核对 Codex 模型分页、用户自定义 provider/profile 行为，禁止用预设模型列表掩盖配置读取失败。
- [ ] 发布验证通过的新 tgz，再提供安装地址；当前安装地址仍为旧的 0.8.1-xagent.3。
- [ ] 用户要求的历史作者修正：只处理本功能分支的自产提交，提前保留远端备份，核对依赖分支/发行标签，禁止直接改写上游或生产分支。

## 继续验证（2026-11-20，服务器重启后）

- 新定位的渲染根因：`flush()` 在提交 durable assistant/message 后才发 finish chunk。原生 fold 为 chunk 分配更大的小数序号，然后释放较早的消息；原生 ConversationAssembler 抛出 `received non-appended Match`，实时视图丢失。现在先结束 chunk 再提交消息，测试断言发布序号单调递增，防止只检查 rebaseline 而遗漏渲染失败。
- Codex 模型列表补齐 nextCursor 分页；模型选择和推理强度校验使用同一完整目录，拒绝重复游标及过大目录。
- 模型目录补充原生 binding 生命周期测试，Claude 目录只展示当前 Agent，普通 DSH 目录不受影响。
- 最终插件全量回归：95 个文件、803 项通过（包括精确 rc.5 原生 fold 与发布序号回归）。
- 检查使用 `scripts/check-with-budget.py`：systemd cgroup 硬限制，内存取空闲三分之一与 2 GiB 较小值，CPU 取空闲三分之一与单核较小值，禁止 swap，所有任务串行且结束清理整个检查组。没有停止或更新生产服务。
- Linux x86_64 / Node.js 24.9.0 / DSH 0.2.2-rc.5；源码与测试类型检查、构建、DSH bundle 校验通过。
- tgz 在仓库外安装到独立 rc.5，原生页面实测：Codex 第二页模型显示且可选择；首轮文本实时显示；工具运行可见；结束后两段回复直接保留，无需切换会话。Agent 是受控本地协议替身，不能等同真实 Codex/Claude 模型调用或 macOS 桌面验收。
- 补充原生 UI：展开完成状态显示 Called tools；页面刷新后最终回复仍可见。测试结束无活动 xagent-check 单元，四个隔离端口均已释放。
- 原生 UI 实测修复前失败、修复后通过；包内没有调试注入标记，没有 .env、auth.json、credentials.json、.npmrc 等敏感配置文件。
- 包版本：`@xcoder/xagent@0.8.1-xagent.4`。验证包：`/root/xagent-rc5-validation/xcoder-xagent-0.8.1-xagent.4.tgz`。
- SHA-256：`f11887b376fda77e0d73864915acc6c20ce39ce11923db9f9c8778bfef8d6114`。

仍需用户环境验证：真实 Codex/Claude 本机配置及首轮/后续轮、手机和平板连接、跨工作区、桌面重启恢复。npm 发布继续暂停，历史提交作者未改写。
