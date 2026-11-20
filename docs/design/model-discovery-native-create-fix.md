# 0.7.0-xcodex.8：模型读取与原生新建会话修复

2026-11-20；分支 `release/baseline-0.7.0-xcodex.5`，基于 49d4184e / .7。
仅修改插件；远程服务、DNS、Nginx 和用户配置均不修改。

## 原因和取舍

DSH 0.2.2-rc.5 的工作区导航从合并后的会话列表选取空白会话，可能将插件 Agent 的 ID 作为 `session/create` 的复用提示。旧网关将该请求转给没有 `session/create` 实现的 Agent 后端，报 `MANAGED_METHOD_NOT_SUPPORTED`。

修复仅在确认注册表归属并通过 live owner 检查后移除这一个复用提示，让原生创建接口照常验证工作区、preset、权限并创建 DSH 会话。原 Agent 会话不删除、不转换；原生空白会话的复用不变。覆盖 invoke 与 dispatchRpc 两个入口以及 Host 重启后的归属恢复。

Codex 原流程串行等待进程/初始化、线程创建或恢复、完整分页模型列表。初始化、打开选择器和选择模型验证可能重复读取模型。Claude 采用不同 SDK 路径，CC 快不能证明 CCR 是差异来源；尚无用户电脑各阶段耗时，不能断言其实际瓶颈。

本版保持线程身份绑定和恢复流程，将模型发现与线程启动并行；同一连接合并进行中的模型读取，成功目录缓存 30 秒，失败不缓存，进程重开自然失效。缓存不跨会话/工作区/配置/账号。完整分页仍全部读取，默认模型仍采用线程返回值，不猜目录第一项。不改变 Claude 流程或 CCR。

`managedAgent/models` 支持 `refresh: true` 强制重新查询（进行中的请求仍合并）；普通选择器打开使用短缓存，未新增刷新按钮。若在外部编辑配置文件，仍需遵循 Codex 本身的配置重载方式，缓存刷新不等于进程重新加载配置。

## 安全耗时诊断

启动 DSH 时可设置 `XAGENT_MODEL_TIMING=1`，日志前缀 `[xagent:model-timing]`。仅输出随机 trace、固定 stage、elapsedMs 和 ok；不输出路径、账号、模型名称、请求体、token 或错误原文。

阶段：`startup-initialize`（进程启动及握手总耗时）、`thread-start` / `thread-resume`、每页 `model-list-page`。并发阶段不可简单相加。默认关闭；此功能用于用户电脑复验，测试替身耗时不能代表真实模型服务。

## 验证和发行

- 9 文件 / 88 项相关测试通过，覆盖并行发现、分页、进行中去重、缓存过期/隔离/刷新、失败重试、安全日志、网关创建/权限、流式/队列/生命周期/Claude 适配。
- 源码和测试类型检查、构建、插件包一致性检查通过。打包校验曾发现根 manifest 仍为 .7，修正为 .8 后重新校验并打包通过。
- 仓库外安装、Host import、CLI help、包内容敏感文件检查通过；真实 DSH 安装目录的 Host 与 tarball 字节一致。
- 精确 DSH 0.2.2-rc.5 原生页面（受控 Codex 测试进程）：首轮流式、工具、结束即时显示、队列、执行中/结束后刷新、模型选择和提问回答通过。新增创建回归验证真实 HTTP `session/create` 拒绝复用 managed blank、创建独立原生会话、原 Agent 身份保留，以及原生新建按钮无报错。初版脚本调用当前 DSH 未暴露的 workspace/list 返回 404；改用已创建工作区 ID 和 session/projections 验证后通过，未为此修改产品代码。
- 真实 macOS Codex/Claude 服务、首次模型加载耗时与手机真机仍待用户复验；没有把受控进程的结果认定为用户环境瓶颈已消除。
- 测试/构建/安装/浏览器全部经 `scripts/check-with-budget.py` 串行运行，CPU 不超过空闲资源三分之一且最多 1 核、内存不超过空闲三分之一且最多 2 GiB，无 swap，结束清理整个检查组。

产物：`/root/xagent-baseline-release/xcodex-remote-0.7.0-xcodex.8.tgz`

SHA-256：`588d2eeb73545263230164f859d742de2944dd09e84d451f0cba5304d22dc114`
