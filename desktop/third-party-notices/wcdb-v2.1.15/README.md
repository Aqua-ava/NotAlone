# WCDB 及关联组件的来源、许可材料

本目录为当前 `wechat-cli v1.6.25` 配套 `libWCDB.dylib` 保存可公开取得的许可原文；当前库 SHA-256 为 `279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3`。仅库和CLI均与该发行包同字节时随包携入这组材料，文件来源、字节数及哈希见 `manifest.json`。

发行来源已固定到 R266 官方 v1.6.25 归档及组件 manifest。候选源码材料固定到 Tencent/wcdb v2.1.15、提交 `a62d7f12191843e1f095e3c37f46785ed04ebde8`；这不证明该自定义构建采用了此提交、没有补丁，或使用同一编译配置。精确构建来源和二进制全部许可覆盖仍未确认。

保存的原文包括 Tencent 完整 LICENSE（含其第三方说明）、候选 SQLCipher、Zstandard 的 BSD／GPL 两份原文、OpenSSL 原文，以及发行包所附 CLI MIT 许可和第三方说明。候选gitlinks对应SQLCipher 4.1.0／SQLite 3.27.2、Zstandard 1.5.5与OpenSSL 1.0.2k；这些版本不冒充当前库的完整BOM。Zstandard原文允许BSD或GPLv2选一种，保存两份原文不意味着库必须采用GPL。原文不翻译、不删改；列入 OpenSSL 或其他候选依赖，不表示已经确认它被编译到当前 macOS 库。

Tencent 根 LICENSE 的旧组件版本标注，与候选目录和当前库中的版本线索不完全一致，因此同时保留组件目录原文。`Custom build` 是未定义 `WCDB_VERSION` 时的默认字符串，不能据此认定私有修改或微信提取。当前库可静态看到 CommonCrypto 导入、SQLite 与 Zstandard 导出；这些线索不能替代编译清单。

尚缺发行者将此库 SHA-256 绑定到源码 revision、补丁、构建命令／选项、依赖清单及对应许可的公开记录；收集和随包保留原文不自动将 `exactBuildSourceVerified` 或 `binaryLicenseCoverageVerified` 改为 true。本目录不宣称完成可重新分发的许可审查，也不替代运行或渠道验收。

来源：[R266 v1.6.25](https://github.com/r266-tech/wechat-cli-releases/releases/tag/v1.6.25)、[Tencent 固定 LICENSE](https://github.com/Tencent/wcdb/blob/a62d7f12191843e1f095e3c37f46785ed04ebde8/LICENSE)、[WCDB 版本宏](https://github.com/Tencent/wcdb/blob/a62d7f12191843e1f095e3c37f46785ed04ebde8/src/common/utility/WCDBVersion.h)。核查日期：2026-10-12。
