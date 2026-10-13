# 固定稳定发行来源材料索取稿

状态：`publication_declined_not_sent`。原拟发布位置：[r266-tech/wx-cli Issues](https://github.com/r266-tech/wx-cli/issues)。本稿尚未发布；用户已明确拒绝本次发布，取消待确认状态，仅端侧保留，不主动再次提议或请求发布。只有用户日后主动明确要求时才重新核对范围。正文仅含公开发行身份、摘要和材料问题，不含本机身份、私人项目资料、聊天、凭据或验收数据。

## 拟发布标题

请补充 v1.6.25 固定 WCDB 二进制的精确构建来源与 BOM 材料

## 拟发布正文

希望核对稳定 `wechat-cli v1.6.25` 的精确来源和随包第三方材料。研究对象固定为原发行字节：

- CLI revision：`7b387ac76da6439c9ecb5f741a400d14ae9fa423`
- CLI SHA-256：`59de512a52d7960aef70da6b42d199358429662919f5b4baababc5132a660355`
- `libWCDB.dylib` SHA-256：`279ac6855ff2865caafa9718ae660e6e30a9667e4748ab064189ae633fd35fc3`
- 稳定 ZIP SHA-256：`0d54554c3ae0a8d55fc72e1b943b09f55a5010cf0f91c0bbc7094d777a180908`
- `release-manifest.json` SHA-256：`9e5f50b201e6d1cf83ab30dd1367f3102ff28498472b9fc64561d7a537abe89d`

已核对原ZIP与manifest，组件文件摘要相符；manifest 的 `wcdb_version` 和 `build_timestamp_utc` 为 `unknown`。当前canonical v2的WCDB 2.1.16／ZSTD关闭构建材料不对应这份旧库，不能据此确认旧发行来源。

请提供允许公开核查、能够绑定上述固定输出摘要的材料：

1. 稳定CLI精确revision的完整源树或历史源码快照、固定 `go.mod`／`go.sum` 与实际发布编译脚本。
2. 该WCDB库实际采用的source tree、子模块精确revision、完整补丁；若无修改，请提供可核查的未修改声明和源归档摘要。
3. 编译器、Xcode／SDK身份、arm64完整命令与选项、crypto provider与链接配置、输入摘要，以及对应构建日志或可靠发布证明。
4. 绑定库摘要的实际编译／链接BOM：逐组件精确来源、版本、适用许可选择及完整许可原文。

已有候选tag、版本字符串和第三方许可原文尚不能建立上述对应关系。若旧构建的某些材料已无法恢复，请明确哪些材料仍保有、哪些缺失；不必提供任何私人微信数据、密钥或本机用户资料。谢谢。
