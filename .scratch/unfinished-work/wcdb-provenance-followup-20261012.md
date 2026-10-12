# WCDB 精确来源与许可材料补核（2026-10-12）

本轮仍不能将当前包中的 `libWCDB.dylib` 绑定到精确源码、补丁、构建输入、构建记录及实际组件许可清单。已完成限定公开路径与现有自有产物的自主核查；继续猜测相近 WCDB 版本或重复下载候选归档，不能补足这些证据。原[来源摘要](wcdb-source-license-20261012.json)保留，`exactBuildSourceVerified`、`binaryLicenseCoverageVerified` 继续为 `false`；[Mac20 原票](../mac-desktop-app/issues/20-mac-app-delivery.md)的状态、依赖与验收条件不变。

## 本轮范围与时间

- 主 Agent 委托并行只读补核；只新增本文件，不修改产品、候选包、原票或过去记录。
- 2026-10-12 17:17:02（Asia/Taipei）开始一次限定查询：4 个 GitHub 官方 API 端点，未使用帐号、凭据或认证头。每个响应限制 1 MiB、单请求超时 25 秒；错误正文另限 8 KiB。
- Web 工具先尝试 3 个 API URL，返回工具不可访问；该错误不当作 HTTP 状态或来源不存在。随后经 Python 标准库读取同一官方端点，并补 1 个精确 `head_sha` Actions 查询；未下载发行归档或构建产物。
- 本地只读已明确归属本任务的候选包资源、材料 manifest 和过去公开核查摘要。没有扫描用户其他目录；没有执行 CLI、动态库、App、探针、OCR、微信、业务数据库、外部模型或聊天发送。

## 本轮新增的公开状态

| 官方读取路径 | 当前结果 | 可支持的结论与限制 |
| --- | --- | --- |
| [稳定发行 v1.6.25 API](https://api.github.com/repos/r266-tech/wechat-cli-releases/releases/tags/v1.6.25) | HTTP 200，9 个资产；发布与更新均为 `2026-09-11T07:38:16Z` | 发行元数据仍可取得；资产清单未新增源码、构建日志、BOM 或证明文件。归档与 manifest 的 API digest 和已固定记录相同，未重新下载归档。 |
| [稳定源码精确 commit](https://api.github.com/repos/r266-tech/wechat-cli/commits/7b387ac76da6439c9ecb5f741a400d14ae9fa423) | HTTP 451，`Repository access blocked` | 当前公开端点无法提供该源码。没有取得源树；不推断该 commit 不存在，也不推断阻断原因。 |
| [稳定 commit 对应 Actions](https://api.github.com/repos/r266-tech/wechat-cli/actions/runs?head_sha=7b387ac76da6439c9ecb5f741a400d14ae9fa423&per_page=1) | HTTP 451，`Repository access blocked` | 当前无法核查该 commit 的公开构建记录。过去摘要中曾取得的 48 个新源码仓 runs／4 个 artifacts 仍只是历史查询，不改写，也不当作本轮可取得的稳定版记录。 |
| [当前库 digest 的发行仓 attestation](https://api.github.com/repos/r266-tech/wechat-cli-releases/attestations/sha256:279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3) | HTTP 404，`Not Found` | 该端点在本次匿名读取下未返回证明；不能扩大为所有仓库、权限或历史证明均不存在。 |

发行的 9 个资产为安装脚本及其校验文件、`release-manifest.json`、两种名称的同字节 macOS arm64 ZIP 及各自校验文件。当前 API 中稳定归档 digest 为 `0d54554c3ae0a8d55fc72e1b943b09f55a5010cf0f91c0bbc7094d777a180908`，manifest digest 为 `9e5f50b201e6d1cf83ab30dd1367f3102ff28498472b9fc64561d7a537abe89d`。这些值证明本轮元数据仍指向先前固定的发行字节，不能代替 WCDB 构建来源。[发行 API](https://api.github.com/repos/r266-tech/wechat-cli-releases/releases/tags/v1.6.25)

## 本地独立字节复核

本轮以 Conda `NotAlone` 中的 Python 标准库读取文件、计算 SHA-256；没有装载或执行库。候选包路径来自原来源摘要，未查找其他包。当前资源与[材料 manifest](../../desktop/third-party-notices/wcdb-v2.1.15/manifest.json)匹配：

| 资源 | 当前 SHA-256 | 结果 |
| --- | --- | --- |
| `notalone-helpers/libWCDB.dylib` | `279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3` | 与固定发行库一致 |
| `notalone-helpers/wechat-cli` | `59de512a52d7960aef70da6b42d199358429662919f5b4baababc5132a660355` | 与固定发行 CLI 一致 |
| 材料 manifest 内的 8 个文件 | 逐文件大小、SHA-256 和包内字节一致 | 加上 manifest，共 9 份材料；包内 manifest 与仓库原字节一致 |

此复核证明正在讨论同一库、CLI 和材料，没有发现本轮内容漂移。它没有重新验收主包签名、Finder、快捷键或渠道；这些独立运行证据保留在[焦点最终摘要](mac-focus-final-20261012.json)与此前记录。

## 为什么现有线索仍不够

1. 发行 manifest 的 CLI commit 为 `7b387ac76da6439c9ecb5f741a400d14ae9fa423`，但 `wcdb_version` 声明为 `unknown`。CLI 的嵌入 Go revision 和 manifest 相同，是 CLI 发行身份线索，不能据此推出配套库的源树。过去静态结果及原发行 manifest 见[来源摘要](wcdb-source-license-20261012.json)及自有 `desktop/artifacts/helper-upstream-20261010.onrvwc/release-manifest.json`。
2. Tencent 候选源码固定在 `v2.1.15`／`a62d7f12191843e1f095e3c37f46785ed04ebde8`。候选的版本宏在未定义 `WCDB_VERSION` 时返回 `Custom build`；本轮重新读取该固定官方文件确认了这一默认行为。此字符串不能证明当前库有私有补丁或来自微信提取，也不能证明采用候选 commit。[固定版本宏](https://github.com/Tencent/wcdb/blob/a62d7f12191843e1f095e3c37f46785ed04ebde8/src/common/utility/WCDBVersion.h)
3. 过去静态记录中的 install name、SQLite／SQLCipher 版本字符串、Zstandard 导出和 CommonCrypto 导入，是组件与版本线索；不能识别全部编译输入、静态链接对象、裁剪范围或补丁。该边界已写在[材料说明](../../desktop/third-party-notices/wcdb-v2.1.15/README.md)，本轮未执行这些函数来推定版本。
4. 现有许可原文和候选 gitlinks 已固定、随包保存，但候选依赖集合不是当前库实际 BOM。保留原文不自动确认当前二进制的全部许可覆盖；不因 Zstandard 保存了两份原文，就把许可选择推定为必须采用 GPL。来源与明确边界见[材料 manifest](../../desktop/third-party-notices/wcdb-v2.1.15/manifest.json)和[原来源摘要](wcdb-source-license-20261012.json)。

## 最小所需上游材料

无需先规定新的工具或证明格式，但材料必须能核对当前库 SHA-256，并明确它与稳定 CLI revision 的配套关系：

| 缺项 | 最小可核查材料 | 不能作为替代的现有材料 |
| --- | --- | --- |
| 精确稳定 CLI 来源 | 对应上述稳定 revision 的源树或公开可取得源码快照，包含固定依赖及发布脚本 | 现行 v2／RC 源码、release tag 名、Go 版本字符串 |
| 当前库源码与补丁 | 实际 source tree revision／归档摘要、子模块精确 revision；完整补丁或可核查的未修改声明 | Tencent 候选 tag、install name、`Custom build` |
| 构建输入和过程 | 编译器、Xcode／SDK、目标架构、命令和选项、crypto provider／链接配置、输入依赖摘要；对应构建日志或可靠发布证明 | 通用构建说明、其他版本 CI 运行、候选 Package.swift |
| 当前二进制 BOM 和许可材料 | 实际编译／链接组件、精确来源与版本、适用许可及原文；绑定输出库 digest 的组件清单和发行声明 | 候选 gitlinks、9 份已收集原文、字符串／符号导出扫描 |

上表是恢复本项核查需要的证据清单，不表示主 Agent 已联系发行者或取得材料。现有持续授权不包含向上游发送消息；本轮没有帐号操作、提交 issue 或其他外部联系。取得这些材料后，再在原票内核验身份、完整性与对应关系；不以新猜测将两项 `false` 提前改为 `true`。

## 收尾与验证

- 限定公开查询完成，精确源码及构建路径仍缺必要材料；在当前已核查范围内，自主读取已完成。此结论不宣称已穷尽整个互联网或任何私有记录。
- 无产品功能、权限、读取范围、默认数据、候选包或原票变更。新增功能继续冻结，OCR 继续暂停。
- 文档最小验证：Python 检查 8 条本地链接均存在、无尾随空白且文件有结束换行。`git diff --no-index --check /dev/null <本文件>` 无空白错误输出，exit1 表示新文件与空文件有差异；主 Agent 暂存后再做正常 staged diff 检查。不为纯调研文档重跑 App、模型或业务测试。
- 本文件未单独提交，由主 Agent 与本轮相关收尾记录一起执行独立 Standards／Spec 审查及任务内本地提交。
