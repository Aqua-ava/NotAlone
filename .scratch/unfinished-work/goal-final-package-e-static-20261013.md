# 最终候选包 E：静态构建与交付材料记录

E 候选包已构建并形成静态基线，实际 App 启动为 **0**。本记录冻结构建材料所写的源码点 `79573503`，不继承 C 的组合验收，也不把 D 包场次 E／F 的前台实测算作本 E 包通过。固定 WCDB 的精确源码／补丁／构建输入和实际二进制许可覆盖仍缺；Mac20 保持 claimed／needs-info、四项 AC 仅原第1项已勾。两轴审查及 Root 主题提交在本记录冻结后安排。[原20票](../mac-desktop-app/issues/20-mac-app-delivery.md)、[精确来源缺项](goal-mac-20261013-provenance.md)、[既有C静态归档](goal-mac-final-c-artifact-20261013.md)

## 构建入口、实际耗时与失败

产物为仓库忽略目录 `desktop/artifacts/goal-final-package-20261013-e/NotAlone-darwin-arm64/NotAlone.app`。Root 使用现有 `npm run package`，显式指定 C 包中固定 v1.6.25 的 CLI／WCDB 输入、`--with-probe`、新建端侧 Electron ZIP 目录及独立 E 输出目录；入口和参数仍见[桌面说明](../../desktop/README.md)。后端 Python／PostgreSQL 继续使用外置本机环境，没有打入 ASAR；本记录没有启动后端或检查业务资料。

首次 prebuild guard 在构建前因旧离线 Electron ZIP 已不存在而失败，尚未执行 package；`prebuild-plan-v2.json` 保留该事实和旧离线目录当前为空。该前置失败没有独立耗时收据，不能算产品运行失败或补写旧包存在。随后从同一个已安装 `desktop/node_modules/electron/dist`，沿已有 `test:package` 的 `ditto --norsrc` 配方重建 Electron 44.7.0 运行时输入 ZIP，实际 **8.855598208秒、exit0**；583条目、AppleDouble条目0，ZIP为130223500字节，SHA-256 `cefff4cd961989ad3424fc92db76f848b2065bea1c75e7d757b5c5fae274cac7`。这是本次自建输入，既不是旧 `0dfd…` ZIP，也不是官方发行 archive；xattrs／ACL／resource fork 全覆盖未认证。它不是 E App 的交付归档。

正式 `npm run package` 实际 **18.786353458秒、exit0**，未超时、source_drift为空、源码未被构建改写。构建日志保留一次 `.icon` 格式缺失警告；没有为此绕过签名或实际启动界面。`build-terminal-v1.json` 当时仍标记静态核查待做，后续 `root-static-baseline-v1.json` 才记录完成结果，两份原收据均保留。前述两个入口合计27.641951666秒，不包含缺少耗时证据的首guard、等待或后续静态读取。

## 包内字节、原生输入与资源

Root 基线记录 **280普通文件、14符号链接，共294项**；子Agent仅用标准库实际重算全部文件SHA／字节／模式、全部链接目标／模式，与该294项基线完全相同。App ASAR SHA-256为 `376c9a53920c4b7e5c927383e1b170ec755033ca5a96aa6573707204c48449ab`，其顶层只有 `dist` 与 `package.json`。包内六份实际dist与本次工作区dist逐字节相同，属于读取时快照，不代表后续源码继续冻结或实际功能已通过。

| helper／动态库 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `wechat-cli` | 9190002 | `59de512a52d7960aef70da6b42d199358429662919f5b4baababc5132a660355` |
| `libWCDB.dylib` | 5120912 | `279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3` |
| `libNotAloneSyncCore.dylib` | 682144 | `9235a1e91850d58fd6e63aa05bf8866458145f38224c08f3ba11ba0ebf2f2570` |
| `notalone-sync-probe` | 135376 | `e10512d1c287986c4eda2690f2853248d042ac2cb4e1914f714952c109e7605c` |

Root 收据将四项均记录为 arm64／signature verified。没有执行这些二进制；CLI／probe manifest 的 `helperExecuted`、`runtimeValidated`、`nativeAcceptance` 均为false，CLI 的 `provenanceVerified` 也为false。本原生输入摘要为 `7f4fed1ef4edeb310f69897e9e007d6a8314a727606d956b2ebeb785b3288934`，随包probe manifest的十一项与当前源码及预构建计划完全一致，按构建脚本的有序JSON摘要重算同值。

| 原生构建输入（相对 native/macos） | SHA-256 |
| --- | --- |
| `scripts/build_cli.sh` | `00853f5be6beb098c412c6363157a54e715f7bfc5a840784ba7e475a28bf8ce6` |
| `Sources/NotAloneSyncCore/ProbeCore.swift` | `3707bed0bbf1f7fbcb8288bba15cffc6e4a74d9a0aa1edf1452805a4b12dd205` |
| `Sources/NotAloneSyncCore/SessionCaptureSafety.swift` | `127a71b7c747346f01b20f7d927a18422bfe5c9ff1dfd5a120c987f4c13d0b5e` |
| `Sources/NotAloneSyncCore/RegionCalibration.swift` | `673b6d81e5bac7bf2de3c79139d1bdc58fae69696990bc6754ada38e78970f71` |
| `Sources/NotAloneSyncCore/MinimalRegionLayout.swift` | `f2ad5a27739d85ebbd82e03476e7c2da8c30162dbe520f3c07f436578087cc66` |
| `Sources/NotAloneSyncCore/MinimalSessionCapture.swift` | `9bfd83b1bcf325e12c303d8f51076024ef665d01b829e1696a334a42042c0e94` |
| `Sources/NotAloneSyncCore/CaptureSupport.swift` | `f702c8edf7473cfb32b3be15a908e9184f8db371c126a12b87e4a54070a60cd0` |
| `Sources/NotAloneSyncCore/SelectedSession.swift` | `ec0c6823ddfb25e313a72a559fb3941745ff64ea0c2029b38db31f4fac645d38` |
| `Sources/NotAloneSyncCore/FrontSyncStatusReport.swift` | `81e6ad03598a54f690a34fc483a62c32a2964c20926adcf5089515b89204e552` |
| `Sources/NotAloneSyncCore/BackendStatusPolling.swift` | `04b8cab55b04867fb50ca566b7b12a8b7724e6204a812edd81d4d470ad964657` |
| `Sources/NotAloneSyncCLI/main.swift` | `b83baabd9f9ff440449e01c01c66e4b6015a77a71a142d39f6ca5d4599b97f35` |

`MinimalSessionCapture.swift` 的 `9bfd83b1…` 是已采纳条件ASCII复核策略：三个现有名称调用各自保留baseline，同一RAM小图仅在完整合法ASCII且低于0.90时至多补1次auto识别；完整UTF-8名称相同且实际置信度至少0.90才替换。前台／会话可见、精确窗口身份、最小区域、复读一致、0.90及帧只在内存的门保持。[生产接线证据](goal-ocr-conditional-ascii-wiring-20261013.md)、[H3独立实际对照](goal-ocr-ascii-recheck-plan-20261013.md)不认证本E包Capture或所有名称均能通过。

## 签名、权限与许可界限

Root 实际主包 `codesign --verify --deep --strict` 返回0；主包identifier为 `com.notalone.desktop`、ad-hoc、TeamIdentifier not set。子Agent本次没有重跑codesign。Info.plist的 `NSAllowsArbitraryLoads=false`，无UsageDescription字段。静态签名与当前可用性都不能认证Developer ID、公证或TCC责任归属；E尚未实际进行权限预检、Capture或联系人定位。[权限与错误台账](../../docs/macos-app-permissions-and-errors.md)、[已有最小归属核查](goal-ocr-permission-attribution-20261013.md)

随包 `Contents/Resources/notalone-third-party` 恰九份材料，完整集合、字节和SHA与C相同；逐一实际比对通过：

| 材料 | 字节数 | SHA-256 |
| --- | ---: | --- |
| `OpenSSL-LICENSE.txt` | 6279 | `0885ecb3437fc1178a62ee58ba3030e48cafab77dc31607e91208476338e0222` |
| `README.md` | 2367 | `09ab531c1e367f0f76cfa352091724b6df9b4f23f44e0d27d59888177a9222bf` |
| `SQLCipher-LICENSE.txt` | 1463 | `3eee3c7964a9becc94d747bd36703d31fc86eb994680b06a61bfd4f2661eaac8` |
| `WCDB-LICENSE.txt` | 22752 | `a4f22734425182c5937bdcf0dd317ba5039088599464a1f9bd9ba284621f2719` |
| `ZSTD-COPYING.txt` | 18091 | `f9c375a1be4a41f7b70301dd83c91cb89e41567478859b77eef375a52d782505` |
| `ZSTD-LICENSE.txt` | 1549 | `7055266497633c9025b777c78eb7235af13922117480ed5c674677adc381c9d8` |
| `manifest.json` | 4303 | `cd393ffb38a6741b886e0bf524ef94e1451c6d954100a7426609cd5e816427bb` |
| `wechat-cli-LICENSE.txt` | 1066 | `27bb479513ef65b019bceb80b2a9614df19687e80ac650b815e1a18d97657710` |
| `wechat-cli-THIRD-PARTY-NOTICES.md` | 794 | `d96086f2c9a8aa38790892f0b88503a2972b0c929ea9e139a0e452483c76f274` |

许可manifest继续 `exactBuildSourceVerified=false`、`binaryLicenseCoverageVerified=false`。固定WCDB库SHA为 `279ac685…`，相近版本源码、既有许可原文、CLI发行声明和严格签名均不能补齐该库的精确链；仍需绑定此SHA的源树／子模块revision、补丁或未修改声明、编译器／SDK／crypto／链接输入及构建记录、实际组件BOM／逐组件许可。没有新查上游、升级CLI或换库。[原精确缺项](wcdb-provenance-followup-20261012.md)

## 完整E目录的实际归档与收尾

Root另在有限静态窗口12:50:11.487811–12:55:11.487811（Asia/Taipei，App／helper／HTTP上限均0）归档整个`NotAlone-darwin-arm64`目录，含App及Electron两份许可／版本文件共四项；实际于12:50:25.262050结束，入口单调耗时 **13.774257334秒、通过**，没有本次新失败。源码、签名及包没有重建；工具复用旧C只读snapshot／codesign函数，未执行旧main，准备阶段已将native硬编码fallback改为实际manifest字段。

交付[完整E目录ZIP](../../desktop/artifacts/goal-final-e-archive-20261013/NotAlone-final-e-darwin-arm64-20261013.zip)为 **140293431字节、0600**，SHA-256 `7db9cebb43c4a741a131bf05e13aef35f81f5cf416852b7e9722403fd058561c`。620条目由283普通文件（含App280）、14链接、323目录组成；ZIP全部Unix属性与源相同、CRC检查无错误。直接解压的完整文件字节／模式／链接已相同，本次链接模式修复为0，不继承旧C失败或将其追写为通过。

沿既有`ditto -c -k --norsrc --keepParent`实际归档9.464413750秒，`ditto -x -k --norsrc`解压0.668227250秒。源目录、直接解压、最终解压三组各主包＋四helper共 **15次严格签名verify全部exit0**，均未执行App或helper。签名、文件属性及完整快照是静态证据，xattrs／ACL／quarantine／resource fork、TCC、WCDB精确链及实际功能仍未认证。

[静态归档报告](../../desktop/artifacts/goal-final-e-archive-20261013/static-report.json)SHA-256为 `4d32d2f15f382e3412fbd3b14c7e508c0edd1b368bacb60d54153c4bfac15686`；`verify_e_archive.py`为 `dd91f3e090be6f4f80ef0ef2a76a0006f13ad20eaaf902b2de481df98700a82c`，计划和包前后／ZIP属性／两个解压快照在同一忽略目录保留。Root后续[独立终态收据](../../desktop/artifacts/goal-final-e-archive-20261013/root-terminal-independent-v1.json)SHA-256 `c02f282a83641bd52ff551b399f218393add97d660a4f0a95d8d178e9f167d7c`：重新核ZIP摘要／大小／0600、源前后及解压快照相同，六个自有ditto命令均exit0且即时ps显示gone，自有dev／ino临时目录已精确移除、复核当前absent。没有认证全OS清理；E App启动／helper执行／Vision／CLI／模型HTTP／桌面操作仍0。

## 证据及当前未验部分

下列原收据保存在端侧私有构建目录，原日志及ZIP不提交；公共文档只保留文件名与摘要，不含本机身份、证书主体、账号或聊天资料。

| 收据 | SHA-256 |
| --- | --- |
| `prebuild-plan-v2.json` | `271e3c01c42223e4d0b539bfa0ec806be2e0e49870b8b7613268e13eb153c850` |
| `archive-preparation-v1.json` | `63c2fc4dfe1eb9a94be3f402d2d8efda8bd2a44e9d300aab1e03c0a03d900fe7` |
| `actual-build-command-v1.json` | `3e9be69e93034ed75218e730d01988d7360898d2a2b731100bc4df62630cff50` |
| `build-terminal-v1.json` | `ec8045df959ea0ccfcf3a7feac29f374043db9844eb2c303c97b7b2eb7728c4d` |
| `root-static-baseline-v1.json` | `bbe8f4fde98bacf31108c82ceeb6ac9a2c8f6c8bcd4e282c5a6a963de20836fd` |
| `ASAR-dist-verification-v1.json` | `8ea822d9607d6b299bbeaa7cad95daa679f2fa76928ed07a406a82118ac29aa7` |
| `subagent-static-crosscheck-v1.json` | `b3b7aeba28fa5b31d2d912f451997b36e27bfb2ef2e762c05a48851cc31f3e96` |

子Agent完整静态字节交叉检查实际0.441238667秒，只写自有证据；没有新增App／helper／Vision／微信／模型HTTP／PG／`.env`读取、权限或签名修改，也没有Git操作。只读检查工具曾因把整数计数当容器而失败、一次可选源码搜索路径不存在；均没有执行产品或改包，另留最小失败记录，不充作产品red／green。运行时输入ZIP、E目录及上述完整交付ZIP保留；Root归档临时目录与六个自有ditto命令收尾已单列。本静态片没有建立App租约、业务库或运行中的后台任务，不认证全OS或其他构建进程的收尾。

下一步仍由Root在新的有限 `test:app` 时段核对同E包基线、实际helper父子与TCC责任、最小Capture／低分／重名与绑定失效／焦点保护，以及同包最终组合。旧C成功、D/F失败和H3合成图的正负控分别保留，不能相互替代。原AC、默认空放行表、真实联系人范围和用户手动发送边界不变。
