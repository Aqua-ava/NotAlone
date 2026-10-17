# 04：集成合法历史回复与明确继续

Triage: ready-for-agent
State: resolved
Type: task
Blocked by: 01, 02
Source unit: U4 / S源票04

## 交付行为

用户仍能查看合法旧候选和编辑，知道依据变化，并明确继续重新生成；真实删除优先清除正文，main准备、退出和重试不会绕过当前复验。

## 范围与兼容

- 区分历史合法依赖与当前新依据，沿原候选/版本/会话及writer接入，不建第二条回复链。
- 扩展本票准备值对象、依赖分组和版本识别；为09提供仍合法历史的依赖验证合同。

## 依赖说明

01提供时间/格式及旧任务处理，02提供人工决定保护；无新DDL，不等待03事件质量资格。

## 验收标准

- [x] 修正/替代/否决/时效变化显示无正文basis_changes；原快照缺版本/时间保持未知，仍合法历史及用户编辑可看可选。
- [x] 来源或记忆真实删除清候选、编辑、携入输入、固定快照与恢复副本；不能借历史模式留存应删正文。
- [x] 用户明确继续/重试时重查当前依据，保留意图和编辑；读取、恢复及刷新不自动生成或选择最新候选。
- [x] prepare→execute→writer中历史/当前依据分组保持；当前新依据仍要求当前有效，不能全局放宽依赖验证。
- [x] 修正/删除前后提交、退出、旧格式回执、迟到及同键重试覆盖原attempt归属；公开普通回复入口与助手入口均复验。
- [x] 公开HTTP/PG、版本传输、React提醒及main生成生命周期回归和两轴审查完成；历史来源接口可供后续学习复用。

## 验证入口

沿用historical reply basis、candidate versions/transport、assistant generation lifecycle和退出HTTP组；新增固定上下文内合法历史与当前修订变化反例。

实施时读取[规格](../spec.md)、[任务图](../planning.md)、[冻结增量](../refreeze-v2.md)、[验证矩阵](../validation-matrix.md)及[来源签收证据](../acceptance-evidence.md)，再按仓库规则/领域路由读取当前约束。来源源码和原票状态一律用固定S核验，不把准备树内的旧源票状态当成当前交付。

## 执行边界

用户已明确继续实施；本票已在独立集成工作树完成独立审查与组合签收，State 为 resolved。S 分叉库保持原样。本票不包含合入 main、业务迁移、push/PR 或部署。

## Comments

- 2026-10-15：按已确认推荐方案发布；未领取、未执行。

## Answer

2026-10-16：固定候选 `df553fcc7c3eb1fd3d65e3fb4c68ceef10985121` 经两轴增量与03／04组合复审均0发现后，以 `e9d9dd6c9ff619db81ccb2e8b366ba2ae273e12e` 无冲突合入本任务独立集成分支，6/6 AC签收，State 为 resolved。以下保留实施原始失败和恢复；最新汇总见[04集成记录](../frontier-04-validation.md)。

- 定向移植 `2b5e0a76→c0ae2c1a` 的合法历史读取、无正文 `basis_changes`、明确继续和提交前复验；未带入事件DDL或后续Skill字段。历史证据允许仍合法的修正／否决／过期版本，当前生成资料继续按实际版本、来源、正文与时间严格核验。
- main 的 prepare 分别核验当前与历史两组，将删除依赖并集留在原 turn；固定 `continuation_basis`、讨论变化与指纹经严格 codec 往返。`version=2`、`schema_revision=2`，旧修订明确重新准备，外部命令只接受既有 `GenerateReply`／`ContinuationGenerateReply`；绑定、候选、scope、request key 不得替换。旧格式 completed 回执可在记忆修正后按原 attempt 可靠读取，running／未知终态仍沿01原规则处理。
- 前端保留 main 的异步 onPrepared、独立任务归属、原编辑和输入恢复；权威读取只更新变化提醒，不自动生成或选新候选。真实来源删除沿原闭包清候选、版本、携入、输入与 prepared JSON，隐藏联系人恢复也复验。

已实际验证：

- 首个公开 HTTP 红例为修正后旧候选错误变成 `unavailable`，定向实现后通过；严格冻结新增值对象编码原先拒绝，白名单及类型／身份合同补齐后 codec 3/3。显式 continue prepare 又复现 current／history 混验以及 `ContinuationGenerateReply` exact type 拒绝，已修复并经公开重启反例验证。
- `PYTHONPATH=.:src:.. python /tmp/notalone-ticket04-run.py tests.integration.server.test_historical_reply_basis tests.integration.server.test_assistant_generation_prepare tests.integration.server.test_assistant_generation_replacement tests.integration.server.test_assistant_generation_lifecycle -v`：69/69、0 skip、82.748 秒，随机自有库 `na04_84a011e716ff4f52_test` 已核销。包含21项历史与冻结反例、原 prepare／旧格式／退出／替换归属。删除在任何 GET 前已 `prepared_context=NULL`；准备后二次修正拒绝且零新模型调用。
- `NOTALONE_DISABLE_DOTENV=1 NOTALONE_ENV_FILE=/dev/null PYTHONPATH=src:.. python -m unittest discover -s tests/unit -t . -q`：1332/1332；`npm run typecheck` 通过；`node --test tests/historical-reply-basis.test.mjs` 15/15；Conda NotAlone 下 `node --test tests/historical-reply-basis-http.test.mjs` 3/3，各自随机 HTTP/PG 夹具均报告 exact owned database remaining=0。
- 根协调独占窗口后执行 `npm run test:pages -- --case historical-reply-basis --timeout-seconds 180`：2场景通过、单 Chrome、cleanupConfirmed=true、Electron=false、nativeAcceptance=false；之后 App／headless 两租约均 absent，已交还根。没有启动实际 App、微信或原生探针。
- 扩大 main 业务 Node 五文件组首次83项为49通过／34失败；34项均由退出夹具仍硬编码58迁移在业务前拒绝。已定向调整 `assistant-generation-ownership.py` 为严格001–059与count59，精确原失败组复验继续进行，不能把首次失败抹成全绿。
- 过程中的两次 cwd／PYTHONPATH 命令设置错误在导入或迁移目录门禁前失败，只清理自己的空随机库；一次源码 helper 合并遗漏导致2项 AttributeError，恢复原 `_source_deletion_order` 后已在上述69项整组通过。未连接共享默认库、业务库或S分叉库。

剩余：修复后的两轴独立复审与组合签收；相关自动回归结论见下方补记。源04 mixed owner手录根→聊天apply-update 在03签收后经正式组合恢复并通过，原人工修正链和同owner另一联系人真实来源删除反例继续保留。所有模型均为脚本化合成，不能据此认证真实语义质量或渠道集成。

## 执行补记

- 2026-10-16：依据用户“继续继续”进入实现；独立分支 `codex/integration-04`，同步根记录 `3e6ac12b`，固定产品基础仍M2，未吸收后续 main。


### 后续相关回归与修复（2026-10-16）

- main 五文件组首次83项49通过／34失败，34项均在退出所有权夹具旧58迁移守卫处提前失败。精确改为001–059/count59后，原退出文件完整42/42、0skip、159.212秒（包含34原失败与8原已过）；另4文件的41项此前通过，形成83个唯一方法分阶段通过，不宣称83项单轮。
- 9模块PG相关组首次93项为85通过、5fail／3error。`style_sample_store` 适配时误向纯祖先ID查询传入 `historical`，已移除（历史核验参数保留在真实门禁）；退出迁移测试尾序已校准M058prepared＋059correction。原3模块24/24恢复，覆盖全部8个原失败目标；其他已过69项不重复加总。
- HTTP3/3又一完整轮通过：联系人A→B→A在A修正期间保留B草稿，回A恢复未保存编辑并从权威turn恢复新basisChanges；原候选、选定版本与明确继续均保留。同owner另一联系人来源的历史prepare→正式装配重启execute 1/1通过。
- 旧退出失败目录的资源核销仍按原PID和私有marker逐个核对，不以源码finally代替实际观察；完成后再记录。版本／携入／样本6模块相关组进行中。


### Standards 独立审查修复（2026-10-16）

固定候选 `e7c528c5` 的 Standards 审查：硬违规0，possible smell1（P3）。历史讨论可用性函数内部始终使用历史合法门禁，外露的 `historical` 参数和调用分支没有实际作用，已定向移除两层冗余参数及传参。`current=True` 的当前讨论CAS、当前证据版本／正文／来源／时间复验均保留。公开修正后合法历史继续、当前时效提交拒绝、普通回复contact/owner当前记忆CAS、CURRENT变化后的保存拒绝与历史回读4/4通过；无新DDL。


### 最终相关自动验证补记（2026-10-16，待独立审查签收）

- 版本／携入／样本6模块131项首轮130通过、1个方法的pending子场景失败：旧夹具绕过 `PostgresMemoryStore.create_candidate` 直接插入NULL来源代际的候选，被02既有保护正确排除。对齐固定S已采用的公开建候选夹具合同后，原方法三类资料1/1恢复。131个唯一方法分阶段通过，不称单轮全绿，产品来源门禁未放宽。
- 退出所有权夹具现在在建库前落盘私有 `database-ownership.json`，复用已有Core接口；最小公开退出回归1/1通过。这仅防止后续丢失库身份，不为旧轮次回填UUID。
- 最终 `npm run typecheck`、`git diff --check` 与公开历史检查均通过。后端001–059迁移和三个Grounded生产默认没有修改；无真实模型、App、微信、原生探针、业务迁移、S库连接、push或PR。

**资源核销的实际范围：** 有限页面报告 cleanupConfirmed=true，双租约随后 absent；正常HTTP／PG组逐库确认删除；本票全部 `na04_<16hex>_test` 命名库经只读pg_database聚合确认为空。35个早期ready失败目录（原34＋独立TAP1）各自private marker显示exit1、库名未记录，35个childPid均已不存在；但全类Core测试库namespace仍非空，不能认证这35轮数据库均无残留，因此原目录继续保留，不连接或删除未知库，也不以源码finally推断代替实际观察。两个独立debug夹具已报告database_remaining=false，再按各自精确库名复核缺席后清理自有私有目录。此缺口单列保留，不能总称资源已全部清理。

### Spec 审查定向修复（2026-10-16）

历史可用性接口收窄后，嵌套祖先测试 wrapper 仍透传已移除的 `historical`，原反例确认1项 TypeError；仅修复 wrapper 的旧参数与透传后，依赖模块19/19通过，包含共享祖先去重成功和同连接删除样本后重新拒绝两分支。两轮自有随机库均已逐名确认删除。已核实际接口调用，产品当前证据门禁没有放宽。完成回读的提醒时序问题仍待独立修复和复审，State 保持 claimed。

完成回读P2已单独修复：普通生成、同键completed重放、明确继续在writer完成后暂扣POST响应，再公开修正记忆并确认GET已显示 `memory_revised`，放行响应后三个红例均从缺失提醒恢复。控制器改用经过原request/input/reply身份核验的completed提醒，并以较晚已接受快照优先；同键只刷新无正文提醒，保留当前编辑与选择。完整公开历史HTTP6/6、0skip、24.962秒；历史纯控制器与联系人独立作业归属30/30、0skip、64.674秒；typecheck与diffcheck通过。SSR沿既有fixture临时提供window并finally恢复，未加入产品global。03／060组合与原mixed apply-update仍待下一步同步，独立两轴复审未签收。

### 同步已签收03／060后的组合验证（2026-10-16）

在P2独立候选 `5f50fa8e` 固定后，合并根 `5bf3d3ac`。03事件、原子版本与060均来自已签收根，不能视作04新增实现。冲突处保留04历史合法门禁及03手录版本来源链；样本来源同时使用捕获正文复验和历史模式；两个有限页面入口同时保留。退出／预算既有夹具及历史新夹具均按正式001–060/count60严格核验，退出迁移尾序保留058prepared、059correction并追加060，没有放宽为下界。001–059字节与根一致，060字节与固定S059一致；codec仍为version2/schema_revision2。

- 后端历史公开HTTP、中央讨论依赖、退出迁移与样本4模块同轮56/56、0skip、45.067秒，精确随机库 `na04_232ec15d3369476e_test` 已删后确认缺席。包括原mixed手录根→公开SELF候选apply-update→继续→真实来源删除：仅混合新版本与其候选被擦除，合法旧根与旧候选保留；原人工修正和同owner另一联系人来源prepare→重启execute反例也继续通过。
- 完整单元1337/1337、14.189秒；历史Node与HTTP同轮21/21、0skip、23.224秒，六个HTTP夹具报告exact owned database remaining=0。正式060最小退出1/1（模型0次，instance/class清理成功、database_remaining=false）；060预算联系人排队归属1/1（模型2次、repeat0、owned database remaining=0）。
- typecheck、diffcheck通过；本轮没有重新启动页面，结束仅只读检查App／headless两租约均absent。早期35个库身份未记录的失败目录继续保留，前述未知残留归属缺口不因本轮成功而消失。State继续claimed，等待独立复审与根组合签收。

### 独立复审与本批签收（2026-10-16）

- 初轮Standards硬违规0、possible smell 1（P3）已由 `f26d3b0c` 移除冗余历史参数；Spec两项P2分别由 `5d3eeb9b` 修复嵌套测试旧参数、`5f50fa8e` 修复完成回读丢失依据提醒。两个独立增量复审均确认0发现。
- 同步已签收03后的 `5bf3d3ac→df553fcc` 组合复审覆盖11个显式共同修改文件及8个自动合并共同路径；Standards硬违规0、possible issue 0，Spec 0发现。03事件、手录来源与捕获正文复验，以及04历史合法门禁、严格当前writer与codec2/schema2均保留。
- merger实际复验TypeScript、Git差异、候选产品/测试字节一致性、正式001–060迁移及严格夹具、退出迁移尾序、codec与两页面入口注册，均通过；没有重跑数据库、HTTP、unit或页面。合并最小静态检查首轮因检查脚本误认历史夹具局部变量而失败，修正检查脚本为实际 `applied`／直接 `migrate` 合同后通过，仓库产品与夹具没有因此修改。
- 35个早期失败目录未记录库身份，虽然childPid全部退出，Core测试库namespace仍非空，数据库残留及归属未认证，原目录继续保留。03默认库隔离事故是另一件事，原152项／65错误／1跳过与身份、并发影响未知继续单列；不能概括为全程只用自有库或全部资源已清。新建库前ownership marker只防后续丢失，不倒填旧UUID。

### 后续资源证据校准（2026-10-16）

原执行报告35次失败中，34个目录由保存的扩大组日志独立定位；另1仅从执行上下文恢复报告路径及现存无库名标记，原TAP到目录的关联未恢复。原35个PID逐项核销缺乏完整落盘清单，独立审计仅复核34个标记PID不存在。可恢复精确库名为0，数据库无残留仍未认证；保留原目录、不连接或清理未知库。以[资源证据缺口](../reports/fixture-ownership-evidence-gap.md)为当前可证范围，不据新保护或成功轮次追认旧清理。

继续追查原始工具输出后，已恢复第35次独立TAP的确切命令、时间和目录关联；该1方法原结果仍为0通过/1失败/0跳过。当前按35个精确目录重查均为私有无库名标记、原childPid不存在，35个目录的本轮归属缺口已补足。精确数据库UUID仍为0，旧库是否残留未认证，未知库与原目录均未清理。原35项检查的Python曾在namespace非空断言失败，shell末尾exit0不能作为清理通过证据；新增证据与摘要见上述报告。
