# 私聊历史窄读取开发适配层

该层叠加在锁定的官方 CLI 源码和既有严格只读补丁上，仅提供选定联系人元数据、目标结构检查及受控快照原语；不开放 SQL、任意路径、发送或密钥扫描。`notalone-history` 使用有界 JSONL，未知操作及未确认范围在打开来源前拒绝。

构建入口为 `desktop/scripts/build-history-cli.mjs`。输入必须是锁定源码、经摘要核验的 Go 归档及既有 WCDB 字节，输出只能是 `.scratch/sqlite-history-cli/` 的一个新直接子目录；不会替换用户工具或配置。构建先核验剩余空间，复制自有源码、补丁与测试，离线构建后只对新 CLI 作开发签名，并写入不含私人路径的 manifest。

原生查询通过精确整数、有界行数和真实 sqlite3_interrupt 收敛；取消等待本次查询结束后才允许关闭连接。来源守卫核验直接子文件身份并监听目录及文件命名空间变化。结构检查只投影目标 schema、声明主键、索引与触发器指纹，实例身份包含 schema_version/rootpage/建表 SQL 摘要。守卫与这些元数据不能证明没有原位恢复。

快照原语在观察连接的共同 data_version 窗口内固定所有分片 reader，再通过声明的主键分页；持有期间的新提交不进入原快照。快照两分钟到期，关闭及取消先中断真实查询，再回收 reader。排序字段始终不冒充先后证据，server_id 非唯一时不签发别名。

状态原值捕获和真实消息资格分开。`snapshot-opaque-v1` 只用于明确的合成原语验证，不构成真实 status、恢复或跨启动连续性认证；正式支持档缺证时保持 unverified，不读取真实正文或启动正常历史。

定向原生测试需设置 `NOTALONE_TEST_WCDB` 指向被核验的现存 dylib，测试只创建合成临时数据库。验收证据见 `docs/verification/sqlite-private-history-support-03.md`；最终产品字节必须另行核对，开发构建 manifest 不宣称真实微信通过。
