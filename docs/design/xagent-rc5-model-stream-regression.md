# DSH rc.5 模型目录与实时消息回归排查

日期：2026-11-20。用户环境：DSH 0.2.2-rc.5、插件 0.8.1-xagent.3。
分支：feat/orca-agent-management。本文是开发检查点，不是发行验收记录。

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
