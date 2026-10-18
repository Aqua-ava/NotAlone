# Python 后端

本目录是独立的 Python 项目，提供联系人、导入、记忆、检索、候选回复、同步和后台任务。HTTP 入口在 `src/notalone/server/`；其他领域及持久化模块同属后端。

```text
backend/
├── src/notalone/       Python 包及 CLI、HTTP 入口
├── tests/              合成夹具、单元与集成测试
├── database/           PostgreSQL 版本化迁移
└── pyproject.toml      依赖、包配置与命令入口
```

## 开发入口

以下命令从本目录执行（从仓库根目录先 `cd backend`）：

```bash
conda activate NotAlone
python -m pip install -e .
notalone-server --help
```

运行配置仍放在仓库根目录的 `.env`，启动命令会从当前目录向上查找已有文件；已有 shell 环境变量优先。首次配置与 owner 初始化按 [仓库说明](../README.md)在仓库根目录执行；根 `.env` 尚不存在时，不要直接从本目录初始化，否则既有默认规则会写入当前目录。

如需从本目录首次初始化，必须在该次命令前加 `NOTALONE_ENV_FILE=../.env`，显式把读取与写回位置指向根配置；同样可指定其他受控配置路径。迁移命令不自动读取 `.env`，需显式提供数据库连接。不要将配置、聊天、备份或数据库文件放入源码目录。

本地 HTTP 服务的手动启动入口为 `notalone-server`；首次身份初始化、导入、同步及模型配置见 [仓库说明](../README.md)。启动服务前须按 [迁移说明](database/README.md)完成目标库的版本检查。

仅构建 Python 包用于打包验证，可在本目录执行 `python -m pip wheel --no-deps --wheel-dir dist .`。SQL 迁移及原生探针仍按仓库中的独立入口管理，该 wheel 不代表完整桌面安装包。

## 验证

```bash
conda activate NotAlone
NOTALONE_DISABLE_DOTENV=1 python -m unittest discover -s tests -v
```

数据库集成测试只使用名称以 `_test` 结尾的合成测试库；设置 `NOTALONE_TEST_DATABASE_URL` 可指定隔离库。真实模型冒烟另需显式凭据，不属于离线验证。

## 整理质量评测与资格

`notalone.experiments.organization_quality` 的 `contract` 可离线输出当前候选、实际规则／提示词／schema／用途及整理预算身份；不读凭据。`serve --prepare-only` 只在明确命名的自有 `_test` 库装配正式质量 HTTP，可准备输入、记录审阅和创建运行，不构造 SDK。实际候选服务必须同时指定 `--suite-directory` 和 `--suite-source-ref`；SDK 使用已有 DeepSeek 工厂、实际总期限及 `max_retries=0`。当前缺省候选为官方 `deepseek-flash`，响应模型、指纹及脱敏请求路由分别留证，无法辨认的底层模型版本保持 `unknown`。

本人／联系人 `layered-memory/quality-input` 接受实际 `memory_versions`。返回的 `{memories, scenarios, corrections}` 与生产四个 Port 共享白名单、反馈过滤和主题投影；人审支持标注只绑定该实际输入 hash 与投影语义。模型、提示词或预算更新使旧运行资格失效；输入语义未变时不用仅为代码变更重复人工标注。L2 核验沿用冻结旧主题；L3 从共同发布组装器形成独立评测 checkpoint，保存真实分配的 UUID／时刻／完整引用，明确 `published_to_product=false`。缺少正式 L3 会读取的合法底层版本时拒绝冻结，不能静默省略。正确空 L2 且没有独立主题时，正常 L3 调用记为不适用，不伪造执行；两层错误候选挑战分别留证。

2026-10-18 验收政策 v2 将本轮工程验收交给独立 Agent：审阅身份必须为 `kind=agent`，通过现有 `allow_unreviewed_smoke=true` 进行有限真实候选核验。该路径不授予完整质量资格；原八维各15例加4条摘要与2条事实更正的全量门槛、人工审阅身份检查及关闭自动使用的规则保持不变。有限核验保留全部失败分母、实际模型身份和同一持久物理调用总账，不新建目录重置额度。

按顺序使用公开 CLI `annotate → create → execute → review`：输入文件就是对应 HTTP 请求 JSON，`execute` 每次请求仅执行一个有限 case，恢复仍指向同一 run。草稿 `kind/detail/gold`、支持与禁用标签及评分不进入提案或核验输入；挑战只发送另行冻结的候选正文。Agent 标注永不算人工，运行中部分输出不能提前通过审阅，输出变动会清旧审阅。所有失败、预算耗尽及未运行阶段保留分母，未执行／未人审不能授予真实资格。

完整集合由 `notalone.experiments.organization_quality_suite` 的 `create/read/summary/export/calibrate` 管理：清单固定 source 环境变量名、明确 `_test` 库名、owner/run/case、输入／标注 hash 及每子运行分配。每个 case 使用独立合成 owner（联系人再独立 contact），120 基线按八类各15计覆盖，4条总结反馈及2条实际底层更正分别单列；底层更正须复验实际决定、新版本及 fact-error 动作回执，缺证保持未知。支线不扩充独立基线分母。持久物理额度在真实 HTTP transport 发送边界预留，跨阶段、样本、失败、进程及重启不退款、不重置，所有子分配之和不超过总额度。本轮全局边界为800次（原750次边界在实际执行前废止，未消耗调用），属于本轮显式授权，非用户永久总预算；变更有限边界必须在实际执行前明确冻结新清单，不能靠重建目录逃避已用额度。全局标定绑定完整成员证据，不能用一条子报告代替全体标定。评测 CLI 初始完整请求字符预算为8000，与物理次数分列，不改变生产缺省预算，也不代表标定通过。每次尝试保存实际请求 UTF-8 实体及解码响应实体的字节／字符数、生成正文总字符数；无响应为 null。解析 JSON 的重序列化估值另列，不冒充原始实体长度。

两条事实更正支线先公开准备单一旧叶 quality-input，再以 `dataset_version=fact-correction-path-preparation-v1`、`data_kind=fixed_synthetic`、`max_http_attempts=1` 和用途确认建立单 case 预备 run。它不能执行模型或接受质量审阅，30分钟内只登记一次精确 scope／epoch／oldleaf 的实际 fact-error。旧输入及 run 正文仍物理清除；只有同事务真实 corrected 决定和合法新叶才完成无正文回执，并由新叶 quality-input 消费一次。普通运行不采集这段历史。支线清单另含实际原 `fact_error_command` 六字段无正文命令，其摘要与后端回执交叉核验，客户端标签不能证明实际层。`DELETE /api/layered-memory/quality-runs/{origin_run_id}` 可主动撤销已撤正文的预备用途；源删除、禁用、世代变化或最终 case 清理均清回执，迟到操作不会重建。两条预备 case／run 与最终126条分列，未执行不产生模型额度消耗。

普通业务库只消费后端显式装配的 `application.organization_quality_suite.SyntheticSuiteReader` 或固定单源 resolver 返回的无正文摘要，不复制合成评测全文，不接受客户端 `verified=true`。每次模型前后及持锁 writer 重新核验当前合同、来源和回执；源删除／停用／纠正、数据库不可达、任一 guard 漂移或可观测模型身份变化都会关闭资格。源库与业务库明确分离，持锁复验使用同一连接和有限锁等待。输入、checkpoint、运行、请求／响应和审阅正文从第一份快照继承完整参与依赖，源清理直接物理级联，不依赖先 GET。工具导出的自有合成审计文件由操作方按其资源归属一并清理，不是业务正文缓存。

正式 `python -m notalone.server.command` 通过 `application.organization_runtime.build_layered_memory_service` 装配。未设置 `NOTALONE_ORGANIZATION_QUALITY_CONFIG` 时不构造整理 SDK，保持未验证；显式设置时读取该绝对路径的0600 JSON，字段仅为 `schema_version="organization-runtime-v1"`、`suite_directory`（私有 suite 绝对路径）及 `organization_budget`（六项完整预算，`max_model_calls=4`）。模型配置复用既有 `NOTALONE_DEEPSEEK_*`，四个实际 Port 与评测使用同一工厂、重试0、实际期限及出站前后资格复验。业务目标库可为普通库，但必须与所有固定合成来源库分离；来源连接仍只由 suite 清单中的 operator 环境变量引用。来源目录或数据库暂失、用途撤销或模型配置不可用时降为未验证，L1及其余读取可继续启动。来源恢复后重新实时复验，不缓存旧 verified；共享 HTTP client 随后端收尾关闭。

正式装配的未知状态工程用例位于 `tests.integration.server.test_organization_quality_suite`：两个自有随机库、真实迁移、单一公开预备 source、私有配置、官方四 SDK 工厂与 dummy key，并在 transport 封住外网；源撤销／目录丢失／凭据缺失时均验证目标 HTTP 仍可读取 L1、无实际模型请求。enable 的200仅保存范围意愿，未获资格时 `work_id=null`、主题为空、画像为空；不能据此宣称整理已运行。原生验收可将同一正式 command 的 `NOTALONE_BACKEND_INFO` 指向自有握手文件接入当前 App，须另记桌面窗口、实际版本和清理，不能把该 HTTP 用例当成原生通过。评测 `serve` 仅负责合成评测，不代替正式业务启动配置。

界面分别显示整理与回复读取的未验证／未通过／已验证、合同、报告和中文原因。整理获准且范围用途确认后可整理；回复比较未知时仍不自动加载新层，原有 L1 保持。受控工程模式始终公开标记 `synthetic`，不能签发真实资格。真实模型、人审、当前 React 及原生 App 分别记录，不相互冒充。

## 整理质量的公开合成构造

`notalone.experiments.organization_quality_construct` 是独立工程 CLI，只调用显式后端的正式联系人、来源导入、候选确认、手录和 `quality-input` HTTP；不读取私人配置、SQL 或微信，不直接调用模型或授予质量资格。来源构造必须连接只装配受控外部模型 Adapter 的隔离工程后端，生产 Worker 与默认空维度放行表保持。先准备合成 dataset、worksheet、评分草稿和必要的显式消息时刻重构表，再从仓库根目录执行：

```bash
PYTHONPATH=backend/src python \
  -m notalone.experiments.organization_quality_construct plan \
  --dataset /tmp/quality-prep/dataset-draft.jsonl \
  --worksheet /tmp/quality-prep/public-construction-worksheet.json \
  --scoring-contract /tmp/quality-prep/draft-scoring-contract.json \
  --source-date-policy append-draft-source-date \
  --source-time-overrides /tmp/quality-prep/source-time-overrides.json \
  --output-dir /tmp/quality-plan
```

`plan` 完全离线，v2产物 `construction-plan.json` 中每条 `text` 可供人工修改；`draft_memory` 保留原正文、来源标签和时间解释。`source_supported` 默认保留为联系人来源导入路径，`manual_entry` 沿正式手录。兼容性试验可显式 `--manual-entry-rebinding` 转为手录并保留降级缺口；这不满足原来源支持覆盖，最终 `provenance_coverage` 必须如实为不完整，不能据此评满120例。

手录日期策略必须显式选择：`unchanged` 原样保留正文；`append-draft-source-date` 把草稿中的合成日期作为正文前缀，日历日明确时刻与时区未知，`null` 明确日期未知。来源导入保留原正文及实际消息时间，不套用手录前缀；当前公开导入要求含时区时刻，生产提取会跳过未知时刻。只有日历日的来源保持未就绪并阻止 `apply`，不能静默补时区。需要构造新的合成消息时，可提供以下重构表；这是新合成输入的假设，不是还原未知旧消息，也不作为 `valid_at` 或事件发生时间：

```json
{"schema_version":"synthetic-source-time-overrides-v1","entries":[{"draft_memory_id":"example-m1","original_date_only":"2026-10-16","source_message_at":"2026-10-16T23:30:00+08:00","assumption":"agent_chosen_synthetic_message_time"}]}
```

工具核对原日历日及实际记忆ID绑定，保存完整假设、重构表摘要与新dataset摘要，所有支持关系重新待审。没有日历日来源时可省略重构表。不把草稿 `kind/detail/as_of`、支持关系或评分说明写入模型；后端实际时间始终取自公开返回。

向已明确授权、已初始化且启用质量输入接口的隔离后端执行；`CONSTRUCTION_BACKEND_URL` 和已提供合成 token 的环境变量名由调用者显式指定：

```bash
PYTHONPATH=backend/src python \
  -m notalone.experiments.organization_quality_construct apply \
  --plan /tmp/quality-plan/construction-plan.json \
  --backend-base-url "$CONSTRUCTION_BACKEND_URL" \
  --token-env CONSTRUCTION_BACKEND_TOKEN \
  --create-contact-name 质量验证合成联系人 \
  --controlled-source-backend --source-files-shared-with-backend \
  --source-owner-external-id wxid_synthetic_quality_owner \
  --source-contact-external-id wxid_synthetic_quality_contact \
  --confirm-source-candidates \
  --contact-per-case --defer-quality-input \
  --output-dir /tmp/quality-bound
```

`--contact-per-case` 用显示名前缀逐case新建并确认独立联系人，合成渠道定位由显式前缀和实际contact UUID派生。需要共用范围时可省略该参数，或用 `--contact-id <明确选择的联系人UUID>`；完整来源构造应使用自有空隔离联系人，避免旧消息水位影响历史导入。仅有本人场景时不创建或确认联系人。来源文件写在输出的 `synthetic-sources/`，须与后端共享本机文件系统。CLI只从显式token环境变量读取鉴权，不读 `.env`、不跟随重定向、不记录token。

全部来源先按明确消息时间排序，逐条 `preview → commit(expected_content_sha256)`，通过一次有界SSE等待生产Worker完成，再沿公开消息／来源／待确认候选核对。默认维度门保持关闭；只有显式 `--confirm-source-candidates` 才确认本轮合成候选，并记录Agent操作来历，不冒充人审质量。所有来源构造完成后按原case顺序绑定公开 `quality-input`，保持原分母和实际ID/revision。v3的62条来源与92条手录需要400次POST（另有有界GET/SSE），后端受控Adapter会执行工程响应；不允许真实供应商调用。手录降级版本只需276次POST，但来源覆盖不完整。

`--defer-quality-input` 只构造L1及来源链，记录 `constructed_l1_cases` 与逐case `pending_quality_input_request`；`quality_prepared_cases=0`，不POST质量输入，也不生成 `model-inputs.jsonl` 或最终支持审阅包。状态为 `l1_constructed_quality_deferred`，并保留完整公开审计。v3逐contactcase隔离且暂缓质量输入时为398次POST；以后绑定质量输入时还需120次。A06反馈属于scope级；共用联系人或本人scope的资料不能直接当作独立反馈评测。逐联系人隔离不改变本人仍共享owner的事实，必须在反馈合同及scope快照稳定后重新准备实际质量输入，早期L1构造或旧质量快照不替代最终冻结。

未暂缓时，`public-bindings.json` 保存公开请求／返回、来源链、原标签、时间假设、实际版本及case/contract摘要，`http-exchanges.jsonl` 保存无鉴权字段的逐请求审计。`model-inputs.jsonl` 每行只含后端原样 `{memories, scenarios, corrections}`，按生产scope分别核白名单：联系人记忆9字段、原6字段时间和完整版本一事件；本人记忆4字段、8字段时间及5字段事件投影。普通公开时间与模型时间分别保留为 `actual_public_timing/actual_model_timing`，不混用合同。`dataset-rebound.jsonl`、`support-review.json` 仅供人审，将支持关系和未知摘要候选映射至实际ID并保留草稿来源。所有状态仍为 `unknown/quality_verified=false`，不授予真实资料资格，金标和评分说明不得成为模型输入。

输出目录必须不存在。失败保留部分绑定及审计，不自动重试；须先核对已有写入。工具不自动删除后端资料，调用者按实际绑定清理隔离资源。`tests.unit.experiments.test_organization_quality_construct` 验证CLI拒绝边界；`tests.integration.server.test_organization_quality_construct_cli` 穿过真实 `create_app`／HTTP／隔离PostgreSQL、生产Worker与受控外部Adapter，验证两scope和逆序来源的完整构造。其 `SyntheticSourceConstructionModel/source_construction_backend` 是自有合成后端装配示例，不是产品运行配置。实际模型质量及真实App另验。

## 持久回复探索接口

回应与主动联系共用认证路由 `/api/contacts/{contact_id}/assistant-sessions/{session_id}/explorations`。`POST` 接受 `content`、`operation_key`、可选 `expected_input_version_id`、`previous_id`、`automatic` 和 `change_group`；回应的 `content.type=response_exploration` 携 `target_message_id`，主动的 `purpose_exploration` 携 `purpose_hint`。两场均可携一次性 `correction`、`requirements` 及 `skill_mode=auto|user|disabled`（user须指定有效 `skill_version_id`）。输入版本由既有助手会话原子分配 UUID，不接受客户端整数版本、已确认意愿、回答或来源声明。

返回明确区分 `directions`、`clarification`、`paused` 和 `generated`。`GET /{exploration_id}` 读取当前结果；`POST /{exploration_id}/confirm` 携实际 `input_version_id` 及 `suggestion_id` 或 `direct_intent`，`/answer` 携实际输入／问题 UUID、`answer` 和独立 `operation_key`，`/stop` 携实际输入 UUID。纠正与回答不建立意愿确认；有服务器保存的确认且关键歧义消失才进入原有回复生成链。完成操作原样重放沿既有助手会话结果，不推进新输入或再次调用模型；修改原操作、来源删除或范围变化拒绝重放。旧 `/api/reply/explore` 返回 `409 exploration_protocol_changed`。

正式 052 保存探索的有限正文、来源身份及删除依赖；原15分钟期限不因刷新重置，自动更新最多3次，暂停任务拒绝继续。实际生成在模型前及保存事务再次核对选择、A当前输入和Skill目录版本，过期后退出owner事务再独立擦除正文。探索只加载所选Skill的受控静态文件，不接表达样本。`test_persistent_reply_exploration` 使用正式生产装配、合成受控模型和真实HTTP／随机PostgreSQL，验证这些后端边界；它不证明页面、真人模型质量、原生读取或App验收。

## 授权经验草稿（09）

认证接口 `GET/POST /api/contacts/{contact_id}/skill-learning` 按宿主 owner 和已确认联系人隔离。GET 返回权威授权、独立待审草稿与原任务进度；启停严格接受 `{enabled, confirmed: true, expected_revision, operation_key}`，旧动作重放不能覆盖后来决定。明确恢复只接受 `{resume: true}`，复用原任务而不发布草稿。参数错误400，其他范围404，修订冲突409，持久化不可用503；响应不缓存。

正式 `064_skill_learning_drafts.sql` 承接063，保存默认关闭的授权、动作回执、独立草稿、有界批次、材料消费回执和方法身份。纠正优先，每批最多8份／24000字符，按完整JSON计入转义与目标方法元数据；普通经验通常至少两份，合法单份过半预算或下一份无法合入时可先处理已选完整材料，未选材料不记消费。允许无新增或复用，草稿不进入当前回复运行目录。

合法历史候选／编辑仅在学习取材局部使用 historical 核验，当前生成门保持原语义。实际参与的偏好与样本来历、原始来源及其世代都进入草稿依赖；删除在同一事务擦除相关草稿、批次与恢复副本，迟到提案不能重新写入。审核发布见11；反馈及政策表查询尚未开放。只在自有合成库验证，业务库未迁移；真实结果、原始失败及未验范围见[09集成任务](../.scratch/memory-skill-integration-preparation/issues/09-learning-drafts.md)。

## Skill 同输入审核与范围发布（11）

同联系人 `skill-learning/drafts/{draft_id}` 提供 GET 详情及 POST `edit`、`decision`、`compare`、`approve`。每个动作携当前草稿修订和 UUID 操作键；对照使用用户明确输入和联系人/精确场景/本人范围，批准还须有效 comparison 及范围、替代关系双确认。编辑、来源、偏好、目标版本或库修订变化使旧对照失效；未知提交结果沿原键恢复。草稿通过隔离只读视图试用，不临时发布。

`066_skill_review_publication.sql` 追加真实草稿、对照、发布、方法及最小调用关联。旧包 `review_origin=false` 不回填。场景进入权威输入和恢复合同；来源删除包括对照额外材料、隐藏导航、偏好与跨联系人实际/准备使用，首个后续 GET 前已清正文。准备格式仍为 version2/schema4，本票未改变 codec 的冻结结构。

普通回复、探索与审核共享的模型由 reply builder **构造时**设置 `max_retries=0`，每个模型轮最多一次物理 SDK 派发，实际次数与 callback 台账在传输测试中分别核对；公共 provider 默认仍为2，其他独立链不变。该 builder 为 DeepSeek ToolStrategy 明确关闭 thinking，预算 DTO 按已核 SDK 浅合并同一字段；只允许此明确扩展，其余附加正文仍拒绝。已批准 ECNU 配置不添加 thinking；未知 DeepSeek profile/counter 继续在本地拒绝，不自动获准。SDK 本地 Mock 仅证明序列化与计账合同，不证明外部调用成功、供应商 token 精度或上界。实际命令、原失败及页面/模型/App边界见[11集成记录](../.scratch/memory-skill-integration-preparation/frontier-11-validation.md)。

## Skill 更新、合并与历史回滚（12）

`GET /api/contacts/{contact_id}/skill-learning/skills`列出当前联系人可管理的真实合法历史，单项路径追加`/{skill_id}`。`POST /{skill_id}/rollback`严格接受`{version_id, expected_revision, expected_current_version_id, operation_key}`，当前版本已删除时`expected_current_version_id`可为null。范围、来源、库修订或原动作结果变化时拒绝重放；回滚保持停用，合并中停用的其他Skill不会自动启用，原管理回滚入口同样遵守。

更新、合并仍形成待审草稿并通过同输入审核、编辑及范围／替代关系双确认；目标须匹配当前版本，混合范围拒绝合并。父版本完整来历在原取材范围复验，当前学习模型不读取其他联系人的私人原话或来源身份。`067_skill_history_operations.sql`追加复合Skill／版本键及无正文回滚回执；只安装001–067，后续政策表尚未查询。[12集成记录](../.scratch/memory-skill-integration-preparation/frontier-12-validation.md)记录实际命令、原失败及HTTP／页面／真实模型边界。

## 明确长期表达偏好（08）

认证接口为 `GET/POST /api/expression-preferences` 和 `GET/PATCH/DELETE /api/expression-preferences/{id}`；owner来自宿主。保存、修改必须携 `confirm_long_term: true`、用户操作UUID；修改／删除还需预期版本。scope的 `contact_id: null` 表示本人全局，或取已确认联系人；`reply_mode` 可空或为回应／改写／主动联系的真实输入类型。origin为明确手工保存或同联系人真实message来历。幂等冲突返回409，已删偏好返回410，持久化失败返回503。

当前联系人管理请求携 `?contact_id={id}`，认证HTTP验证联系人归属，SQL只读取本人全局和该联系人偏好；无查询范围的目录／单项请求只管理本人全局，不返回其他联系人正文。修改和删除同样在当前查询范围内复验，未知或其他owner的联系人返回404；当前React控制器始终携已选范围。

生产回复链有界读取适用偏好，当前明确意图优先，模型前与提交事务复验。回复回执与保存的助手会话提供生成时实际正文、范围和版本；修改后的目录不替换历史依据。删除偏好或参与来源清理相关回复、讨论和候选衍生样本；主动保存样本的独立偏好依赖不会因先删助手会话而消失。一次性指令、选择、复制和表达样本不会自动保存为长期偏好。

正式迁移为 `063_expression_preferences.sql`，在本任务自有隔离库验证真实001–062→063、旧资料/未知证明保持和重复执行；HTTP夹具不再直接应用pending。联系人物理维护须经 `persistence.contact_deletion.delete_contact` 在同一事务清理偏好派生闭包，去除无正文墓碑的联系人身份并保留失效操作键；直接SQL级联受FK阻止。当前没有整体联系人删除产品入口。准确命令、失败记录及未验范围见[08集成任务](../.scratch/memory-skill-integration-preparation/issues/08-expression-preferences.md)。业务库未升级，原生App/微信和真实模型质量未验。

会话授权管理沿用认证回环 HTTP 和当前运行 owner/微信账号范围：`GET /api/sync/cli-bindings` 只返回 active 绑定的 `binding_id/contact_id/conversation_locator/display_name/status`，包含 CLI 列表消失的绑定。`POST /api/sync/cli-bindings/revoke` 严格接受 `{contact_id,binding_id}`，复核完整范围后在 SyncHost 同一 cycle 锁中幂等撤销。最多等待 4 秒取得锁，超时返回 `409 cli_binding_revoke_busy` 且不执行迟到撤销；跨范围为 `404 cli_binding_not_found`，其他失败不会包装成功。成功响应后不再新增该绑定的 tail，历史资料与绑定记录保留。批量 confirm 仍为追加；可选 `observed_display_name` 核对服务端最后复读的名称，任一不符整批拒绝。携带该字段且省略 `contact_id` 的明确新建选择若在最终确认时已存在 active 绑定，同样整批返回 `409 cli_binding_rejected` / `selection_stale`，不静默复用既有联系人或部分创建其他项。显式指定相同联系人仍可重放，原 `display_name` 仍可自定义，未提供新字段的既有调用兼容。此检查不锁住外部微信后续改名，后续变化仍需撤销后重新确认。

`tests.integration.server.test_binding_consent` 自建并回收随机 `_test` 库、正式迁移、生产 `notalone.server.command` 和合成 CLI，只通过真实 HTTP 观察授权与历史结果，并在 CLI 进程边界核验 tail。不依赖默认测试库、私人 `.env`、真实微信或模型；既有测试的 `NOTALONE_TEST_DATABASE_URL` 仍需显式隔离。

桌面端代码在 [desktop/](../desktop/README.md)，Mac 平台能力在 [native/macos/](../native/macos/README.md)。后端不会发送外部聊天消息，联系人范围和用户确认规则见 [产品领域文档](../CONTEXT.md)。

文字同步的一次性 `tail`、单会话 `tail_follow` 和全局会话事件流均显式传入 `--include-media-paths false` 与 `--strict-read-only`，保留非文字事件的最小计数及水位。v1.6.25 同二进制 schema 声明媒体路径补齐默认开启；严格只读不能代替这一关闭参数。外置 CLI 不支持参数时按既有命令错误失败，不回退到媒体默认。75 项相关合成回归通过；真实配置初始化、事件/游标兼容、媒体查询是否关闭及其他 CLI 版本兼容仍需运行验收，见[任务 20](../.scratch/mac-desktop-app/issues/20-mac-app-delivery.md)。

## 真实微信单联系人验证边界（2026-10-10）

固定 CLI v1.6.25 在授权单联系人、严格只读与无网络的本机隔离下，已确认用户测试新事件到达。生产有界轮询引擎与正式 PostgreSQL 仓储在独立随机 `_test` 库验证：入库 1 条，重启与重新开启同步新增 0，关闭期间 CLI 调用 0；临时库已清理。未使用模型或业务库，未发送消息。此轮不证明全局会话事件流、异常重启、双联系人切换或完整桌面闭环。

单次 tail 使用完整 JSON envelope，以实时来源、精确会话、无警告和 has_more=false 确认检查完成；空结果不推进游标。不能证明来源或存在后续页时保留未完成状态，当前不执行分页。follow 仍使用 JSONL。相关公开接口与后台合成回归 85/85；现场范围及剩余项见[验收台账](../docs/macos-app-permissions-and-errors.md)。

2026-10-10 追加故障验收：对本轮自有且已核对可执行文件的单次tail进程中断，生产适配器报告cli_command_failed；消息数0、游标不变。显式retry_backfill后补回1条、补齐错误清除；后续重启/重开不重入，关闭零读取，自有进程和临时库均清理。这是单次读取故障后的显式恢复，不能替代全局流自动退避或App退出验证。该记录属于入口修复前的单次读取验收；最新全局流入口与结果如下。

## 当前全局流诊断与恢复（2026-10-10 23:55）

2026-10-11分时发送补验已通过10分钟后台持续同步与去重：用户授权Computer Use发送3条约定测试文字，正式后台线程运行601.5秒，120次采样均活跃、失败0、流进程1；三条各入库1次、游标推进，关闭后零读取，进程与临时库清理。选定会话新增全局事件0，消息由安全对账读取，因此不作为全局事件触发链路通过证据，也不代表小时级、高负载、双联系人或最终App验收。OCR与模型未运行，产品代码未改。

前一轮空闲连续运行补验（2026-10-11）：正式后台线程与真实CLI连续运行601.6秒，120次采样均活跃、后台错误0、仅1个流进程；关闭后零读取，进程及临时库已清理。该轮未出现约定的新测试消息，只取得10分钟空闲存活证据；这不是漏消息结论。后续分时发送结果见上段。OCR、模型和App未运行。

鉴权follow-smoke接口现已接到正式后台引擎，开始/中断/状态不调用旧fallback或OCR。结束仅结束诊断，正常同步继续；关闭总开关或宿主停止才停止读取。全局流失败保留有界轮询并在3秒起、最长60秒的指数退避后重连，沿用全局cursor；明确不支持的CLI不自动重试。解析线程退出与进程回收分离，回收失败可重试，不能丢失旧进程引用后继续拉起新流。

7个相关unittest模块120/120；真实固定CLI与生产引擎、SyncHost、控制器、进程内鉴权路由和独立PostgreSQL通过中断/意外退出自动恢复、恢复后新消息入库及去重、结束诊断继续同步、关闭零读取。所有测试进程和临时库已清理。正文仅用户确认的单联系人测试文字，OCR和模型未运行。未覆盖网络HTTP监听、常驻后台线程、最终Electron退出、双联系人切换和中断期间新消息；完整范围见[运行手册](../.scratch/native-app-backend/follow-smoke-runbook-20261005.md)。

2026-10-11复验更正：前述进程内脚本的host.check会主动请求重试，自动恢复应以本次正式SyncHost后台线程结果为准：不调用立即检查，中断后约3.2秒重连，意外退出同样恢复。首轮补齐因验收层发现非约定测试消息而被拒绝，保留失败记录；核对文字并另起独立验收后，关闭期间CLI调用0、新流0、计数不变，用户确认发送新测试文字，重开按保存游标补齐1→2，等待16秒后台对账仍2、backfill_failure=null。自有进程和临时库已清理，生产代码未改。正式线程和关闭期间补齐已有真实证据；故障期间新增消息、长时稳定性、双联系人、网络HTTP及最终App退出仍未验收，OCR保持暂停。

2026-10-11追加故障窗口验收：总开关持续开启，终止自有真实CLI流并在验收runner边界暂时阻止流重建和单次读取。用户在故障期间发送约定测试文字后解除注入；正式后台线程无手动检查或重试，11.77秒自动补入1条，全局流自动恢复，安全对账无重复、补齐错误为空。故障期间消息数与游标不变，最终自有进程和临时库已清理。该项现已通过，属于受控CLI不可用故障与真实单联系人数据的组合验证，不代表全部故障类型或最终App验收；OCR和模型未运行，生产代码未改。

明确方法反馈使用 `GET/POST /api/contacts/{id}/skill-learning/policies`；提交包含已核验的Skill、版本、具体`method_id`或明确`null`整个Skill、`scope`、`expected_revision`和`operation_key`。撤销使用 `POST .../policies/{policy_id}/undo`。canonical068只保存范围决定和无正文动作，普通意见不写政策，长期修订仍走草稿审核；实际候选验证范围见[13记录](../.scratch/memory-skill-integration-preparation/frontier-13-validation.md)。

### 分层回复的独立质量与快速对照

逐组输出审阅须保存 `reply.quality.reply_review_binding(case, arm, calls)` 的 `binding`，
同时固定实际请求／响应、最终候选、持久依据与两侧资料摘要；更换其中任一项不能沿用旧审阅。
报告还会交叉核验公开生成回执、独立依据读取和实际模型响应；正式来源逐次核对原整理 case 的实际输出摘要。

正式后端会把同一分层资料服务接入回复。operator 配置可用
`schema_version: organization-runtime-v2`，保留既有 `suite_directory` 和
`organization_budget`，另加 `reply`：`directory` 指向私有回复证据目录，
`contact_budget`、`owner_budget` 分别使用显式 `LayeredReplyBudget` 字段，
`scenario_read` 使用 `calls`、`paragraphs`、`characters`；不用的一侧填 `null`。
缺少配置、来源或有效资格时保留原 L1，读取预算变化不会改变整理合同。

快速合成对照入口（默认只生成被阻塞的零调用记录）：

```bash
PYTHONPATH=src python -m notalone.experiments.reply_comparison \
  --input-package /absolute/package.json --output-directory /absolute/new-output
```

输入包包含 `manifest`、`cases`、`contact_budget`、`owner_budget`。manifest 由
`build_manifest` 从实际 `build_reply_contract` 构造；每例的 `input_package`
包含已确认的 `scope`、完整 `request`、`installed_l1_version` 回执，另记录真实
整理输出摘要及支持审阅。执行时增加 `--execute --synthetic-confirmed`、
`--database-url-env NAME`、`--expected-test-database NAME_test`、`--api-key-env NAME`。
只在明确自有 `_test` 库内，才可用 `--controlled-layered-installation` 读取已受控安装
的合法合成候选；它不会授予生产自动使用资格，也不会替用户发送消息。
每例还须冻结 `installation_binding`：原完整获审 C 输出、原引用到实际 L1 的版本映射，
以及该例唯一预期侧的实际 profile／scenario 版本、完整正文及摘要。另一侧必须没有
已安装资料；单侧对照仅使用该侧预算，并明确报告另一侧未覆盖。每组外发前重新核对
安装状态，生成后核对持久依据；更换候选、来源映射或增加另一侧资料时阻断该组。

每组最多 6 次、总计最多 48 次物理请求，SDK/传输无重试、无重定向。
生成及独立复核共用一个不可续跑账本；失败、未知和未执行组完整保留，
不能替换失败例凑数。`bundle.json` 为私有 0600 实际请求、响应、依据及账本回执。
可信读取资格会重新核原物理账本；正式正例还须绑定活的整理资格回执及每例
`organization_dependencies`（`reply_case_id`、原 `case_id`、`input_sha256`、
`case_evidence_sha256`），来源删除或撤销后关闭。Agent 审阅和四例冒烟只报告
实际覆盖，正式资格仍为 `unknown`；原整理侧 800 次累计账本保持独立。
