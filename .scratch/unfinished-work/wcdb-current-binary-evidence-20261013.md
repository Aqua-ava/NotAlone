# 当前 WCDB 二进制：精确材料与缺项

日期：2026-10-13。范围仅为当前固定 WCDB 的源码、补丁、构建输入、实际组件清单及许可证据，不扩大 Mac 交付验收。先读取[最新来源摘要](../wcdb-exact-provenance-parallel-20261013/evidence-summary.json)、[交接](../wcdb-exact-provenance-parallel-20261013/handoff.md)、[已有补核](wcdb-provenance-followup-20261012.md)及端侧提交回收收据，再复核固定文件。

## 结论与对象

本轮没有取得新的精确源码、补丁、构建日志或实际 BOM。以下清单记录现有材料能证明的范围和具体缺件，不将“整理完成”写成“来源验证完成”。生产材料中的 `exactBuildSourceVerified=false`、`binaryLicenseCoverageVerified=false` 保持；[Mac20](../mac-desktop-app/issues/20-mac-app-delivery.md)的状态、依赖和验收条件未改。

唯一对象为 `libWCDB.dylib`，**5,120,912 bytes**，SHA-256 **`279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3`**。本轮读取固定发行 runtime 中的文件，摘要与实际发行 manifest 的 `artifacts.libWCDB.dylib` 项一致；没有读取或修改 App。发行 manifest 为 2,076 bytes、SHA-256 `9e5f50b201e6d1cf83ab30dd1367f3102ff28498472b9fc64561d7a537abe89d`，声明 `wcdb_version=unknown`、`build_timestamp_utc=unknown`。[本轮静态收据](../../desktop/artifacts/wcdb-current-binary-audit-20261013/receipt.json)、[固定发行身份](../../desktop/third-party-notices/wcdb-v2.1.15/manifest.json)

精确源码 revision 仍为未知。CLI 内嵌的 `7b387ac76da6439c9ecb5f741a400d14ae9fa423` 只属于 CLI 声明，不能写成 WCDB revision。Mach-O install name 为 `@rpath/WCDB.framework/Versions/2.1.15/WCDB`，UUID 为 `5E040183-C782-3A87-A975-EB7B0F450844`；版本路径、UUID 和 `Custom build` 均不能证明 source tree 或是否修改。[此前证据边界](wcdb-provenance-followup-20261012.md)、[本轮静态收据](../../desktop/artifacts/wcdb-current-binary-audit-20261013/receipt.json)

## 五类材料逐项核验

下表每一项都须直接绑定上述完整库 digest，或通过可核查记录把同一构建的输入摘要关联到该输出。所列文件名为材料形式示例，不表示文件已取得。

| 材料 | 已有证据及限度 | 仍缺的精确材料 |
| --- | --- | --- |
| 实际源码 | 已保存 Tencent 候选源码的固定 commit／子模块及原文身份；未证明当前库采用它 | 实际仓库、完整 commit／tree、全部子模块 revision、完整源快照及摘要，以及与本库 digest 的关联记录 |
| 修改与补丁 | 没有当前 WCDB 的完整 diff；CLI 的 `vcs.modified=false` 不适用于库 | 基于实际源树的完整补丁及摘要，或明确涵盖库源码、子模块、生成文件和配置的可核查未修改声明 |
| 构建输入与输出绑定 | 本库 load commands 声明 arm64、minos 15.0、SDK 15.5、tool 3／1167.5、LC_SOURCE_VERSION 0；这些不是完整工具链或日志 | 实际编译器／Xcode／SDK身份，源码／补丁／生成文件／配置摘要，全编译与链接命令、宏、crypto选择、静态库／对象输入、install name／签名等后处理，以及同时引用输入和最终库 digest 的构建日志或可靠证明 |
| 实际组件清单 | 下节只有符号和动态依赖声明；候选 gitlinks 不认证实际编入范围 | 绑定本库 digest 的编译／链接 BOM，每个组件的精确源 revision／摘要、采用文件或对象／静态库、编译选项、静态或动态链接关系；说明是否裁剪及生成内容 |
| 许可覆盖 | 九份既有材料逐文件大小／SHA已重核；只证明这些文件完整保留 | 对实际 BOM 逐项提供精确 revision 的完整许可／notice原文及摘要、适用许可选择和对应分发位置；把每份原文映射到实际组件并说明覆盖范围 |

验收依据为[原规格的四项完整来源条件](../wcdb-exact-provenance-parallel-20261013/spec.md)。构建输入及输出绑定拆在同一行，许可与实际组件分行列出，不降低原条件。没有用相近版本、候选 tag、相同字符串或原文数量填补缺件。

## 当前二进制的组件证据

这是**静态观察清单，完整 BOM 未取得**。`nm -g` 只读取 Mach-O；未执行版本函数或装载库。`T` 为当前文件的代码符号，`U` 为未定义符号，不据此认证完整组件来源或精确版本。[本轮符号与 load commands 收据](../../desktop/artifacts/wcdb-current-binary-audit-20261013/receipt.json)

| 观察对象 | 当前库直接证据 | 来源／许可覆盖状态 |
| --- | --- | --- |
| WCDB | 2.1.15 install name，当前完整 digest／UUID | 实际源码、修改、构建与覆盖未知 |
| SQLite／SQLCipher 相关接口 | `T _sqlite3_libversion`、`T _sqlite3_key` | 接口存在；不认证采用文件、revision或补丁；不能把候选源码版本当实际 BOM |
| Zstandard 相关接口 | `T _ZSTD_versionNumber`、`T _ZSTD_versionString` | 接口存在；未执行函数确认版本，未确定实际 revision／修改／许可选择 |
| CommonCrypto 相关接口 | `U _CCCryptorCreate`、`U _CCCryptorUpdate`、`U _CCCryptorFinal`、`U _CCKeyDerivationPBKDF` | 仅记录导入需求，不能恢复 crypto 完整构建设置或全部来源 |
| OpenSSL | 六条动态依赖声明没有单独 OpenSSL dylib | 不能排除静态编入；保留既有候选许可原文，不认定已编入或未编入 |

本轮从固定字节重读的六条 `LC_LOAD_DYLIB` 为 Security、Foundation、CoreFoundation frameworks，以及 `/usr/lib/libz.1.dylib`、`/usr/lib/libc++.1.dylib`、`/usr/lib/libSystem.B.dylib`。完整 install path、current／compatibility version 已在收据逐项保存；这些字段是库的链接声明，不证明本机实际加载文件、系统组件源码版本或完整静态链接清单。未读取系统库文件或进行运行验证。

九份已保存材料为 `WCDB-LICENSE.txt`、`SQLCipher-LICENSE.txt`、`ZSTD-LICENSE.txt`、`ZSTD-COPYING.txt`、`OpenSSL-LICENSE.txt`、`wechat-cli-LICENSE.txt`、`wechat-cli-THIRD-PARTY-NOTICES.md`、`README.md`、`manifest.json`。外部原文的来源 URL／scope 见[既有材料 manifest](../../desktop/third-party-notices/wcdb-v2.1.15/manifest.json)；九份文件本轮的字节数／SHA 全部见收据，manifest 不列自身摘要，README也不具有独立外部来源URL。前五份仍属候选源码材料，CLI许可／说明属于发行材料，不能将它们合并声明为 WCDB 的逐组件覆盖。[材料范围说明](../../desktop/third-party-notices/wcdb-v2.1.15/README.md)

## 已查路径与最新提交结果

原限定公开核查已累计 **40 GET／12搜索**，本轮重新核对40个 URL 唯一、40份保留响应的字节数／SHA；**新增网络请求和搜索均为0**。本轮只证明既有响应未变，不重新确认远端状态，也不推断材料不存在。未发现具体未查且指向当前库精确来源的入口；不重置原预算。[原请求摘要](../wcdb-exact-provenance-parallel-20261013/evidence-summary.json)、[本轮核对收据](../../desktop/artifacts/wcdb-current-binary-audit-20261013/receipt.json)

已查类别包括精确旧仓 revision／raw／codeload／Actions、发行仓 tags／history／tree、Go proxy、Software Heritage、有限 GitHub commit／repository／issue及fork索引、Internet Archive availability、固定 digest 的 repo／User attestation、Tencent固定候选发行资产，以及 canonical初始／rc.5构建和发布材料。404／451／401／429、索引不完整和抽样边界沿原记录保留；既有失败路径不重试，新仓 WCDB 2.1.16／ZSTD OFF构建不替代本库。[此前限定补核](wcdb-provenance-followup-20261012.md)、[本日材料及查询](../wcdb-exact-provenance-parallel-20261013/evidence-summary.json)

最新端侧回收收据已记录最后五文件在 **`248ad5ca2f4e2bd9c826147eab3d9c2ebb85220a`** 提交（台北17:51:33），对应公开历史检查 exit0／issues0；35 GET片 `8c9ff9e6` 的检查亦已回收。本轮用 `git show` 将这五文件的实际 commit bytes 与当前文件、回收摘要逐项核同。因此旧交接中的“最后五文件待提交”只作为当时快照，不再次提交旧切片，也不把本地收口当成来源通过。[原回收收据](../../desktop/artifacts/wcdb-exact-provenance-parallel-20261013/recovered-commit-248ad5ca.json)、[本轮核对](../../desktop/artifacts/wcdb-current-binary-audit-20261013/receipt.json)

CLI purego声明依赖的源ZIP核验属于此前CLI材料，不纳入当前WCDB BOM。完整精确材料的解除条件仍为上表五类输入与固定输出的关联证据；需要具体新文件或可定位快照才能进一步核验。不联系上游，不再提出发送索取稿。

## 本轮验证与数据影响

端侧原始收据为 `desktop/artifacts/wcdb-current-binary-audit-20261013/receipt.json`，9,316 bytes，SHA-256 `fccc6f5b990c2d72fbf55ab7d26fbc01b03b8f95b509034828b6733ea4a05a67`；脚本和完整符号输出同目录忽略保存，不强行提交第三方源码或二进制。

实际命令为固定库的 `nm -g`、Node标准库静态脚本 `node desktop/artifacts/wcdb-current-binary-audit-20261013/audit.mjs`、只读 `git show`／状态及文档读取。首次脚本把保留正文的字段读为 `body`，实际字段是 `bodyPath`，exit1；修正后静态核验exit0，失败事实保留在收据，不充作产品测试。库前后digest一致；九材料、六动态依赖、八指定符号、40响应及五个已提交文件已核。

本轮App／CLI／helper执行、库装载、Computer Use、微信、模型、业务数据、凭据、依赖安装、上游消息及远端Git均0。只新增本地证据记录，未改产品、包、许可原文或证明字段；无需产品测试，也没有启动服务需要清理。18条本地链接、换行／空白及收据摘要验证通过；独立Spec问题0，Standards修正一处材料来源定位后问题0。唯一提交范围为本文件，不重复提交旧五文件或捎带其他工作区修改。

按工程规则执行本主题本地提交和提交后公开历史检查，实际收口收据保存于本轮忽略目录的 `completion.json`。检查通过 `NOTALONE_PUBLICATION_ENV_FILE` 指向本任务空文件，不读取根 `.env`，因此不做真实环境密钥值比对；其余格式及既有政策检查照常执行。来源与许可覆盖两个false不会因提交或历史检查通过而改变。
