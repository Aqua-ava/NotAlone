# 03 私聊历史支持档核验

日期：2026-10-29。范围为现存只读制品的静态核对、一次既有账号只读status与最终配套库的隔离合成原生探针。未安装、初始化或重建组件；未执行sessions/tail/watch、真实消息schema查询、迁移／恢复实验、模型或消息发送／撤回。版本化三值结果见[支持档](../../backend-ts/src/history/sqlite/support-profiles/wechat-4.0.6-29387.json)。支持档是本次证据，不能未经运行时匹配自动放行其他字节或机器。

## 制品与运行证据

| 制品 | 大小 | SHA-256 |
| --- | ---: | --- |
| bin/wechat-cli | 8495824 | d566d4842b656ca5b07a8af0c1fdada5c225724e9e7fda28e409b06f117d0655 |
| lib/libWCDB.dylib | 4490832 | 4f05cafc4626a142afca1818f0a88c4092a13d5f4c83e30cd5125b558ba0417d |

文件为普通非符号链接arm64，codesign --verify --strict均为0，与既有静态构建审计的字节一致。工具根缺组件manifest和旁侧公开源码，未宣称完整发行、可重现构建、公证或干净机器通过。固定补丁命令白名单仅status/sessions/resolve-chat/tail/watch/help/version，强制只读且禁止自动刷新。静态核对没有发现inspect_message_schema、message_metadata_barrier、table_xinfo、index_xinfo、source_generation或sqlite_schema入口；不以普通消息查询后删输出充当无正文结构检查。

在既有配置所指的同一CLI上执行有界status --include-debug --strict-read-only，退出0、strict_read_only=true、live_read_ok=true、readiness=degraded；既有parseConfiguredWechatAccount接受候选，但不授予来源连续性或正文资格。stdout/stderr仅在端侧进程内存解析，不保存账号标识、配置或路径。DYLD_PRINT_LIBRARIES观测到一条预期配套WCDB加载，未见其他WCDB；该结论只覆盖此次status进程。

## 最终配套WCDB字节的原生合成检查

复用既有wechat-wcdb-native-probe-v3.py，以本次配套dylib为唯一显式参数。脚本通过ctypes调用该库导出的sqlite3函数，仅新建并清理自有临时合成数据库；没有以Python内置SQLite代替。库内sqliteVersion=3.27.2，12/12断言组通过：加密错误密钥拒绝、只读禁写、两分片完整身份与精确大整数/正文列authorizer、WAL固定快照、持续变动拒绝、静止后重试、observer/reader短获取窗口及扫描期间正常提交、窗口内提交拒绝、新分片失效、短暂命名空间变化正向观测、文件替换失效、interrupt后语句/连接释放。

这些结果将既有12项机制证据绑定到本次实际配套库字节，不认证当前微信schema、消息状态、迁移映射或来源命名空间连续性。kqueue正向观测不证明事件永不丢失，持续提交时仍只承诺有界拒绝，不承诺必定取得共同切面。既有14项生命周期仍是合成状态规则，本轮未冒称重跑真实状态转移。

## 桌面与仍缺证据

dev:status为stopped，无本工作树dev进程；未启动、重启或关闭开发实例。Computer Use核对实际微信窗口已在用户指定目标，未切换到他人、滚动、输入或发送。没有将窗口名作为稳定会话身份，没有持久化截图。

当前CLI没有受控消息schema窄操作。仍缺实际目标的schema、声明主键、完整分片/表实例、消息状态语义、来源连续性及可靠历史目标/游标证明。因此真实身份适配器继续unverified，未经02正常逐人确认创建真实读取许可，也未读取真实正文或媒体。组件准备与安装仍搁置；不能绕过白名单、扫描密钥或用tail补证。03的正常合成服务、来源删除和界面检查与该真实门槛分别报告，票保持claimed。
