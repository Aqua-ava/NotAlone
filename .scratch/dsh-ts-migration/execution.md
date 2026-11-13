# 全迁移执行交接
本轮最新指令已核验：由接手会话继续完成全迁移，不再停在自然收尾点；最新交接见 [next-agent-handoff.md](next-agent-handoff.md)。用户于 2026-10-24 明确授权所有额度，并要求独立任务并行、会话间直接通信、主会话统一集成；实际 App 验收使用联系人 ran。
2026-10-23授权全部任务持续执行、目标模式及独立会话并行；2026-10-24用户重申必须并行：依赖满足、文件及运行资源不冲突者直接并行推进，不逐次询问，后续交接沿用。2026-10-25用户更正：并行单元必须是**全新的 Codex 会话**，不是 sub Agent；新会话之间直接通信，主会话负责统一集成与唯一 App/微信验收。三个当前独立会话按标题识别：`DSH 07 UI 验收`、`DSH 10 消息提取集成`、`DSH 21 Vision 定位验收`；主会话为当前迁移会话。
主目标：完成02—26的实现、逐票验收、兼容切换与退役；01已在 `10135184` 验收。2026-10-24用户明确废除ECNU，不再要求兼容，其余条件不变；先备妥实例再提最少验收配合，见provider-scope-update.md。
入口：[规格](spec.md)、[依赖索引](planning.md)、[01基线](baseline/README.md)。

## 当前执行责任

| 会话 | 职责与独占写入范围 | 当前阶段 |
| --- | --- | --- |
| 主会话 | 总目标、依赖调度、planning及整合验收；不重复实现子会话模块 | active；并行调度、唯一桌面操作与共享源集成 |
| 05回复与模型会话 | reply/retrieval/model模块及测试、05证据 | resolved；原六条已在b0a68175关闭，完整质量/最终切换留25—26 |
| 06Skill会话 | skill模块及测试、06证据 | 票resolved；根完成宿主、来源C、官方profile与实际App签收，原受限子目标不恢复 |
| 09记忆偏好会话 | memory/preference及共用managed-update-backups，限定04时间/版本scope参数化 | 票resolved；根完成闭包、官方宿主与实际App签收 |
| 07探索会话 | 自有snapshot实现、来源与Skill矩阵；主树根集成 | resolved；恢复态Skill展示、生产页面与 ran 实际 App 已由根签收 |
| 10消息提取会话 | 自有snapshot窗口/trace/A段与唯一写入移交 | resolved；根复验52/52、tsc0、公开扫描0；生产切换留24，B/trace留11/12 |
| 21前台定位会话 | 原生探针、定位领域/宿主验收；主树根集成 | claimed；当前 macOS accurate Vision 超时，证据已归档，等待健康 Mac 或系统修复 |
| 23用量设置诊断会话 | 两冻结切片与根签收证据 | resolved；3e044a0源提交及实际npm run dev验收 |

18已签收b4276969/9a5f6cf0，108为db1d9cbd；58TS/22Python/32UI、双轴及两轮合成App通过，工具准备原任务保持open。
04已在f4acc05d/2dd9ad4a验收；05、06、09合同审计已归档，18独立审计已归档于wechat-scope/contract-audit.md；05/06/09/18已分别派发目标实现会话。
子会话只提交自己任务文件，不夹带主调度或他人文件；独立审计交主会话收录。Git索引操作串行，避免交叉提交。
共享合成PG /tmp/notalone-dsh-migration-pg-20261024仍运行，主会话最终清理；官方源码恢复及资源见runtime-validation/recovery-20261024.md。

## 历史调度记录（当前状态见顶部及最新签收）

02—04、09、18已验收；05/06独占各自领域，09既有成果已由根整合；19增量同步与21前台定位已开独立目标会话并核验active，各先查锁定官方源码。
09分层503修复已过37后端/7Python及双轴；21已接线并短占host/app，根09+21官方HTTP联合8/8。恢复后09/21/19已串行完成合成实际App验收，根分别核验stopped/pids空；证据见app-resumption-20261024.md。
06独立交接/RPC已提交f56bd0be；根在05端口提交后整合既有09/21成果：memory323b5972（19/19）、preferenceacfcc5e0（13/13）、21领域ee2b0a33（串行20/20），各隔离tsc/双轴/scan通过。109删除抑制及19组件已归档，整票仍待宿主最终验证。
主目标与05现active且无已知额度阻碍；05三依赖端口2546d21d已归档（隔离9/9、双轴0、扫描0）。06/09仍usageLimited，19/21仍blocked，其会话不执行；主目标继续整合已交接成果，不改子目标或重建。05完整验收后才解锁23。
24等待17、20、21、22、23，25等待24，26等待25；不把预先写空壳当依赖完成。
自动删除抑制窄前置已开独立目标会话，票auto-read-deletion/issues/01-durable-guard.md，109/Python已在7f4a1729提交，TS独立模块998ec226、Python移交cb0b17b0已归档；窄票d2698519已resolved且goal complete；109归此修复，05未落盘台账顺延110，取代此前预留。根持久恢复单例1/1与移交端口15/15已记录。
共享8覆盖的verify-integrated-host.py最终官方13/13、隔离tsc0及Python36/36。Spec已知回执误suspend已修并实测；合成CLI首次exec超250ms用有界准备修复，产品预算不改。见integrated-host-validation.md；实际App复核通过并清理，见integrated-app-validation.md；09票已resolved，子目标未改，05台账/装配仍待验。 19时间边界a268f206：29/29+官方焦点1/1+tsc；真实单私聊新消息验收已做开关/退出/同库重启并清理，暂无新消息；21真实OCR与纯合成均卡ANE编译，保持未签收；历史提示缓存回执c9cc31cb已修：专项2/2、相关16例与真实开发App合成CUA通过并清理。见real-wechat-acceptance-20261024.md。

## 不可丢失的执行约束

先查锁定DSH官方文档、源码与示例；01候选为`687f282e8625c6b8d11ff58211a90524be2e4317`，02须证明实际制品对应并锁全闭包。
必须实际运行官方profile与裁剪后的有效插件树；假provider只替换外部模型，不能自己造假Harness。
普通TS业务与DSH共后台，Electron独立；不保留永久Python桥，不擅改DSH核心。
无额外会话上传、包清单上传、长期JSONL、压缩摘要或无关Shell工具；用实际请求及文件观察验证。
原PG身份、资料、用户修改/删除和来源保持；测试只用合成独立库；真实业务迁移不在无明确数据范围下执行。
日常只`npm run dev`，先检查复用实例；禁止打包/打包版、push/PR及未经指定的外部聊天发送。
真实模型在本地确定性验证后安排：先固定材料、供应商与累计预算，不使用私人聊天或绕过计数；大批预算不得由“全部任务”推断成无上限。
真实App/微信验收按工程规则主动执行，操作占用由一个负责人协调，合成/模型/原生证据分开报告。
只在真实架构冲突或需要未授权高风险动作时返回决策，其他可执行工作继续。

## 当前生产宿主与离线对照进度（2026-10-24）

cc263095已整合唯一模型宿主、原SDK物理许可、已知终态ACK未知保护和正常DSH入口的跨模式恢复门禁；根最小1→相关42、strict0及SDK/profile/公开链14/14，实际npm run dev默认无模型正常导航/退出与隔离资源清理完成。默认仍Python，不等于最终TS切换。原材料上下文28×3×2=168/168通过且独立核原UUID/全文/来源/作者/微秒。

当前接收6路径离线来源/完整输出报告及计时修复：根最小4/4→相关97/97→strict0，独立0finding；来源缺失/多attempt/时序未知保留未定，两认证始终false。详见comparison-root-integration/validation.md。实际paired collector跨臂累计预算、配置等价、真实供应商固定材料/预算与完整输出盲评仍待，05保持claimed。06既有模块整合审计并行进行，不恢复受限子目标。

## 06 根签收（2026-10-24）

既有普通 Skill 模块与移交门经最终 12 路径装配完成：单一 TS 管理、原来源 C、官方逐轮只读 scope，默认 Python 回复不变。根固定基线 RED→最小 1/1→相关 41/41、Python 21/21、provider／PG 端口 14/14、strict 0；双轴和五项覆盖核对无阻碍。实际 npm run dev 经原 API 操作、CUA 核对 v1／正文／启停／删除，正常退出并清理合成资源。原 artifact 两文件碰撞单列；详见 skill-host-root-acceptance/validation.md。06 resolved，07 仍等 05；不签其他票或最终切换，不恢复受限子目标。

## 显式 TS 未配置管理能力（2026-10-24）

根组合 Core＋TaskHost＋已签 Skill，26 路径；缺 key／owner 时保留真实共享 ModelHost、恢复和管理接口，生成明确 unconfigured，删除五步继续，模型动作写前拒绝。根最小 profile1→相关38／Python16→已配置 profile1／strict0；独立 core／TaskHost 0 finding。实际 App 两态及合成本人初始化的原完整重启通过并清理；一度 fixture 禁读刚保存配置的失败保留原证据，经单变量红绿及实际复验仅修 fixture。详见 ts-controlplane-root-acceptance/validation.md。默认 Python、schema111及其余依赖票不变，不把此切片算 05／22／24 完成。

## 05 离线盲评工具组件（2026-10-24）

冻结5个正式路径f0983fe6在基线43ae208f应用，根最小1/1→相关26/26；实际CLI实产2项、0700/0600、拒绝覆盖且原文件不变、缺参提示和临时清理通过。来源与完整语义保留，身份仅私有绑定；外模/DB/App/微信0。详见reply-blind-root-acceptance/validation.md，manifest 2dafb60854794789ba59cceb106b07fb189d16edb50f4252920c8a47465aefa2。仅组件通过，当前只支持本机假供应商采集，语义评审0、真实质量/切换false，05保持claimed。

## 19 根最终签收（2026-10-24）

原26原子矩阵24项已有具名分级证据，补齐官方profile下D5自然code7退避重开与D6带数据launcher父丢失同库恢复。独立原始/归档/当前源及清理核对0产品问题/0新增阻塞；原始RED保留，不改产品。根核运行源无漂移及最终制品/review摘要，复用既有真实微信正向，不再发消息、不重跑已绿矩阵。selected/new-only直接补证与既有all_private/非空排除/109组合，不能扩大为真实Electron崩溃或20追赶。详见incremental-root-final-acceptance/validation.md。19 resolved，原blocked子目标未改；20仍等10，21及最终切换未签。

## 19 永久回归：带数据父丢失（2026-10-24）

只新增parent-loss测试及专属helper，冻结patch ebf33403；根主树最小1/1、0skip、10.04秒，原同库/路径自然恢复与UUID/来源/receipt保持，全部自有资源清理、模型0。独立审查本对无阻碍，reconnect夹具失败清理P2由独立角色修，不夹带接收。详见incremental-parent-loss-root-acceptance/validation.md；不扩大19原签收或20/App崩溃范围。

## 19 永久回归：自然重连及失败清理（2026-10-24）

根精确接收两个reconnect专属测试路径；先完整fixture纯seam6/6，再主树真实官方profile/Legacy/PG两case2/2、0skip。自然code7后5122ms重连、metadata cursor接续、消息2/复用4、关闭停读和正常退出均通过；真实active=1原断言/缓存错误保留且清理完成。原两轮清理P2保留、最后独立delta0，未知退出不强删活库；该极端启动失败仅纯seam覆盖，不冒称真实自然复现。自有库/目录/宿主清理0、无应急；模型/App/微信0，详见incremental-reconnect-root-acceptance/validation.md。19状态与parent-loss既有证据不改。

## 05 回复对比报告器 v3 组件（2026-10-24）

根精确接收reporter与原测试两路径，patch85c22144，最终70fc72f2/6746abf0；核作者46+Standards8+Spec32文件及七只读依赖，双轴0。主树新增8/8→相关78/78（均0skip）→TS7 tsc/noEmit 0；日志原字节相同并清临时副本。固定字段投影关闭元数据额外正文出口，完整原证据摘要/合法理由/96分母/原阈值保持，最终持久结果为延迟门、首token仅诊断。不合实验hardcoded覆盖；multi source/caller/盲绑定及正式fixture仍后继，05/真实质量/切换false。详见reply-reporter-v3-root-acceptance/validation.md；外联/SDK/PG/App/微信0。

## 2026-10-24：05验收收口与下一批并行实现

- 05原六条已逐项验收并同步resolved，关闭元数据提交`b0a68175`；[根接收](05-final-root-acceptance/accepted-manifest.json)与[提交后扫描](05-final-root-acceptance/postcommit-publicscan.json)为当前状态入口，原六条文字和25完整门槛不变。
- 业务证据：`ca94d34f`完成实际同Host仲裁与TS→Python→TS同库回退；`431a5d4d`完成背景公开业务与实际npm run dev+Cua App。根最小9+2、7+1通过，App另本机HTTP3，真实供应商0；原供应商两臂2次另有原始已结案证据。
- App查看依据、编辑自动保存、甲乙隔离、复制、真实超时和生成中会话删除后晚结果不保存已完成；没有独立取消按钮，普通切联系人不取消，复制不冒充selection写入。菜单正常退出、独占进程/库/temp/snapshot/App目录清理，共享PG保留。
- 07探索与Skill、10消息提取核验、23用量设置诊断已建立独立目标会话并认领；[依赖门禁](parallel-root-coordination/next-wave-gate.json)为true，可并行实施。三会话复用既有冻结准备，先查锁定DSH官方文档源码，只在自有候选/snapshot工作；正式源/index/桌面根统一集成，禁止打包/push/微信发送。
- 默认真实用户回复仍Python，quality/switch=false；完整96及质量/费用/性能保留25。19已resolved；21原生Vision阻塞未解除，本轮未扩大其验收结论。


## 2026-10-24：23 根验收与剩余并行

- 23原五条保持原文，按37条正式路径+34份证明本地提交`3e044a0`；源提交前后publicscan均exit0/issues0。根入口task23-root-acceptance/accepted-manifest.json及completion-audit.json，九具名接口逐项消账，无无限剩余范围。
- 根设置1/13/12/官方HTTP1；管理最小1/39、台账HTTP9、状态消费者19、双TS7 strict0；实际npm run dev+Cua配置owned换PID/pending清除、用量4/2/1/未知/分组及读取故障刷新不新增调用、原生预览/取消/0600导出441字节一致通过。Electron Node24.21.0普通TS probe通过。
- 仅合成数据，无新增真实模型/微信；菜单退出8已知PID及own库/temp/journal/socket/home0，共享PG保留。首次夹具和命名操作未验成功场景单列；原始记录仓外0700/0600，未改产品守卫。
- 测试清单仍exit1，仅既有表达偏好bigint未登记；不把它算绿、不夹带外来三测试。Python结构准备/任务执行仍原责任票，quality/switch=false，24仍等待17/20/21/22，未因23通过而越过依赖。
- 用户明确允许各会话开subagent，已向07/10/23传达并记录；独立日志归档/查证/审查/回归并行，正式源/index/App根独占，禁止打包/push。07/10继续原目标；本次并行raw日志的全树扫描RED保留，移私有后实际扫描0，不以重跑替代原始失败。

## 本轮自然收尾（2026-10-24）
- 用户明确要求当前在跑工作自然完成当前交付后交其他Agent；不启动下游或新一波迁移。
- 07源提交 `08e90b8f20bc6032e98828d506af2b2dac2932ee`：根最小/模块/正式宿主及类型检查通过；真实App只验证express、auto Skill、最近50条及候选编辑保存，其他UI保留待验，整票仍claimed。
- 10默认A→原B冻结交付见 `task10-implementation/handoff.md`；根核50源/187依赖/7日志与精确目标树，未合入主源或代签整票。
- 07/10作者报告目标paused且会话idle；23已complete/idle，根subagent及测试均结束。根自有App/库/临时目录已清；共享PG及3个其他保留库客户端0，归属未确认不删除。
- 明确余项、资源责任和接手顺序见 `next-agent-handoff.md`；不得由本轮代码提交推断07、10或整迁移完成。
