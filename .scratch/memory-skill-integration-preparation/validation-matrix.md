# 后续验证矩阵与验收标准

> 当前正式实施入口见[规格](spec.md)及[任务图](planning.md)，M2增量要求见[重新冻结](refreeze-v2.md)。本页U编号沿用首轮单元，不是正式票编号。

本页所有产品验证均为**待执行提案**。本轮只检查入口存在及相关代码/记录，没有运行unittest、npm test、页面、Electron、微信、模型、数据库或迁移。源成果通过情况另见[证据表](acceptance-evidence.md)。

## 执行分层

每个集成单元先做最小且相关的验证，明确方法身份与源码摘要，通过后再扩大到受影响回归。最终同源组合完成后作Standards/Spec独立两轴审查。保留原失败、恢复轮次、未执行部分及环境准备错误；单次通过和分阶段合格并集分开记录，不把“已收集方法数”写成“已执行”。

Python按engineering使用Conda NotAlone、Python3.12；按模块在backend执行。隔离PG/HTTP使用自有合成库、独立端口和进程登记，不借用业务库。页面、App与桌面占用在实际执行前重新协调，不沿用来源记录的旧资源状态。当前准备任务不启动这些资源。

| 层/对应单元 | 现有固定入口 | 必须新增或组合验证的情形 | 通过标准 |
| --- | --- | --- | --- |
| Git与范围 | baseline及三个TSV文件/提交索引 | 执行时main漂移；原成果到S映射；产品修正342e63a8归属 | 新固定基线可复算；不夹带S后修复或其他树未提交内容；仅批准单元变更 |
| 迁移文件 | `tests.integration.persistence.test_database_migrations`、`test_database_adoption` | canonical编号、所有硬编码、035前缀及S分叉拒绝 | 连续唯一；M001–058字节不变；原基线/账本不伪造 |
| 新库与前向 | 同上，加`test_expression_preferences_upgrade`、`test_skill_learning_upgrade`、`test_skill_review_upgrade`、`test_memory_upgrade_migrations` | 固定M058建立合成前缀，再追加；保留既有prepare JSON、来源、绑定、水位、NULL依据和旧Skill | 全量及前向成功；repeat零新增；新表/外键/trigger与索引逐项存在；旧内容、身份、授权、水位及未知值保持 |
| 迁移故障恢复 | loader原故障/并发测试，新增各新增版本边界 | SQL失败、账本写失败、中断及两个runner互斥 | 当前SQL和记录同回滚；前序成功不重放；有明确失败状态，不能靠ready代替结构验收 |
| U1/U2/U3记忆 | `tests.integration.server.test_memory_current_status`、`test_memory_correction_protection`、`test_memory_event_updates` | Grounded默认提取到事件提案/核验/保存；旧证据改写、重启、新证据及事件不同发生时段 | 历史不冒充现状，未知保持未知；人工决定不被自动覆盖；事件阶段不由时间自动完成；版本原子且可合法撤销 |
| 原文保真不退化 | M `tests.unit.memory_extraction.test_grounded_extraction`、`test_grounded_runtime`，M来源与编号回归 | 新event字段不得改写原主张/主体/限定；原协议与新适配非法字段 | 使用main默认builders；原文、证据位置、未名指代及质量门保持；不为通过旧夹具切回旧提取器 |
| U4合法历史 | `tests.integration.server.test_historical_reply_basis`、候选版本/传输组 | prepare后修正/替代/否决/时效变化；删除不同于修改；继续/重试/退出 | 合法历史仍可看与编辑；当前新检索严格复验；删除清正文/编辑/携入/恢复副本；不自动继续 |
| U5/U6概览 | `test_contact_relationship_overview`、`test_owner_memory_overview`及relationship/owner overview lifecycle、upgrade、generation组 | 空概览、原消息/世代/版本变化、无当前叶、SELF跨关系边界、重建迟到 | 投影无私密正文副本；entry来源与current_leaf真实；本人不泄露原联系人的私密定位/原话；no-store、错误不返回旧正文 |
| U7冻结检索 | M `test_assistant_generation_prepare`、`test_assistant_generation_lifecycle`、`test_exploration_generation_preparation`；S `test_overview_reply_{retrieval,budgets,lifecycle,races,snapshot_compat,source_generations}` | 新嵌套值对象及旧编码；导航历史+偏好+继续依据的prepare→保存→重启→执行；prepare后新消息到达；运行中旧格式/未知终态/零C及已有C失败 | codec显式版本及严格字段；旧格式先核验执行归属、封键及租约，不能生成第二次；输入/初始材料不变；补查限制在冻结500条ID及初始ID；独立数量/字符预算；实际使用回执准确 |
| U8偏好 | `test_expression_preferences`、`test_expression_preference_overview_combination` | 一次性意图优先；prepare后删除偏好/来源；隐藏联系人缓存与迟到结果 | 只有明确动作持久化；下次适用、本次明确意图优先；固定JSON/使用表/缓存/重试无可恢复被删内容 |
| U9学习 | `test_skill_learning`及unit worker/requests | 授权关闭/撤销、重复触发、同库重启、会话/样本/记忆/偏好删除及晚返回 | 草稿与已发布分离；授权范围及世代复验；默认关闭；批准前不加载；任务恢复幂等 |
| U10/U11/U12 Skill | `test_skill_review`、`test_skill_lifecycle`、`test_skill_feedback` | 同输入旧/新对照、编辑使对照失效、范围/场景、方法延续、合并祖先停用、资源加载、回滚/删除双向并发 | 恰好一次发布；对象与scope明确；正文/资源都排除停用方法；旧批准不批新版本；删除高于回滚，GET前直接核验擦除 |
| U13升级 | `test_memory_upgrade`、`test_memory_upgrade_batches`、`test_memory_upgrade_lineage`及worker | 算法指纹变更、预览不写权威记忆/不推进提取水位、合法新增与人工保护空动作、来源/修订变更、部分失败、取消、重复、undo | 允许持久化job/batch/task/preview/trace；范围/总预算明确；水位不清零；旧NULL不补证；批准幂等；新键旧修订拒绝；undo不覆盖人工后续决定 |
| 桌面归属/新字段 | M `contact-content-restore-http.test.mjs`、`contact-generation-jobs-http.test.mjs`、`explicit-generation-context-http.test.mjs`、`continuous-generation-combination-http.test.mjs`、`assistant-generation-quit-http.test.mjs` | scene/basisChanges/偏好/执行视图的A→B→A；多联系人任务晚完成；关闭面板后政策轮询；运行中旧格式/未知终态回执 | 结果只回原联系人/会话；输入与用户编辑不丢；异步onPrepared许可生效；不恢复已关闭面板；退出有明确结果；旧格式不能绕过执行中止与终态核对 |
| main原有边界 | M前台、binding consent、observation/global-session-stream及生成准备回归 | 新Worker/任务优先级、删除trigger不阻塞授权同步；群聊/失焦/关闭与既有门禁 | main已经实现的前台调度/后台范围/停读/恢复不退化；未确认会话不读正文；无聊天发送Tool |
| U15同源组合 | `tests.integration.server.test_memory_skill_evolution`、S `desktop/tests/headless/memory-skill-evolution.ts` | 同一合成来源贯穿记忆→两概览→实际候选编辑选择→学习/审核→停用→升级→删除；加M prepare/联系人切换 | 生产装配与集成后默认协议真实使用；合法新增和空动作均覆盖；直接DB擦除先于GET；重启/冲突/晚返回/两顺序有精确结果 |
| 类型与有限页面 | `npm test`，相关`node --test`，后续有限`test:pages` | strict payload读取、偏好/概览/审核/升级/evolution各相关case；M2探针18源与旧17源manifest | 类型、安全/调度及macOS自有探针编译/签名组通过，不执行产物或启动App；页面用生产React与隔离HTTP/PG，资源归属及cleanup清楚 |
| 质量/真实环境 | 独立批准的真实模型/App/微信/业务升级范围 | 必要时按最新约束另行确定样本、供应商、出站预算、真实测试对象及数据迁移范围 | 分别报告，不据工程合成通过宣称真实质量、原生权限、渠道、业务升级或外部副本删除完成 |

后端表中未重写的缩写 `test_*` 位于 `backend/tests/integration/server/`，迁移专组位于 `backend/tests/integration/persistence/`。通配花括号仅为组名说明，不是unittest可直接接受的模块参数。桌面HTTP文件位于 `desktop/tests/`。

## 命令约定与范围

下列为已核对仓库支持的**未来执行模板**，本轮没有运行：

```bash
# 先按本机Conda入口激活NotAlone；从backend执行精确相关模块
python -m unittest tests.integration.server.test_memory_current_status \
  tests.integration.server.test_memory_correction_protection \
  tests.integration.server.test_memory_event_updates -v

# 最终扩大验证时，从仓库根目录运行；不能用收集数量代替实际结果
python -m unittest discover -s backend/tests -t backend -v

# 在desktop执行；M2 npm test含macOS探针快照编译/签名，不执行产物或启动App
npm test
node --test tests/contact-content-restore-http.test.mjs \
  tests/explicit-generation-context-http.test.mjs
```

迁移、页面、App、模型与备份命令含目标、资源、预算或数据范围，应在实际工作时按最新README及授权构造，不在此生成可误执行的业务库操作命令。`npm run test:pages`的case/时间参数按集成后的 `desktop/README.md`核对；`npm run package`仅构建包，不能作为App验收。M2已改独立持续源，旧只注入正式probe的App包装器不能据此控制其诊断；正式15须另核有效包内helper路径与捕获入口。默认跳过不计通过，也不认证TCC、联系人或事件覆盖。

## 最终放行门槛

1. 方案和基线：D1–D4的适用部分已明确，原S成果及S后修复分界可追溯。每个批准单元有路径清单、冲突决策和本地提交，不捎带其他工作树修改。
2. 数据与兼容：新库/M058合成前向/幂等/失败/旧基线通过；S分叉拒绝或另行批准的留存路径真实验证。新依赖类型、固定上下文、锁序和删除闭包有动态反例。
3. 功能与回归：各单元公开接口、受影响main行为和同源组合均实际验证；新增事实路径不能由空动作替代；原超时与失败不抹除。
4. 审查与证据：Standards及Spec在最终候选重新独立审查；方法身份、实际输入源码、原失败、精确恢复、单次/并集、未验范围和资源退场如实记录。
5. 发布边界：默认质量门与语义关闭不随工程通过改变。仅在另行明确实际合入/业务迁移/远端操作范围后执行对应步骤；本轮准备材料不构成这些执行结果。

若仅工程集成通过，可签收“固定main上的合成工程集成”，仍需单列真实模型、App/微信、业务数据升级及部署未验。真实桌面验收在其实际任务中由Agent按最新规则主动完成，本准备任务遵守用户明确的“不占桌面、不启动服务”范围。
