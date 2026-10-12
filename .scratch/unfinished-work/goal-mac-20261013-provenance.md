# 持续目标：Mac 交付与 ECNU 体验证据检查点（2026-10-13）

## 结果与下一步

当前固定 `libWCDB.dylib` 的精确源码、补丁、构建输入和二进制许可覆盖仍未确认。此次取得发行者当前官方源码树的七份不可变 blob 并核对 Git blob hash；该构建明确使用 **WCDB 2.1.16、`WCDB_ZSTD=OFF`**，不能替代现有 **2.1.15 install name、含 Zstandard 导出** 的库。没有升级 CLI、换库、改许可材料或迁移数据。[当前官方锁定输入](https://api.github.com/repos/r266-tech/wx-cli/git/blobs/a6e3382b5b40b00894943ff1a21d146fdc2b9e98)

00:58 初查的 ECNU 旧候选包通过主包／四 helper 签名、九材料及六 dist 静态复核，但不含新 OCR 修复。后续候选 B 已重新打包，其十一 probe 输入匹配 `7a61a001`，同包静态复核通过；Root 的最终组合和独立现场实测仍另记下节。旧许可包的 23 个非 OCR 完整场景不迁移为 B 通过。[Mac20 原票](../mac-desktop-app/issues/20-mac-app-delivery.md)

ECNU 体验首场失败保留，第二场后续找到完整守护终态，明确实际就绪 1181.765 秒、正常退出与资源收尾；按原规格的 20 分钟有限开放及质量评测排除范围，Root 已将原票写 `resolved`。旧真实模型尝试数、用户是否生成和真人质量仍未知，不把守护通过等同于模型质量。后续补核与独立评审见末节。[ECNU01 原票](../ecnu-reply-budget-adaptation/issues/01-production-estimated-budget.md)

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

时间均为 2026-10-12 Asia/Taipei。第二场两个文件 mtime 相隔 1185.359 秒，**只是元数据写入区间，不作为实际 App 运行秒数**。00:58 初查时没有取得完整 runner exit／正常菜单退出／后端与租约收尾的守护收据；随后 Root 找到后在末节补核，真实模型尝试计数和真人反馈仍未取得。不能用 `.last-run passed` 补出未记录的模型质量或计数。初查没有在系统临时目录找到与已记录两个 run ID 同名的守护目录，没有扩展扫描其他私人目录。

## 证据索引、验证与资源

本轮原始公开响应、immutable blob、静态结果、首步失败和最小终态摘要，均保存于忽略目录：`desktop/artifacts/goal-mac-provenance-20261013.1za69b13/`，主要文件为 `public-query.json`、`static-package.json`、`static-package-first-failure.json`、`ecnu-experience-minimal-status.json`。这些文件是证据产物，不提交第三方完整源树或任何私人资料。先前[来源摘要](wcdb-source-license-20261012.json)、[非 OCR 场景](mac-delivery-non-ocr-20261012.json)、[焦点结果](mac-focus-final-20261012.json)、[真实 CLI 退出分项](mac-real-sync-quit-final-20261012.json)均保留。

本检查点子任务 App 启动 0、外部模型调用 0、微信读取 0、测试消息 0、业务数据库读写 0，不代签主 Agent 其他并行执行的计数。没有系统权限、TCC、配置、上游二进制、默认资料、库版本或远端 Git 变更；没有新后台服务需要清理，仅保留本任务自有证据目录。主 Agent 已获新一轮 OCR 与微信验收授权，旧记录的 OCR 暂停仅保留为历史事实。

文档最小验证：Conda `NotAlone` 的 Python 标准库检查七条本地链接全部可达、无尾随空白、有结束换行；公开 JSON 聚合核对 17 次请求、七份 blob hash、四份 helper 签名、九份材料、六个 dist 及十一份 probe 输入（一个预期 OCR 改动差异）。`git diff --no-index --check /dev/null <本文件>` 无空白错误，exit 1 仅表示新文件与空文件有差异；暂存后另做正常 diff 检查。没有为纯证据文档重跑 App、模型或业务测试。

独立两轴：memory_diagnosis 审 Standards，硬违规／Fowler 判断气味／证据越界均为 0；ocr_repair 审 Spec，新增 missing／scope／error 均为 0。评审仅读取本文件及必要公开证据，不读取私人正文或运行第三方二进制。本文件不将外部缺项写成成功，也不改变 Mac20 原四条验收条件。主题独立本地提交随后执行，远端 Git 操作 0。

## 后续最终候选 B：同包静态复核与组合验收范围

本节是第二片 OCR 诊断提交 `7a61a001847bacd9f163210dd236b8d96c83c7e9` 后的新快照，不覆盖前述旧包或其 23 场记录。候选为 `desktop/artifacts/goal-ocr-package-20261013-b/NotAlone-darwin-arm64/NotAlone.app`。本子任务只读取包、源码、测试和固定收据，未启动 App 或 helper、未读取微信、未调用模型；Root 的实际场次另记。

同包静态证据保存于 `desktop/artifacts/goal-mac-provenance-20261013.1za69b13/candidate-b-static.json`：ASAR SHA-256 为 `25c3e21fd9a27d3b909c6448b03cf286c63e0817b21c78a1ec006d00038f1d6d`。主包 deep/strict 通过，identifier 为 `com.notalone.desktop`、ad-hoc、TeamIdentifier 未设置；entitlement 仅 allow-jit，ATS arbitrary loads 为 false，没有 UsageDescription 声明。这不是 Developer ID、公证或实际屏幕权限证明。主可执行文件、Info.plist、CodeResources 摘要也保存，便于实际运行后核对包未变。

两组 helper 的只读 `inspectRuntime` 均通过格式、arm64、依赖图与严格签名检查，四文件大小／SHA 与各自 manifest 完全相同：CLI `59de512a…`、WCDB `279ac685…`、新核心库 `f3828ded81a0f6b012ae3561109d28821863e1438ac06c883dc932c83d541b33`、probe `e10512d1…`。probe 的十一份构建输入逐项匹配上述提交，`buildSourceDigest=b27d9cdf0954f927f67fba6a984db08fde6795c5fb4981d6371d4262953f5e06` 也按实际清单重算一致；六份 ASAR dist 与读取时当前 dist 逐字节相同。源码／后续文档更新不改变这个包内快照。

九份许可材料完整集合为 `WCDB-LICENSE.txt`、`SQLCipher-LICENSE.txt`、`ZSTD-LICENSE.txt`、`ZSTD-COPYING.txt`、`OpenSSL-LICENSE.txt`、`wechat-cli-LICENSE.txt`、`wechat-cli-THIRD-PARTY-NOTICES.md`、`README.md`、`manifest.json`；逐文件字节数／SHA 和 manifest 原字节均与仓库原文一致。实际验收结束后须重核 ASAR、四 helper、主包 deep/strict、九材料完整集合与原 SHA；若生成交付 ZIP，再记录该归档的大小／SHA 和其对应包。本次 B 目录未找到 ZIP。WCDB 精确来源与二进制许可覆盖的两个 false 保持，许可文件完整不补齐上游缺项。

### 最终集成入口及启动预算

已读取[工程规则](../../docs/agents/engineering.md)、[桌面入口](../../desktop/README.md)、`test-app.mjs`、`app-test-lease.mjs`、Playwright 配置和 fixture。Root 可沿本轮连续授权预登记一次最长 60 分钟的最终集成，构建计入时段；仍用 `test:app --interactive --coordinator main-agent --suite`，禁止直接 Playwright／npm start 绕过租约。门禁固定 workers=1、retries=0、repeat-each=1、max-failures=1；到期停止新启动并收尾，不延长原场次或拿备用额度自动重跑。

静态 Babel AST 只解析测试文件、展开固定 for-of 并人工核对 fixture 依赖，未执行测试模块：49 个顶层 spec 共 162 个具名用例。最终签名包默认 149 个非文件级跳过用例；其中一个 setup-concurrency 用例只用两个隔离后端、不启动 App，bindingPage 的 13 例经依赖仍启动 App，desktop-controls 的冲突用例在 body 内跳过但其 App fixture 已启动。默认首次／重启／重复实例共需最多 152 次。显式开启 `NOTALONE_MAC_DELIVERY_ACCEPTANCE=1` 增加四个合成 CLI 场，开启 `NOTALONE_ASSISTANT_LIFECYCLE_ACCEPTANCE=1` 增加一场、含重开两次：预计执行 153 例、跳过 9 例、最多 158 次启动。Root 选择预登记硬上限 180，实际计数必须由活 broker／owned 收据记录；剩余额度不算运行证据。计算与首次 TypeScript 常规 AST 模块入口不可解析的静态失败保留于 `candidate-b-suite-static.json`，随后改用已安装 Babel parser 完成，没有运行 App。

执行时将 `NOTALONE_TEST_APP_EXECUTABLE` 指向 B 的绝对 `Contents/MacOS/NotAlone`，并在 Root 台账填写实际 from/until、180 上限和输出目录。`test:app` 的 build 只重建工作树 dist，不写 B 的 ASAR。全量及两组显式用例使用独立 userData／配置／握手、随机 `_test` 库和合成资料；导入／改写的模型边界受控替代，CLI 使用本轮 controlled-cli 或不存在路径、probe 使用不存在路径。普通导入替换必要 dialog I/O，不要求 Root 操作系统选择器；全量无需现场键盘、OCR 或微信操作。runner 环境应显式清空两种模型密钥变量、禁用 dotenv／外部 tracing，并清空下表现场 flags；不读取根 .env 来准备合成全量。

默认每例 30 秒，生命周期场 180 秒；全量最坏逐例等待总数可超过 60 分钟，静态范围不能保证本机在预约内跑完。Root 在约 15／30／45 分钟记录完成／失败／跳过和启动数，截止时未执行项保持未运行。首失败立即停，定位后只补必要最小场，不重新跑整套。finally 删除目录或兜底信号不能代签产品认证停读；结束仍核对本轮 App／后端／worker、随机库／目录、握手、两租约及包摘要。后台单联系人长同步与 App 合成全量分别记录，持有桌面焦点期间不并发操作微信；错过分时消息检查点须照实保留。

### 默认跳过及独立现场缺项

| 场景 | 显式入口或限制 | 最终 B 所需证据 |
| --- | --- | --- |
| 最小区域选择／采集／OCR | `NOTALONE_FOREGROUND_LAYOUT_ACCEPTANCE=1`，`native-foreground-layout.spec.ts`，一场最多一次、测试 420 秒 | 本包 Resources probe、真实前台与最小 sourceRect、原始帧内存政策、名称质量数字／profile、实际 helper／父进程／签名与系统权限归属；现场失败保留 |
| 旧单独几何选择 | `NOTALONE_FOREGROUND_CALIBRATION_ACCEPTANCE=1` 默认关闭；该旧场显式指仓库构建 probe | 只证明待校验选择，不能拿该外部 probe 代签 B；上行公开 layout 场已包含选择，不为凑次数重复 |
| 真实系统导入及实际快捷键／其他 App 焦点 | `NOTALONE_AGENT_NATIVE_DESKTOP_ACCEPTANCE=1`（与 human 模式互斥），`native-desktop-acceptance.spec.ts`／`native-focus-acceptance.spec.ts`，各一次 | Root CUA 选择本轮合成 JSONL、实际系统按键与独立 agent 收据、同一小窗显示／隐藏、正常菜单退出；程序观察不冒充真人反馈 |
| Finder | `NOTALONE_FINDER_PACKAGE_ACCEPTANCE=1`，`finder-package-acceptance.spec.ts`，一次、测试 8 分钟 | Root Finder 双击 B、隔离配置／随机库、默认目录身份暂存恢复、两窗与正常退出；不与另一个 App 场争焦点 |
| 真实 CLI 在失焦后继续及退出停读 | `NOTALONE_REAL_SYNC_QUIT_ACCEPTANCE=1`，`real-sync-quit-acceptance.spec.ts`，一次、测试 240 秒；须新鲜私有已确认 scope | 同包实际 CLI channel、明确单联系人边界、失焦仍读与公开菜单退出后 CLI／后端退场；不能代签双联系人、对方来信或 60 分钟同步 |
| 故意到期收尾 | `NOTALONE_APP_TEST_EXPIRY_ACCEPTANCE=1`，另一次最多 60 秒短预约、一次启动 | runner 预期 124／interrupted，窗口 ready、owned 清理与租约 absent；不能放进普通 PASS 全量或代签产品正常停读 |
| 破坏资源与同进程快捷键冲突 | 最终包 `errors.spec.ts` 文件级跳过、desktop-controls 冲突 body 跳过 | 只适用于隔离源码副本，不改 B 资源／签名救分；真实系统按键仍按独立现场验收 |

真实联系人映射、低置信／重名消歧、绑定失效和焦点保护不是这 153 个合成集成用例或单次 layout 验证就能完成；OCR 原票与公开合成页面证据分别报告。单联系人现场／当前长同步不能补出未授权的第二联系人和对方到达条件。上述静态通过也不证明权限已获准，不自动修改 TCC 或请求用户重新确认已授权范围。

## ECNU 旧体验守护收据的后续补核

Root 本轮取得原 `jsbsOZ` 的完整 ready／finish／supervisor-finish 三份 0600 收据后，本子任务仅独立读取其固定状态、时间及已拥有资源元数据，未读取日志、真实资料或密钥。startup ready／两窗可见、初始未选联系人、Agent 自动触发为 false、CLI／probe 不可用；2026-10-12 台北 22:07:35.630–22:27:17.395 实际就绪区间 **1181.765 秒**。finish 为 time_limit、App exit0／握手删除，supervisor 为 runner exit0／临时 spec 删除／租约 absent；已记录 App 和后端 PID、独立 userData 当前均不存在。与前述只看 mtime 的区间不同，这次使用明确字段，但不记成完整 1200 秒实开。

原规格验证决定 5 要求 20 分钟有限 test:app 内开放真实 App，由用户自主选择／触发，且明确排除模型质量评测。因此建议原 ECNU01 按原条件收尾，不新增真人语义质量门或重新迁移／开 App。旧真实 HTTP 尝试数与用户是否生成仍未知，限定逻辑台账为 0 不能代签 HTTP0；原首场失败保留，当前记忆目标计数独立。本次 Root 的[原票收尾证据](goal-ecnu-budget-closeout-20261013.md)与原票结果更新另经两轴，不将本静态 B 核查算该票新运行。

本次新增 B／守护核对文档增量经 memory 子 Agent 独立 Standards 与 OCR 子 Agent 独立 Spec 评审，硬违反／判断气味／missing／scope／error／证据越界均 0；两轴只读本文件差异与两个静态 JSON，没有运行 App／微信／模型或读取原守护日志、聊天及密钥。最小本地引用、空白及 `git diff --check` 核查通过；主题本地提交仍按 Root 的共享 index 调度，实际 App 场次结果由 Root 单列。
