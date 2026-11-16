# xcodex 账号直连：服务端实现与客户端契约

日期：2026-11-13。状态：**已部署到 agent.xcodex.vip 供联调试运行**，真实账号与手机验收尚待完成。
当前构建 `xcodex-brand-20261113-c84a5b59fb6f`（包含 Google 回跳修复）；详见 [部署记录](deployment-agent-xcodex-vip.md)。本次不改 xcodex 网站、数据库、Nginx、DNS、证书，也不扩展扫码或浏览器 SSO。

## Supabase 网页登录（2026-11-13 已试运行上线）

构建 `supabase-web-20261113-25fd524fd383` 已上线。首次因既有站点延迟阻断；用户随后明确允许延迟波动，保留可达性监测后重试成功。用户确认已添加 Redirect URLs，真实账号完整登录仍待验收。

复用官网 `/root/Xcoder/app/login/page.tsx` 的三种登录方式：Google、邮箱验证码、邮箱密码。同一个 Supabase 项目，同一个 xcodex `/me` 身份契约。Remote 是 Node HTTP + React/Vite，官网是 Next.js，因此移植流程而非直接复制 Next.js 服务端路由和 Cookie 适配器。

页面：`https://agent.xcodex.vip/app/login`。注册/找回密码仍链接官网；此次未复制完整注册、改密或账户中心。验证码登录不隐式创建账号（`create_user=false`），使用现有邮件模板中的数字验证码；未实现邮件 magic-link 直接返回 Remote。

**Supabase 后台配置**：在 Authentication → URL Configuration → Redirect URLs 添加：

```text
https://agent.xcodex.vip/api/v1/auth/supabase/callback?remote_state=*
```

不要修改原 Site URL，也不要删除官网已有回调。Google 提供方继续使用同一个 Supabase 项目原有的 Google 回调地址，不需要把 Remote 地址填进 Google 的 redirect_uri。`remote_state` 为每次随机值，仅此查询参数使用通配符。配置依据见 [Supabase Redirect URLs](https://supabase.com/docs/guides/auth/redirect-urls)。

服务端流程：

- `GET /api/v1/auth/methods` 返回当前模式及 Google/邮箱验证码入口能力。
- `POST /api/v1/auth/supabase/google` 生成 PKCE verifier/challenge、十分钟一次性 flow、HttpOnly/SameSite=Lax 浏览器绑定 Cookie，返回 Supabase 授权 URL。
- `GET /api/v1/auth/supabase/callback?remote_state=...&code=...` 验证浏览器绑定、有效期和一次性状态；服务端兑换 Supabase 凭证并调用 xcodex `/me` 验证身份，最后设置 Remote 登录 Cookie，跳转 `/app/remote`。失败仅携带受控错误码返回登录页，不回传原始上游错误。服务重启后未完成登录需重新发起。
- `POST /api/v1/auth/supabase/otp/send` 请求体 `{email}`；同邮箱一分钟一次，保留全局/IP 限流。
- `POST /api/v1/auth/supabase/otp/verify` 请求体 `{email,code}`；验证验证码，再验证 `/me`。
- `POST /api/v1/auth/supabase/password` 请求体 `{email,password}`；直接使用 Supabase password grant，再验证 `/me`。旧 `/auth/login` 保留供现有客户端兼容。
- 上述新增 POST 是**浏览器同源接口**，必须有匹配 Remote origin 的 `Origin`；不能让第三方页面发起登录 CSRF。上游 access/refresh token 只在服务端加密保存，不返回前端，不放进跳转 URL 或浏览器 localStorage。

前端默认验证码登录；错误按密码/验证码无效、账号停用、上游不可用、登录过期区分。请求超时 25 秒。自建 `local` 模式继续显示原密码登录。

**客户端边界**：网页登录只创建 Remote 浏览器会话，不会自动授权本机电脑插件，也不会使 Host 上线。现有电脑插件邮箱密码方式仍兼容；Google/验证码原生 App 与 PC 浏览器授权交接需要客户端另行接入。不要把上述同源网页登录接口当成现成的原生 App OAuth 回调协议，也没有新增扫码配对。

验证：93 项服务端测试、类型检查及生产构建通过；Chromium 390px/1280px 覆盖三种入口、验证码与密码输入、Cookie 登录、设备页和 Google 回调（模拟上游）。真实 Supabase authorize 返回 302 到 accounts.google.com；未输入真实 Google 账号、未向真实邮箱发送验证码。完整 Google 回调、邮件送达及真实账号仍待用户配置与联调。

## Google 回跳 403 修复（2026-11-13）

现场日志（UTC 06:38:47）显示 Supabase callback 返回 303 后，`/app/remote` 返回 403。浏览器保留整个跨站重定向链的 `Sec-Fetch-Site: cross-site`，原逻辑在提供公开 HTML 前就拒绝它，导致已完成 Google 身份校验仍显示 `AUTH_INVALID`。

修复只对公开 HTML/静态资源 GET 和受 flow+PKCE 保护的回调放行跨站导航；账号/设备 API、登录 POST 和 WebSocket 保持原 Origin/跨站检查。回调失败后的登录页跳转也涵盖此修复。

94 项服务端测试通过，新增用例验证跨站落地页面 200、API 403 和伪造回调拒绝。Chromium 390px/1280px 通过 `127.0.0.1 → localhost → 127.0.0.1` 的真实跨站导航链验证，不再只做同源模拟回调。测试使用模拟上游，无真实 Google 凭证。

修复版本 `oauth-nav-fix-20261113-e7d786b4a005`；刷新旧回调 URL 不能重用一次性 code，测试时须重新打开登录页发起登录。

## 已核实的鉴权来源

- `https://xcodex.vip/api/portal/config` 提供本地登录开关和 Supabase 公共配置。
- 本地账号调用 `/api/portal/auth/login`，仅当返回 404 且业务错误恰为 `该邮箱不是本地账户` 时，转入配置中固定允许的 Supabase password grant。密码错误、停用、网络错误均不回退。
- 旧 Supabase 账号使用其 `/auth/v1/token?grant_type=password`；目标 origin 必须与服务端固定配置一致，禁止重定向，客户端不能指定上游。
- 两种登录均须再通过 `/api/portal/me` 校验，使用返回的 UUID 建立身份。邮箱只用于展示，不用于合并账号。
- 源码及匿名/无效凭证的现场响应已核对。真实两类账号成功登录及真实停用尚未验证；不能把模拟提供方测试视为线上接口验收。
- `/me` 没有通用 `status` 字段，通过成功/拒绝判断可用性；其内部依赖计费服务。Remote 不直接查库。

## 客户端直接按此对接

默认 Server URL 为 `https://agent.xcodex.vip`，保留自建服务器配置。入口显示“使用 xcodex 账号登录”，邮箱密码表单只提交给 Remote。

1. `POST /api/v1/auth/login`，JSON 为 `{ "email": "用户邮箱", "password": "用户密码" }`。
2. 成功响应保留原有 `token`、`expiresAt`（Unix 毫秒）、`account`、`profile`、`isAdmin`，新增不透明 `userId`。不要解析或自己生成 userId。此 token 是 Remote 账号会话，不是设备或 xcodex token。
3. 使用 `Authorization: Bearer <账号 token>` 调用现有 `POST /api/v1/devices/register`；请求仍为 `{v:1,device:原有设备描述}`。手机 role 为 `client`，电脑为 `host`。**不要提交 ownerId/userId 作为归属依据**，服务器从会话决定。
4. 注册响应、设备 access/refresh token、Noise 身份、刷新请求和 `/ws/v1/connect` 保持现有协议。凭证安全保存；不保存密码。
5. 手机以设备 access token 调用 `GET /api/v1/devices`，只返回本账号的 host；沿用 online 状态和现有 connect.request / Noise 握手。空列表表示本账号还没有电脑，不是登录失败。浏览器账号设备页使用 `/api/v1/account/devices`。
6. `POST /api/v1/auth/refresh` 继续使用 `{deviceId,refreshToken}`。`GET /api/v1/auth/me` 查询账号会话，`GET /api/v1/me` 查询设备，不能混用两种 token。
7. 退出手机账号需先以设备 token `DELETE /api/v1/devices/self`，再清除本地凭证和账号会话；`POST /api/v1/auth/logout` 只注销当前账号登录会话，**不会让已注册电脑下线**。不承诺“退出全部设备”。撤销后沿用原有重建本地设备身份流程。

登录最慢可能连续进行四次上游请求，每次超时 5 秒。新客户端登录超时建议至少 25 秒；现有电脑插件单次请求超时为 10 秒，正常响应的隔离兼容测试已通过；慢上游场景需联调并决定是否统一缩短服务端上游预算或调整客户端超时，不宣称插件已全链路验收。

### HTTP 错误处理

仍使用 `{error:{code,message,retryable}}` 包装；按 code 判断，不依赖英文 message。

| HTTP / code | 客户端行为 |
| --- | --- |
| 401 `AUTH_INVALID` | 登录时提示邮箱或密码不正确；设备接口按现有刷新逻辑处理 |
| 401 `REAUTH_REQUIRED` | 重新登录；不要无限刷新 |
| 403 `ACCOUNT_DISABLED` | 提示账号已停用，停止自动重试 |
| 403 `EMAIL_NOT_VERIFIED` | 提示先完成 xcodex 邮箱验证 |
| 403 `AUTH_ACCESS_DENIED` | 提示账号暂不能使用服务，不归因为密码错误 |
| 409 `ACCOUNT_IDENTITY_CONFLICT` | 停止连接，提示重新登录并联系支持 |
| 503 `AUTH_SERVICE_UNAVAILABLE` | 鉴权服务暂不可用，退避重试，保留本地设备凭证 |
| 429 `RATE_LIMITED` | 退避重试 |
| 404 `DEVICE_NOT_FOUND` | 目标不存在或不属于当前账号，不暴露他人设备 |

WS 为兼容旧协议，将永久身份失败映射为 `AUTH_INVALID`、暂时不可用映射为 `CONNECTION_FAILED`。客户端可以通过 HTTP 刷新/登录取得详细原因。

## 服务端实现与安全边界

- `xcodex-auth.ts`：上游适配、固定目的地、错误分类、账号复核、AES-256-GCM 加密会话。
- `store.ts`：v2 users + devices.ownerId；身份键由固定 issuer 和 `/me.id` 生成。设备 token 仍只持久化摘要。
- `server.ts`：账号/设备凭证分离、所有查询与注册归属检查。
- `gateway.ts`：连接、信令、中继与心跳检查账号，不能凭猜中的设备 ID 或连接 ID 跨用户操作。
- 不保存/记录密码或明文上游 token。为后续 `/me` 复核，持久化加密后的上游 access token；Supabase refresh token 亦加密。解密密钥不存入 state，不提交 Git。
- 成功验证缓存最多 60 秒；活跃账号后台复核，过期缓存失败关闭。暂时上游故障不会删除设备凭证，但可能中断控制连接。确认停用/身份无效会清除该账号设备 token、登录会话并断开控制/Relay。
- 本地 token 无已知续期接口，最长约 7 天后需重新登录。Supabase 可刷新；旋转后的凭据先加密保存，再调用 `/me`，避免后者故障导致刷新凭据丢失。
- 停用不是瞬时推送：受缓存、请求超时及心跳周期影响。独立 P2P 数据通道是否随控制断开终止需要 Host 配合和真机验证，服务端不能单独保证已建立 P2P 立即停止。
- 同账号普通设备直接互连，授权边界是账号；账号被盗会影响该账号下电脑。Noise 加密和设备密钥校验仍保留。
- 仍是单进程 JSON 存储，不支持多副本同时写。每账号最多 256 个未撤销设备、全局 4096 个设备/用户；不是完整 SaaS 管理平台。

## 配置与旧账号迁移

默认 `DSH_SERVER_AUTH_MODE=local`，旧单账号使用方式不变。启用新功能须从本分支构建，不可假设上游 `latest` 镜像包含改造。

| 配置 | 含义 |
| --- | --- |
| `DSH_SERVER_AUTH_MODE=xcodex` | 登录改用 xcodex |
| `DSH_XCODEX_ORIGIN=https://xcodex.vip` | 固定可信门户 |
| `DSH_XCODEX_SUPABASE_ORIGIN` | 固定允许的 Supabase origin，默认与当前门户一致 |
| `DSH_XCODEX_CREDENTIAL_KEY` | 随机 32 字节十六进制密钥；从部署秘密配置注入，跨重启保留 |
| `DSH_SERVER_ALLOW_LEGACY_LOGIN=false` | 默认关闭新旧管理员登录入口；设 true 才启用 `/api/v1/auth/legacy/login` |

继续保留原 `DSH_SERVER_ACCOUNT/PASSWORD`，不要在迁移时修改。旧设备和凭证归属 `legacy` 身份，保留但不自动授予任何 xcodex 用户。即使邮箱相同也不合并；旧账号映射另行明确后实施。现有旧设备继续按 legacy 权限使用，不受 xcodex 停用检查管理。

首次读取 v1 state 会创建同目录 `state.json.v1-backup`，再迁移 v2；已有不同内容的备份会阻止迁移。升级前仍须单独备份服务版本、state 和秘密配置。已包含 xcodex 用户的 v2 不允许简单切回 local 模式；密钥错误时启动失败，不抹掉用户数据。

## 隔离验证与发布门槛

已在 Linux / Node.js 22.22.0 / pnpm 9.15.4 下完成服务端 85 项测试：原协议回归、两账号 HTTP/WS 隔离、同账号连接、第三方 Relay 拒绝、刷新/重启、v1 备份迁移、加密持久化、停用断连、上游故障与刷新旋转边界。上游使用模拟响应，未替代真实账号验收。另使用仓库现有 HostServerApi / ClientServerApi 通过真实隔离 HTTP 服务验证了登录、注册、同账号发现、不同账号隔离和设备撤销。Server 类型检查、生产构建和编译产物独立临时端口启动/health 均通过。

待完成：真实本地账号、旧 Supabase 账号登录；第二账号隔离；现有 PC 插件登录/刷新兼容；手机真机消息收发、重启断网恢复；真实停用与 P2P 撤权；真实账号联调后的正式验收。隔离迁移/回滚演练及试运行部署已完成。手机端入口/文案由客户端开发方实现。

发布前使用隔离端口和独立 state，不复用生产写路径。正常发布应通过联调后备份、切换本服务；本次按用户明确授权先部署供联调，真实验收边界保留；不改共享入口。回滚时停止新服务写入，保留 v2 数据与密钥备份，恢复旧可执行版本及配套 v1 快照，再复测旧设备。回滚会丢失快照之后的新注册/凭证变化，不能让旧代码直接读取 v2；不能安全完成备份和回滚演练则不部署。

## xcodex 设备浏览器登录扩展（2026-11-13）

完整接口、字段、PKCE/领取密钥边界与验收进度见 [设备浏览器登录契约](device-browser-login-plan.md)。网页登录自动交接到最初绑定的设备；手机和电脑使用相同用户身份，无需扫码或额外批准。设备访问凭证与既有刷新、归属、加密连接协议不变。Google/验证码/密码入口均支持该交接；普通网页登录不会自动创建任意设备。
