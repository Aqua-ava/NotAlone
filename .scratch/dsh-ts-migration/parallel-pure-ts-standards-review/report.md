approve

# 固定候选 Standards 独立审查

本轴未发现本次变更新增、可复现的 P1/P2。该结论仅覆盖下述固定差异的工程规范与领域硬边界，不批准产品切换或 Ticket 25/26 签收。

最终冻结为`4f89bb976dd4086a02b7ae983fee2760d6e4ff64`，Standards结论仍为approve。以下保留`ff45f2ec`核心审查，并在文末追加7路径小差异；原始核心交付物已逐字节存入`ff45-archive/`，没有把旧探针改称在新候选上重跑。

- 基点：`e17d4c752c69618e90e43c42488f1cb2c4d1b7a4`。
- 核心候选：`ff45f2ec296c4cead326d2ab6f3cf7770c9396ab`；merge-base 为指定基点。
- 核心差异：129 文件，8743 行新增、91 行删除。独立核验联合清单128项及候选各文件 SHA，见 `source-audit.json`。
- 仅此 Standards 轴独立执行；未派子 Agent，未读取另一轴报告。

## 范围与规范依据

读取了 `docs/agents/workflow.md`、`engineering.md`、`domain.md`、`issue-tracker.md`，架构索引、领域词汇及相关现行领域／流程／隐私条款；并核对 ADR-032、066、102、本轮 spec、25/26票、供应商范围更新及验收范围更新。

适用的硬边界为：`AGENTS.md:7–12` 的确认联系人、owner/contact隔离、分层来源及人工发送；ADR-066的原库原地、可信历史与失败停写；ADR-102的官方入口、唯一业务责任方、临时框架会话及逐次物理调用保护。范围更新允许先接通纯TS路径并保留旧库存，费用暂豁免没有取消预算、质量或权限要求。

## 核对结果

| 规范 | 固定候选中的关键位置与独立结果 |
| --- | --- |
| 原库、基线、账本与迁移原子性 | `schema-prepare.ts:32`、`:47`、`:63` 复用原兼容性检查，拒绝不明历史、其他连接与锁冲突；逐版本SQL和账本同事务。115份原SQL与基点逐字节相同。合成库覆盖035审计基线、历史checksum漂移、SQL中途COMMIT回滚、103旧Skill损坏拒绝及保留原身份。 |
| Darwin同一内核寿命锁与正常收尾 | `managed-database-lifetime.ts:7`、`managed-postgres.ts:31`、`host-plugin.ts:61`、`:224`。私有文件／归属拒绝、TS共享锁与原Python flock互斥、消费者退出后监督器才能独占停库均通过；正式launcher实际运行期持锁，完整关闭后释放。 |
| 显式模式与唯一责任方 | `pure-ts-runtime.ts:2` 拒绝冲突模式／远端许可；`host-plugin.ts:596` 仅兼容臂启动Legacy。纯TS launcher在不存在Python路径、无Conda子进程环境下执行，公开关闭取消并排空在途假供应商，没有晚候选。旧源码／组件库存仍存在，不能据此宣称26已完成。 |
| 联系人范围、来源、删除与晚写 | `pure-ts-reply-scope.ts:10`、`assistant-generation-store.ts:103`、`layered-memory-management-store.ts:20`、`layered-memory-management-source-policy.ts:7`。manual/desktop重叠与跨范围隔离、并发同键唯一有效写者、替换后晚候选拒绝、采用新消息继承权威要求、来源删除封旧键、停用Skill旧准备拒绝均通过。分层任务不混入入队后的新增L1；纠错保护与未知结果不重放通过。 |
| 实际出站前的授权与累计预算 | `model-provider.ts:89`、`quality-model-caller.ts:78`、`quality-model-authorization.ts:36`。调用走现成provider、官方prepared stream及Unix许可；PG从实际case/run/token和冻结输入核scope、lease、source_ref及请求摘要。安装时guard绑定不能靠修改env撤销；六phase累计8次后第九次在发送边界拒绝，实际HTTP仍为8、SQLite used仍为8。 |
| ACK未知、取消、失败与回执 | `quality-model-caller.ts:90`、`:103`、`:131`。开始PG预约后丢失ACK保留pending和未知permit，换phase零新增HTTP；取消或HTTP失败不退款。预约后租约过期零HTTP且保留not_sent，实际HTTP后来源撤销拒绝质量正文晚写并保留消费元数据。 |
| 人工审核、质量身份与文字保真 | `organization-quality-review.ts:10`、`organization-quality-report.ts:81`、`pure-ts-public-api.ts:32`。Agent审核不升级为人工通过，自动使用资格固定false；不可得的实际response model／fingerprint保持unknown。新公开JSON入口使用有界字节读取及fatal UTF-8，最终HTTP实体的中文／emoji字符计数等号与超一字符拒绝通过。 |

`source_ref` 的职责是绑定PG实际质量case及冻结输入摘要；它不替代累计问题账本、不授予供应商授权，也不证明模型质量。质量执行不伪造生产任务claim；正式SDK路径仍要求已安装的guard及来源解析能力。以上没有以请求模型配置冒充实际响应身份或以运行成功冒充人工语义审阅。

DSH固定依赖为`0.2.1-rc.2`，实施记录指向官方commit `687f282e8625c6b8d11ff58211a90524be2e4317`。本次另核对已安装的官方LLM `prepareCall`、DeepSeek `prepareExtensions → signal检查 → fetch`实现与现有profile；版本和实际读取源码摘要已记录在 `source-audit.json`。profile未增加Shell、任意文件执行、日志上传或外部聊天发送工具。未以可变网页替代锁定源码证据。

未把文件压缩排版、个人命名或偏好的大重构列为阻塞；没有需要升级为P1/P2的新增规范违例，因此没有缺陷最小复现清单。

## 实际执行

全部在仓库外私有git archive快照内执行，依赖通过现有锁定node_modules符号链接复用；源码从固定对象提取。最终1554份快照文件逐项与候选重核一致。执行环境Node `v24.19.0`，统一使用`<NODE_BIN>:<NOTALONE_ENV_BIN>:$PATH`，未activate环境。

命令公共前缀为`perl -e 'alarm <秒数>; exec @ARGV' -- node --experimental-strip-types --no-warnings --test --test-concurrency=1`。下表参数和工作目录均相对`<SNAPSHOT>`；完整精确命令、计数、耗时及各私有日志SHA见 `validation.json`。

| cwd | 入口／筛选重点 | 本轮结果 |
| --- | --- | --- |
| backend-ts | schema-prepare，显式筛选首次准备、诊断、102／114、未知历史、035、COMMIT与103损坏 | 8/8 |
| backend-ts | managed-database-lifetime、managed-postgres，包含合成Python flock比较器 | 4/4 |
| backend-ts | quality-model-caller：实际scope/source_ref、取消、实体字符、ACK、transport、错身份 | 7/7 |
| backend-ts | pure-ts-lifetime、pure-ts-shutdown | 2/2 |
| desktop | pure-ts-startup | 2/2 |
| backend-ts | quality-model-caller：安装时guard、六phase累计8次 | 2/2 |
| backend-ts | layered-memory-management及pure-ts-binding-scope：纠错、未知、并发、冻结目标和manual/desktop | 5/5 |
| backend-ts | assistant-generation-lifecycle | 9/9，含8个嵌套子例 |
| backend-ts | quality-model-caller：预约后租约失效／HTTP后来源撤销 | 1/1 |

这些是本轮实际执行的分组结果，不与组件方／根会话日志相加为新的正式分母。未重跑全后端、全桌面或完整联合套件；根已提供的TSC等日志仅为参考。初次schema运行的负向名称筛选额外运行了Python schema比较器，未计入固定源码结论；随后显式正向筛选的8项为表中有效证据。运行命令／夹具问题没有登记为源码缺陷。

独立审查探针 `verify_fixed_candidate.py --snapshot <SNAPSHOT> --output <REPORT_DIR>/source-audit.json` 已实际运行成功；它逐字节核候选快照、联合清单及原SQL，不读取.env或业务库。

## 数据、清理与限制

- 仅本机fake provider、随机`_test` PostgreSQL、合成SQLite和测试目录；真实配置、原资料、真实问题账本、供应商与实际App／微信均未访问。合成SQLite初始化使用另外从同一候选归档的4份Python CLI源码；该测试夹具不进入产品运行进程。
- 实际测试全部完成其teardown，受查合成库命名前缀剩余计数为0；没有清理未知资源。原日志留仓库外私有证据目录，权限0700/0600；源码快照及其node_modules符号链接在最终核验后移除，详情见`cleanup.json`。
- 执行期间工作树的`extraction-flow.ts`、`extraction-protocol-contract.ts`出现另行修改；未使用或评审这些漂移版本，固定候选对象与快照核验不变。未改生产源、原测试、他人报告或票面；未暂存、提交、push、PR或打包。
- 真实模型质量、1152正式分母、120资格、实际App／微信及最终性能仍未签收；费用为用户暂豁免，并非达标。本次没有用接口通过覆盖旧a61/legacy真实记忆质量失败，也没有把该既有问题列为本提交引入。
- 核心批准保持，最终结论按下文追加差异绑定`4f89bb97`；原未知模型结果不得盲重放，Ticket 25/26状态保持原样。

## 4f89bb97增量审查

结论：approve，未发现新增P1/P2。`4f89bb976dd4086a02b7ae983fee2760d6e4ff64`的直接父提交为核心候选`ff45f2ec`。独立逐文件确认前一差异的129项完全未改，其中85项为backend-ts及desktop源码／测试；最终相对原基点为136文件、8928行新增、94行删除。

本次只评审固定对象的7路径：2生产文件13行新增／3行删除、一份71行合成回归及4份说明。逐项blob／SHA、父子关系、原解析协议和pnpm锁文件保持结果见`delta-audit.json`；没有读取漂移工作树作为候选源码。

| 位置 | Standards核对结论 |
| --- | --- |
| `backend-ts/src/extraction-flow.ts:153` | 仅当前direct调用显式开启完整引文覆盖说明，继续走同一模型端口、窗口、协议、来源、物理许可、预算与追踪。没有新增读取范围或模型调用。 |
| `backend-ts/src/extraction-flow.ts:175` | 对已解析为supported且要求完整来源的候选，用实际逐字引文的message_id集合复核声明的source_message_ids；缺项转unsupported／insufficient_evidence，在写入前拒绝。保留原model_verdict／model_issues和模型返回追踪，不把程序拒绝伪称模型原判。 |
| `backend-ts/src/extraction-protocol-contract.ts:11`、`:20` | 新选项默认关闭，且限定legacy-v4；未修改旧默认builder、nullable-proof-v3、Python协议或解析器。新增说明明确完整覆盖只是必要条件，仍需核验主体、正文和限定。 |
| `backend-ts/src/extraction-protocol.ts:126` | 本文件与核心候选逐字节相同；`requires_all_sources`和持久删除依赖`source_dependency_mode`仍分别表达各自职责，没有把原any改all。缺引文拒绝回归亦实际断言原any保留。 |

本轮实际执行：

- 在仓库外新建的`4f89bb97`git archive快照运行`cd backend-ts && perl -e 'alarm 60; exec @ARGV' -- node --experimental-strip-types --no-warnings --test --test-concurrency=1 test/extraction-verification-quality-regression.test.mjs`：2/2，0失败0跳过。缺声明来源拒绝；明确单源与完整双源两个正向场景保留。
- 独立`delta-contract-probe.mjs <DELTA_SNAPSHOT>`对比固定`ff45f2ec`与新helper：4组默认合同逐字段相同，缺省调用相同、事实输入未修改，显式完整覆盖选项在nullable-proof-v3被拒。该探针只执行普通TS函数，不装配DSH、模型或数据库。
- 日志摘要和精确命令见`delta-validation.json`。此前9组核心探针保留原候选和原结果，没有机械重跑全量；组件方83项等记录只作参考，不算本轴本轮执行。

快照259文件在运行前后与固定候选逐项核验一致；基线helper另外从`ff45f2ec`精确提取。日志私有0700/0600保存；自有源码副本及符号链接已清理，无自有残留进程，未创建PG／SQLite／App资源，见`delta-cleanup.json`。首次归档误指向不存在的npm锁文件，在测试启动前改为实际跟踪的pnpm锁文件；该命令修正没有计为源码缺陷。

完整引用覆盖不证明语义成立。根转述的原E/V离线回放为P2拒绝、P1/P4保留、P3仍不支持；本轴未读私有材料或独立执行该回放，没有新增真实模型调用，也不据该转述签收语义质量。单源语义错误及1152／120、实际App／微信、最终性能、25/26未签收状态保持；旧unknown仍不得盲重放。
