# 11：候选编辑、选择与版本回看

State: resolved
Triage: ready-for-agent
Blocked by: [assistant-session-context/07 默认会话的一次生成与可靠保存](07-default-session-persistence.md)

拆分标识：C05（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧02；Q11、Q12。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。原依赖关系保留；本票自动验收范围已完成，实际证据及未执行的原生范围见 Answer。

## What to build

用户选择和编辑候选，保存修改前后及选择关系；主界面展示新版，可展开旧版并重新选取。

## Acceptance criteria

- [x] 候选选择和编辑通过公开入口保存，重读显示新版并可展开、重新选择旧版；修改前后和对应要求可追溯。
- [x] 区分默认展示与用户明确选择：未点击不能记录为用户已选；实际选择不是发送或长期偏好。
- [x] 先以明确候选ID操作，保持会话、候选组、版本身份；不把生成时间或数组位置当持久身份。
- [x] 派生版本保留来源依赖，删除后旧版本及恢复副本不可得；自然语言编号解析由C06完成。
- [x] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [x] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

先使用明确点击的候选ID；保存与公开再读取一致，派生版本随来源删除；不在本票实现自然语言编号指代。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

2026-10-11 本主树上述五文件最终独立两轴：Standards硬要求0／重要Fowler可能气味0、Spec新增P0–P2为0。审查检查唯一选择权威与原物理删除断言；27项实际运行结果由总协调单独取得，未将静态审查当成运行验收。

2026-10-11 总协调主树精确消费 A a035 的 handler／HTTP 两文件及 C 549 的版本公开组合测试净增，不重复已集成 A10／A11 store。隔离 runner 真实联跑 `tests.integration.server.test_assistant_candidate_versions`、`tests.integration.persistence.test_assistant_candidate_versions`、`tests.integration.server.test_authentic_expression_candidate_versions`：27 GREEN／43.636秒、skip0＝9版本HTTP＋16持久化／迁移＋2C删除HTTP。正式001–053、052→053与重复0均核验，HTTP／两个schema库／外层随机库精确剩余0；handler mypy1、三文件compile及diff通过。C两例各一次受控模型与旧入口拒绝／物理清理断言均保留；本轮未运行UI／App／外部模型，不据此关闭桌面或人工剩余。

### 总协调正式基础集成复验（2026-10-11）

主树原样接入正式 `6c5d26e965fdfa28dbb69048c9cbdf01a9c0b0ff` 后，实际生产001–053空库、052升级及重复迁移均通过；16项测试中15项通过，删除级联1项在 `PostgresAssistantSessionStore.delete` 处出现接口缺失错误（3.244s），自有随机数据库全部清理，remaining=0。该方法属于尚未正式交付的A09后端，本次不复制working实现、不移除或放宽原断言。A11存储基础的Standards hard0／新增重要smell0，Spec实现0、集成依赖缺口1；本票继续claimed，待正式A09接入后复跑完整16及公开HTTP／页面，不将15项基础通过写成删除组合通过。负责人自树的16项GREEN与这次主树缺前置结果分别保留。

2026-10-11：用户认可30票复审修订后发布；表达样本独立保留规则已单独确认。尚未开始实现或执行产品验收。

2026-10-11：领取第11票，当前仅准备公开HTTP失败证据、消息组版本接口和053停放迁移。现行07及B候选消息组主题是前置事实；051输入升级和052正式连续迁移尚待总协调接入，未完成本票或页面验收。准备阶段不改共享应用、原有存储和桌面文件，不自行提交。

## Answer

2026-10-11：准备阶段冻结，State保持claimed；本票尚未完成。仅有真实公开入口缺失的RED及接口/迁移准备稿，没有版本存储GREEN、公开页面验收或实际App证据。正式051→052前缀、共享接线及053正式消费由总协调继续串联。

### 身份与版本契约

- `candidate_id`是整份备选方案及其消息组的稳定身份；`candidate_group_id`投影既有`reply_request_id`，表示本轮备选方案组。`candidate_number`从该请求保存的`ordinal + 1`展示，不作为持久操作身份。用户操作始终提交UUID。
- 原版`version_number=0`，`version_id=candidate_id`，只持候选引用；不复制B的`reply_candidate.message_group`、原文或依据。原版的`parent_version_id`、`edit_key`、消息组副本和`requirements`均为空。可在有效范围重读时幂等建立这一无正文引用，不能因此记为用户已选。
- 编辑版使用独立UUID，序号在同一候选下递增；必须明确`parent_version_id`，可从旧版继续编辑。完整保存原组的每条`message_id`和原顺序，仅替换文字；第一版不增删或重排消息。组内条数、大小与聚合正文继续按正式B契约核验，不另建消息身份规则。
- 对应要求只保存本次用户明确提供的`requirements`，缺失为null；不捏造要求，不变为长期偏好。默认展示取最新版本，`default_display_version_id`与用户最后点击的`selected_version_id`分别返回；编辑、展示、复制和同步均不隐式选择。
- 选择记录有独立UUID和会话内递增次序。只接受用户明确提交的`candidate_id + version_id`，可重新选旧版；选择不代表发送、采用关系事实或主动保存表达样本。

### 最小公开接口提议（总协调已认可方向）

基础路径为`/api/contacts/{contact_id}/assistant-sessions/{session_id}`，owner仍来自服务端已验证运行身份。

| 操作 | 请求 | 公开结果 |
| --- | --- | --- |
| 查看原版与修改记录 | `GET /candidates/{candidate_id}/versions` | 会话/turn/候选/候选组身份、展示序号、默认展示UUID、可空的实际选择UUID、完整有序版本列表及对应要求 |
| 保存编辑 | `POST /candidates/{candidate_id}/versions`：`edit_key`、`parent_version_id`、完整`messages:[{message_id,text}]`；`requirements`可空 | 保存后的同一候选版本历史；同编辑键同内容重放，异内容409，不触发模型 |
| 实际选择 | `POST /selections`：`selection_key`、`candidate_id`、`version_id` | 明确选择记录的UUID、次序及候选/版本UUID；同键同选择重放，异选择409，不触发模型 |

错误提议：结构/UUID/长度无效返回400 `assistant_candidate_version_request_invalid`；不属于owner/contact/session的候选、父版或所选版返回404 `not_found`；来源失效、请求已失效、整组身份改变及幂等键异内容返回409 `assistant_candidate_version_conflict`，reason分别使用稳定类别`source_unavailable`、`request_invalidated`、`message_group_mismatch`、`edit_key_conflict`、`selection_key_conflict`。读取或提交故障返回503，不回显正文、要求、SQL或驱动异常，不把失败提交宣称为可恢复。

### 持久化与删除准备

- `backend/database/pending/053_assistant_candidate_versions.sql`不在正式迁移扫描目录。准备两张表：`assistant_candidate_version`保存上述父版/整组/要求，`assistant_candidate_selection`只保存明确选择身份与次序。版本的候选、turn、session及父版均用范围外键绑定；选择引用同范围的确切版本。
- 原版候选外键使用cascade，删除原候选即可清除全部版本、要求与选择副本；session和turn删除也级联。不外键或复制独立表达样本，不改变ADR-044。SQL检查编辑整组沿用B函数，逐条UUID与顺序必须等于原组，并核验有效turn与请求成员关系。
- `backend/src/notalone/persistence/assistant_candidate_versions.py`当前只定义带类型的命令、历史、选择和错误契约，尚无PostgreSQL适配器或共享接线。后续每条读写均须在owner锁内复验candidate属于session已完成turn、A turn有效性及C的`require_reply_sources_current`实际捕获来源守卫；不能把后来挂接来源当作旧候选来源。请求失效或来源不再有效时拒绝，不能恢复旧版本。

### 真实RED、命令与未执行项

已运行前先激活Conda `NotAlone`，从`backend/`使用`NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src NOTALONE_TEST_DATABASE_URL='postgresql:///notalone_a_session_test?host=/tmp&port=55441' PGPORT=55441 PGHOST=/tmp LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false`。

```bash
python -m unittest tests.integration.server.test_assistant_candidate_versions -v
python -m compileall -q src/notalone/persistence/assistant_candidate_versions.py tests/integration/server/test_assistant_candidate_versions.py
```

- 新HTTP测试复用真实server builders、回复流程、来源守卫和业务存储，只替换外部模型。helper按当前扫描目录用生产迁移runner创建随机专属`_test`库；当前含尚未正式验收的051准备稿，不注入052或053，不作为正式前缀通过的证据。
- 先通过公开默认会话和生成入口保存真实候选，模型调用数断言为1；读取版本路径得到404 `{"error":"not_found"}`，期望200，1 test / 0.985s，真实RED。新增调用数断言并补查专属库清理后重跑为1 test / 0.966s，同一404 RED；`owned_database_remaining=0`。退出码1是预期功能未实现，不是通过。
- 第一次受限环境在本地PG socket遭拒，0 tests；随后仅对已授权的本地55441隔离PG/回环HTTP升级重跑。未触碰业务库，没有假造迁移消除前置。
- `compileall`及当前任务已跟踪文件的`git diff --check`通过。053未执行，没有SQL行为GREEN；公开编辑、选择、重读恢复、来源删除、范围、幂等及页面仍待正式前缀后逐片RED→GREEN。
- 当前精确文件范围冻结为本票、053 pending、新持久化契约及新HTTP测试四份。没有修改共享app/store/service/reply/runtime/desktop/registry，没有自行commit、push、页面测试、App、微信/OCR、私人数据、外部模型或19验收。

### phase2：独立PostgreSQL适配器（未接公开入口）

2026-10-11：正式051/052及B原消息组接口已接入当前树；本票仍claimed。上述初冻结的“仅类型契约”已由真实适配器替代，新增一份独立PG测试。053仍位于pending，未消费为正式迁移；本阶段的真实临时升级验证不等于正式SQL、HTTP或页面交付完成。

- `PostgresAssistantCandidateVersions`实现`read/edit/select/selected`。同connection辅助入口为`read_candidate_versions`、`edit_candidate_version`、`select_candidate_version`和`read_candidate_selection`，供后续共享应用复用既有事务；所有路径在同owner锁内核验scope/session、候选确属已完成turn、回复完成且未被invalidated、A已捕获依赖及C的实际`require_reply_sources_current`。不另造原始来源记录，不从当前消息补推旧来源。
- 原版0幂等建立无正文引用，从B权威组读取有序消息；编辑保留完整原组逐条UUID及顺序，明确同组父版本，只新增版本并保存用户本次要求。旧父版可另开版本分支；同edit_key同内容重放，不新增记录或回退默认展示，异内容冲突。没有模型调用、外部发送或样本自动保存。
- 选择事件身份、次序、候选及版本保持不变。相对初冻结的053，只增加`assistant_candidate_selection.is_current boolean NOT NULL DEFAULT TRUE`、owner/contact/session范围内`WHERE is_current`唯一索引及注释。新明确选择在同事务把旧current置false，再新增事件；旧selection_key重放只返回原receipt，不倒转当前指针。删除当前B后current为空，历史A不自动复活；用户用新键重新选A才成为当前选择。
- 两张新增表继续沿candidate/turn/session及同组父版的范围外键cascade。实际原始来源删除及既有A9公开会话删除清除版本、要求和选择，旧UUID不可重读或重选；独立原始来源不因会话删除消失。先前的body、选择和版本副本不能绕过guard恢复。

真实PG切片逐项证据（验证入口为上述公开持久化合同；不替代HTTP/页面）：

| 行为 | 实际结果 |
| --- | --- |
| 原版读取/重开及无隐式选择 | adapter缺失RED，最小实现后GREEN |
| 完整消息组编辑、父版、要求及重开 | edit缺失RED，实现后GREEN |
| 明确选择旧版、新版及旧键重放 | select缺失RED，实现后GREEN |
| A→B→实际来源删除B→不回退A，显式新键重选A | 回归GREEN；删除后原旧选择键也不复活current |
| 跨owner/contact/session、候选组、父版或所选版本及选择键异内容 | 回归GREEN，404或稳定冲突，原选择保持 |
| 来源delete_requested、当时原始快照缺失、failed turn及invalidated request | 回归GREEN，读取/编辑/选择/重放拒绝，不复制或推断旧正文 |
| 旧父版分支、异内容复用edit_key、组内重排/缺项/重复/未知UUID | 回归GREEN，保留已有历史与默认展示 |
| 实际PG选择insert失败 | 回归GREEN，原current原子回滚，公开错误不回显SQL或正文 |
| 并发同编辑键及不同键 | 回归GREEN，同键只有一版，不同键次序唯一 |
| A9公开会话删除后旧版本/选择不可恢复、原始来源仍可独立删除 | 回归GREEN；不是9页面或原生验收 |
| B单句65536、多句8192及非空/要求长度边界 | 回归GREEN |

从`backend/`激活NotAlone后实际运行：

```bash
NOTALONE_DISABLE_DOTENV=1 PYTHONPATH=src PGHOST=/tmp PGPORT=55441 LANGSMITH_TRACING=false LANGCHAIN_TRACING_V2=false python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.persistence.test_assistant_candidate_versions
python -m compileall -q src/notalone/persistence/assistant_candidate_versions.py tests/integration/persistence/test_assistant_candidate_versions.py tests/integration/server/test_assistant_candidate_versions.py
```

- 最终14 tests / 1.529s，OK。协调脚本只创建本次随机专属`_test`库，先以生产runner安装实际001–052；新增PG测试复制同一真实前缀和真实pending053到临时目录，再用生产runner升级，实际`applied=['053_assistant_candidate_versions.sql']`、重复`applied=[]`，没有直接执行DDL补造缺失迁移或空占位。`owned database remaining=0`。
- 发生一次夹具安排失败：把来源状态误写成不存在的`pending_deletion`，数据库CHECK拒绝，随后依据005正式状态修正为`delete_requested`。这次不是业务RED；原始错误如实保留，最终同用例通过。
- 选择保存故障通过随机测试库的临时CHECK约束注入，观察公开存储调用失败和原current重读，不用该约束代替正式迁移。约束和合成owner随实际归属清理。
- 当前HTTP旧404用例保持，因12合成profile/fixture装配由总协调串行稳定，本阶段未重跑或改共享fixture。公开HTTP编辑、选择、重读投影、页面及两轴复审仍待下一槽；所有Acceptance criteria仍未据此预勾。
- 允许范围为本票、pending053、新版本适配器、新HTTP测试及新PG测试五份。未改共享app/service/AStore/reply/runtime/desktop/registry、12 support或corefixture；未stage/commit、未跑pages/npm test/App、没有微信/OCR、私人数据、外部模型或19验收。

### phase3a：053正式扫描与真实升级

2026-10-11：总协调分配A053正式槽后，将冻结SQL原样从`database/pending/`移入`backend/database/migrations/053_assistant_candidate_versions.sql`。136行正文未变，SHA-256仍为`38fea517ff30b782baf30799defc8da7f48e555635f057c40c2bffdb31cf129d`；001–052未改。测试此后仅消费正式扫描目录，不再拼接pending迁移。本票仍claimed，公开HTTP、页面及两轴尚未交付。

- 移动前先记录真实正式迁移RED：空库实际仅安装52项，期望53；实际001–052前缀后再跑正式目录得到`applied=[]`，期望053。2 tests / 0.928s，两项失败，专属库均回收。这证明正式扫描缺口，未用pending注入消除RED。
- 原样移入正式目录后，以同一生产runner在新随机空库安装实际001–053，重复返回`applied=[]`；另一新随机库先安装从正式文件复制的真实001–052原前缀，再对正式扫描升级，准确返回`['053_assistant_candidate_versions.sql']`，再次返回空。不是直接执行DDL或修改账本。
- 同正式前缀重新运行原14项PG适配器合同，保留全部来源、范围、明确选择、删除与并发回归；未修改适配器或猜测12预算值，未调用共享HTTP fixture。

实际命令保持上述NotAlone/禁dotenv/禁tracing/55441环境：

```bash
python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.persistence.test_assistant_candidate_versions
```

最终16 tests / 2.763s，OK（正式安装/升级2项 + 适配器14项）。输出明确为`installed=001–053, repeated=[]`、`installed=001–052, applied=[053], repeated=[]`；两个schema专属库与协调脚本专属库均`owned database remaining=0`。新增真实迁移验收与公开接口接线是不同证据，本阶段只确认正式schema及独立适配器。

本阶段仅移动自己的053、更新自己的PG测试与本票记录。没有改app/service/AStore/desktop共享文件，没有stage/commit、pages/native或业务库迁移；HTTP公共槽仍由总协调随后分配。

phase3a 提交前主 Agent 复验：同一正式生产 runner、空库／052 升级／重复执行及 14 项业务适配器回归共 16 项 GREEN／3.068 秒，所有专属测试库残留 0。限定四文件的双轴审查完成：Standards 硬要求 0、低风险判断性气味 1；Spec 0。重复的范围／候选／原版准备守卫保持各入口显式执行，暂不扩大为无关重构。正式迁移与同连接存储 API 作为独立主题提交，供完整讨论及后续 13 消费；该切片不等于公开 HTTP／页面交付，本票仍 claimed，所有原验收标准保持。自动部分继续实施，人工部分未执行。

### phase3b：公开HTTP版本与选择切片（桌面尚未接线）

2026-10-11：新增`server/assistant_candidate_versions.py`，公开上述`GET/POST /candidates/{candidate_id}/versions`与`POST /selections`。主Agent在共享`app.py`只注入既有版本Protocol/正式PostgreSQL适配器，并把对应路径分发到新handler；本票实现者未改共享应用、service、store、runtime或桌面文件。本票仍claimed，原验收框仍保持，页面与完整本票两轴/提交尚待总协调。

- handler只解析严格JSON/UUID、调用唯一`PostgresAssistantCandidateVersions.read/edit/select`并投影其类型结果。owner来自已验证宿主，路径给出contact/session；请求不能注入owner、消息次序或额外候选正文权威。原版继续从B权威组读取，完整版本消息UUID/order及父版/要求来自正式适配器；没有新来源权威或选择指针。
- 版本历史分别返回`default_display_version_id`与`selected_version_id`。选择返回原有receipt的`selection_id/selection_number/session_id/candidate_id/version_id`，不表示发送或长期偏好。修改和重新连接不会新增模型调用；同键重放不新增版/选择、不倒转较新的实际选择，重新选旧版必须明确提交新操作键。
- 已知路径不支持的方法返回405。无效结构/UUID/长度400、不在当前范围或删除后404、来源/请求/turn/整组与幂等键冲突409，reason沿用正式适配器；读写故障返回固定503 `assistant_candidate_version_save_failed`，不回显正文、要求、SQL或驱动异常。实际HTTP正常和错误响应均检查`Cache-Control: no-store`，未鉴权401。

本次逐片与回归证据：

| 行为 | 实际结果 |
| --- | --- |
| 已生成候选的原版读取、稳定身份及尚未选择 | 当前正式源码重新确认404 RED：1 test / 2.566s；主Agent接线后同用例GREEN：1 / 1.572s |
| 双条整组编辑、完整UUID/order、父版/要求、同键重放与新后端实例重读 | POST先405 RED：1 / 1.088s；最小edit接线后读取+编辑2 / 2.615s GREEN |
| 明确选择、编辑不改变原选择、旧key重放不倒current、异选择同key冲突、新key重新选旧版 | POST先405 RED：1 / 1.059s；最小select接线后前三片3 / 3.441s GREEN |
| 严格body、非法UUID、额外owner/字段、错误method、鉴权和no-store | 回归GREEN：1 / 1.667s；已有版本/选择不变、零额外模型 |
| 跨owner/contact/session、同会话其他候选的父版/所选版、整组ID和操作键冲突 | 回归GREEN：1 / 1.513s；原history/current不变、零额外模型；另一个会话仅为合成范围夹具，不消费第10票新开能力 |
| C实际来源pending→公开Worker真实删除，先A→B再删除B、A旧receipt不复活、新key明确重新选A | 回归GREEN：1 / 1.788s；pending读/编辑/选择/重放409，删除后B旧UUID404，新后端不含B候选/编辑/要求/原消息，A保留且当前选择先为空 |
| 实际PostgreSQL读取、编辑insert和选择insert故障及重试 | 回归GREEN：1 / 1.649s；自有库临时触发器注入真实异常，不替代迁移；版本与current原子回滚、固定503不泄漏SQL或正文，成功重试次序为2 |
| A turn不再completed及原请求已invalidated | 回归GREEN：1 / 1.945s；已保存编辑与选择的读取/重放均409，不恢复旧正文副本，零额外模型 |

两次合成夹具安排错误不作为业务RED：非法URI最初使用未转义中文，urllib在发出HTTP前拒绝（1 / 5.985s）；改为ASCII `invalid-uuid`后通过。来源候选夹具最初漏填既有`reply_to_message.direction`而生成400（1 / 1.002s）；读取正式parser后补入明确合成方向，再通过。各失败运行仍清理专属数据库。

从`backend/`激活Conda `NotAlone`，使用禁dotenv/禁tracing/`PYTHONPATH=src PGHOST=/tmp PGPORT=55441`环境实际运行：

```bash
python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a-session tests.integration.server.test_assistant_candidate_versions tests.integration.persistence.test_assistant_candidate_versions
python -m compileall -q src/notalone/server/assistant_candidate_versions.py tests/integration/server/test_assistant_candidate_versions.py
```

最终24 tests / 12.600s，OK（8公开HTTP + 正式迁移/独立适配器16）。生产runner仍实际安装001–053与重复空集，真实052→053准确升级后重复空集；HTTP内层库、两个schema内层库、coordinator外层库均`owned database remaining=0`。不是注入pending SQL、直接执行DDL补造前缀或业务库迁移。编译与任务文件空白检查通过；HTTP测试模型继承已声明的合成预算协议，生产builders显式注入该profile，不猜默认预算或绕过真实模型守卫。

数据影响限于本地真实版本/明确选择记录及同范围公开读取，新增正文仍受原候选、turn、session及C实际原始来源的守卫和删除级联。版本读写不调用模型、不自动发送、不采纳偏好或自动保存样本。本阶段精确改动范围是新server module、新HTTP测试与本票；共享app接线由主Agent管理，053/adapter/PG测试未改。未stage/commit/push，没有页面、App、微信/OCR、私人资料、外部模型或19验收，桌面新版展示/旧版展开/点击操作与人工部分均未执行。

phase3b正式切片提交前复核：仅正式d89584f导出加11四文件（不含14替换、12未正式consumer或桌面working），24项HTTP／PG／迁移全部GREEN／11.589秒，实际001–053、52→53及重复执行通过，自有库0。Standards初审硬0／判断性P3路由重复1，已把宿主与handler路径识别收至candidate_versions_path唯一函数；增量复核硬0／Fowler0、Spec原轴0，受影响8项HTTP再GREEN／8.307秒、库0，来源与完整整组断言未削弱。公开后台阶段完成，桌面编辑／选择／回看与页面仍继续，整票claimed；自动部分继续实施、人工部分未执行。

总协调主树精确消费正式 `daa443deac6bafddfb6ad704a7ce80bc710aba94` 四文件，保留既有 A／B／C 公共接线。在 Conda `NotAlone`、关闭 dotenv／追踪、`PYTHONPATH=src:.` 环境实际运行 `python /private/tmp/notalone-coordinator-isolated-tests.py /Users/local-user/learn/NotAlone tests.integration.server.test_assistant_candidate_versions tests.integration.persistence.test_assistant_candidate_versions`：24 项 GREEN／12.661 秒，正式 001–053、52→53 升级与 fresh 重复迁移通过，内外专属数据库均精确剩余 0。新增 handler 单文件 mypy、两文件 compileall 与差异检查通过；限定两轴审查无新问题。该证据只覆盖公开 HTTP 和存储，未运行本票新桌面页面。A 唯一负责通用版本／选择 ports、主进程／桥接 DTO 和会话回看；B08 复用同一权威实现策略候选组逐消息编辑／复制，不新增选择指针。本票继续 claimed，原验收标准和人工未执行记录保留。

phase3c 权威选择重读：同一 `/api/contacts/{contact_id}/assistant-sessions/{session_id}/selections` 新增 GET，响应 `{selection: receipt|null}`。只委托既有 `selected(scope, session_id)`，没有新增选择指针或从默认展示、逐候选标记推断选择。首项公开 405 RED／1.195 秒，四行接线后 1.592 秒 GREEN；扩展原八项加一项公开完整流程，共九项 GREEN／9.763 秒。空会话、原版与新版明确选择、旧 selection_key 回执重放、重新连接、来源失效与实际清除、turn／request 失效及会话删除均验证实际指针，不新增模型调用。原方法负例改用 DELETE，保留 405 断言；初始 socket 拒绝和三处合成安排修正不作业务 RED。

主 Agent 从正式 `5fad4327e3eb2d37f1c45bb46ce0b156c03a0cd0` 导出独立副本，只加入 handler 与 HTTP 测试两文件，排除其他未提交代码。实际 `PGPORT=55441 python /private/tmp/notalone-coordinator-isolated-tests.py /private/tmp/notalone-a11-selection-get-cut-4jkxdx1g/source tests.integration.server.test_assistant_candidate_versions` 九项 GREEN／9.999 秒，生产 001–053、HTTP 内层与 runner 外层自有数据库清理均剩余零。日志 `/private/tmp/notalone-a11-selection-get-fresh.log`。限定独立双轴 Standards 硬规范 0、Fowler 判断 0；Spec 0。桌面通用 DTO／RPC、来源删除后的 RAM 视图协调及历史页面继续实施，本票保持 claimed，人工部分未执行。

2026-10-11 通用桌面接口切片新增严格版本 DTO、唯一版本控制器及 Main／preload 四个 RPC：读取、保存整组编辑、明确选择、显示已有版本。默认展示新版不代表用户选择，明确选择始终从后端 GET selections 重读，旧操作回执不能倒退实际指针；消息 UUID 与次序、父版本、本次要求和展示编号均保留。保存与选择无模型调用，不将复制、自动第一项或临时编辑推断为持久选择。

新鲜审查先指出单候选来源失败仍在 Main 保留旧正文，补公开 RPC 回归后修复；第二轮独立审查又指出同一 raw 来源可能影响多个 turn，READ／SAVE／SELECT 各在 404 和 source_unavailable 两条路径共六个实际 RED，不能只清触发候选。现先隔离旧投影与正文动作，以同会话完整 GET 权威复验所有轮次、输入和版本；清理 actual redacted／unavailable／消失的记录，同时保留权威仍有效的独立讨论。中间事件不能发布尚未核验正文，GET 失败物理清空旧视图，旧 contact／SID／scope／connection／operation 的迟到复验不能清新视图。不新增正文恢复缓存。受控 generation 与独立结果的 waiting 收尾、重连接口的版本 scope 也有真实 RED→GREEN。

实际在 desktop cwd 运行 `node --test tests/assistant-candidate-versions.test.mjs tests/assistant-candidate-version-ports.test.mjs tests/assistant-session-catalog.test.mjs tests/assistant-session-catalog-read.test.mjs`：工作树和固定正式 1675 导出的独立 ONLY11 副本均 50／50 GREEN、类型检查 GREEN；主 Agent 重建冻结副本再得 50 GREEN／2.541 秒、`npm run typecheck` GREEN。五十项包含八项既有目录回归，不计作五十项新增版本测试。另加已经独立交付的 09 门禁四项，相关组合 46 GREEN／1.086 秒，未运行页面或真实 App。

本切片只正式交付通用 DTO／RPC、来源复验及测试与本票记录，历史展开、编辑／选择按钮和展示页面仍待；不能用纯 Node 回归替代公开页面→HTTP→PG 闭环。最终新鲜两轴审查与本地提交正在进行，原整票保持 claimed，自动部分继续、人工部分未执行；未触及 B RewritePanel 业务、C 样本复制控制器、13／16／054、私人资料或外部发送。

第三轮新鲜审查实际发现三个剩余来源路径：生成清空当前 turn 展示后仍缓存的历史版本、消息列表及来源派生目的、另一有效讨论尚在核验依据的 held 结果。各有公开 RPC 的真实 RED→GREEN。版本控制器只向复验返回 turn／candidate UUID，完整 GET 失效或缺失时一并清除历史正文；复验期间隐藏旧消息与派生目的，再从正式消息入口重读；用户独立手写目的保留。只保留另一有效结果已有的来源核验任务，不增设可恢复正文副本。独立副本相关 57 项 GREEN／2.641 秒、类型检查 GREEN，包含已正式交付的 09 四项。

主 Agent 随后补较早分页反例：另一有效消息已被用户从第二页明确选中，版本来源复验只刷新最新二十条会错误清空该选择，真实一项 RED／208.271 毫秒。现在沿后端实际游标核验到已选消息或末页，只将重新核验的正文进入原视图；重复游标失败关闭、scope／generation／operation 失效即停读，不以旧缓存证明来源有效。工作树五份相关纯测试共 58／58 GREEN／1.348 秒、`npm run typecheck` GREEN，模型请求未增加。冻结 ONLY11 独立副本的主 Agent 复验、第四轮两轴审查及本地提交继续；真实页面和人工部分仍未执行，不据这些回归勾选整票验收。

第四轮独立副本 58 项 GREEN／1.318 秒、类型检查 GREEN 后，两轴同报一项 P1：generated 探索已经清空 currentExploration，却仍持有 strategyJob 的旧输入快照；来源复验仅取消尚存探索指针的路径，公开重试及迟到响应可再次带回原消息。新增两个公开 RPC 反例真实 RED，再按作业自己的 session、原输入 UUID 及失效结果清除作业，取消对应请求并推进 operation；来源失效后的旧重试不再发出 POST，已接收的迟到响应也不能再次发布原输入或候选。工作树完整相关 60／60 GREEN／2.615 秒、类型检查 GREEN。最初迟到夹具重复阻塞第二次调用，已终止该自有纯 Node 进程并把阻塞限定为一次；该夹具问题不作业务 RED。重新冻结与第五轮两轴审查继续，真实页面与人工仍未执行。

第四轮 Standards 的另一项 P3 判断为版本控制器的范围操作生命周期重复，非硬性违规；此处保留明确入口，不扩大来源修复为无关控制器重构。

### 第六来源核验修复切片：公开接管、删除检查点与正式终态传输

2026-10-11：本票仍 claimed / partial。仅在固定 `9bef2c67e74e14d8db9bdca5dbcbf26fa6a0d2b0` 加 ONLY11 的独立源码切片中修复第五次复审的三类问题；当前阶段未宣称完整 11、页面或原生交付。共享 Main 与 JsonClient 仅提供精确补丁，由主 Agent 串行接入，不带入未提交 13/17/18。

- 公开完整会话读取接管已确认来源失效后，404 / source409 复用原来源清理入口，清除结果、候选版本、私有策略输入、探索身份和派生意愿。即使尚未建立策略 job，在途身份读取也失效；迟到 generated 重试和再次重试不能恢复目标消息正文。独立手写草稿及目的保留。
- 删除受理与删除任务成功的既有 production 检查点遇到版本来源核验时，先用同一实际 scope 的 `readSavedSession` 接管完整 GET，再执行原消息／依据复验；保留已核验有效的独立讨论。未知传输失败保留隔离并允许同范围公开读取重试收尾，旧 scope 迟到结果不改变新视图，不建立第二份正文缓存。
- 真实 JsonClient 的 typed reason 与序列化白名单仅增加正式 `request_invalidated`、`candidate_unavailable`。候选控制器严格匹配 `409 + assistant_candidate_version_conflict + 正式失效 reason`；read/save/select 和后续 selections GET／恢复协调按原来源清理处理。普通 edit_key_conflict、selection_key_conflict、无 reason 409 和任意后端字符串不扩大为来源删除，也不暴露 SQL／正文。

真实 RED→GREEN（仅纯控制器及随机本地回环合成 HTTP）：第一类 3 fail→3 pass；第二类 2 fail→2 pass；第三类真实回环合同先 7 fail / 3 pass，再 10 pass。第三类首次受限运行因 loopback listen EPERM 失败，属于执行环境失败，未记为业务 RED；随后只对合成回环 HTTP 升级重跑才取得上述真实 RED。附加未知故障公开重试、旧 scope、两个正式 reason 的选择 GET／reconcile 共 4 pass。

在精确 ONLY11 切片从 `desktop/` 运行：

```bash
node --test --test-reporter=spec tests/assistant-candidate-version-ports.test.mjs tests/assistant-candidate-versions.test.mjs tests/assistant-session-catalog-read.test.mjs tests/assistant-session-catalog.test.mjs tests/assistant-session-deletion-guards.test.mjs
./node_modules/.bin/tsc --noEmit
```

原 60 项与新增 19 项共 79 / 79 GREEN，类型检查 exit 0。原有效 B held／依据核验、較早分页中的已选消息、同源多 turn／历史版本缓存与普通故障保留均继续通过。源码冻结、文件 allowlist／SHA、精确 shared patch、逐片原始日志位于 `/private/tmp/notalone-a11-sixth-freeze-WmsO11rr/`，不是提交的敏感资料。

数据影响仅为删除／失效后的当前授权会话内存副本及展示收尾，不增加持久化、来源权威、联系人授权、外发或样本留存。未运行 App、pages、npm test、safe、微信／OCR、私人数据、外部模型或 19；未 stage／commit／push。后端正式 provider、主树接入、后续两轴 fresh review、公开页面与人工原生项仍由主 Agent 据实收口，B/C 继续等待 formal11 provider；本切片不勾选完整验收框。

### 第七来源核验切片：首次探索与展示／读取结果归属

2026-10-11：本票保持 claimed / partial。以正式 `0137671a2b0856922fce7fd5988f7877867136e0` 导出并只覆盖原十份 ONLY11 文件；无未提交 13/14/15/16/18、055 或 C working。主树只同步版本控制器及其两份 OWN 测试；共享 Main 与本票记录均提交精确增量补丁供主 Agent 串行接入，不直接修改共享主树。

- 首次 open 保存新输入 X 的响应仍在途时，`expected_input_version_id` 是有效独立前版本 B，不能作为 X 或目标消息 T 的来源有效性证明。完整会话 GET 中 A/X 已 redacted、B 仍 active，且公开消息读取不再包含 T 时，清除策略中的目标快照并推进探索 operation；迟到 directions 与后续 retry 均不能恢复已删依据、理解或原消息。有效独立 B 的输入、讨论及版本继续保留。
- show 已有版本只持有展示结果，不接管读取／保存／选择结果的 operation。已确认的 404 与正式来源 409 独立按 contact/scopeRevision/SID/generation 传递给 Main 复验；同范围较新读取接管也不能吞掉该信号。旧 scope、SID 或 generation 仍不能报告当前失效或污染新视图；普通 edit_key_conflict、selection_key_conflict 和无 reason 409 不扩大为删除。
- 完整来源快照通过后，继续使用既有 reconcile GET selections 读取唯一实际指针，保留无正文占位及独立有效版本，解除无 live operation 的 loading。后续选择来源再次失效至多再复验一次，持续失败以 failed/null 收尾，不无限循环读取。读取最终选择期间，用户已明确展开的同候选旧版继续显示，不被默认新版回退，也不产生选择 POST。

真实逐片：首次 open 的 404 / source409 为 2 fail → 2 pass；同源 show/迟到失效、独立 A 实际选择收尾及有效 B 读取为 4 fail → 4 pass；版本控制器四种同范围读取接管为 4 fail → 4 pass；同候选选择 GET 迟到回退为 1 fail → 1 pass。旧 ports 测试原先锁定永久 loading/null；改为必须完成来源复验、保留独立 A、重读实际选择且达到 ready。旧 controller 测试原先仅 operationCurrent=false、scope 未变化却要求不报告来源；保留不发布／不污染 state 的原断言，并加强为必须传递范围信号，另增真实旧范围反例。原已知有效 B held、较早分页目标与其他所有原用例仍运行，未削弱原时限。

在十文件 ONLY11 切片的 `desktop/` 实际运行：

```bash
node --test --test-reporter=spec tests/assistant-candidate-version-ports.test.mjs tests/assistant-candidate-versions.test.mjs tests/assistant-session-catalog-read.test.mjs tests/assistant-session-catalog.test.mjs tests/assistant-session-deletion-guards.test.mjs
./node_modules/.bin/tsc --noEmit
```

完整原 79 场及新增 12 场合计 91 / 91 GREEN（1444.034333 ms）；类型检查 exit 0。原始 RED/GREEN、命令 exit code、正式基线、十文件 allowlist/SHA 与共享增量补丁保留于 `/private/tmp/notalone-a11-seventh-6mo5gW/`。首次完整回归 87/88 的唯一失败是上述错误的“同范围来源静默”旧预期，已保留原状态断言后加强；首次探索事件断言的采集起点曾含来源尚有效时的 loading 事件，已改为从来源确认失效起采集并在未修复基线重新取得真实 RED。

数据影响仅为当前授权范围内已失效的助手输入、目标消息、策略快照、历史版本和实际选择 RAM／展示收尾；不新增持久化副本、来源权威、读取授权、样本、模型调用或外发。未运行 App、pages、npm test、safe、PG、微信/OCR、私人资料或外部模型，未 stage/commit/push。新鲜两轴复核及最终主树接入由主 Agent 继续；公开页面、实际 App 与整票验收仍未执行，保持所有原验收框未勾。


### 第八来源核验切片：首次 open 的实际输入与 reconcile 展示收尾

2026-10-11：本票保持 claimed / partial。以正式 `0cc6e30fe693d85610d33aa83ccf0d056c6f8267` 导出，叠加第七轮精确十份 ONLY11 文件，再仅修改本票控制器、两份 OWN 测试及共享 Main 增量。主树所有文件保持本轮开始时的 SHA，未并发写入；OWN、Main 和本票追加均以精确补丁交主 Agent 在测试窗口释放后串行接入。无未提交 13/055、B/C working 或其他票改动混入切片。

- 首次 open 的新输入 X 会捕获目标 T 之外的近期消息或确认资料；前版本 `expected_input_version_id` B 与目标 T 仍有效，不证明 X 的额外来源 R 有效。来源 A/X 失效时，完整会话返回 X 的 redacted/unavailable 占位；迟到 directions 必须用实际响应的 `input_version_id` 核验并清除策略。独立有效 B 的版本和讨论、仍有效 T 均保留，不复制原始来源或制造新输入身份。
- 策略只持有当前 operation、contact/scopeRevision/SID 和 connection generation 的 UUID/state 来源摘要，无第二份正文缓存。完整 GET 已确认 inactive、仍 active 和尚未覆盖实际 X 分别处理；早于 X 保存的成功快照缺项先隔离，迟到响应或公开精确重试按实际 X 完整补验。连接故障、403 和普通 409 保留独立 B，探索以 failed/canRetry 收尾而不发布旧依据；同范围正式会话 404/source409 停止探索及后续重试。旧 scope、operation 或 generation 的补验结果既不发布正文也不改变新版本视图。来源事件只复验/清理，不能作为当前展示结果复活。
- reconcile 的 selections GET 在途时，公开 show 可展开已核验有效 A 的旧版；成功或普通故障收尾从当前受信 items 取展示，不覆盖用户期间选择的 displayVersionId。后端唯一实际选择仍通过 GET 决定；无隐式选择 POST，不永久 loading。

逐片真实 RED→GREEN：实际 X 的额外 R 失效、B/T 均有效，真实 JsonClient 回环 404/source409 两场 2 fail→2 pass；完整来源复验后公开 reconcile/show 一场 1 fail→1 pass；controller direct success/transport 两场 2 fail→2 pass。首次回环 listen EPERM 单独记为环境失败，随后只升级合成随机回环 HTTP 得到业务 RED。完整 GET 早于 X 保存的缺项竞态再取得 1 fail→1 pass；实际 UUID 与 current 指针区分、未知 GET 精确重试、正式 GET 终态和 scope/operation/generation 迟到守卫另有 9 pass。

最小测试、完整相关回归及类型检查从十文件工作切片的 `desktop/` 实际运行：原 91 项及新增 15 项共 106 / 106 GREEN（1615.183833 ms），类型检查 exit 0。原用例全部保留，没有放宽时限或删除断言；正式基线精确冻结的复验结果与命令 metadata 见下述产物 manifest。

```bash
node --test --test-reporter=spec tests/assistant-candidate-version-ports.test.mjs tests/assistant-candidate-versions.test.mjs tests/assistant-session-catalog-read.test.mjs tests/assistant-session-catalog.test.mjs tests/assistant-session-deletion-guards.test.mjs
./node_modules/.bin/tsc --noEmit
```

数据影响仅为已授权会话范围内的失效输入、方向探索、版本展示和实际选择 RAM 收尾；无新增原始资料、持久化副本、读取范围、样本留存、模型调用或外发。原始日志、正式基线、精确十文件 SHA 及补丁位于 `/private/tmp/notalone-a11-eighth-7G1wlF/`。未运行 App、pages、npm test、safe、PG、微信/OCR、私人资料或外部模型，未 stage/commit/push。最终主树接入与新鲜两轴 review 由主 Agent 接管；整票及公开页面/人工 App 未验收，原验收框均不勾选。


### 第八来源收尾及通用四 RPC 正式部分交付

2026-10-11：总协调确认先正式交付本十文件通用接口，供 B、C 接线；整票保持 claimed / partial。首次探索的实际新输入 X 不能由 expected B 或目标 T 代替复验：使用同范围、同 generation／operation 的无正文 UUID/state 摘要，在实际 X 回来时再次核验。快照尚未包含 X 视为未知并允许严格同范围重试，实际 X 已失效则清原作业与目标；独立有效 B 保留。reconcile GET selections 成功或失败收尾均读取当时展示，不能倒退用户在等待期间展开的旧版。实际 HTTP 两条来源 RED→GREEN、控制器与 ports 的展示反例三条 RED→GREEN、早期未知 X 一条 RED→GREEN，均保留原来源门禁及完整消息组。

主 Agent 已逐项核对十文件 SHA，并串行应用精确 OWN/shared/issue 补丁。只在固定正式 `0cc6e30fe693d85610d33aa83ccf0d056c6f8267` 加 ONLY11 副本运行上述五份纯 Node 模块：106 / 106 GREEN，1534.882417 ms；`./node_modules/.bin/tsc --noEmit` exit0。不启动 App、浏览器或模型；合成回环验证不代替公开页面→后端HTTP→隔离PG。

Standards 新鲜轴：硬性违例0；已知 P3 possible Duplicated Code 1（版本操作生命周期守卫重复），本来源修复不扩大为无关重构。Spec 新鲜轴：P2 实现错误1——合法长版本历史超过 JsonClient 1 MiB 响应上限；renderer 操作与完整公开页面组合仍 partial2，其他范围／来源／实际选择未发现新增错误。连续三个 65536 字中文编辑版，正式响应同时返回 `text` 和 `messages.text`，仅正文便至少 1,179,648 字节；保存可能成功而响应及重读失败，不能据本阶段声明长历史完整可用。

总协调已批准下一切片用只读分页与有界写入回执修复上述 P2，四 RPC 签名保持兼容、复用唯一版本写入者，模型完整历史读取不分页／不截断，不提高全局 transport 上限。逐页使用实际 scope/connection/operation；任何页确认来源失效须丢弃整个累积正文，实际选择和用户展开旧版继续保留。该修复仍待实现与真实大体积 HTTP 回归。

本提交只包含四 RPC、DTO／Main／preload、JsonClient 正式 reason 白名单及来源安全控制器和两份 OWN 测试与本票；没有 C 样本控制器、13/15/16/17/18 working、055 或 B 业务。真实 App、人工部分和19均未执行；本阶段不勾选整票验收、不宣称全部自动部分完成。

2026-10-11 总协调净接正式adb426c8四RPC ONLY10。与已正式root6303860 B自动更新同一Main的临时三路合并仅一处publish冲突：保A实际operation来源复验初始化，保B automaticUpdatesPaused，不改各自authority。其余八source/tests逐字正式patch，原11doc只附正式后缀保主树历史。whole桌面 `npm --prefix desktop run typecheck` actualexit0；desktop运行原五版本／目录／门禁加样本77及actualSkill5共188项。首次默认sandbox为174G/14ERROR0.956s，十四项均127.0.0.1 listen EPERM，未到产品HTTP，不计产品RED；授权回环测试重跑原188 **188G／1137.229375ms／skip0**。其中真实JsonClient回环HTTP仍受控后端，不是实际PG或公开页面，未借它闭整票。大版本超过1MiB的已知P2、renderer与页面组合仍由A/B及root继续；原11claimed及标准不改，独立安全端口可供B08/C06消费，不将其说成所有历史GET成功。

2026-10-11 总协调最终合并发现并修复与 B09 的交叉 P2：公开 `saveCandidateVersion` 保存用户编辑必须沿既有 `notifyInputChanged()` 停止自动队列和定时器，并拒绝在途自动回执，不能让新消息继续更新原讨论。实际公开 preload/RPC → BackendHost/HTTP → 隔离 PG 先复现 RED：探索 POST 2、模型 3；同一保存入口一行修复后 GREEN：探索 POST 1、模型 2，CURRENT 不变，自有资源清理成功。该修复不取消已发候选生成、不增加来源或选择写入者。两轴新鲜复核新增交叉问题0、规范硬要求0／重要判断项0；已知长响应 P2 和完整编辑组件缺口继续保留。

永久回归登记在原 `reply-strategy-bounded-updates` 的第14场。实际命令 `npm --prefix desktop run test:pages -- --case reply-strategy-bounded-updates --timeout-seconds 240`：原13场及新增公开保存版本后两次真实 SSE 只提醒共14完整场景全部 GREEN、actualexit0。新增场景以四 RPC 保存真实不可变版本，不是假版本投影；同 SID 明确开启未确认探索后保存，检查原理解、总模型载荷2、CURRENT 和完整 turns 均不变，不代表 B08 全组编辑 UI 完成。quiet92／active0／onscreen0／maxApps1／policy2、单 Chrome、cleanupConfirmed=true，独立 fresh status absent 后释放窗口；Electron/nativeAcceptance=false。新修复后的原188项 Node 亦全部 GREEN（1155.7675ms）、skip0；whole桌面 TypeScript exit0。日志保留 `/private/tmp/notalone-root-version-edit-auto-real-red.log`、`/private/tmp/notalone-root-version-edit-auto-green.log`、`/private/tmp/notalone-root-a11-notify-related-node-green.log`、`/private/tmp/notalone-root-b-r09-fourteen-save-version-page.log`。

本轮部分交付新增的是当前范围的 RAM 清理与编辑停止自动探索；不新增持久化正文副本、样本、模型权限或发送能力。大历史分页、有界写入回执和完整 renderer/页面仍接续；本票仍 claimed，原标准未提前勾选，人工真实 App 未执行。

正式A 4e9acf4后缀净接；以下最终proof归A的私有切片复验，不借为此主树实际结果。

### 长版本传输 P2：只读分页与有界写入回执

2026-10-11：在固定正式 `5a5e4f3e7e9c5383356d379ba9ca90f0a44ec82e` 的独立源码副本实现；整票仍 `claimed / partial`。四个通用 RPC 的签名不变，B/C 页面接线及最终 App 验收不由本切片宣称完成。

- 正式 `GET versions?page=0` 返回一个完整版本及读取锚点，后续使用 `page + through` 读取同一有序完整范围；每页同 owner/contact/session/candidate 锁与 C 实际来源守卫。原版在只读事务中也可读取，不靠 GET 写入原版引用；新增版在本次锚点之后时不混入旧页。收齐并核对连续编号、全部身份、消息顺序、父版、要求及末页后才发布正文，不把有限页当完整历史。
- 桌面保存使用 `POST versions?receipt=1`，仅返回 UUID、编号、编辑键和父版；新旧 HTTP 入口复用同一个版本 writer，保存后始终权威分页重读，并从 GET selections 读取唯一实际选择。旧编辑或选择键回执不能倒退当前指针；用户期间展开旧版及新 scope/connection/operation 的结果不能被迟到页覆盖。旧完整 HTTP 契约仍保留兼容，长历史桌面读取始终使用新分页协议。
- 中间页 404 或正式来源 409 丢弃本次累积正文，复用既有 Main 来源清理与完整来源复验，保留独立有效讨论。未知传输失败不发布不完整内容，允许精确同范围公开重试；没有新增正文恢复缓存、持久化副本、第二写入者、总版本数限制或全局 response cap 调整。
- 正式 052/053 的整组聚合正文上限为 65,536 Unicode 字符（含消息分隔符），最多八条，要求最多 4,096 字符。服务端 JSON 每字符最坏六字节转义，双正文加要求的保守上界为 811,008 字节，UUID、编号和时间等固定元数据另少于 2 KiB，仍小于默认 1 MiB。真实八消息极值使用七条 8,192 加末条 8,178 字符，响应实际 811,970 字节；八条各 8,192 加分隔符被正式 HTTP 拒绝。合法 65,536 Unicode codepoint 旧版读取另取得真实 RED，版本 DTO 改按同一字符契约读取，完整正文未截断；本切片未扩大 Bridge 的既有编辑输入规则。
- 模型仍使用原权威完整 `read_candidate_versions` / discussion reader，不分页、摘要或截断。分页只改变显示传输；完整讨论仍参加同一模型输入预算与来源复验。

真实 TDD：长历史第三次保存的正式 HTTP 已落四版，但默认 JsonClient 保存响应与再次 GET 失败，响应 1,181,164 字节；1 项 RED／1.203 秒／exit1，修改后原反馈 1 项 GREEN／1.317 秒／exit0。Unicode 完整合法正文另为 1 项 RED／1.129 秒／exit1 → GREEN／1.310 秒／exit0。各轮均正式安装 001–054，账本匹配、重复迁移空集，自有数据库剩余 0；保存、读取、选择、重连及故障守卫额外模型调用均 0。

必要相关回归在独立副本实际取得 66 / 66 GREEN／26.232 秒，包括新增长传输公开四 RPC→正式 HTTP→PG、既有九项版本 HTTP、十四项唯一 writer/选择以及三十二项完整讨论读取。五份原相关 Node 模块 106 / 106 GREEN／1132.154167 毫秒，完整桌面类型检查、两源有限 mypy、语法检查通过。最终冻结副本的复验和 SHA/命令/清理证据见 `/private/tmp/notalone-11-transport-freeze/manifest.json`。

扩展完整模型消费者组合实际 77 项／44.635 秒，76 通过、1 失败：未改 `test_assistant_discussion_budget.test_history_only_sample_dependency_is_separate_from_current_five_and_erased_by_c` 在删除旧样本后携旧 expected input UUID 再生成返回 409 `assistant_session_input_conflict`。独立仅正式固定基线、无本切片任何补丁，单跑同项 1 项／2.022 秒同样失败，生产 001–054 与自有库清理 0 已核验；不改 12/C 的守卫或夹具，不将 77 项记作全 GREEN。

默认沙箱合成回环曾 listen EPERM，随后仅对同一已授权自有回环升级执行，不计功能 RED。三处旧合成保存夹具原先不持久化 POST 正文，不能通过新回执与权威重读核验；已补合成后端的实际保存投影并保留全部原断言。中页来源夹具首次按数组第一项错误取独立 B 的展示 UUID，修正为实际 candidate UUID 查询后通过，不计业务 RED。共用 HTTP 夹具提取为非 TestCase，原九项均照常独立执行，没有动态隐藏测试。

数据影响仅为当前授权范围内版本显示的完整传输与失效 RAM 清理，不增加读取授权、来源权威、样本、长期资料或外发。Context7 当前工具清单没有可用入口，按仓库回退核对 Python 3.12 官方 JSON/urllib.parse 文档与实际 3.12.13；不新增依赖。未运行 App、pages、npm test、safe、native、微信/OCR、私人资料、真实外部模型或 19，未 stage/commit/push；共享 app 和 issue 只提供精确增量，主树接入、新鲜两轴与正式本地提交由协调者串行收口。本票原验收框不勾选。


### 主 Agent 精确收口与新鲜两轴

主 Agent 对上述九份 OWN 文件及共享路由三处查询透传逐项核对冻结 SHA，精确接入，不夹带 13/15/16/17/18 working 或 055。新鲜 Standards 硬性违例 0，P3 possible duplicate_history 行投影 1；新鲜 Spec 本传输切片错误 0、范围越界 0，既有 B/C 展示接线与 Page 自动验收仍属整票 partial，不能由本切片测试冒充完成。原 77 项组合的基线失败原样保留；12 的新 CURRENT 回归另属独立只测试提交，不改变来源删除门禁。真实 App、人工部分、19、私人资料、微信/OCR及外部发送均未执行。

主 Agent 最终同字节切片最小复验：新十一项正式 HTTP/PG 11 / 11 GREEN／13.217 秒，001–054 账本匹配、repeat0、两层自有库剩余0；原五份窄 Node 模块 106 / 106 GREEN／1062.804833 毫秒，完整桌面 tsc exit0。首次默认沙箱合成回环 listen EPERM，未计为业务 RED；仅对同一已授权自有回环升级后通过。未运行 Page/App/native。

2026-10-11 总协调主树净接正式 A `4e9acf4` 十份源码／测试及本票纯后缀；`app.py` 仅三处 query 透传，保留 B owner guard、`e092de2` 保存停更与 `80b871f` 样本来源恢复，不覆盖 Main/session 或取 13/055 working。公开版本 RPC 签名保持，分页与写入回执遵循实际新 HTTP 协议，模型完整讨论读取不分页、无静默截断或全局 transport cap 扩大。

主树真实首次三模块36项为34通过／2失败／28.038s，失败只在原053迁移测试：使用已包含054的整个目录，却仍要求空库53及052只升级053。仅测试夹具固定复制真实001–053到自有临时目录，保留原53、单次053、重复0及数据库清理断言；完整054安装和账本仍由独立外层生产CLI实验。最小迁移2项 GREEN／1.248s，随后原三模块 **36项全部GREEN／27.516s／skip0／actualexit0**，含11条默认JsonClient/公开版本RPC→实际HTTP→隔离PG的长历史、完整八条消息、Unicode、分页中途来源失效、跨范围/连接/operation迟到及锚点/选择回归；原server9、store14和migration2同轮通过。最坏完整八消息实际响应811970 bytes、模型追加0。正式001–054 ledger与repeat0，自有两Core库、两migration库及外层库剩余全部0。

新协议下同八套桌面200项 Node 全部 GREEN／1253.041167ms／skip0／actualexit0，whole TypeScript exit0，两个实际候选 source 的限定 silent mypy 无问题，compile及diff通过。C来源合成传输首次未识别 query 的失败单独保留，只有该夹具使用 A 正式 `candidateVersionProtocol` 适配新协议后，新12项来源回归 GREEN／113.377375ms；不删除原断言、不把该 wrapper 的缓存当实际后端。真实长传输由上述11条 HTTP／PG覆盖。

日志为 `/private/tmp/notalone-root-a11-paging-real-http-pg-combination.log`（初次36）、`/private/tmp/notalone-root-a11-original-053-prefix-migrations-green.log`、`/private/tmp/notalone-root-a11-paging-final-http-pg-combination.log`、`/private/tmp/notalone-root-a11-paging-related-node-combination.log`。本片关闭长版本 transport P2，完整组编辑公开 UI仍随B正式交付/主树Page继续，本票仍claimed；人工真实App未执行，不借协议通过提前勾整票。


### 总协调原自动验收收口（2026-10-11）

主树继正式 `b84fcf5` 有界版本传输及 `12e80fe` 编辑／选择／逐消息复制接线，按原规格执行 `npm run test:pages -- --case reply-strategy-group-boundaries --timeout-seconds 240`。Conda `NotAlone`，禁 dotenv／tracing，session10071 **actualexit0／五完整场景 GREEN**，真实公开页面→具名Main→认证HTTP→隔离PG；915个实际运行源码、测试、夹具、迁移及配置全窗 SHA 不变。两种场景各八条完整消息、三次真实整组保存、四版完整重读及父版／消息 UUID，旧权威聚合超过1MiB，正式有界传输保持正文完整；新窗口实际明确选择原版第8条复制、同PG真实后端重启及宿主重建后显示最新完整组，再选择并复制第1条。两种场景 actual historyTool 来源删除均清除已保存／恢复的组与未保存正文和要求，旧版本／消息复制失败，重建仍为无正文占位。另一 owner 使用独立认证HTTP访问甲的实际合法 CID/SID/candidate 路径404，同owner错误CID404；错version/request/组消息、旧scope/SID均拒，当前新范围正向通过。

公开层正常保存503保稿、选择已commit但GET503不假确认、旧版／新版明确选择、逐条复制、samePG重建恢复以及新消息到达保稿，已由主树 `12e80fe` 的四正常加两编辑通知共六完整场景实际GREEN；plain改写／恢复副本与来源擦除已有原公开页面和具名RPC证据。原默认展示不替代选择、candidate/version稳定身份及无隐式发送／长期偏好保持。长版本独立11 HTTP、原server/store/prefix共36真实HTTP/PG GREEN27.516秒、200 Node、TypeScript与范围删除断言是原正式证据，没有用合成transport冒真实后台。

本次 quiet68／active0／onscreen0／maxApps1／policies[2]／单Chrome／cleanupConfirmed=true，Electron/native=false；actualexit后独立freshstatus session29655 **exit0／absent**。915文件全窗未变，原5秒、来源15秒、HTTP23／25秒、ps1秒、quiet、单240和最多两label门槛均保留。日志 `/private/tmp/notalone-root-group-boundaries-five-page.log` 和前后独立status保留。原所有早期失败／迁移夹具修正／未知瞬时风险继续保留，不能据后来GREEN改写旧运行事实。

六条原自动标准据上述公开、持久化、身份与来源证据勾选，State resolved；编号指代仍是A13独立范围，不成为本票新增门槛。只用合成模型、消息及必要宿主适配器，系统剪贴板实际接收、真实App／原生能力、真人语义质量与人工验收按本轮范围未执行且未标通过，不影响已满足的原自动范围。没有付费／外部模型、私人聊天、OCR、微信、发送接口、push、发布或部署。

### 本轮自主协调最终结果（2026-10-12）

候选及组内消息编辑、明确选择、历史版本重读均接原稳定身份和删除依赖；默认展示不冒充用户选择。最后消息组公开场覆盖编辑及复制，复制不记发送。

剩余：本票可自主范围已完成。真实模型语义、自然度、关系适配及用户相似度未知；本轮没有原生App、私人资料、微信／OCR、外部发送或远端操作。

证据：[29票逐项结果与实际命令](../../unfinished-work/round29-autonomous-results-20261011.md)、[固定源码、自动验证及清理回执](../../unfinished-work/round29-autonomous-verification-20261011.json)。各次不同来源的计量分列，未把静态审查、合成模型或受控宿主冒为原生／真人通过。原验收文本逐行对共同基线保留；只更新实际可验收的勾选和State。
