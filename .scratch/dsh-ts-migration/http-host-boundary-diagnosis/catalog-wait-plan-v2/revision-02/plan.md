# catalog 等待的下一有限诊断方案（执行前冻结边界，尚未启动）

2026-10-26。Root正在独占单例复现，本方案没有启动PG、HTTP、宿主、采样、测试或产品修改；只有源码/旧合成证据读取、参数提取和官方公开文档核对。旧静态七文件及run-v1冻结证据保持原样。

## 本修订的事务事实与选择

本修订以读取时ContactContext.ts:26的实际调用为准，使用businessTransaction；HostStorage:276/367对应普通BEGIN。它与首轮GET保持相同事务入口，不改成businessReadTransaction。首个暖机callback会在同连接核对实际隔离与read_only；若不符合预先冻结的read committed/off则保留失败并停止，不以额外SET改环境或自动换入口。完整DSH/HTTP与独立HostStorage的装配差异仍然存在，不能因此宣称整个运行环境相同。

## 推荐范围及能回答的问题

推荐**40个配对事务单元：10 warm + 30 score，单并发、一个自有合成_test库**。每单元通过真实 `HostStorage.businessTransaction`，保留与首轮GET相同的普通BEGIN、三个原SET、fresh迁移文件身份/摘要核验、实时catalog/ledger/约束核验、COMMIT、撤销和DISCARD ALL。对inspect必经原catalog Q仅加原位时钟；业务callback再用同一lease的原字符串query重载执行一次 `EXPLAIN ... Q`，参数原样传递。

这给出40次原Q和40次EXPLAIN，即**80次目标catalog执行，60个计分执行**；EXPLAIN ANALYZE也实际运行Q。初始化/兼容读取中额外的catalog和其他控制SQL单列实际数量，不混入80或隐藏。若只批准40次catalog物理执行，就无法同时得到两类各10暖机+30计分，本方案不能默默改成20/20。

原Q来自当次真实inspect，不在callback再执行第三条原Q。原Q完成后仍先执行原有baseline/ledger等检查；通过后才进入callback运行EXPLAIN。原Q总是在EXPLAIN之前，位置、同会话缓存与前一执行的影响明确保留，不能把配对当作随机因果对照。不给它套用AB/BA来重排安全核验。

本次是实际HostStorage上的SQL机制探针，没有完整DSH/HTTP/TaskEvents/原HTTP诊断ALS；不建立最小服务器，也不把这种装配差异当修复。40单元足以检查这份合成材料中PG planning/execution是否已经达到毫秒量级、返回结构/计划是否稳定、客户端边界是否完整；不足以认证完整宿主根因、尾延迟、观察器成本、性能门槛或大资料行为。30计分的p95只作描述，所有慢点/失败/unknown保留，不补跑。

## 固定输入和精确源码

- 生产基线1e90，读取时HEAD b8ba；host-storage.ts SHA `0c96568ae4d608beda97af03bbaba696f07148627ecae153b1692dc52ee94f25`。SQL位于431–453，等待在457，selectors表达式703–709。
- `catalog.sql`保存源码模板的22行原样字符串，不改空白、条件、聚合或约束分支；SHA `8a15efb91f36745a9d06eeef6e4b503d68092c95c3a1da581b33a28eb8617670`。`explain.sql`仅加一个固定前缀，后缀必须逐字等于原Q。
- `params.json`保存两个有序数组，各108项；columns有24个null。用源码REQUIRED_TABLES/REQUIRED_COLUMNS及JS保持覆盖位置的对象顺序离线生成，没有执行产品模块。参数与较早projection证据一致；旧103是返回catalog行数，不是参数数。
- 固定原合成dump、plan、Node v24.19.0、Python、双依赖、pg_restore及四个pg源文件SHA见source-pins.json；沿用既有已安装工具，不安装、不复制依赖，不修改原state。实际PG server_version_num目前unknown，获准后只在setup读取并记录，不冒用工具或文档版本。
- 若目标源码/参数/依赖或原输入摘要改变，停止并报告新的pin差异，不能静默采用新版本。仅元数据HEAD变化可另记，但不改变所选生产基线和字节绑定。

## 拟实现范围（driver/私有patch仅已准备，未执行）

1. 私有精确源码副本只在host-storage.ts的catalog发起前、files前后、原await前后插入轻量同步数字标记；SQL、参数、调用重载及Promise原对象不动。不修改Query、Client.query、回调或全局prototype。source patch与driver按本次新授权先自校验并冻结摘要，发启动通知后执行。
2. 私有探针只调用真实HostStorage事务；callback中的EXPLAIN使用 `client.query(explainSql, params)` 字符串重载，正常await原返回值，无命名prepared statement、Query对象、额外then链或类型解析器替换。仍由原错误归类和回滚路径处理失败。
3. raw记录 `query.dispatch→query.resume`、`files.begin→end`、`await.begin→resume`。第一项包含文件核验与并行等待，不称纯PG往返；后两项不相加伪造分解。
4. EXPLAIN记录独立client dispatch→resume、JSON中的Planning Time/Execution Time、Plan/Actual Rows/Loops/Buffers及JIT字段是否存在。TIMING OFF减少逐节点读钟，仍有语句总执行时间；不把cost单位当毫秒。首轮不启用SERIALIZE，也不改GUC、统计信息或计划策略。
5. 单元级别记录sample_index、warmup、所有失败、原返回envelope字段/计数、原Q与EXPLAIN的时点、连接generation别名、lease复用与本次query同连接标识。原lease5秒生命周期保持；跨单元换连接照录，不强行保活。原始计划、原始envelope及实际PID仅私有保存；公开相对别名、脱敏结构和双SHA。
6. 原result包含无ORDER BY的JSON聚合；仅在计时之外按完整字段排序生成canonical摘要，原数组和原SHA同留，不改SQL加ORDER BY，也不把顺序变化误判为丢字段或筛掉样本。

## 时间比较的边界

| 量 | 含义 | 不能怎样使用 |
| --- | --- | --- |
| raw dispatch→resume | 当次必经catalog，包含重叠文件工作、协议、PG和恢复 | 不能减files得到纯PG；不能当成原始完整HTTP |
| raw await.begin→resume | 文件核验后继续等待到原await恢复 | 不知道数据何时到达，不能直接称pg解码/续点 |
| EXPLAIN Planning Time | 这次EXPLAIN执行所报告的规划时间 | 不含parse/rewrite，不能概括全部PG CPU |
| EXPLAIN Execution Time | 同一次EXPLAIN所报告的执行时间 | 默认不含正常结果转换/网络；不能充当另一条raw执行时间 |
| EXPLAIN client总await | EXPLAIN命令自身的客户端总时长 | 返回的是计划JSON，不能代表原catalog结果的传输/解析 |

`Planning+Execution`只能在同一EXPLAIN样本内相加作为已报告的两个区间；`EXPLAIN client−(Planning+Execution)`若输出，也只能命名“该EXPLAIN未覆盖剩余”，包含多种服务器/客户端工作，不称纯客户端开销。不同执行的raw与EXPLAIN不能相减分出解码。

更不能做“首轮HTTP p50−本轮SQL p50”“首轮catalog残余p50−本轮PG timing”或“p50相加还原首轮”。两轮不是同请求、同进程装配或同一次执行；schema缓存、顺序、结果形态和EXPLAIN观察开销不同。首轮1.8–2.1ms只是定位先验，不是本轮可相减基线。

官方说明：Planning不含parse/rewrite；默认EXPLAIN省略正常结果转换/传输，且有观察开销。TIMING OFF仍给语句总执行时间。[PG执行计划边界](https://www.postgresql.org/docs/18/using-explain.html#USING-EXPLAIN-ANALYZE)、[EXPLAIN选项](https://www.postgresql.org/docs/18/sql-explain.html)。这是18版文档语义核对，不是已确认本机server为18；实际版本匹配在获准setup时核验，不支持时保留失败，不自动换选项重试。

## 可证伪信号和停止点

- 若EXPLAIN的Planning/Execution自身多次达到毫秒量级，支持优先查这份精确catalog计划的数据库侧成本，但不证明它解释首轮全部差值。
- 若raw dispatch/resume仍慢、EXPLAIN报告短，尚不能判Node：parse/rewrite、原JSONB文本转换、传输、解码和续点都可能在未覆盖部分。保留unknown，再审阅下一观察范围。
- 若本探针原Q快速而完整宿主曾慢，仅排除“这份SQL在所有环境下必然慢”，说明需要回到完整宿主的实际连接/调度状态；不能把两个数相减宣布DSH成本，也不自动开展第二实验。
- 完成40单元或遇不可恢复来源/连接/超时错误即收尾，预先建立40个计划行，未执行项保留not_attempted。没有“看起来不稳定就加样”或只重跑输臂。

## 同一批EXPLAIN必须核对的name/text机制假设

原Q的 `required.relname/attname` 来自 `$1/$2::text[]`，而官方catalog定义中 `pg_class.relname`、`pg_attribute.attname` 为name。[pg_class字段](https://www.postgresql.org/docs/18/catalog-pg-class.html)、[pg_attribute字段](https://www.postgresql.org/docs/18/catalog-pg-attribute.html)。这只给出类型差异，尚未说明本机计划如何处理或是否影响索引。

在原有40份EXPLAIN JSON中递归检查全部相关pg_class/pg_attribute节点与对应别名，完整保存 `Index Name`、`Index Cond`、`Filter`、`Join Filter`、`Hash Cond`、`Merge Cond`、Node Type、Actual Rows/Loops、Rows Removed by Filter及Buffers。特别记录cast落在catalog列侧还是参数/连接侧，以及名称匹配是在Index Cond还是事后过滤。若使用组合索引，逐个检查实际条件键；不能只见Index Name就说全部组合键生效，也不能只见Seq Scan或cast就宣布索引失效。

待验证预测：若类型处理使这次计划不能把名称等值约束用于预期索引定位，应看到相应条件留在过滤/连接中、索引条件缺少名称键，并伴随有意义的扫描/过滤/循环工作。实际计划若直接用上对应条件或扫描工作很小，会削弱这一方向。即便发现这些形状，微小表的成本选择、连接顺序和算子支持仍可能合理，单一原计划不能证明“cast导致退化”。如果主要时间在Planning而Execution很短，也不能把执行节点的索引形状强写成毫秒原因。

本轮只读取同一批原Q的计划，不改成name[]、不加显式cast变体、不改索引/连接/GUC，不增一组实验。先给事实及unknown，之后任何方案均另行审阅。

## client级ready/dataRow观察：明确不在推荐首轮内

若root以后批准，最小方式是在私有HostStorage副本获得**自有native client后、businessLease创建前**，仅对该实例connection添加明确命名的前置/尾置 `dataRow` 与 `readyForQuery` 同步监听。先记录既有监听顺序，前后只写有界内存时点，不改msg/rows/result，不增await/IO，不改回调和返回值；退出时逐一移除自有监听并核对既有顺序/函数身份未变。不得触及其他client、全局prototype或进程级async hooks。

- 不从业务lease Proxy读取connection：`host-storage.ts:98–100`对活跃对象属性访问会置reusable=false；监听API调用也会改变复用资格。这会让“观察”偷偷变成逐次重连，必须避免。native client引用不暴露给业务callback或长期保留。
- 不给Query添加row监听；`pg/lib/query.js:79`的累积条件与其有关。也不监听connection.message，避免改变`_emitMessage`行为。
- dataRow前/后仅包围现有Client数据行处理，字段文本到JSON类型转换/行收集可能包含其内，但协议bytes解析已在事件前发生，仍非完整wire解码。ready尾点在原callback/队列处理之后，不精确等于Promise刚resolve；resume差值不能命名纯微任务排队。
- 每次目标query前确保同client没有其他待发query，原Q/EXPLAIN各自标签，非目标连接握手消息不混入。额外监听本身改变调度，必须另设可比对照并预先审阅样本/开销；当前40单元不包含这一扩展，不能自动启用。

## 时间上限、数据和清理

获准的本次流程上限180秒：工作150秒、收尾30秒，含绑定、一次restore、40事务与资源核对；这是本次新授权的上限，不继承或扩展到第二实验。raw从一开始仅写自有授权私有子树，目录0700/文件0600，launcher以umask077先打开输出fd再交子进程，不靠末尾chmod修补。公开只脱敏证据、相对locator及raw/public双SHA。

只创建一个明确注册的随机_test库和一个Node探针进程；不启动HTTP/DSH/App/微信/模型/后台任务，不停止共享PG，不读取邻居或实际App资料。控制PG显式OS user且不输出身份，产品connectionOptions不变。

finally关闭HostStorage及全部自有client、退出探针，检查同名自有会话0再DROP自有库、核对库不存在，移除自有源码/临时目录；完整raw保留。源码、SQL、参数、依赖/二进制和dump前后hash均核对。root正在复现的问题及其数据库不触碰；收尾核对后明确归还窗口。本文件冻结时以上均未执行；新driver和私有patch自校验成功、SHA冻结并发启动通知后，仅执行这一次授权流程。性能/25/26状态不变。
