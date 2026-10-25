# Ticket25：持久 broker 交接
状态：工程接缝完成；正式语义、五阶段／120人类时间资格与Ticket25签收均未确认。
独占目录：`.scratch/dsh-ts-migration/nonreply-persistent-broker/`，只在此目录写源码／公开证据。
最终pin：e60074b5946b8d1c990fcb75ba13bd58f789b2fb；旧臂3c168296e9e8edaa43b8b323ff693e790e709069。
9b20→e600仅reply-comparison显式费用豁免差异，diff SHA已绑定；发送链路无差异。
入口：`broker.mjs:30` createPersistentBroker，注入原预算/source/permission/assertCurrent/credential。
FormalExecutor：传broker.budget和broker.supplier，最终调用`broker.mjs:115` reconcileExecutorReport。
恢复：`attempt-journal.mjs:11` open，非终态→unknown；根核验旧进程停止才回收锁；禁止换ID盲重放。
ACK/发送：`broker.mjs:59`唯一reserve；`:73` ACK不reserve；`:87`原字节单次发送。
协议：Messages `/anthropic/v1/messages`；Beta strict `/beta/chat/completions`；根追加旧chat `/v1/chat/completions`。
官方目标固定在`transport.mjs:7`；无任意URL、重定向或自动重试。
四个runtime文件已冻结，SHA以`manifest.json`为准；两位driver已收到同一SHA。
输出393216或旧参数省略均仅记录；费用unknown保留，不作为门槛。
最终结果：13/13测试，11个broker用例原始journal/budget/wire留存在仓库外私有目录。
成功pair：HTTP=外层used=物理journal=4；双方PG ledger各2，新臂ModelHost实际装配。
503 pair：HTTP=used=failed journal=2；双方PG各1、余998；SDK/business重试0。
冻结problem-budget-port：reserve1、ACK2、used仍1、HTTP0，原账本未读取。
实际进程退出、丢ACK、缺终态、并发、取消、源码/权限/lease/raw变化均有验证。
旧提取脚本可能failed_batches=1却报succeeded，保留reported结果，由journal降级，不改冻结脚本。
最终执行：`$BROKER_NODE .scratch/dsh-ts-migration/nonreply-persistent-broker/verify.mjs --synthetic-only`。
全部八次profile历史保留：4失败、4工程通过，合成HTTP33/对应reserve33，不删失败。
最终证据：`verification-1792939380105.json`、`profile-probe-1792939380099.json`及各bindings。
清理：合成PG/profile/socket/archive均清理；最初缺USER留下的四个空合成库已精确复核清理。
未启动App/微信、不打包、不发外部消息、不读真实资料／项目.env／原累计账本、不真实供应商外呼。
没有再委派；无独立审查；主协调独占Git index/commit，本任务不提交、不push。
根下一步：核manifest/SHA后集成具名driver；真实凭据、授权、原问题账本及资格仍由根提供。
