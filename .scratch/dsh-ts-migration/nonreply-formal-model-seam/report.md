# 非回复正式模型执行接缝

2026-10-25。交付最小可执行 `FormalExecutor`、根注入合同、既有问题总账桥、完整冻结计划、非空提取与故障证据。**真实模型调用0，App/微信操作0，正式质量0，25/26不批准。**

起始已紧凑读取前准备聊天，逐SHA核验初始 `a36012aabd276c6af8fa32c1eb17123ad06ea9c9b1cff3f93ed83d4093be321a` 清单101项全部一致。原10/10、完整取消/角色/Skill v1/修正及E/V证据复用，不重做；后续根授权该作者更新输出/费用说明，最新清单观察值另见 [继承回执](inherited-frozen-receipt.json)。原材料、oracle、门槛与历史报告未改；109/140数值推理未重跑。

## 实际完成

| 项目 | 结果与证据 | 限制 |
| --- | --- | --- |
| 完整计划 | 140提取、L2/L3/Skill各12 ×3 ×双臂，1056非回复、1152统一分母；[计划CLI日志](plan-cli.log) | 原24/51与1128未执行保持原历史，不合并成本轮质量 |
| 根端口 | [FormalExecutor](formal-executor.mjs) 默认无供应商、许可或预算；[合同](execution-contract.md) / CLI只读plan、preflight | 真实发送只能由根API明确注入；缺端口preflight退出2 |
| 持久原子预算 | [ProblemBudget端口](problem-budget-port.mjs) 只绑定既有账本，复用旧reply bridge与configuration freeze；全问题/双臂/所有尝试共用deadline；竞争末笔额度只成功一次 | 本轮仅合成SQLite；未读真实问题账本、不创建真实额度；旧bridge不接受continuations，根续期接口另注入 |
| 发送重核 | 服务端owner/contact、来源/消息摘要、任务/worker/租约、源码快照、实际prompt/schema/requestSHA、许可和取消在预留前/实际写出前重核；header先validate，ACK不再reserve | 根supplier端口属可信边界，必须核actualRaw并保留发送回执；授权后异常的实际发送状态为unknown，不退款 |
| 固定4f89非空E/V | [integration-03](integration-03.log) 双臂各2次loopback HTTP、各2笔业务持久台账、各1事实；合成总账used4/4；原始trace旧48事件/新16事件；中性盲包2条、完整E/V为2 | 只一对工程探针；独立审阅0；不把fake逐字回显判为语义正确 |
| 新臂职责 | 官方profile→实际`startModelHost`→`createHostReplyRuntime`→公开`/internal/extraction/run-b`→PG；全部TS职责flags，保留ordinary/strict两条产品来源/许可守卫 | 薄评测装配，不认证完整App主宿主；Python只作固定旧臂评测及合成夹具准备 |
| 故障无重试接缝 | 根授权后只改两个生产构造器；显式`extractionRetryPolicy:{maxRetries:0,retryDelayMs:0}`，产品省略保留Flow既有默认5/30000；实际profile/PG/ModelHost故障新E1/V0、will_retry=false、PG失败台账1，双臂合成used2 | 工作树受控源码验证；必须由根提交并在最终完整pin复验，不自动认证4f89或后续HEAD |
| 最小验证 | [接缝合同21/21](contracts-final-v2.log)、[相关模块8/8](related-final.log)、[类型检查](typecheck-final.log)；自包含公开Batch+PG新测试2/2 | 官方profile故障原始红/绿另见retry-prod-red-03与retry-prod-green-01，前两次夹具接线失败保留 |

## 重试发现与最小生产增量

原4f89故障轮的旧臂到达1次，新臂在0、30.448、60.949、91.578秒到达4次；后三次请求SHA相同，前三新臂预留ordinal2/3/4，第四被预算拒绝。下游fake HTTP为0，**used4保留不退款**。原因是业务`extraction-flow`默认5次恢复/30000ms，502满足可重试；SDK自身maxRetries为0，Batch/Host当时没有透传接口。详见 [retry-gap](retry-gap.json)。

根随后明确授权最小生产接缝：仅 `backend-ts/src/extraction-batch-service.ts`、`backend-ts/src/host-reply.ts`，以及新 `backend-ts/test/nonreply-formal-model-seam-retry.test.mjs`。新增内部策略复制/冻结及既有范围校验，再透传原Flow参数；无新HTTP/用户env开关，不改provider/Flow/TaskStore/claim/权限/预算。三文件精确SHA见 [生产清单](production-patch-manifest.json)，两文件补丁见 [production.patch](production.patch)。根独占index/提交，本聊天未提交。

旧固定臂 `DirectExtractionRuntime(max_retries=0)` 是3c168296已有公开构造器，SDK也为0；V使用同SDK且没有独立恢复配置。故障只实际检验E失败，不把它扩称为V故障资格。外层另外保留首次失败锁定，后续内部到达不再reserve/send，不能拿该锁定冒充内部恢复策略已关闭。

## 时间与正式资格

[时间资格](time-qualification.json)：旧3c168296 `evaluation.py:82–101` 明确以`2026-09-15 UTC + index分钟`构造消息发生时间，双方适配与该原始builder一致；它不是评测时点，也不把来源消息时刻升级为事件发生时间。原140材料没有as_of。Skill没有独立公共clock参数，冻结observed_at不能冒充统一学习时钟。L2/L3已有公共now/旧Store clock接法，但本目录没有实现其完整业务driver。

预算deadline与租约始终使用实际壁钟/PG时钟；未全局伪造Date或PG now。若根只能批准“共同实验消息时间/观察截点”的上下文说明，时间资格仍须单独决定和独立语义复核，当前`formal_time_qualified=false`。

输出容量及费用按根转达人类决定不作阻塞/停止/验收门槛；记录实际控制和来源，未硬编码4096检查，393216控制亦通过接缝合同。历史4f89实际配置仍保留，不能据新配置改写历史。未取得SDK真实response_model/fingerprint时为unknown，fake模型字段不冒充供应商版本。

## 仍未完成

- 内置业务driver只接提取。L2/L3/Skill仍需根注入具名、来源可核验的真实业务适配，不能用旧fake适配器解锁real。
- 根的真实供应商许可、有界持久问题预算/续期、ordinary与Beta strict发送端口及持久attempt journal的最终接线未由本轮执行。旧reply relay不接受Beta strict端点；不能未经适配宣称可用。
- 最终新提交pin及同配置比较待根冻结；只读plan/preflight可接受完整commit，执行不签漂移工作树。
- 五阶段公共边界未全部观测，完整分区保持unknown；首事件/首token/最终持久延迟门槛未通过。保留raw trace和物理attempt，不以HTTP时间补齐阶段。
- 1056/1152真实矩阵、120资格、96回复、独立盲化侧信道与语义审阅、实际App/微信、切换均未执行或认证。

DSH固定0.2.1-rc.2 / `687f282e8625c6b8d11ff58211a90524be2e4317`。核对[官方profile架构](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/docs/architecture.md)与[公开LLM文档](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/llm/llm/README.md)，并核对安装版本/入口、锁文件与实际请求。直接依赖快照前后相同，不冒充全部传递实现字节认证。

## 数据、失败与清理

只处理冻结合成材料、随机_test PG及合成SQLite；原始日志/请求响应/中性包私有0700/0600，[私有索引](private-evidence-index.json)与[脱敏日志绑定](log-bindings.json)保留精确SHA，不公开本机用户名或绝对私有路径。所有RED、初始模块接线错误、header失败used4均在 [探针历史](probe-history.json) 留存。

[清理](cleanup.json)：15份已记录本任务夹具均dropped，且pg_database核验不存在；自有源码快照/引用进程为0。首轮两份未返回receipt的夹具经唯一原始配置、115项逐checksum与4f89匹配、构造顺序及父目录核验，且根/Spec均明确排除其所有权，已归属本轮并正常DROP；前后连接0、库和仅含配置目录均不存在，未强制断连。历史unknown与后续归属证据均保留。真实业务表、原库、真密钥、既有真实问题账本均未读；未启动App、微信或打包，未push/PR/操作index。
