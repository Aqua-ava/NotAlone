# 11：候选编辑、选择与版本回看

State: claimed
Triage: ready-for-agent
Blocked by: [assistant-session-context/07 默认会话的一次生成与可靠保存](07-default-session-persistence.md)

拆分标识：C05（第三版映射；执行时以本文件为准）。

## 规格与范围

[正式规格](../spec.md)；旧02；Q11、Q12。 读取[工作流](../../../docs/agents/workflow.md)、[工程要求](../../../docs/agents/engineering.md)、[领域路由](../../../docs/agents/domain.md)、[领域语言](../../../CONTEXT.md)、[ADR-042](../../../architecture/adr/042-assistant-session-context-boundary.md)。依赖是完整交付的前置，不代表这些前置已完成；本票尚未实现。

## What to build

用户选择和编辑候选，保存修改前后及选择关系；主界面展示新版，可展开旧版并重新选取。

## Acceptance criteria

- [ ] 候选选择和编辑通过公开入口保存，重读显示新版并可展开、重新选择旧版；修改前后和对应要求可追溯。
- [ ] 区分默认展示与用户明确选择：未点击不能记录为用户已选；实际选择不是发送或长期偏好。
- [ ] 先以明确候选ID操作，保持会话、候选组、版本身份；不把生成时间或数组位置当持久身份。
- [ ] 派生版本保留来源依赖，删除后旧版本及恢复副本不可得；自然语言编号解析由C06完成。
- [ ] 新增路径按owner/contact隔离，保留来源及删除路径；敏感正文不进入普通日志，候选只能由用户亲自发送。
- [ ] 记录实际命令、结果、数据影响及剩余风险；未执行的验收不得预填通过。

## 范围边界

先使用明确点击的候选ID；保存与公开再读取一致，派生版本随来源删除；不在本票实现自然语言编号指代。

## 验证与交付

使用公开页面操作 → 后端HTTP → 隔离PostgreSQL，复用真实业务控制器与存储，只替换模型、消息到达和必要宿主事件为可控合成适配器。观察公开结果、持久化重读和模型调用次数，不绑定内部调用顺序。

按工作流以TDD垂直推进，完成相关验证、Standards/Spec两轴评审与本地提交后，在本票补充Answer并据实更新状态。合成响应只证明数据和控制契约，不证明真实模型语义质量。真实App只能由主Agent在另行约定的有限窗口通过项目入口验证；页面结果不能代替原生证据。

本票不授权OCR、真实微信读取/发送、外部模型调用、部署或push；也不提前实现其他票。

## Comments

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
