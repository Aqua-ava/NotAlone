# 当前外置微信工具候选包 G：静态构建与完整归档

本轮按当前[交付票20](../mac-desktop-app/issues/20-mac-app-delivery.md)和[外置工具规格](../external-wechat-tools/spec.md)补建候选包；用户已取消第三方CLI／WCDB随包及其来源获取子项，历史E／F和许可未证结论保留。现场继续按用户“暂缓现场验收，继续代码与证据”；本次实际App、微信、CLI、探针执行、OCR、模型HTTP、PG、发送、权限变更均0。只构建、静态核对和归档，不能代签当前包的组合验收。

## 产物及实际时长

- 源码点`d26f460615d7a290fa22471bf6daa36496495f1a`；186份桌面／打包／原生输入逐项SHA，打包前后保持；后端与Python／PostgreSQL外置。
- 从已安装Electron 44.7.0重建离线输入，9.293276542秒／exit0，SHA `cefff4cd961989ad3424fc92db76f848b2065bea1c75e7d757b5c5fae274cac7`。该档来自本机安装runtime，不冒官方发行档。
- 公开`npm run package -- --output-directory <新目录> --electron-zip-directory <本轮离线目录> --with-probe`实际20.949966875秒／exit0，包含前端build；未执行App或自研探针。
- App：`desktop/artifacts/goal-final-package-20261014-g/NotAlone-darwin-arm64/NotAlone.app`。
- 完整交付ZIP：`desktop/artifacts/goal-final-package-20261014-g/NotAlone-macOS-arm64-G-external-tools.zip`，134699612bytes／606条目，SHA `f5d8bc405b773eeb1857487a9f19691a06094d960ed8fa3e5a54d2c454832ca6`；归档9.790571875秒／exit0。包括完整App、两份Electron许可及version。

## 静态证据及边界

ASAR `1a1c165105cef7b066d9bdcf700206435209280b97c64d21b01f082d5acbe0e6`；全部6份当前dist与档内逐字一致，启动清单只含name／productName／version／description／main。包中无wechat-cli、libWCDB.dylib、notalone-helpers或notalone-third-party；只附自研notalone-probe两文件及manifest，文件SHA逐项核同。当前外置CLI配置需用户本机安装和确认路径，静态包不能证明工具可用或正文同步。

交付目录271普通文件／14符号链接／321目录（含顶层）；ZIP完整性和AppleDouble缺席检查通过。直接ditto解压0.899784042秒，完整文件字节／模式／链接目标与源快照一致，零差异；原目录末核不变。原包及直接解压副本各核主包deep strict与两自研文件strict，共6次exit0。identifier com.notalone.desktop／ad-hoc／无Team，主包仅allow-jit，ATS arbitrary loads=false、无UsageDescription。静态签名不证明TCC责任、Developer ID、公证、quarantine、xattrs／ACL／resource fork或所有OS安装环境。

自有直接解压目录和本轮Electron输入按当前所有者／目录身份及已记录输入摘要核对后清理，产物和私有收据保留；未动默认userData、用户外置工具或未知资源，不宣称全OS清理。工程脚本自有staging按finally结束，所有本轮同步子命令返回；没有App／监听进程。原票claimed／needs-info及原4AC保持，历史Finder勾选不是当前G Finder成绩。

所有原始输入摘要、源／解压快照、ASAR比对、签名、归档日志和精确清理仅在忽略目录`desktop/artifacts/goal-final-package-g-prepare-20261014/`私有0700／0600保存；公开无私人会话／身份／帧／密钥。模型仍累计64真实HTTP，App612、发送8/12、来信0；本次新增均0。真实快捷键、前台识别／歧义／绑定失效／焦点、TCC责任、真实同步与最终退出／重开和当前包组合验收仍待现场恢复。默认维度放行空、模型质量和业务库迁移不由此包认证。
