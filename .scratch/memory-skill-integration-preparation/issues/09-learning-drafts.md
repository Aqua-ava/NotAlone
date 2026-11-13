# 09：集成授权增量学习与待审草稿

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 04, 08
Source unit: U9 / S源票09
Migration mapping: S063→064 (canonical)

## 交付行为

用户在明确授权范围开启学习后获得可查看、可恢复的待审草稿；未审核不执行，授权撤销或来源删除阻止迟到材料和重复草稿。

## 范围与兼容

- 复用S草稿、材料世代、有限合批、任务租约和幂等，追加canonical064并沿现有Worker接线。
- 04的historical接口保留合法编辑；本阶段仅本地包/草稿来历，审核发布来历及管理由11–13扩展，不提前查后续表或开放其端点。

## 依赖说明

04是真实历史读取接口；08既提供偏好依赖又提供063前缀。07不是业务前置。

## 验收标准

- [x] canonical064承接063，task复合唯一键等真实前向/全量/重复验证；学习默认关闭，授权改变原子生效。
- [x] 纠正优先、普通经验有界合批且可无新增；重启、重复触发、同键操作不重复消耗材料或产草稿。
- [x] 授权范围、原会话/候选编辑选择、记忆/样本/偏好及完整参与来源世代持续复验，旧证据删除或撤权使迟到结果不可写。
- [x] 仍合法历史候选/用户编辑可作为授权材料，保留historical验证语义；来源删除仍清完整副本，不能全局放宽当前依赖。
- [x] 当前草稿目录不被回复runtime发现；授权→取材→提案→保存→verify→删除/恢复全链及list/read均不查询未建审核/政策表，不为复制最终S反向等待后续票。
- [x] 公开HTTP/PG、React待审入口、Worker/优先级/停止及完整删除相关回归与两轴审查完成，后续审核端口可承接。

## 验证入口

沿用skill learning、worker/requests、授权/批次/世代/来源删除及页面组；新增在仅001–064库运行的最小草稿流程。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

发布时本票为open；收到后续持续实施指令后，已在独立集成树完成本票并经两轴审查签收。S分叉库保持原样；本票不包含合入main、业务迁移、push/PR或部署。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。

- 2026-10-16：08最终产品与EOF校准经独立两轴复审和merger签收后，按真实依赖领取本票；在已准备的独立工作树实施，先进行无数据库守卫模拟，再按固定范围运行事前登记的合成验证。本票尚无新功能签收，AC保持未勾；S库保留，不合main或执行远端操作。

- 2026-10-16：固定候选6370c06b经独立完整及增量两轴审查，Spec原P1工具选择合同已关闭，新增及未关闭0；Standards硬项0／possible0。独立merger在clean根3200fc65无冲突no-ff合入dff25a77，合并树与已审候选一致；类型、迁移字节、保留合同及公开检查通过，六项AC签收。分阶段200个唯一方法、原失败、旧页面与新运行时字节差及资源边界见[09集成记录](../frontier-09-validation.md)。当前10 resolved、0 claimed、5 open，AC59／32；10尚未领取，不宣称实际App／微信或真实模型质量通过。


## Answer

来源固定为 `562f85e4→e88a983e`，在08签收与正式领取基线 `3200fc65` 上集成。canonical064逐字等于源S063，SHA256为 `c59bc7779ed497c127b1f4822a051ef72d21de9dfa4d8508224d124b44a7132d`；001–063未改。没有新增prepared冻结字段，codec version2／schema_revision4保持。原025实现提交时保持claimed和AC未勾；后续独立审查与集成签收见Comments及[09记录](../frontier-09-validation.md)。

已接入默认关闭的同联系人学习授权、修订CAS与动作幂等，纠正优先及有界普通合批、no_change／reuse、稳定材料消费回执、原Worker租约／前台优先／停止、草稿保存和verify恢复。草稿不进入当前运行Skill目录；只查询已存在001–064结构，不查询后续审核／政策表，也没有发布或聊天发送入口。

跨票接缝包括：学习取材局部historical=True保留合法历史候选及用户编辑，当前生成依赖不全局放宽；实际偏好使用与样本偏好来历递归进入完整来源闭包，styles／preferences行摘要进入世代复验。手录偏好即使无reply_request，也在删除事务直接擦除学习副本；在途偏好修订／范围变化拒绝迟到提案。Main沿现有异步作业、联系人隐藏缓存与草稿恢复接线，来源、偏好、记忆及助手会话删除先隔离再权威复验。

实际验证按单轮记录，重复轮不能相加为唯一方法数：

- 无数据库模拟先15/15，修复dict_row身份核验后16/16；覆盖planned先于CREATE、失败CREATE无DROP权、首次拒绝poison后不再CREATE但允许确证created清理、63字、双URL／import-before、独立Cursor／Async／Connection.connect拒绝。该守卫仅覆盖枚举接缝，不是任意PG客户端沙箱。
- 首次smoke运行1项失败，系私有守卫用tuple下标读取dict_row连接身份，2个created库全部精确absent；修复并模拟后，固定4方法4/4通过，实际5created／cap5全部absent，覆盖默认关闭→草稿、会话删除、真实全量64与063→064前向／重复0。
- 跨票偏好来源反例先1失败、补闭包后1/1通过；学习＋升级核心27/27通过。新增四项跨票组首次4中3通过1测试payload键错误，改用实际公开嵌套reply结构后4/4通过：偏好直接删除、在途偏好修订、原材料消费后样本来历、合法历史编辑。所有该轮已created库逐名核销。
- 相关单元首次41中38通过3失败，为07导航查询夹具未覆盖；补封闭查询夹具后41/41。完整unit首轮错误PYTHONPATH导致experiments导入失败，1389中1error；使用 `PYTHONPATH=src:.. python -m unittest discover -s tests/unit -t . -q` 后1394/1394通过，生产导航和冻结合同未放宽。
- 固定14模块原静态196方法，加本票4个跨票方法为200。第一轮64中63通过1失败，6created／cap12全部absent；旧样本断言未跟随基线排队即擦除行为。校准为排队前父子均存在且409、排队后子候选物理删除404而旧父仍被缺快照409拒绝；单方法最终1/1通过，直接断言精确持久身份，保留evidence／重放／续写拒绝和2次生成。
- 恢复轮152中151通过1失败，11created／cap12全部absent；旧优先级夹具仍返回自由正文提取协议。仅该合成类适配真实Grounded分句与E／V／A序列，显式synthetic维度门不代表生产默认放行或质量资格。后续尾组8中7通过1失败（问句误标导致V重试），窄方法先失败后1/1通过；尾组再10中9通过1失败（阻塞调用读取可变工具名），冻结每次调用的工具名后停止／原31秒租约恢复／三次失败预算单方法1/1通过。
- 未到达尾组首次31中30通过1失败，2created／cap2全absent；worker10与来源删除15均通过，候选版本第6项旧断言仍期待pending409。按基线同步擦除契约补B版本0、独立A版本1和空当前选择的直接数据库证据，窄方法1/1通过。最终优先级15/15通过（112.215秒，2created／cap2全部absent），候选9/9通过（11.192秒，2created／cap2全部absent）；补强精确剩余版本ID与数据库当前选择为空的断言后，该方法另1/1通过（3.113秒，2created／cap2全absent）。因此分阶段实际通过的唯一方法为前151＋优先级15＋worker10＋来源删除15＋候选9＝200，不存在单轮200/200；重叠窄组不重复计数。
- TypeScript通过；学习Main／preload／视图／删除与恢复控制器16/16，页面门禁在最终脚本上另1/1。`npm test` 首轮65中64通过1失败，独立命令副本因eager页面manifest import未到达互斥门；仅改为相应case内lazy import后互斥单项1/1、完整65/65通过。此命令未运行App或浏览器。

真实页面仅一轮：`NOTALONE_LEARNING_EVIDENCE_DIR=<仓库外700目录> npm run test:pages -- --case skill-learning --timeout-seconds 240`，单Chrome的case与scenario通过。实际生产Main／preload／React经真实HTTP／PG验证授权、纠正材料、草稿及私人依据、A→B→A、同库后端重建、撤销授权与来源删除后刷新无复活；页面不提供发布，运行Skill目录保持空。learning模型实际started=seen=1且硬cap1，external0；该计数只约束learning模型。准备阶段直接SQL种合成来源／消息，再以公开inputs写入讨论材料，没有调用C生成；不把learning字段冒称全夹具所有模型计量。

页面证据直接记录15关键Python模块的实际路径／SHA、exact001–064／repeat0、导入前planned与Core身份一致、直接Python child exit0和database_remaining=false。独立复核2个执行artifact及4个唯一浏览器资产（8次响应原字节）的SHA；原字节均私有保留。runner的browser exit、cleanup tracker及ownedGroupGone是释放门，另以原owned-identities中的15个精确PID做后置ps观察均不存在，App／headless双租约复查absent。字段、代码门和实际观察分开保存；没有依据finally直接推定退场。

原始失败、各实际轮分母、事前0600/fsync planned→created→exact DROP／absence、模块证明及资源索引保留于端侧 `/tmp/notalone09-validation-resource-index.json`；页面原字节在 `/private/tmp/notalone09-page-first-Sl6dyM`，执行守卫已冻结或按原SHA精确恢复的版本见 `/tmp/notalone09-preserved-guard-index.json`。临时登记只属于本票确证资源，不补证或连接03默认库、旧35／07／08未知资源。本轮没有业务库升级、真实DeepSeek、原生App／微信、push／PR、main合入或S清理；自动化页面不替代这些验收。独立两轴由集成主Agent完成。


失败校准的生产依据为领取基线已存在的 `source_tasks.enqueue_delete`：设置delete_requested后即在同一事务调用 `delete_source_replies`，09没有修改该文件，也未放宽候选／样本读取门。旧父缺快照仍409，真实子候选与B版本同步擦除后404；独立A的精确版本ID与空当前选择由SQL和公开接口分别核对。优先级夹具仅指向生产装配接缝，真实Grounded标签由合成原文分句构造，独立V与来源核验保留；双裁决明确提供两句，E／V／A／A实际序列断言通过。仅本合成类显式关闭维度放行门，不代表生产默认自动采纳或语义质量资格。


### 独立审查增量：thinking模式的学习请求合同

固定候选0255565a的独立Standards为hard0／possible0；Spec发现1项P1：生产学习复用thinking enabled的DeepSeek，却强制具名tool_choice。[DeepSeek官方合同](https://api-docs.deepseek.com/api/create-chat-completion/)不支持该组合。原报告保留，未观察或宣称一次真实服务400。最小修复仅在学习适配器省略强制选择，保留唯一指定SkillLearningProposal、invalid_tool_calls、normalize_proposal及全部拒绝门，不增加可执行业务Tool或Provider框架。

新增真实SDK本地MockTransport回归，经实际build_deepseek_model与ChatDeepSeek构造及序列化，生产thinking参数不变；仅在测试构造接缝补入本地异步client。每轮固定端点、最多5次Mock派发／15秒，合成key、禁外部tracing、同／异步clients均在finally关闭。red为1方法5个子例失败（0.220秒），直接捕获请求体仍有具名tool_choice；修复后1/1通过、5子例全部通过（0.226秒）：合法no_change成功，错名工具、额外工具、自由正文和坏提案均拒绝；实际请求保留唯一工具schema且省略tool_choice。

既有runtime＋proposal 11/11通过（0.004秒），TypeScript通过。原始日志 `/tmp/notalone09-review-sdk-red.log`、`/tmp/notalone09-review-sdk-green.log`、`/tmp/notalone09-review-runtime-related.log`、`/tmp/notalone09-review-typecheck.log`；事前计划 `/tmp/notalone09-review-sdk-plan.json`，增量索引 `/tmp/notalone09-review-fix-index.json`。本增量无PG、App、页面、lease或外部HTTP，也未改共用Conda。没有重复200／65或页面；原页面只认证0255565a的源码摘要，新learning_runtime字节不同，不能称页面已在新字节执行。修复提交时State及AC仍claimed／未勾，随后经独立增量两轴复审与merger签收。
