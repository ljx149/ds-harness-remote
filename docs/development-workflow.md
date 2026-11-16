# 开发与线上分支约定

2026-11-16，按用户要求设立。

| 名称 | 地址/用途 |
| --- | --- |
| origin | https://github.com/ljx149/ds-harness-remote.git，用户 fork，提交与推送目标 |
| upstream | https://github.com/liguobao/ds-harness-remote.git，上游同步来源 |
| production | 当前线上运行代码基线；只在验证并授权发布时更新 |
| dev | 从 production 建立，所有后续日常开发在这里进行 |
| main | 保留现状，不在本次建立分支时合并其新增内容 |

## 初始线上基线

- 原始基础提交：d48a11c63318db27ebe188d828db05dd20d7067d，加上本地已完成的 Xcodex 适配与诊断修改。
- 实际 server release：exchange-diagnostics-20261113-4492148c416b。
- 实际插件：xcodex-remote@0.6.4-xcodex.2。
- 插件包 SHA-256：76cfad250e555d36b6cda5eb2af389a6236ea1ae8a936a9cabfad96388e70a69。
- 建立分支前将 21 个服务端/网页源文件与线上发布源归档比较，内容一致；插件 Host bundle 与已发布 tgz 一致。
- 本次只提交、推送代码和文档，不触发线上部署、不修改 Nginx/DNS/证书，也不重新签发任何凭据。

## 后续流程

在 dev 开发、测试、提交并推送。需要同步上游时，在 dev 上审查合并并验证，避免直接更新线上分支。发布前记录目标提交、测试结果、数据兼容性和回滚版本；获得发布授权后更新 production，并执行本项目部署流程。不能仅凭 production 分支有新提交就声称线上已更新。

生产状态、凭据、env 文件、私有备份、日志和 tgz 不入 Git；保留项目既有允许跟踪的两个插件 bundle。功能与实测限制见 docs/TODO.md、docs/xcodex-plugin-isolation.md、docs/device-exchange-diagnostics.md。此前文档“未提交/推送”是当时的历史状态，本次分支建立将其保存为可追踪提交。
