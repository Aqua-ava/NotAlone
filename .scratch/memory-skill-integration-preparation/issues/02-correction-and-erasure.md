# 02：集成纠错防复活与完整擦除

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: None
Source unit: U2 / S源票03
Migration mapping: S058→059 (canonical)

## 交付行为

用户纠正或否决后，同一旧证据上的错误含义不能换说法或重启后重新出现；真正新证据只形成待确认差异，删除后不留下可恢复正文。

## 范围与兼容

- 复用S完整纠错证据身份、原窗口/来源世代、人工决定及幂等合同，追加canonical059。
- 独立交付纠错核心；最终S的事件扩展由03接续，升级工作擦除hook由10接入原删除事务。本票不提前导入/调用尚未集成的升级模块，不增加反向依赖。

## 依赖说明

无产品前置。canonical059须在03的060之前；这不要求本票等待01的codec。

## 验收标准

- [x] M2原001–058字节不变；S原058以canonical059前向加入，移号测试保留原边界意图，全量/固定前缀/重复验证使用新合成库。
- [x] 同旧证据改写、重复批次、人工更正/否决、同库重启与迟到自动更新不能覆盖用户决定。
- [x] 新证据进入待确认并显示差异；语义不确定不自动采用，来源和人工决定在写入事务中再核。
- [x] 删除同步清纠错正文、快照和候选证明；只有仍有效消息需要时保留无正文erased_guard，否则移除决定，另一联系人不受影响。
- [x] 公开纠错/确认/拒绝入口与React状态、失败重试及晚返回实际覆盖；新写入和删除闭包一起可用。
- [x] 相关来源/纠错/记忆写入回归、两轴审查及Answer如实完成；不操作S库、不清理其他任务资源。

## 验证入口

沿用memory correction protection、来源擦除、人工版本更新和迁移组；添加canonical058→059及复合来源反例。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

用户已明确启动正式集成；本票在独立任务工作树实施，S分叉库保持原样。完成本票也不包含合入main、业务迁移、push/PR或部署。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。

- 2026-10-15：基于固定M2的集成基线领取；采用公开HTTP/隔离PostgreSQL、生产React控制器与迁移命令接缝进行验证，不使用业务或S分叉库。

## Answer

2026-10-15：在固定M2的独立任务分支`codex/integration-02`完成本票代码和合成验证；固定候选`1873defb624de25aeaff45b802af3fa011565fd9`经独立Standards/Spec两轴审查均0项发现后，无冲突合入本任务集成分支，6/6 AC具备证据，State标为resolved。不合入main。

### 来源与集成增量

- 固定来源为S=`54e482a6ccfa8ca1ccc7e9dc34b0bfaf27fb1616`中的源03；按`ca3adb86^..c0821fc4`抽取纠错闭包，包含`14893b7d`人工决定与迟到自动更新的原子修复。使用三方增量保留main已有接口，不重放整条S分支。
- M2原001–058字节保持；S原058改名为`059_memory_correction_protection.sql`，内容blob与固定S相同（`dfc597a54791d0942279ba11df2eccbf7d17a1cb`）。未接入后续事件字段或旧资料升级擦除hook，没有导入未交付模块。
- 纠错保护按完整规范消息、来源引用世代、实际窗口和人工决定复验；新来源引用不能冒充新消息。新消息保持待确认对照，未知语义不自动撤销人工判断。自动新版本及原自动版本失效同事务，重试不追随新人工叶。
- 删除覆盖纠错正文、完整快照、候选证明、相关追踪和恢复副本；仍有效消息需要防复活时仅留无正文`erased_guard`，最后有效来源删除后移除决定。联系人和owner范围继续分别隔离。
- 主动纠错、否决、确认和删除公开HTTP接缝及生产React控制器一起接通；未知提交和晚返回不回填旧比较。资料端点使用`Cache-Control: no-store`。main的Grounded默认提取器保持，新增组合夹具只替换模型标签；并发写入验证显式关闭维度门仅限该合成组，另有contact/self两例证明生产默认空门仍pending，不授予质量放行。

### 实际验证

全部Python命令先激活Conda `NotAlone`，显式`NOTALONE_DISABLE_DOTENV=1`，关闭LangChain/LangSmith外部追踪。公开HTTP夹具及迁移组自行新建随机库；相关持久化组由端侧`TASK_ISOLATED_RUNNER`新建`notalone_integration02_<UUID>_test`，显式设置两个数据库环境键、应用001–059，finally仅删除自有库并记录`ISOLATED_CLEANUP_CONFIRMED`。没有读取业务`.env`或连接S原库。

| 最终不重叠测试组 | 实际结果 |
| --- | --- |
| 离线全unit | 1329/1329，0跳过，13.454秒 |
| 纠错公开HTTP | 45/45，0跳过，42.197秒 |
| Grounded生产装配与纠错组合 | 10/10，0跳过，26.345秒 |
| 来源/纠错/维度/记忆存储/提取追踪/记忆API相关7模块 | 107/107，0跳过，13.395秒 |
| 035审计基线与真实账本/记忆时间/来源处理3模块 | 62/62，0跳过，24.755秒 |
| 迁移命令（含canonical059） | 13/13，0跳过，6.745秒 |
| 生产资料控制器 | 8/8，0跳过 |
| 生产React页面 | 纠错1流程、编辑12场景、读取9场景分轮通过；每轮单个无头Chrome、隔离HTTP/PG，最终`cleanupConfirmed=true` |

离线全unit、公开HTTP/PG及迁移的命令分别为：

```sh
# backend目录，已激活NotAlone；PYTHONPATH=src:..用于全unit。
python -m unittest discover -s tests/unit -t . -v
python -m unittest tests.integration.server.test_memory_correction_protection -v
python -m unittest tests.integration.server.test_memory_correction_grounded -v
python -m unittest tests.integration.persistence.test_database_migrations -v
python "$TASK_ISOLATED_RUNNER" \
  tests.integration.persistence.test_postgres_memory_store \
  tests.integration.persistence.test_postgres_owner_memory \
  tests.integration.persistence.test_source_deletion \
  tests.integration.persistence.test_dimension_evidence \
  tests.integration.persistence.test_dimension_evidence_v2 \
  tests.integration.memory_extraction.test_extraction_trace \
  tests.integration.server.test_memory_api
python "$TASK_ISOLATED_RUNNER" \
  tests.integration.persistence.test_database_adoption \
  tests.integration.persistence.test_memory_timing \
  tests.integration.ingest.test_source_processing_trace

# desktop目录
node --test tests/memory-correction/controller.test.mjs
npm run test:pages -- --case memory-correction-protection --timeout-seconds 180
npm run test:pages -- --case memory-editing-full --case memory-reading-full --timeout-seconds 180
npm run test:pages -- --case memory-reading-full --timeout-seconds 180
```

新迁移组实际覆盖全量安装、M2的058前缀前向、幂等、059文件失败回滚恢复、DDL约束及合成S058分叉拒绝；没有改写loader、035审计基线或实际账本。所有原001–058的Git差异为空。受影响生产源码和纠错页面依赖图的TypeScript检查通过；完整`npm run typecheck`受固定M2缺失`tests/observation-measurements-fixture`阻断，另有该缺失导致的两项隐式any，主Agent已独立复现。此项不计通过，由集成侧记录处理。

### 原失败与恢复

- HTTP tracer RED：M2人工纠正后，相同旧消息改写仍pending，1失败；集成后同例1/1，随后45/45。
- 控制器tracer RED：新证据的`correctionReview`丢失，1失败；接通当前读取/确认后8/8，覆盖迟到读取、未知提交、跨联系人来源事件及删除。
- 首轮相关107例为6失败/3错误，保留原记录；相同组因一次补丁命令路径错误未实际应用而重复同样失败，不计通过。复用固定源03已有测试合同修订：旧正文指纹改为无正文墓碑、删除须使用当前确切版本、范围过滤夹具用独立证据、旧NULL快照不回填、原子失效故障接缝及完整参与来源删除。修订后的同组107/107，运行时代码未为旧断言放宽。
- 035/时间/来源处理首轮62例为2失败/1错误：历史期望停在055、实际DDL同伴退出前先触发writer守卫，以及旧NULL候选确认。按源03修订并保留M058+新增059；对本例DDL确切PID与随机库名有界等待退出，仍由原正式守卫及目录复核拒绝漂移。最终62/62；无运行时守卫改动，正常夹具本轮均一次成功。
- 初期路径错误和私有runner缺少backend测试模块路径造成的ImportError，以及新Grounded夹具缺少`time`导入，只作为夹具修正记录，不计有效红绿或通过数量。

- 扩展旧页面先后暴露夹具未携完整人工决定标识、删除后乐观隐藏被误作提交完成、旧比较被误期望原样保留、同证据三主体候选被误期望逐条否决、主动录入被误标成聊天来源，以及新增比较引用使全局定位不再唯一。逐项按公开合同修订合成准备与断言，不改运行时迁就旧期望；最终编辑12场景、读取9场景分别完整通过，不把前序部分通过累加成整组。一次准备失败保留了未确认租约；核对夹具异常清库路径、自有runner和进程已退场后，仅按精确租约ID释放。最终租约`absent`，本机`notalone_contact_session_<UUID>_test`剩余数为0，没有清理未知库或进程。
- 首次提交暂存检查报告截取源测试多余EOF空行，已在收尾提交移除；最终差异检查重新执行。公开历史检查使用`NOTALONE_PUBLICATION_ENV_FILE=/dev/null`，首次结果为0问题，未读取业务凭据。

### 数据影响与边界

新增纠错表和候选快照只在本轮新合成库实际迁移；没有迁移或清理业务资料、S分叉库、其他会话文件或资源。未启动Electron、真实App、微信、探针、独立Worker进程或长期后台服务；有限HTTP/TaskHost线程仅在自有夹具生命周期内运行并清理。没有真实模型调用、维度放行、push、PR、部署或main合并。真实语义质量、原生App/微信和业务升级仍未验。后续由主Agent完成两轴审查与最终状态更新。

### 集成基底与审查交接

代码候选提交为`fd2cc0263f1257c8a201b1d52618b13359154fc6`；随后收尾仅补证据及删除多余EOF空行。最终复核发现共享main由其他工作推进到`e47ad39657844019226b42cc40b269c08c27014b`，本票仍按已冻结M2=`08c4d48e719353492f37620f4fb2aabd8710efc6`实施，不自动重基或纳入新main。已向主Agent报告漂移；不把该引用变化记成自己的main改动。

- 集成签收：固定候选`1873defb`两轴均0项发现；合入前`git diff --cached --check`与完整`npm run typecheck`通过。原M2类型检查缺口已由独立基底修复，本票原失败记录保留；组合回归另在集成记录中报告。主集成仅更新本票状态及索引，没有访问S库、真实业务库、桌面或其他会话资源。
