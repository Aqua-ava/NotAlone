# Ticket25 完整非回复编排

> 当前阶段以 [最新范围](scope-update.md) 为准：真实记忆初步跑通即可，后续质量由用户调整。完整质量矩阵／语义盲评保留为可执行能力，不再阻塞当前推进；历史失败与未定不改写。

本目录独占实现统一计划、具名业务路由、持久 run journal、冻结物理 broker、恢复和私有盲包。生产源码、既有冻结材料、oracle、driver 原件、Git index/ref 均不修改。25/26 未批准。真实供应商、App、微信和外部消息均未运行；正常桌面开发仍只允许 `npm run dev`，本任务不启动桌面。

## 分母和旧证据

旧臂固定 `3c168296e9e8edaa43b8b323ff693e790e709069`，材料 manifest 固定 `84b81a3255bffe8bc69da6f38c0dd79e1ba83510454ef8a9091c947b995b362b`。`prepareFormalPlan` 逐份核验原56份材料及301例规范摘要，保留140提取、16回复、109检索、36组织。非回复176例 × 3重复 × 2臂 = 1056；另96回复，模型总分母1152；109检索另列数值证据，不能加进1152。

旧 `resumed-nonreply-evaluation/report.md:16` 的24个fake、非回复1032未执行、统一1128未执行始终作为独立历史记录保留，不能认证新pin，也不累加到当前完成数。当前报告逐条保留1056个 `succeeded/failed/unknown/rejected/idle/cancelled/not_executed`，字段和分域计数均不丢失。失败与未知不能删除、退款、重建run ID或只重跑输臂。

## 实际接缝

- `ports.mjs`：`createRootPorts` 接入根原问题账本、permission、source snapshot、显式supplier transport及观察截点；不创建真实账本、不取凭据、不自动启用官方transport。
- `router.mjs`：从固定archive加载原 `extractionBusiness`、`createL2ScenarioBusiness`、`createL3ProfileBusiness`、`createSkillBusiness`；每个run使用独立私有证据目录，避免原薄driver同名日志覆盖。
- `taskless-business.mjs`：全删来源Skill批次使用真实公开学习配置、enqueue、capture和原PG状态；未创建任务时保持 `task_id=null/lease_generation=null`，记录idle。新臂另实际核验不存在联系人返回404，作为辅助拒绝证据，不能替代原case语义。
- `empty-layered-business.mjs`：空范围／仅owner资料的联系人整理经过原公开流程；真实完成任务与 `empty` 持久状态保留，使用 `observed_terminal`，不伪称无任务。
- `session-executor.mjs`：冻结FormalExecutor的显式新版本，保留原始SHA。只有根独立复验scope/source/auth/status/public-response/PG task与ledger计数后才能写零调用终态；任何零调用路径尝试dispatch，即使吞掉异常，也在reserve前失败。无伪造task、lease或placeholder attempt。
- `orchestrator.mjs`：`FullOrchestrator.preflight/open/executePair/run/report/close`；按冻结AB/BA及sequence顺序逐对串行执行。每次实际发送沿冻结broker的原字节验证、唯一reserve、ACK及来源／权限／lease复验。ACK不再reserve；内层PG实际台账仍保留，SDK和业务自动重试0。
- `run-journal.mjs`：0700目录、0600 SQLite、独占锁、同步写入与哈希链。业务开始前持久登记run；中断恢复为unknown；attempt存在但业务终态缺失也回收为unknown。已记录任何终态只保留，不会因内存seen集合重建而重发。

## 材料覆盖的真实边界

`materialCoverage(plan)` 对全部176例给出具名adapter和case SHA；这是字段映射清单，默认 `full_case_runtime_verified=false`。140提取的消息／targets沿原材料，来源时钟沿原9/15窗口；36组织保留来源版本、主体、范围、删除状态、existing_skill及取消事件。全删Skill补零任务适配；全删或仅owner资料的联系人L2/L3补真实空任务终态。既有L2/L3只明确支持 `start/cancel/synthetic_late_result`，existing_projection非null拒绝（本材料均null）。

原Skill driver的 `skill_learning-09` 会在assertCurrent拒绝foreign来源行，尚未完成“合法本联系人来源继续、外域资料不可出站”的完整语义适配；若根执行该run，其真实失败保留。其他未实测材料也不能因schema能读而叫完整业务通过。工程小集的每域非空、零调用和故障不等于全36或140例实测，更不等于模型质量通过。盲包投影还须覆盖完整命题和来源，不能使用工程回显投影签收质量。

## 默认离线CLI

使用工程环境中的Node24和NotAlone Python，先将其加入PATH。下面的 `FINAL_PIN` 只能由根明确提供；本轮小集的e600只是已知工程候选，不是全部修复后的最终生产pin。

```sh
node .scratch/dsh-ts-migration/nonreply-full-orchestration/cli.mjs plan --candidate-commit "$FINAL_PIN"
node .scratch/dsh-ts-migration/nonreply-full-orchestration/cli.mjs preflight --candidate-commit "$FINAL_PIN"
```

第一条只返回计划摘要，0业务/0HTTP；可加 `--output /绝对私有目录/plan.json` 保存完整计划。第二条在未注入ports时退出2、`root_permission_required`，不会构造官方transport或读取用户配置。

根在仓库外提供0600的具名模块 `ROOT_PORTS`，导出 `createPorts({plan,directory})`，返回ports或 `{ports,close}`。该模块应使用 `ports.mjs` 的工厂：固定archive、原账本 `bindExistingProblemBudget`、实际permission、显式transport、原scope/source/lease以及中性盲包projector。`createRootPorts` 不替根决定真实资料范围、凭据、预算、最终pin或审阅者身份。

```sh
node .scratch/dsh-ts-migration/nonreply-full-orchestration/cli.mjs preflight --candidate-commit "$FINAL_PIN" --directory "$PRIVATE_EXECUTION" --ports "$ROOT_PORTS"
node .scratch/dsh-ts-migration/nonreply-full-orchestration/cli.mjs pair --candidate-commit "$FINAL_PIN" --directory "$PRIVATE_EXECUTION" --ports "$ROOT_PORTS" --domain l2_scenario --case-id l2_scenario-01 --repeat 1 --report "$PRIVATE_REPORT"
node .scratch/dsh-ts-migration/nonreply-full-orchestration/cli.mjs resume --candidate-commit "$FINAL_PIN" --directory "$PRIVATE_EXECUTION" --ports "$ROOT_PORTS"
node .scratch/dsh-ts-migration/nonreply-full-orchestration/cli.mjs run --candidate-commit "$FINAL_PIN" --directory "$PRIVATE_EXECUTION" --ports "$ROOT_PORTS" --selection "$PRIVATE_RUN_IDS" --report "$NEXT_PRIVATE_REPORT"
node .scratch/dsh-ts-migration/nonreply-full-orchestration/cli.mjs export-blind --candidate-commit "$FINAL_PIN" --directory "$PRIVATE_EXECUTION" --ports "$ROOT_PORTS" --output "$NEW_PRIVATE_BLIND_DIRECTORY"
```

`resume`只检查和导出；`pair --resume`或`run`只执行尚未开始的成员，任何已记录failed/unknown均返回retained。selection是完整run ID的JSON数组，必须成对。省略selection会遍历全部1056，仅供根以后明确需要完整评测时使用；按最新口径，本阶段不启动剩余完整质量批次。已有输出文件拒绝覆盖。未知锁仅由根证明旧进程已停止后回收，PID仍活跃时拒绝。

## API与盲包

`new FullOrchestrator({plan,ports,directory})` → `await open()` → `executePair([id1,id2], {resume,signal})` 或 `run({selectedRunIds,signal,resume:true})` → `report()` → `close()`。全程根拥有同一个问题账本；外层broker拥有唯一预约权。关闭前先abort/drain在途请求。

`exportBlind({plan,report,directory,projector})` 生成两份各528对／1056输出的私有可见包和独立0600绑定文件。全部未执行、失败、空终态保留；reviewer目录没有run/arm/commit映射。projector必须提供源码合同SHA及 `{items,unobserved?,source_mapping_status?}`；条目回指原冻结来源的中性 `S1…` 标签及逐字quote。允许未知映射，不能假造引用。工程probe投影明确 `not_prepared_for_formal_review`，没有形成完整命题金标或正式评审成绩。

## 资格、时钟与费用

精确出处及可执行承接方式见 [qualification-and-clock.md](qualification-and-clock.md)。按本次委派，输出、费用和旧资格不再阻塞采集；实际值与unknown保留。模型／temperature／thinking／top_p、范围、来源、授权、取消、质量和时延要求继续。旧8192与新393216只记录差异。2026-10-25已核官方Chat与Anthropic文档：实际wire满足deepseek-flash且thinking.disabled时，旧显式top_p1／新省略的有效值均为1；该单字段等价不再列未知或拒绝理由，原raw仍保留。其他协议、Prompt、schema及底层模型身份不随此结论自动等价。

五阶段、首事件、首token和最终持久化只能沿driver实际观察填写；transport时间及elapsed_ms不能补造原业务阶段。旧PG预约与新outbound ledger分别留原依据，数量不一致保留错误／unknown，不据外层HTTP伪造内层台账。

## 最小验证与清理

```sh
node --test .scratch/dsh-ts-migration/nonreply-full-orchestration/journal.test.mjs .scratch/dsh-ts-migration/nonreply-full-orchestration/session.test.mjs .scratch/dsh-ts-migration/nonreply-full-orchestration/report.test.mjs
node --import ./.scratch/dsh-ts-migration/nonreply-layered-formal-drivers/network-guard.mjs .scratch/dsh-ts-migration/nonreply-full-orchestration/probe.mjs --synthetic-only --selection mixed --directory "$NEW_PRIVATE_0700_DIRECTORY"
```

probe使用同一个纯合成持久账本和冻结broker，实际SDK/profile/ModelHost/随机PG及localhost supplier；不会连接真实供应商。只选每域非空、无任务、空任务、503、缺终态的小集，随后重开两层journal复验0重发。前期RED和每次源码SHA／私有日志SHA保留。自有profile、socket、随机PG和archive关闭／清理；仅私有raw、journal及来源manifest保留。公开只计数和SHA，无正文、凭据、原账本或本机绝对路径。

本目录不涉及新的DSH API或核心更改，沿既有冻结driver的官方profile与公开业务入口；锁定版本0.2.1-rc.2、commit `687f282e8625c6b8d11ff58211a90524be2e4317`。装配新代码只触及本目录的Node编排与已实现仓库业务接口。
