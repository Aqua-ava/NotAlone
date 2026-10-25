# 冻结存储改动 Standards 静态审查

代码结论：`undetermined`。静态未发现可行动问题；输入包含 WIP，尚无最终提交和独立运行窗口，不能提前 `approve`。
总体运行门禁：不批准。25 维持 `claimed/not approved`，26 维持 `open`。

- 基线：`e5d8183bff811bc9bdd466a3035deb0b6abf10e3`。
- 捕获 HEAD：`3a550efb6f59342b487b212c65b5819fa7b1425c`。
- Manifest SHA-256：`3513144b9dd7e53825a52c262a3df7ce631616928e0d93ff8b267b81c5c86deb`。
- 六份文件及 patch 摘要均通过；在内存中把 patch 应用到基线，结果逐字节等于冻结 `source/`。完整绑定见 `inputs.json`，未将当前工作树当冻结输入。

## 审查结论

1. 小 ACK：`backend-ts/src/pure-ts-sync.ts:80–91` 保留无参数完整响应；`desktop/src/main/sync/priority.ts:61–70` 保留 16 KB、2 秒、代际复验与串行登记。`backend-ts/src/wechat-scope-api.ts:133–141` 的装饰只追加固定范围字段。没有从登记回执推定消息已读取。
2. 文件与结构：`backend-ts/src/host-storage.ts:400–487` 每次重验真实文件身份及账本，变更身份重算摘要，目录变化和链接失败关闭；catalog 继续实时读取并合并既有约束判定，没有缓存联系人资料或认证结构结果。对应 ADR-066:9–11、ADR-102:13。
3. 连接与租约：同文件 `86–120、303–394、510–514` 仅复用本机 socket；当前密码参与键，租约撤销后转入关闭客户端；异常、原生 Query/命名配置、监听器和显式客户端变更走关闭路径，关闭屏障等待归还和排空。静态未见扩大 owner/contact 范围、重放业务或删除后恢复正文。
4. 原生合同：锁定 `pg 8.16.3`、`pg-pool 3.14.0` 源码已绑定。Query/配置/回调/thenable/重入错误合同对照既有 `business-transaction-errors.test.mjs:64–289`；本轮没有执行这些用例。复用前会话重置的语义依据为 [PostgreSQL 16 DISCARD](https://www.postgresql.org/docs/16/sql-discard.html)。第三方调用形式对照 [pg Client](https://node-postgres.com/apis/client) 与 [Queries](https://node-postgres.com/features/queries)，具体实现以锁定源码为准。

仅检查必要未改路径；未读其他审查结论或作者聊天，未读取原资料、真实配置，未启动模型、App、微信、测试、数据库、benchmark、类型检查或宿主；未安装依赖，未改产品、测试、索引、用户三文件或 Git。无 DSH 直接接口变更；普通业务边界及退出装配保持原入口。

## 待 root 安排

性能测量窗口结束、最终源码冻结后，申请最多 180 秒合成独立窗口：先查一组原生 pg 重载/回调/thenable/重入错误单例，再查租约撤销、同连接隔离、passfile 改变和关闭排空。只使用当前冻结源码的独立副本、合成 `_test` 库，记录原始输出与资源清理；失败原样保留，不改门槛。此处未运行，也未占用窗口。

委派给定而非本轮重测的总体门禁：HTTP 性能仍 RED；正式 40 次启动/RSS、最终回复 96 和最终真实 App/微信未完成；记忆 1056/120 为 deferred 而非 passed。输出/费用豁免不放行功能、数据、权限、来源、删除、取消、持久化、回复与性能要求。最终批准须绑定最终 commit 和源码 SHA，作者测试不能替代独立复现。
