# Xcodex Remote 独立插件与统一登录

## 2026-11-13 实施计划

1. 将包、Component、Cordis、控制接口、设置与本地存储隔离为 xcodex-remote；不迁移、不禁用官方插件，不改线上传输协议与用户归属校验。首次安装重新登录。
2. 邮箱密码使用与网页登录相同的 Supabase 身份验证，保留旧客户端接口兼容。Google 通过系统浏览器完成设备授权。登录页移除旧 OAuth/扫码入口，保留自建服务器地址设置。
3. 统一 Xcodex Remote 显示名称，保留上游许可证与源码归属。
4. 执行核心认证测试、构建、包外安装与官方插件共存验证，再发布版本 0.6.4-xcodex.2。
5. OSS 仅上传用户指定的非 ecjoy bucket；等待目标信息不阻塞代码工作。

## 验收与未完成

代码、打包与服务端部署完成；真实用户 Google/邮箱登录、手机连接及 macOS/Windows 验收需区分模拟验证，不宣称已完成。

## 实现契约

- 包名/执行命令 `xcodex-remote`，Component ID `vip.xcodex.remote`，版本 `0.6.4-xcodex.2`。
- 独立 Cordis 服务、浏览器单例、CSS/事件、设置、HTTP 控制路径 `/xcodex-remote/*`、本地工具名 `xcodex_remote_*`；保留线上 RPC/Noise/设备归属协议兼容。
- 默认目录 `$DSH_HOME/xcodex-remote`（未设 DSH_HOME 为 `~/.dsh/xcodex-remote`）。不读取/迁移官方 `remote` 或 `ds-harness-remote` 目录、不禁用官方 loader。环境变量使用 `XCODEX_REMOTE_*`；DSH_HOME 仍为宿主通用变量。
- 新增原生客户端 `POST /api/v1/auth/account/password`，邮箱密码同网页走 provider.passwordLogin/Supabase。原 `/auth/login` 保留旧客户端契约。自建本地鉴权模式保留本地账号验证。
- Google 按钮沿用设备绑定/PKCE 流程，浏览器 URL fragment 添加一次性 UI 提示 `login_provider=google`，网页自动启动 Google。提示消费后清除，失败可手动重试，不把 token 放进 URL。
- 密码登录前取消未完成浏览器授权，阻止迟到的授权覆盖新登录；只在本机插件保存设备凭据。
- Google 注册但未设置密码的账号应使用 Google，错误提示说明此情况；不能保证任意 AUTH_INVALID 都是接口问题。
- 未发布受控 npm 更新源前，禁用 npm 自动更新提示，避免指向无关同名包。上游 MIT、作者与源码归属保留。

## 验证记录

- 服务端 6 文件 / 100 tests 通过，类型检查及构建通过。
- 插件全量已执行 650 tests 通过；Android browse subscription 测试文件在收集时因 @noble/ciphers/chacha 依赖解析失败，未算作通过。原扫码页面测试已改为共享登录组件的密码失败/成功、Google 设备 URL 和取消契约测试。
- 已验证官方 0.6.4（从 Git d48a11c 的已构建包产生）与新包同时安装、Host 模块及浏览器模块同时激活、独立身份；模拟身份上游下密码登录、设备浏览器交接及 Host online 通过。
- 环境 Linux，打包/服务端 Node 22.22.0；真实 DSH 0.2.2-rc.1 试装使用 Node 24.9.0。390px/1280px 实际 Harness 页面确认邮箱密码和 Google；网页六场景（OTP/密码/Google × 两宽度）通过，均为模拟身份上游。
- 包外 GitHub/npm 两种依赖闭包与真实 WebRTC fallback 双向 DataChannel 通过。
- 新包 SHA-256：`76cfad250e555d36b6cda5eb2af389a6236ea1ae8a936a9cabfad96388e70a69`。
- 真实 Google/邮箱账号、macOS/Windows 安装、手机真机连接待用户验收。OSS 等待指定非 ecjoy bucket；不能把旧 ecjoy 地址当下载地址。

## 发布状态

服务端 `xcodex-plugin-auth-20261113-2bddbdc1ccb2` 已上线。仅重启本项目服务，启动耗时 0.542 秒，保留现有 5 个设备和所有账号映射/凭据，未改共享入口。

同一份试装包已可匿名下载：
https://agent.xcodex.vip/assets/xcodex-remote-0.6.4-xcodex.2.tgz

```sh
dsh plugin --profile web add -w https://agent.xcodex.vip/assets/xcodex-remote-0.6.4-xcodex.2.tgz
```

下载摘要与本地试装包一致；OSS 上传尚未完成，等待用户指定非 ecjoy 存储位置。仓库工作区修改尚未提交/推送；对应基础提交 `d48a11c63318db27ebe188d828db05dd20d7067d`，不能把新包标作该提交的纯构建。

发布监测完成：33 个既有目标共 792 次探测、0 新增状态/TLS/延迟异常，旧站同一长连接 114 秒 / 22 次请求保持。实际 OSS 列表仅有 3 个 ecjoy 桶，均未上传；仍需用户指定其他目标。
