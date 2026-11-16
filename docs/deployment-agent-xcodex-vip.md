# agent.xcodex.vip 自部署记录

## 2026-11-13：xcodex Remote 品牌统一（当前线上）

- 当前构建 `xcodex-brand-20261113-c84a5b59fb6f`，源码快照 SHA-256 `5ad3a5ba3384358c3c16ab34649a07fa7a799a0ce16d1c217d38cee794d6bba8`；仍为未提交工作区构建。
- 旧 AgentPort A 标识替代鲸鱼；首页/登录/设备页/页脚及标题统一 xcodex Remote，配色参考官网深灰/浅蓝并适配浅色主题。实际插件安装包名不变。见 branding-xcodex.md。
- 类型检查、构建、隔离旧账号 Relay/刷新和恢复演练通过；Chromium 390px/1280px 深浅主题、图标、首页/登录布局检查通过，隔离模拟登录及设备页检查通过。公网相同页面验证通过。
- 仅重启本服务，原 3 条设备、用户、凭证与密钥保留；公网新 SVG 返回正确类型，Google 跨站回跳修复保留。共享 Nginx、DNS、证书不变。
- 按用户授权延迟只告警：33 个请求目标共 1287 次请求无新增状态/TLS/可达性异常，0 条延迟告警；既有 TLS keepalive 跨切换保持约 193 秒。
- 备份/日志 `/root/ds-remote-brand-20261113/`；回滚目标 `oauth-nav-fix-20261113-e7d786b4a005` 与配套 final-state.json/final.env。敏感文件不提交。


## 2026-11-13：Google 回跳 403 修复部署（当前线上）

- 当前构建 `oauth-nav-fix-20261113-e7d786b4a005`；来源为未提交工作区，源码快照 SHA-256 `fec4d7a30e01b7dcb65cab1420b91b6a561b019cc6d2393d6a8acd2660d7855b`。前一版保留为回滚目标。
- 修复全局跨站校验误拦截 OAuth 回跳后的公开页面；Google callback 303 后设备页 403 的日志证据已确认。公网携带 cross-site 头访问登录/设备 HTML 为 200，访问账号 API 仍为 403。
- 94 项服务端测试、类型检查和构建通过；Chromium 两种宽度的不同站点重定向链验证通过，真实 Google 账号仍需用户重新发起验收。
- 隔离 Relay/刷新、旧版本恢复演练通过。仅重启 DS Remote，原 3 条设备、用户、凭证与加密密钥保留；Nginx/DNS/证书未改。
- 按用户已授权的“延迟仅记录，可达性仍阻断”标准，33 个目标 693 次请求无新增状态/TLS/可达性异常；0 条延迟告警，TLS keepalive 跨切换保持约 95 秒。旧有 502 不记作本次新增。
- 运行/备份留档 `/root/ds-remote-oauth-fix-20261113/`，敏感数据不进入仓库；`SUCCESS.json` 已生成。回滚保留当前数据后恢复配套 final-state.json/final.env 与前一版发布链接。


## 2026-11-13：Supabase 网页登录重试部署成功（当前线上）

用户确认已添加 Supabase Redirect URLs，并明确接受测试期间偶发延迟；本次监测将延迟退化改为记录告警，仍检查可达性、TLS、既有 HTTP 状态基线、监测存活和入口配置完整性。保留前一次阻断记录，没有删除历史异常。

- 当前构建 `supabase-web-20261113-25fd524fd383`，已切换 `/opt/ds-harness-remote-server/current`；仅重启 DS Remote 服务，3005 切换前无已建立连接，启动到就绪约 0.535 秒。
- 3 条原设备记录、用户映射与设备凭证全部保留；原加密密钥保留。Nginx、DNS、证书、systemd 定义未修改。
- 公网 `/app/login` 已提供 Google、邮箱验证码和密码登录。方法发现、HTTPS healthz/TLS、Google 授权发起/PKCE/回调目标检查通过，Supabase 授权入口实际返回 302 到 Google。
- Chromium 390px/1280px 公网页面布局和密码/验证码切换通过，未提交真实凭证。完整 Google 回调及验证码邮件送达仍由用户联调；用户报告已配置回调，不等同于已完成真实回调验收。
- 33 个既有请求目标共 561 次请求无新增状态/TLS异常，本次未触发滚动延迟告警；已有 TLS keepalive 跨切换保持约 74 秒、15 次请求。原有 4 个 502 仍按既有基线记录。
- 备份与记录 `/root/ds-remote-supabase-20261113-retry1/`：`final-state.json`、`final.env`、`prepared.json`、`SUCCESS.json` 和监测结果。目录 0700，敏感文件 0600。上一版 `xcodex-20261113-f24687b67690` 保留；回滚需保存当前数据后恢复配套旧版本/state/env，仅操作本服务。
- 源码仍是未提交工作区；没有推送 Git，也没有发布 npm 包。

下文是先前部署历史，当前状态以本节为准。

## 2026-11-13：Supabase 网页登录候选（部署被门槛阻止，未上线）

- 候选 `supabase-web-20261113-25fd524fd383`，路径 `/opt/ds-harness-remote-server/releases/supabase-web-20261113-25fd524fd383`。
- 93 项服务端测试、类型检查、构建、Chromium 390px/1280px 三方式模拟登录、隔离旧账号 Relay/刷新和旧版本恢复演练通过。真实 Supabase authorize 302 到 Google；未验证真实用户登录和邮件。
- 留档目录 `/root/ds-remote-supabase-20261113/`（0700），源码快照 `server-source.tgz` SHA-256 `6cc9d9f79270aa505c51c368563472a49198daa3558043e50aa5be574b7c1401`。沿用现有凭证加密密钥，未旋转生产密钥。
- 上线前监测发现 `ic.xshow.live/` 延迟异常：初始中位数 0.043917s，本轮阈值 0.4s，最后五次中位数 0.418719s（单次最高 1.618362s），HTTP 仍为 200。未定位其原因，不认定由本次代码导致。
- `cutover.py` 在初始 guard 阶段退出，尚未停止/重启生产服务或修改生产配置/发布指针；无需回滚。共享入口未修改。不得删除异常记录或直接放宽阈值后宣称通过。
- 当前线上仍为 `xcodex-20261113-f24687b67690`，新的 Google/验证码登录页未上线。后续需重新确认既有服务稳定与监测完整，再开始新的发布尝试。


## 2026-11-13：xcodex 多用户试运行部署

已按用户“部署一下试试看”授权部署，供真实账号与客户端联调；不代表真实账号/手机对话已验收。

- 当前构建：`xcodex-20261113-f24687b67690`，发布路径 `/opt/ds-harness-remote-server/releases/xcodex-20261113-f24687b67690`。
- 基于 `d48a11c63318db27ebe188d828db05dd20d7067d` 加本地未提交修改；没有伪称为新的 Git 提交，没有推送远端。
- 源码快照 `/root/ds-remote-deploy-20261113-xcodex/server-source.tgz`，SHA-256 `fef3cc33afc1ff197cc3cb4a9f2fe6d8d4747e7e2bbfc831f1dc58e07c6a9b8b`。
- 启用 `DSH_SERVER_AUTH_MODE=xcodex`；专用加密密钥仅在本机私有配置中保存。`DSH_SERVER_ALLOW_LEGACY_LOGIN=false`：普通登录使用 xcodex，旧管理员密码不再用于普通登录；旧设备不自动并入同邮箱账号。
- state 从 v1 迁移到 v2，原有 3 条设备记录与所有设备凭证完整保留。旧管理员独立归属保留，未自动映射到 xcodex 用户。
- 仅更新本服务发布链接和环境文件，重启 `ds-harness-remote-server.service`。切换前 3005 无已建立连接；启动至就绪约 0.534 秒。仍监听 `127.0.0.1:3005`，systemd 定义未修改。
- 沿用域名、DNS、证书和 Nginx，未修改/重载共享入口，入口配置校验值与 11 月 12 日相同。
- 构建、独立 33059 端口迁移、旧账号 Noise/双向加密 Relay/凭证刷新及恢复旧快照启动旧版本演练通过。实际 xcodex 上游错误凭证返回预期 `401 AUTH_INVALID`。
- 公网 HTTPS 首页、登录、设备页及 healthz 返回 200，TLS 校验通过；匿名设备列表 401，关闭的 legacy 登录入口 404；切换后持续观察超过 60 秒。
- 其他站点 33 个探测目标共 1056 次请求无新增状态/TLS/滚动延迟异常；原站点同一 TLS keepalive 跨切换保持约 154 秒、30 次请求。4 个原有 502 仍为原基线，未修复。
- 待验收：真实本地邮箱与旧 Supabase 账号成功登录、手机和电脑同账号消息收发、第二真实账号隔离、断网恢复及 P2P 撤权。公网测试从本机发起，不替代手机运营商网络。

备份与回滚留档：`/root/ds-remote-deploy-20261113-xcodex/`（0700）；`final-state.json` 和 `final.env` 为切换时备份，文件 0600，禁止提交或分享内容。原发布目录保留。异常时仅停止本服务，先保留当前 v2 state 和密钥配置，再恢复上述配套旧 state/env 与旧发布链接，启动本服务并复测；不让旧代码读取 v2。回滚会撤掉本次上线后新增注册和凭证变更，须明确告知测试者。目录内 `cutover.py` 是一次性部署记录，不可重复执行作为回滚命令。

以下为 11 月 12 日历史部署记录，当前版本以本节为准。

日期：2026-11-12。状态：Server 已部署并完成下述验收，真实 Host/手机客户端对话尚待用户接入验证。

## 范围与版本

- 用户指定部署本仓库 `/root/joseph/ds-harness-remote`，沿用原 AgentPort 域名。操作前旧 `agentport.service` 已停止并禁用，3005 无监听。
- 源码提交：`d48a11c63318db27ebe188d828db05dd20d7067d`；根包 0.6.4，Server 子包 0.5.21。按实际提交部署，不以子包旧版本号推断源码新旧。
- 地址：`https://agent.xcodex.vip/`；登录：`https://agent.xcodex.vip/app/login`；登录后设备页：`/app/remote`。
- 本次是 `apps/server` 的单账号自部署版本，不包含完整 Remote Web 聊天界面。DSH Host 插件和客户端均需配置此服务地址及同一账号。
- 未修改业务源码，未发布 npm 包、镜像或 GitHub Release。旧 AgentPort 数据与文件保留，不迁移其账户或配对。

## 运行位置

| 项目 | 位置或值 |
| --- | --- |
| 主机 | `ecs110-us`（原任务称 ecs110-us-raw） |
| systemd 服务 | `ds-harness-remote-server.service`，active / enabled |
| 监听 | `127.0.0.1:3005`，不对公网开放后端端口 |
| 服务定义 | `/etc/systemd/system/ds-harness-remote-server.service` |
| 发布目录 | `/opt/ds-harness-remote-server/releases/d48a11c63318db27ebe188d828db05dd20d7067d` |
| 当前链接 | `/opt/ds-harness-remote-server/current` |
| Node | 独立复制到 `/opt/ds-harness-remote-server/bin/node`，v22.22.0；未修改系统 Node |
| 环境文件 | `/etc/ds-harness-remote-server/server.env`，目录 0700、文件 0600，仅 root 可读 |
| 状态数据 | `/var/lib/ds-harness-remote-server/state.json`，systemd StateDirectory 管理 |
| 验证留档 | `/root/ds-remote-deploy-20261112/`，不提交其中运行时数据、凭据及日志 |

账号使用 `admin@xcodex.vip`，随机密码仅保存在环境文件的 `DSH_SERVER_PASSWORD` 中，本文不记录密码。账号为本次新服务独立配置，与旧 AgentPort 账户无关。

服务使用 DynamicUser 非 root 运行，启用 ProtectHome、ProtectSystem、私有临时目录、0700 状态目录及资源限制（512 MiB、1 CPU、128 tasks）。开机自启，失败自动重启。这里只运行中继 Server，不在该进程启动 DSH Host 或远程终端。

## 入口及未变更项

实际 80/443 入口位于独立 Docker daemon：`unix:///run/xcamshow-docker.sock`，容器 `xcm-stage-edge`，host 网络。不要误操作默认 Docker 中的其他 Nginx，也不要使用宿主机 nginx.service。

- 配置源：`/root/xcamshow-uswest-migration/nginx-edge-stage.conf`，单文件挂载到 `/etc/nginx/nginx.conf`。
- 部署前后 SHA-256：`c261ccbf75a94b8d17639fd034be9570181ba7a78c40a8e2ede569e8ab0af232`。
- 保留既有域名站点：HTTP 跳转 HTTPS，HTTPS 代理到 `127.0.0.1:3005`，已有 WebSocket Upgrade 和 3600 秒代理超时。
- DNS 仍为 `agent.xcodex.vip -> 43.110.147.146`，无新增/修改记录，因此无本次 DNS RecordId。
- 沿用 `/etc/letsencrypt/live/agent.xcodex.vip/` 证书，签发时间 2026-11-10 06:18:36 UTC，到期 2027-02-08 06:18:35 UTC。证书和既有续期方式均未修改；本次未重验续期任务。
- **没有修改或重载共享 Nginx，没有重启容器，没有修改防火墙、其他服务或旧数据库。** Nginx master/worker PID 前后仍为 24192/25209。

## 验收及边界

- 使用锁定依赖，pnpm 9.15.4；Protocol/Crypto/WebRTC/Client Core 先构建，Server 类型检查、62 项测试、生产构建及包外模块加载通过。首次测试因 Plugin 测试引用的 workspace 未安装完整失败，补齐其依赖后全量通过，未跳过测试。
- 在独立回环端口 33059 和隔离数据目录先验证同一 runtime；完成后停止临时进程。
- 生产 HTTPS 首页、登录路由、设备路由、JS/CSS、健康检查通过；`curl --resolve` 保持 TLS 校验，结果 HTTP 200、证书校验 0。
- 账号及 HttpOnly/Secure/SameSite Cookie、未授权/错误密码/错误 Origin 拒绝通过。
- 实际注册测试 Host/Client，通过公网域名完成认证 WebSocket、在线状态、Noise IK 握手、双向加密 Relay、重放拒绝及凭据刷新。WebSocket 持续 90 秒并保持心跳；测试设备已撤销，测试登录会话已退出。
- Chromium 实际输入和点击：390px 与 1280px 均能登录、进入设备页和退出；不是手机真机验收。
- 其他站点 33 个请求目标累计 1716 次探测，状态/TLS/滚动延迟相对基线无新增异常；既有站点一条 TLS keepalive 连接跨部署保持约 264 秒、50 次请求未更换 socket。
- 基线已有 `admin.xcamshow.live`、`bill.xmodels.ai`、`platform.xmodels.ai`、`xcamshow.live` 首页返回 502，部署后保持同样状态。本次未修复，不能描述为所有既有站点均健康。
- 上述公网域名测试从部署环境发起，不替代独立外网/运营商网络实测。真实 DSH Host、手机客户端、真实模型回复及工具审批待验证。
- 未配置额外 STUN/TURN，未开放新端口；使用可用的默认传输行为，以加密 Relay 实测为准，不宣称公网 P2P/TURN 已验收。
- 现有代理使用追加式 X-Forwarded-For，因此没有启用要求覆盖单 IP 的 `DSH_SERVER_TRUSTED_PROXY_IPS`。本版本按回环代理 IP 共用默认 API 240/min、登录 20/min 限额；若扩展使用规模，需单独评估该域名代理头及限流适配。

## 运维与回滚

状态检查：`systemctl status ds-harness-remote-server.service`；健康检查：`curl --fail https://agent.xcodex.vip/healthz`。

本次回滚基线是“旧服务已停止”，不是恢复旧 AgentPort 在线。新服务异常时仅执行：

```sh
sudo systemctl disable --now ds-harness-remote-server.service
```

这会让该域名回到上游不可用的 502 状态，不会落入其他默认站点；保留新服务数据与凭据供排查。共享 Nginx/DNS/证书不需要回滚。未经明确要求，不重启旧 AgentPort，不删除或合并两套身份数据。

后续更新应先备份本服务的环境文件、状态数据与发布指针，在隔离端口验证候选版本，再更新本服务；不照搬上游 Compose 的默认公网映射或操作共享入口。

## 2026-11-13 设备浏览器登录候选：已回退

- 候选 `device-login-20261113-0a46c1069965`，备份和证据目录 `/root/ds-remote-device-login-20261113/`（含私有状态/环境备份，不得提交）。
- 隔离上游模拟、实际 DSH 插件安装与自动上线、迁移/回滚、旧版 Relay/凭证、真实上游无效密码拒绝均通过。
- 试切换启动耗时 0.546 秒；3 条既有设备、用户与凭证保留。首轮持续验收通过，HTTPS 页面、API、新 start/poll/cancel 与匿名包下载安装通过。
- 延长监测于 15:34:51 发生 `TLS/request failed api.moyisgs.com/`（curl 10 秒请求上限），33 项目标监测中断。未据此断言是本次部署导致。依照门槛中止上线并回退。
- 当前生产构建恢复 `xcodex-brand-20261113-c84a5b59fb6f`。新设备登录 API 和插件下载 URL 未保持在线；不要将切流脚本先前的 SUCCESS 视为最终发布通过，最终状态以 ROLLED_BACK 为准。
- 无数据格式变更，旧代码可读取现有 v2 状态；回退前备份当前状态并保留全部实时用户/设备/凭证，逐字节确认回退未改数据。只切回 Remote 服务二进制。共享 Nginx、DNS、证书和其它服务未修改。
- 测试包 `artifacts/xcodex-device-login/ds-harness-remote-0.6.4-xcodex.1.tgz`；SHA-256 `e332e038442555a4fb58990e68a40359c2acee9cccb7a5ba3e61336c9dc70090`。未提交/推送或覆盖上游 npm。
- 完整实施计划与手机交接契约见 [device-browser-login-plan.md](device-browser-login-plan.md)。

回退后 33/33 目标状态/TLS 均与基线一致；`api.moyisgs.com/` 返回 200，耗时 0.049939 秒。共享入口 SHA-256 保持 `c261ccbf75a94b8d17639fd034be9570181ba7a78c40a8e2ede569e8ab0af232`。这次恢复不能单独证明超时原因。监测累计记录 1188 条探测结果，最终因一次请求超时失败，不计为完整通过。

## 2026-11-13 用户调整门槛后重试：已上线

- 用户明确接受个别慢请求/偶发超时，要求既有服务仍可访问即可继续。监测改为每个失败目标最多重试 3 次，每次 20 秒，记录原始失败；持续不可达仍阻断。没有放宽账户隔离、TLS 校验或共享入口约束。
- 当前版本 `device-login-20261113-0a46c1069965`；仅切换并重启 Remote 服务，启动耗时 0.543 秒。3 条既有设备、全部用户/凭证保留；共享 Nginx、DNS、证书、其它服务未修改。
- 监测 33 个目标，共 660 条探测记录，重试告警 0 条；既有站点同一 TLS 长连接保持 87.7 秒，18 次请求，无新增失败。4 个既有 502 按自身基线处理。
- 公开 HTTPS 页面、健康检查、Google/邮箱登录入口发现、无效密码拒绝、设备 start/poll/cancel 验收通过；真实账号及手机真机仍待联调。
- 新证据目录 `/root/ds-remote-device-login-retry-20261113/`。旧回退目录作为历史保留，不代表当前线上状态。
- 包经 ECS 的 OSS 内网 endpoint 上传，公网匿名下载 SHA-256 与测试包一致；未改 bucket ACL。下载与安装命令见 [设备登录契约](device-browser-login-plan.md#oss-测试包下载2026-11-13-重试发布)。

### OSS 对象撤回

用户明确要求不使用 ecjoy OSS。已仅删除本次 `xcodex/releases/ds-harness-remote/0.6.4-xcodex.1/ds-harness-remote-0.6.4-xcodex.1.tgz` 对象；相关 OSS 下载/安装链接撤销。线上 Remote 服务和本地测试包保留。后续上传使用用户指定位置。

## 2026-11-13 独立插件密码鉴权发布

- 当前 release：`/opt/ds-harness-remote-server/releases/xcodex-plugin-auth-20261113-2bddbdc1ccb2`，旧 release `device-login-20261113-0a46c1069965` 保留；仅本项目服务切换，启动 0.542 秒。
- 新增 `/api/v1/auth/account/password`，插件密码登录与网页使用相同 Supabase provider；旧客户端登录接口保留。Google 登录提示只通过 fragment 传递 UI 意图，原设备 PKCE/账号隔离不变。
- 新包 `xcodex-remote@0.6.4-xcodex.2` 可从 `/assets/xcodex-remote-0.6.4-xcodex.2.tgz` 匿名下载；旧测试包路径也保留。SHA-256 `76cfad250e555d36b6cda5eb2af389a6236ea1ae8a936a9cabfad96388e70a69`，匿名下载与试装包一致。
- 现有 5 个设备、账号映射与凭据原样保留。共享 Nginx SHA-256 仍为 `c261ccbf75a94b8d17639fd034be9570181ba7a78c40a8e2ede569e8ab0af232`，未改/重载 Nginx、DNS 或证书。
- 33 个既有目标 792 次探测，状态/TLS 无基线变化，0 重试/延迟告警；旧站同一 TLS 长连接持续 114 秒、22 次请求跨发布保留。4 个既有 502 仍按原基线记录，不宣称已修复。
- 隔离端口验证旧协议 Relay、真实上游错误密码拒绝、旧版本回滚均通过。正式服务健康、无凭据拒绝、Google 入口及新密码错误拒绝、旧下载链接/新包可用；真实用户账号登录和手机连接待验收。
- 发布证据位于 `/root/xcodex-plugin-20261113/deploy/`；该目录含私有数据备份，不得上传或打入发行包。回滚只切旧版本和环境，保留兼容 v2 状态以免丢失发布后操作。
- OSS 仍未上传：现有本机凭据只列出 3 个 ecjoy 桶，用户已禁止使用；等待用户指定其他 bucket/目录。不要创建新桶或修改桶 ACL 来绕过此限制。


## 2026-11-13 Exchange 字段诊断

当前 release `exchange-diagnostics-20261113-4492148c416b`，回滚版本 `xcodex-plugin-auth-20261113-2bddbdc1ccb2`。仅重启 Remote 服务（0.546 秒，活跃控制连接需重连），不改变共享入口。7 个设备/账号映射/凭据保留；进行中的内存登录流程需要重新发起。协议校验未放宽，仅新增不含值的失败明细与诊断关联 ID。103 tests、隔离 relay/回滚、生产错误响应和安全日志匹配通过。人工错误请求用 64 字符 verifier，不能归因于用户的旧 400。证据与私有备份在 `/root/exchange-diagnostics-20261113/`，不得上传该目录。

本次监测完成：33 个既有目标 924 次探测无基线变化，旧站同一 TLS 长连接保持 129.6 秒 / 26 次请求；未出现监测错误。发布后尚无真实客户端 exchange 400 诊断事件（合成探测除外）。
