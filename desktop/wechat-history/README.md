# 私聊历史窄读取开发适配层

该层叠加在锁定的官方 CLI 源码和既有严格只读补丁上，仅提供选定联系人元数据、目标结构检查及受控快照原语；不开放 SQL、任意路径、发送或密钥扫描。`notalone-history` 使用有界 JSONL，未知操作及未确认范围在打开来源前拒绝。

构建入口为 `desktop/scripts/build-history-cli.mjs`。输入必须是锁定源码、经摘要核验的 Go 归档及既有 WCDB 字节，输出只能是 `.scratch/sqlite-history-cli/` 的一个新直接子目录；不会替换用户工具或配置。构建先核验剩余空间，复制自有源码、补丁与测试，离线构建后只对新 CLI 作开发签名，并写入不含私人路径的 manifest。

原生查询通过精确整数、有界行数和真实 sqlite3_interrupt 收敛；取消等待本次查询结束后才允许关闭连接。来源守卫核验直接子文件身份并监听目录及文件命名空间变化。结构检查只投影目标 schema、声明主键、索引与触发器指纹，实例身份包含 schema_version/rootpage/建表 SQL 摘要。守卫与这些元数据不能证明没有原位恢复。

快照原语在观察连接的共同 data_version 窗口内固定所有分片 reader，再通过声明的主键分页；持有期间的新提交不进入原快照。快照两分钟到期，关闭及取消先中断真实查询，再回收 reader。排序字段始终不冒充先后证据，server_id 非唯一时不签发别名。

状态原值捕获和真实消息资格分开。`snapshot-opaque-v1` 只用于明确的合成原语验证或无正文的单条元数据诊断，不构成真实 status、恢复或跨启动连续性认证；正式支持档缺证时保持 unverified，不读取真实正文或启动正常历史。

普通读取的状态规则由本机受版本管理的 profile 提供，同时精确匹配完整 `local_type`、发送方向和原始状态；高位类型不会自动继承低32位类型的资格。规则值与 `StatusSemanticsVerified` 认证分开，只有已认证的 sent/received 规则和必要的服务端身份条件全部满足时才取文字正文。pending、failed、recalled、deleted、unknown 均不取普通正文。当前真实 profile 未启用这些认证规则，合成测试的状态数字不代表微信状态码约定。

定向原生测试需设置 `NOTALONE_TEST_WCDB` 指向被核验的现存 dylib，测试只创建合成临时数据库。验收证据见 `docs/verification/sqlite-private-history-support-03.md`；最终产品字节必须另行核对，开发构建 manifest 不宣称真实微信通过。


`observe-metadata` 只在同一已解析目标及显式 `selected-message-metadata-v1` 下执行。每次固定全分片reader，仅按指定类型选择一条元数据；固定切面探针只投影常量，不额外取任意消息ID。输出不含正文、source/XML或媒体，字段、类型低32位与全部作用域均严格核验。无匹配返回NULL，未知状态始终unverified；观察不写正常捕获、不授予target/page或完整覆盖资格。取消、超时和Close仍等待真实读者释放。

受控阶段观察按方向隔离：`observe-test-metadata` 使用 `selected-test-lifecycle-metadata-v1` 观察本人新增文字；`observe-received-test-metadata` 使用 `selected-received-test-lifecycle-metadata-v1` 观察已选联系人的新增文字。两者分别维护 arm/next/current 基线和锁定身份，响应 format 不同，不能互用许可或借用另一方向的基线。只在唯一新增文字及发送者映射可证时锁定，出现多条、错误方向或身份歧义即拒绝；已锁定行之后允许报告类型变化或缺失。每方向最多两条、二十次调用、十分钟，均复验同一微信进程与来源守卫，仍只返回未核验元数据，不发送外部消息或授予正常历史资格。


`quarantine-target` / `quarantine-page` 是另行明确授权的一次性隔离快照，consent 固定为 `selected-quarantine-history-v1`。它要求所选私聊、固定版本结构、声明主键、来源文件及微信进程守卫均可核验，允许将未知文字交给独立本机隔离仓；状态始终 unverified，非文字载荷不读取，不能供普通聊天、检索、记忆或生成使用。普通 target/page 的认证门禁保持独立。来源守卫使用固定微信路径、启动时刻和内核退出/exec事件；这只检测本次持有期间的相应变化，不承诺跨重启连续性或恢复映射。
