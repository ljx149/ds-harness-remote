# xcodex 设备浏览器登录：计划与接口契约

2026-11-13。状态：服务端、网页与插件已实现；2026-11-13 用户调整可用性门槛后重试上线成功，当前新接口在线；手机真机联调待完成。

## 目标与边界

电脑插件与手机各登录一次同一 xcodex 账号，服务端自动归属设备，电脑上线后手机可发现并直接连接。无扫码、配对码或第二次“允许设备”确认。复用现有 Supabase 登录页、设备身份、Remote token 刷新、Noise 与连接协议。

网页登录不直接暴露 Supabase token；新增交接只发放发起请求的设备凭证，不返回可注册任意设备的账号 token。普通网页登录不受影响。客户端原有自建地址与身份数据不覆盖。此流程没有额外带外确认，登录链接应只由用户在自己设备的插件/App 中发起，不应打开他人发送的设备登录链接。

## 执行顺序

1. 固定以下协议与移动端回调白名单配置，文档优先。
2. 服务端独立设备登录模块：设备绑定、PKCE、浏览器完成、领取/兑换、撤销、过期及重放防护。
3. 网页携带设备请求跨越 Google/验证码/密码登录，已登录时自动完成；显示成功/取消/过期，不增加批准按钮。
4. 插件 Node 侧保存领取密钥与 verifier（仅内存），前端只得到登录 URL 和状态；浏览器登录后自动保存设备凭证并 resume Host。默认地址改为 agent.xcodex.vip，仅影响未显式设置的默认值。
5. 插件设置/工作区及旧 Host 面板接入同一个登录组件；保留密码兼容入口、自建服务器与既有凭证。
6. 协议/插件集成测试、原有回归、浏览器跨站测试；构建独立测试包，包外检查入口与依赖。验证安装工具支持的格式后再提供安装命令。
7. 备份与隔离验证后部署服务端；不改共享 Nginx/DNS/证书。发布测试包与校验值，更新开发日志和待办。不擅自推送上游仓库或覆盖上游 npm 包。

## 接口契约 v1

基址 `https://agent.xcodex.vip/api/v1`。以下新增接口都返回 JSON，错误沿用 `{error:{code,message,retryable}}`。POST 使用 application/json。

### POST /auth/device/start

客户端复用现有设备 ID/公钥，生成新的 32 字节随机 verifier（base64url）和 state；challenge 为 SHA-256(verifier) 的 base64url，无 padding。

请求：`{device:原有 AccountDeviceDescriptor,codeChallenge:string,state:string,redirectUri?:string}`。device.role 为 host 或 client。不得提交 ownerId。私钥和 verifier 不上传。

响应：`{requestId,loginUrl,pickupToken,expiresAt,interval:2}`。时间为 Unix 毫秒；有效期10分钟。pickupToken 留在插件 Node/App 内存，不放 URL、不发送给浏览器、不记录日志。loginUrl 的 URL fragment（`#device_login=…`）含独立随机浏览器凭据，不进入 HTTP 请求路径和访问日志，与 pickupToken 不同。每次创建取代客户端自己上一轮等待，不复用过期链接。

移动端 redirectUri 必须在 `DSH_DEVICE_LOGIN_REDIRECT_URIS` 配置的精确白名单中，无通配符。值为逗号分隔 URI。允许 HTTPS App/Universal Link 或明确配置的应用 scheme，禁止 HTTP、脚本/data URL、fragment、userinfo。目前移动端准确地址待对方提供，默认白名单为空。电脑不传 redirectUri，使用轮询，不启动公网监听或临时 HTTP 回调端口。

### POST /auth/device/complete（仅网页登录使用）

请求 `{browserToken}`，必须有同源 Origin 和当前 Remote 登录会话。服务端验证账号状态，绑定 ownerId，生成一次性 code，不立即注册设备。重复完成同一账号返回相同结果；其他账号不能重新绑定。返回 `{status:'complete',redirectUrl?:string}`。

有移动端回调时，redirectUrl 为白名单地址附加 `code`、`state`、`requestId`；无回调时网页显示“登录完成，可以返回电脑”。网页登录 UI 自动调用，不添加确认步骤。Google flow 必须保留 device_login 上下文。

### POST /auth/device/poll

请求 `{requestId,pickupToken}`。响应 `{status:'pending'|'expired'|'cancelled'}` 或 `{status:'ready',code,state}`。至少间隔2秒；429/503退避，网络失败保留当前请求，不无限自动创建新请求。

### POST /auth/device/exchange

请求 `{requestId,pickupToken,code,codeVerifier}`。验证领取凭据、PKCE、code、有效期及账号状态后，按初始绑定的设备描述注册，返回 `{deviceId,account,...原有DeviceTokenPair}`。不得在兑换时更换设备 ID、角色或公钥。

一次 code 只能触发一次注册；相同证明的短期重试（60秒内）返回相同凭证，处理响应丢失，不重复注册/轮换。凭证失效或撤销后不能靠重试恢复。不能只拿回调 code 兑换。客户端验证 deviceId 后持久化设备凭证，再建立原有连接。

### POST /auth/device/cancel

请求 `{requestId,pickupToken}`。取消尚未兑换请求；已兑换不会撤销已注册设备，返回冲突。客户端关闭等待时尽力取消并清除本地临时状态。服务端重启后未完成流程失效，重新登录即可。

## 关键错误

- DEVICE_LOGIN_INVALID（401）：请求或证明无效。
- DEVICE_LOGIN_EXPIRED（410）：过期或服务重启，重新发起。
- DEVICE_LOGIN_CANCELLED（410）：已取消。
- DEVICE_LOGIN_CONFLICT（409）：账号绑定冲突或已完成后不能取消。
- DEVICE_LOGIN_REDIRECT_DENIED（400）：回调未允许。
- DEVICE_REVOKED（403）：设备身份曾撤销；沿用插件现有明确重登录时的身份恢复机制，重新创建请求。
- 账号停用/重新认证/上游不可用与既有身份接口一致。

## 验收清单

- [ ] 同账号 host/client 自动注册、列表隔离、真实控制连接。
- [x] 丢失兑换响应后可恢复同一对凭证；错误 verifier/领取密钥/设备篡改和重放无效。
- [ ] 取消、过期、服务重启、账号切换和旧设备撤销处理正确。
- [x] 跨站请求不能完成设备登录；Google 回跳上下文保留；普通网页登录不回归。
- [ ] 插件登录完成自动上线，凭证重启恢复，退出/服务器切换取消旧请求。
- [ ] 手机/桌面网页验证；手机真机由移动端联调，不以模拟器或模拟上游代替。
- [ ] 测试包的真实安装、包外加载、版本/构建标识和 SHA-256 交付。

## 实现与交付记录

- 服务端 `apps/server/src/device-login.ts` 管理有界临时请求；`server.ts` 接入会话、账户校验和 Google 回跳。未更改 state v2 数据结构。重启丢失的请求返回 `DEVICE_LOGIN_INVALID`，客户端应重新发起。
- 网页 `DeviceLoginComplete.tsx` 自动完成交接，登录三入口保留 fragment 上下文；支持 hash 改变后的新请求。浏览器凭据不进入 HTTP 请求 URL。
- 插件 Node 侧通过 `HostServerApi` 持有 verifier/pickupToken，UI 仅拿到请求 ID、URL、到期时间。设置/工作区/Host 面板共用 `client/browser-login.ts`。两种运行方式复用已有 Host 或 Client → owned Host 注册；遵守用户关闭本机远程控制的设置。
- 默认地址与安装 patch 指向 agent.xcodex.vip。已显式配置其他服务的用户仍需在设置中切换地址，不自动覆盖。
- 命令行辅助程序默认浏览器登录，npm 包提供独立 bundle；插件 UI 登录会自动 resume，单独辅助命令登录后仍需启动/重启 Harness。

### 安装

当前 fork 测试包版本 `0.6.4-xcodex.1`，包名继续使用 `ds-harness-remote`，未覆盖上游 npm。现有安装先停止该 Harness 实例，安装后重新启动。Web profile：

```bash
dsh plugin --profile web add -w https://agent.xcodex.vip/assets/ds-harness-remote-0.6.4-xcodex.1.tgz
```

Desktop 用户通过自己 Desktop 配套的官方 `dsh` 启动器执行相同命令，将 `web` 换成 `desktop`。不要另装不同的全局 DSH 去管理保留的 desktop profile。打开插件后选择“使用 xcodex 账号登录”；浏览器登录完成后自动上线。手机 App 需按本契约发起自己的 client 设备请求，仅打开普通登录网页不会把登录凭证写入 App。

该 URL 曾通过匿名下载和实际 DSH 安装验证；随后服务回退，该下载地址当前未保持在线。先保留本地 `.tgz`，重新发布后才能继续使用上述命令。URL/file 安装不享有上游 npm 在线升级；不要换成上游 `@latest`，其中没有本次 xcodex 登录适配。

### 验证与未完成

- Ubuntu 24.04.2 x86_64；服务端 Node 22.22.0；真实 DSH 0.2.2-rc.1 / Node 24.9.0 的隔离 profile 安装通过。实际运行已验证浏览器交接、凭证保存、自动注册 owned Host 和 Host 在线（身份上游为隔离模拟）。
- Server 全量 99 tests；插件身份/控制/客户端/辅助命令核心 67 tests；类型检查、构建、DSH bundle 与打包 WebRTC 生产依赖闭包/双向 DataChannel 验证通过。
- 插件全量第一次 658/663，默认地址与默认登录行为的测试更新后核心重跑通过；第二次 662/663 且另一个 Android 文件加载失败。Android 相关测试因 `@noble/ciphers/chacha` 解析失败未通过，本次未修改该相关功能，不能称插件全量通过。
- Chromium 390px/1280px 下，Google（真正跨站模拟跳转）、OTP、密码登录均自动完成并成功兑换；未替代真实 Google/邮箱或手机真机验收。
- 公开 HTTPS start/poll/cancel、匿名下载及 SHA-256 比对通过；没有为公开探测注册实际设备。
- 待完成：移动端精确 redirectUri 白名单、真实同账号手机/电脑发消息和断网恢复、第二真实账号隔离、Mac/Windows/Desktop 真机。移动端也可先不传 redirectUri，通过 poll + exchange 联调；不要假设网页登录 cookie 是 App 的设备凭证。
- 当前修改尚未提交/推送，未向上游仓库或 npm 发布。Git 基线 `d48a11c63318db27ebe188d828db05dd20d7067d` 加工作区修改。

测试包：`artifacts/xcodex-device-login/ds-harness-remote-0.6.4-xcodex.1.tgz`；SHA-256：`e332e038442555a4fb58990e68a40359c2acee9cccb7a5ba3e61336c9dc70090`。

### 试上线后的回退

候选 `device-login-20261113-0a46c1069965` 在 15:33 完成切换及首轮检查，延长监测于 15:34:51（Asia/Shanghai）遇到既有 `api.moyisgs.com/` 请求超时。尚不能归因本次变更，按门槛停止并回退至 `xcodex-brand-20261113-c84a5b59fb6f`。新登录接口和下载 URL 当前不在线。共享 Nginx 未修改；v2 数据结构相同，回退保留试运行期间的用户/设备/凭证，未用旧数据覆盖活跃数据。部署记录及后续复测见 deployment-agent-xcodex-vip.md。

## OSS 测试包下载（已按用户要求删除，勿使用）

用户要求通过 ECS 内网上传；使用现有 OSS 配置和 `oss-us-west-1-internal.aliyuncs.com` 将已验证的同一份测试包上传至独立版本路径，未修改 bucket ACL。公网匿名下载比对 SHA-256 通过。

下载：https://ecjoy-media-us-20260921.oss-us-west-1.aliyuncs.com/xcodex/releases/ds-harness-remote/0.6.4-xcodex.1/ds-harness-remote-0.6.4-xcodex.1.tgz

```bash
dsh plugin --profile web add -w https://ecjoy-media-us-20260921.oss-us-west-1.aliyuncs.com/xcodex/releases/ds-harness-remote/0.6.4-xcodex.1/ds-harness-remote-0.6.4-xcodex.1.tgz
```

Desktop 仍使用自己 Desktop 配套的官方启动器，将 profile 换为 desktop。版本 `0.6.4-xcodex.1`；大小 1,671,280 字节；SHA-256 `e332e038442555a4fb58990e68a40359c2acee9cccb7a5ba3e61336c9dc70090`。该 OSS 对象已按用户要求删除，历史链接与命令不可再用。

## 本次重试最终状态

当前生产版本 `device-login-20261113-0a46c1069965` 已上线，健康检查、登录方式发现、设备 start/poll/cancel 通过。此前回退记录仅代表上一次尝试；目前新接口与站点下载地址均已恢复，ecjoy OSS 对象已按用户要求删除，不得使用上述历史 OSS 下载地址。真实账号和手机真机验收仍待完成。

2026-11-13：用户明确禁止使用 ecjoy OSS；仅删除本次插件对象，未操作 bucket 或其它对象。后续上传须使用用户指定的存储位置。
