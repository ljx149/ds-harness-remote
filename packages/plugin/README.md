## Xagent scoped package (2026-11-20)

Package: `@xcoder/xagent`, display name: **Xagent**, preview version: `0.8.1-xagent.2`.
Publication is pending npm organization access; do not treat this name as an available download yet.
After publication, install `@xcoder/xagent@next` through DSH's plugin package installer.
An existing URL/tgz installation needs one migration to the registry package before DSH can update it from npm.
The Component ID, Cordis instance ID, settings namespace and credential directories remain unchanged to preserve pairing and sessions.
Finish running tasks before replacing the old installation; do not run both package generations together or delete credentials.
Update checks offer a notification; they do not silently install or restart running Agents.
The npm package is shared across platforms, but macOS/Windows recovery and desktop/mobile update acceptance remain pending.

# Xcodex Remote

使用 Xcodex 账号在手机和电脑之间建立加密远程连接。默认服务为 https://agent.xcodex.vip 。

安装下载的插件包：

```sh
dsh plugin --profile web add -w /path/to/xcoder-xagent-0.8.1-xagent.2.tgz
```

打开插件设置，选择「使用 Xcodex 账号登录」，填写邮箱、密码，或使用 Google 登录。Google 会打开系统浏览器，完成后自动授权本机。手机使用同一账号即可发现上线的电脑。

此插件使用独立包名、Component ID、设置、控制接口和 `~/.dsh/xcodex-remote/` 数据目录（设置 DSH_HOME 时位于该目录下）。不迁移或覆盖官方 ds-harness-remote 插件的数据；从官方插件首次安装需登录；已有 Xcodex 配对数据保持不变。若以前安装过同名的 Xcodex 测试包，可先在插件管理器中停用旧测试包，再安装新版。

源自 [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote)，保留 MIT 许可证与上游贡献者归属。此分支不从上游 npm 自动更新。
