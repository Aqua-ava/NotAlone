# 冻结输入 v1：独立 Spec 静态审查

代码结论：`undetermined`。本轮未发现可登记的规格偏离（0项），但输入包含 WIP，未绑定最终提交，且独立运行尚未安排；不作最终 approve。总体运行门禁：`not approved`，25保持 claimed／not approved，26保持 open。

## 输入与方法

- 基线 `e5d8183bff811bc9bdd466a3035deb0b6abf10e3`；捕获提交 `3a550efb6f59342b487b212c65b5819fa7b1425c`。
- 输入清单 SHA256：`3513144b9dd7e53825a52c262a3df7ce631616928e0d93ff8b267b81c5c86deb`；补丁：`d687ba0ab1ffe9f392f5829bdcb5a2420a664b23249fee7bf8c84c03bb7f185c`。
- 六份冻结 source 的 SHA256／长度全部吻合，独立从基线重建各补丁结果也全部匹配。只审查冻结源码，未把当前工作树同名文件当冻结输入。
- 11份相关依赖从捕获提交读取；pg 8.16.3实际安装源码另作只读绑定。规范与依赖副本及摘要见 `binding.json`。未读取另一 Standards 报告或作者聊天。
- 应用 code-review 的 Spec 轴；按任务禁止委派，不另开 Agent／chat。实现文档／作者测试只作线索，未当独立复现。

## 规格核对

下表行号指输入清单内 source；补充依赖行号指捕获提交。均为静态判断，不等于端到端通过。

| 合同及原条款 | 代码依据与结论 |
| --- | --- |
| 原库、账本、未知结构停写：ADR-066:9；spec.md:62–63 | `backend-ts/src/host-storage.ts:400–487`：逐次核对目录／文件身份，身份相同才复用摘要；变更后重读摘要；账本、035基线、必需列与结构错误仍参与本事务判定。未见成功就绪缓存。 |
| 实时结构与约束：ADR-066:9；spec.md:63 | `host-storage.ts:429–487,703–708,841–857`：catalog投影与约束合并保留原必需表非零可见列、未知对象处理、账本／基线、NULL约束、有效性／延期性和后台唯一约束的原判定。 |
| 有界本机复用、受控配置：spec.md:54,63；ADR-102:12 | `host-storage.ts:303–344,358–364,775–827`：只复用非TLS Unix socket；空闲槽1个、空闲最多1秒、仅复用年龄小于5秒的连接；每次求值密码provider并纳入键；TCP、TLS、hostaddr、升级／降级继续走原流程。没有新连接回放业务回调。 |
| 租约、原生pg Query／config／callback／thenable／重入及错误归属：spec.md:54；issues/24-cutover-rollback.md:21 | `host-storage.ts:18–120,346–394`：保留原Query分发与错误观察；查询重载原参数委托；非普通查询、监听／对象状态访问淘汰连接；回调结束撤销租约；成功归还前DISCARD；观察器与监听器收尾。未见可确认的行为偏离。 |
| 退出排空、删除取消与隔离：spec.md:28,41,53,62–65；privacy-deletion.md:71–75 | `host-storage.ts:346–394,510–514`：关闭后拒绝新事务、提交前复验并等待在途／关闭屏障。改动不替换owner／contact过滤或删除服务，也不提供旧租约到复用连接的正常查询路径。未运行删除／取消集成，保留运行门禁。 |
| 优先登记只调整已确认范围顺序：core-flows.md:98；issues/21-foreground-contact-location.md:21 | `pure-ts-sync.ts:75–91`与依赖`sync-incremental-api.ts:41–70`：ACK仍经过既有账号／owner和命令校验；只登记priority，不直接启动CLI、历史或模型。实际读取仍按原授权引擎。 |
| 可选小ACK、旧POST／GET兼容：spec.md:54；core-flows.md:98 | `pure-ts-sync.ts:77–91`：精确`?response=ack`仅适用于priority；其他非空查询仍拒绝；无参POST保留原状态分支，GET status保留。回执`accepted/contact_id`不写历史完整或读取成功。 |
| 16KB／2秒、代际、串行与最新选择：spec.md:26,51；core-flows.md:98 | `desktop/src/main/sync/priority.ts:24–70`：只改请求路径；2000ms、16384字节、代际校验、初始清除、串行及切换合并均保留。客户端没有从ACK推算读取或历史成功。 |

## 验证与保留门禁

实际仅执行只读 Git／文件定位、SHA256和补丁重建；未运行本地测试、数据库、benchmark、类型检查或宿主。未启动App／微信、访问原资料／真实配置／模型／预算，未装依赖，未改产品、测试、任务状态、index或Git；只新建本审查目录。

后续独立运行如获根安排，可从冻结候选的HostStorage／业务查询错误／两张模型回执迁移合同模块及priority定点／桌面相关模块开始，串行合成预计30–60秒；本轮未执行。作者报告的通过不算本审查独立通过。

HTTP性能仍RED；正式40次启动／RSS、最终96次回复及最终实际App／微信未完成。输出／费用按用户决定豁免，1056／120记忆语义为`deferred_by_user`，不能改成passed；其他功能、来源、隔离、权限、删除、取消和持久化等原门禁不变。后续只接受新冻结manifest与最终提交的delta复核，不沿用本轮WIP为最终批准。
