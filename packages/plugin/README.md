# Xcodex Remote

使用 Xcodex 账号在手机和电脑之间建立加密远程连接。默认服务为 https://agent.xcodex.vip 。

安装下载的插件包：

```sh
dsh plugin --profile web add -w /path/to/xcodex-remote-0.6.4-xcodex.2.tgz
```

打开插件设置，选择「使用 Xcodex 账号登录」，填写邮箱、密码，或使用 Google 登录。Google 会打开系统浏览器，完成后自动授权本机。手机使用同一账号即可发现上线的电脑。

此插件使用独立包名、Component ID、设置、控制接口和 `~/.dsh/xcodex-remote/` 数据目录（设置 DSH_HOME 时位于该目录下）。不迁移或覆盖官方 ds-harness-remote 插件的数据；首次使用新版需要重新登录。若以前安装过同名的 Xcodex 测试包，可先在插件管理器中停用旧测试包，再安装新版。

源自 [liguobao/ds-harness-remote](https://github.com/liguobao/ds-harness-remote)，保留 MIT 许可证与上游贡献者归属。此分支不从上游 npm 自动更新。
