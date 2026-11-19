# 插件更新发现与安装来源

2026-11-19：现有更新检查只读 npm 的 `xcodex-remote` dist-tags，而当前发行物位于 `ljx149/ds-harness-remote` 的 GitHub Releases；另有更新链接遗留指向 `liguobao`。因此仅发布新 Release 不会触发旧插件的更新提示。

本次改为启动时及每小时检查自己 fork 的 Releases（最近 100 条）。只识别 `xcodex-remote-<版本>` 且已上传同版本 tgz 的发行，忽略草稿、其他组件和非本仓库下载地址。按语义版本比较；测试版安装可检测测试发行，正式版不自动进入测试通道。失败保留上次成功结果，不阻塞启动。使用匿名公开 API，不发送登录凭据。发布后的提示需等待检查和状态刷新，不是即时推送。

这修复的是插件自身侧栏和设备页的更新提示。DSH 0.2.2 的 `dsh-plugin-manager` 中 `updateRefusal()` 明确只允许安装来源为同名 registry 包的原生更新。GitHub tgz 安装仍不能使用原生一键更新。要做到这一点还需准备 registry 发布和迁移安装来源，或另行设计 URL 更新能力；本次未修改 DSH 核心、未发布 npm。

旧版本的检查逻辑不会自动变化，需要先手动安装包含此修复的新版。单纯提交分支也不会产生更新提示，必须发布带同版本 tgz 的 Release。本次提交未发布新安装包。

验证：4 项更新检测测试、TypeScript 类型检查、bundle 构建和包结构校验通过；匿名请求真实 GitHub API，成功识别 `0.7.0-xcodex.3`。未做本轮 DSH 真机更新提示验收。
