---
name: production-bounded-checks
description: 在生产机验证 Xagent 时限制测试、构建和隔离浏览器的资源，并清理所有子进程。
---

只用于确有生产机验证授权的场景。用户约束优先。

- 测试/构建/试装/浏览器验收串行进行，同一时间只启动一个检查组。
- 从仓库根目录运行 `python3 scripts/check-with-budget.py COMMAND [ARG ...]`。
- 前置：Linux cgroup v2、systemd、root/systemd 权限、Python psutil。缺少硬限制能力就停止，不退化成仅轮询 RSS 的限制。
- 启动时采样 MemAvailable 和 CPU 空闲率。内存限制取空闲内存三分之一与 2 GiB 较小者，CPU 取空闲核数三分之一与 1 核较小者。不足 6 GiB 可用内存或不足 25% 单核预算则拒绝启动。
- systemd MemoryMax/MemoryHigh、CPUQuota、MemorySwapMax=0、低 CPU/IO 权重、idle I/O、TasksMax=256；最长 600 秒。资源预算下降则停止本检查组。结束后停止整个 cgroup，包含后台进程，不只主进程。
- 不关闭现有服务，不清理全机缓存，不杀无关 Node/浏览器，不使用 `pkill node` 等宽泛命令。
- 隔离 Host、测试 Server 和浏览器必须从同一受限检查组启动，并使用独立目录及 loopback 端口。禁止使用会把浏览器转移到其他 service/cgroup 的启动器。
- `--dry-run` 只打印测得预算，不启动进程。无参数应失败。
- 检查结束用 `systemctl list-units --all 'xagent-check-*'` 确认没有残留活动检查组；报告真实通过项目和未完成项。
- 外部中断/OOM/预算停止不是测试通过。禁止把测试替身回复称为真实模型验收。

## 原生插件页面回归

- DSH 的 peer 依赖和平台 optional 包也属于运行依赖；隔离 Harness 安装不要用 `--legacy-peer-deps --omit=optional`，否则可能移除 Cordis 插件或原生 addon。锁定用户的准确 DSH 版本，使用正常依赖解析。
- 隔离服务的状态文件、Host 身份目录和浏览器 profile 每次新建，登录准备必须等待 Host online 并断言成功，避免复用过期测试设备导致误判插件故障。
- UI 必须测试同一份待发布 tarball，检查已安装 Host 与包内容一致。若临时加诊断，结束后重新安装原包，最终验收不能使用改过的安装目录。
- 首轮实时文本、工具、回合结束立即显示、执行中刷新、队列下一轮、问题回答、刷新后再次选择模型分别验收。不能只看最终历史存在。
- 原生 `api-session/added` 不更新已附着 Session 的 running 状态，必须另外发送 `api-session/status`；否则任务已完成但发送按钮仍显示排队。流式 finish 必须先于 durable settlement，否则 ConversationAssembler 会拒绝倒序片段。
- 严格 schema 的窄接口必须显式挑字段，TypeScript 的结构类型不会移除运行时多余字段。启动计划交给持久进程保护时只传 sessionId/agent。
- 相关实现和回归测试入口见 [会话恢复记录](../../../docs/design/baseline-chat-restoration.md)。先类型检查和相关回归，再构建/打包/试装/页面；全量已通过后仅对新改动涉及的检查重跑。
