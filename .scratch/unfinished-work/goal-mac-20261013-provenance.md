# 持续目标：Mac 交付与 ECNU 体验证据检查点（2026-10-13）

## 结果与下一步

当前固定 `libWCDB.dylib` 的精确源码、补丁、构建输入和二进制许可覆盖仍未确认。此次取得发行者当前官方源码树的七份不可变 blob 并核对 Git blob hash；该构建明确使用 **WCDB 2.1.16、`WCDB_ZSTD=OFF`**，不能替代现有 **2.1.15 install name、含 Zstandard 导出** 的库。没有升级 CLI、换库、改许可材料或迁移数据。[当前官方锁定输入](https://api.github.com/repos/r266-tech/wx-cli/git/blobs/a6e3382b5b40b00894943ff1a21d146fdc2b9e98)

现有最新 ECNU 候选包的主包与四个 helper 严格签名、九份许可材料均通过静态复核；六个 `desktop/dist` 文件与该包 ASAR 逐字节一致。当前原生 OCR 修复使 `MinimalSessionCapture.swift` 与该包 probe 的构建清单不同，最终候选必须重新打包，再由主 Agent 完成一次完整组合验收。旧许可包的 23 个非 OCR 完整场景不迁移为新包通过。[Mac20 原票](../mac-desktop-app/issues/20-mac-app-delivery.md)

ECNU 体验的第二场 `.last-run.json` 已为 `passed`，首场仍为 `failed`；两场已记录 App PID 当前均不存在、各自 userData 均不存在。但没有取得原守护器完整收据、真实模型尝试计数或真人语义反馈，不把简要测试终态等同于真实模型质量。原票继续 `claimed`。[ECNU01 原票](../ecnu-reply-budget-adaptation/issues/01-production-estimated-budget.md)

## 限定公开核查

2026-10-13 00:58:35–00:59:58（Asia/Taipei）的本轮脚本共访问 **17 个官方公开端点**：无认证头或帐号、单请求 20 秒上限、JSON 正常响应最多 1–2 MiB、错误正文最多 8 KiB；旧源码归档尝试上限 16 MiB，实际只有 404 的 14 bytes。先前 Web 精确 revision／digest 搜索没有取得直接匹配证据，结果不代表穷尽互联网。没有再次下载发行二进制或 Tencent 候选归档。

| 官方材料 | 实际结果 | 对当前固定库的意义 |
| --- | --- | --- |
| [v1.6.25 发行 API](https://api.github.com/repos/r266-tech/wechat-cli-releases/releases/tags/v1.6.25) | HTTP 200，9 资产；ZIP digest 与此前固定值相同 | 确认仍讨论同一发行；资产没有新增源码、BOM、构建日志或证明文件 |
| [旧精确 CLI revision](https://api.github.com/repos/r266-tech/wechat-cli/commits/7b387ac76da6439c9ecb5f741a400d14ae9fa423) | HTTP 451 | 仍无法从该端点取得源树；不推断 revision 不存在 |
| [旧精确 revision 的 codeload](https://codeload.github.com/r266-tech/wechat-cli/zip/7b387ac76da6439c9ecb5f741a400d14ae9fa423) | HTTP 404 | 未取得旧源码快照；同 revision 的 raw 请求另有 `URLError`，不当作 HTTP 404 |
| [新 canonical 仓库中的旧 revision](https://api.github.com/repos/r266-tech/wx-cli/commits/7b387ac76da6439c9ecb5f741a400d14ae9fa423) | HTTP 422 | 不能用新 clean history 恢复旧 revision |
| [发行仓库 tree](https://api.github.com/repos/r266-tech/wechat-cli-releases/git/trees/main?recursive=1) | HTTP 200，完整树只有 README | 发行仓库未提供额外构建源文件 |
| [当前 canonical tree](https://api.github.com/repos/r266-tech/wx-cli/git/trees/main?recursive=1) | HTTP 200，非截断，tree SHA `d833d68737454169848760642b2127302911de1b` | 固定本轮公开输入，tree SHA 不冒充 commit SHA |
| [发行仓库当前库 digest attestation](https://api.github.com/repos/r266-tech/wechat-cli-releases/attestations/sha256:279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3)及[canonical 仓库同 digest](https://api.github.com/repos/r266-tech/wx-cli/attestations/sha256:279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3) | 匿名请求均 HTTP 404 | 本次未取得证明；不扩大为所有帐号或历史证明都不存在 |

七份已保存材料：README、`release-dependencies.json`、THIRD_PARTY_NOTICES、prepare-release-inputs、release-macos workflow、RELEASE_GOVERNANCE、release-manifest。每份 API 解码内容都核对了 `sha1("blob " + size + NUL + bytes)` 与 immutable blob SHA，也保存 SHA-256 和字节数。

锁定文件的 WCDB commit 为 `df808591b9f9a9ab42156006819c3550d5af13a3`，候选源码归档摘要 `260845053c5dedc4578570203a5ba235c3be1e74a671c2fc1aeb12c988dd5346`。构建脚本使用该锁、CMake 和 arm64，改 install name 后 ad-hoc 签名；这些明确输入属于新构建，并未绑定当前库 `279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3`。[不可变构建脚本](https://api.github.com/repos/r266-tech/wx-cli/git/blobs/54e8c8022036f591849113751f125369caaf82e3)、[发布治理材料](https://api.github.com/repos/r266-tech/wx-cli/git/blobs/8acc1d186185656b5853fcb6c6c391c5b0f24385)

解除本项需要上游提供绑定该库 SHA-256 的实际 source tree／子模块 revision、补丁或未修改声明、编译器／SDK／命令／crypto 与链接设置、对应构建记录，以及实际编译／链接 BOM 和逐组件许可。相近 tag、当前 v2 锁、版本字符串及九份候选原文均不足。未向发行者发送消息或提交 issue。[先前精确缺项清单](wcdb-provenance-followup-20261012.md)

## 最新候选包静态结果

- 路径：`desktop/artifacts/ecnu-estimate-package-20261012/NotAlone-darwin-arm64/NotAlone.app`。本轮没有运行或修改 App；ASAR SHA-256 为 `919523eaf71bcc289e7009b5e8cd5723a376799faaa033de3e33c6802c3e4cfe`，不同于完成 23 个非 OCR 场景的旧许可包 `27cc230a…`。
- 主包 `codesign --verify --deep --strict` 通过，`com.notalone.desktop`、ad-hoc、无 TeamIdentifier；entitlement 只有 `com.apple.security.cs.allow-jit`。没有 NSUsageDescription 新声明，ATS arbitrary loads 为 false。不是 Developer ID／公证证据。
- 四个 helper 均严格签名通过，SHA-256 与固定记录相同：CLI `59de512a…`、WCDB `279ac685…`、核心库 `e9f8ed9b…`、probe `e10512d1…`。公开 `npm --prefix desktop run check:helpers -- --directory <该包notalone-helpers> --version 1.6.25 --source <固定发行URL>` 返回 exit 0／`static_checks_passed`；`provenanceVerified`、`runtimeValidated`、`nativeAcceptance` 均为 false。
- 对该包固定 WCDB 的本次 `otool -L`／`nm -gU` 均 exit 0，直接确认 install name 为 `@rpath/WCDB.framework/Versions/2.1.15/WCDB`，导出 `_ZSTD_versionNumber` 与 `_ZSTD_versionString`。只读 Mach-O，没有执行／装载库；这些标记只用于排除新 2.1.16／ZSTD 关闭材料的替代关系，不认证旧库 source revision。
- 八份内容文件及 manifest 共九份，大小／SHA 与仓库完整原文一致；包内 manifest 逐字节相同。`exactBuildSourceVerified`、`binaryLicenseCoverageVerified` 保持 false。
- ASAR 中六个 dist 文件与当前 `desktop/dist` 一致。probe 的十一份构建输入中，当前未提交 OCR 修复的 `MinimalSessionCapture.swift` 不一致，其他十份一致；这里只记录本轮读取时的快照，不冻结主 Agent 的修复。
- 静态脚本首步相对目录 `require` 未解析 ESM exports、退出 1；读取安装的 asar 4.3.1 exports 后改明确模块路径，随后读取成功。entitlement 首次 `--entitlements -` 没有取得 XML，改用本机支持的 `:-` 后验证唯一字段；没有把空解析认作无权限。两项诊断失败独立保留，未修改产物或放松签名。

## ECNU 体验最小终态核对

仅读取本轮两个 `.last-run.json`、App ownership 元数据及这些普通文件的 mtime；未读取私人 DOM、日志正文、聊天、配置、原库或模型请求。来源为 `desktop/artifacts/real-ecnu-experience-McMLPn/`、`desktop/artifacts/real-ecnu-experience-jsbsOZ/` 的原始记录。

| 场次 | 原测试终态 | 已记录 App／userData 当前结果 | 文件时间证据 |
| --- | --- | --- | --- |
| McMLPn 首场 | failed，1 个失败测试 | PID 不存在、userData 不存在 | ownership 写入 22:06:30.422；last-run 写入 22:06:35.277 |
| jsbsOZ 第二场 | passed，0 个失败测试 | PID 不存在、userData 不存在 | ownership 写入 22:07:32.081；last-run 写入 22:27:17.440 |

时间均为 2026-10-12 Asia/Taipei。第二场两个文件 mtime 相隔 1185.359 秒，**只是元数据写入区间，不作为实际 App 运行秒数**。完整 runner exit／正常菜单退出／后端与租约收尾／真实模型尝试计数尚缺可核查守护收据，真人语义反馈没有从这些材料得到。不能用 `.last-run passed` 补出未记录的模型质量或计数。未在系统临时目录找到与已记录两个 run ID 同名的守护目录，没有扩展扫描其他私人目录。

## 证据索引、验证与资源

本轮原始公开响应、immutable blob、静态结果、首步失败和最小终态摘要，均保存于忽略目录：`desktop/artifacts/goal-mac-provenance-20261013.1za69b13/`，主要文件为 `public-query.json`、`static-package.json`、`static-package-first-failure.json`、`ecnu-experience-minimal-status.json`。这些文件是证据产物，不提交第三方完整源树或任何私人资料。先前[来源摘要](wcdb-source-license-20261012.json)、[非 OCR 场景](mac-delivery-non-ocr-20261012.json)、[焦点结果](mac-focus-final-20261012.json)、[真实 CLI 退出分项](mac-real-sync-quit-final-20261012.json)均保留。

本检查点子任务 App 启动 0、外部模型调用 0、微信读取 0、测试消息 0、业务数据库读写 0，不代签主 Agent 其他并行执行的计数。没有系统权限、TCC、配置、上游二进制、默认资料、库版本或远端 Git 变更；没有新后台服务需要清理，仅保留本任务自有证据目录。主 Agent 已获新一轮 OCR 与微信验收授权，旧记录的 OCR 暂停仅保留为历史事实。

文档最小验证：Conda `NotAlone` 的 Python 标准库检查七条本地链接全部可达、无尾随空白、有结束换行；公开 JSON 聚合核对 17 次请求、七份 blob hash、四份 helper 签名、九份材料、六个 dist 及十一份 probe 输入（一个预期 OCR 改动差异）。`git diff --no-index --check /dev/null <本文件>` 无空白错误，exit 1 仅表示新文件与空文件有差异；暂存后另做正常 diff 检查。没有为纯证据文档重跑 App、模型或业务测试。

独立两轴：memory_diagnosis 审 Standards，硬违规／Fowler 判断气味／证据越界均为 0；ocr_repair 审 Spec，新增 missing／scope／error 均为 0。评审仅读取本文件及必要公开证据，不读取私人正文或运行第三方二进制。本文件不将外部缺项写成成功，也不改变 Mac20 原四条验收条件。主题独立本地提交随后执行，远端 Git 操作 0。
