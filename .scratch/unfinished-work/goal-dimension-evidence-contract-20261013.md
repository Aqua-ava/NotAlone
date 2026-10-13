# 原03运行维度依据实施合同与隔离证据（2026-10-13）

用户本轮批准[四类运行字段方案](goal-memory-runtime-fields-20261013.md)：候选新增可空、带版本的 `dimension_evidence JSONB`；所有相关维度须同时具备当前有效依据、并分别获用户放行。旧候选保持未知，不回填或重新采纳。本片只迁移自己创建的合成测试库；业务库升级仍需单独批准。主 Agent 独占 Git，子 Agent 不暂存或提交。

## 既有约束与本片边界

本片修订 ADR-036 的“单一优先键”接口，不改变原语用、0.7、风险白名单或默认空放行表。旧 `dimension_key` 作为兼容诊断保留；有效门改为相关集合的合取。质量资格仍由原至少15例、假事0、错人0、一般错误不超过1及逐类用户批准决定；运行字段的结构和来源有效性不能代替这些证据。

现 E 14字段与 V 4字段不变。V 的 `supported` 和逐字片段只证明既有来源核验契约，不能独自证明保真限定、指代目标、转述关系。程序可以把片段转换为当前窗口内的定位依据和受控媒体类型；无法唯一推导的关系明确未知。不会新增模型调用、读取新资料、上传真实聊天、采集视觉帧或改评测答案。

## 接口与数据合同

沿用的公开接缝是 `ExtractionFlow.run`、`load_contact_messages`、`DimensionRelease.allows`、`MemoryAdoption.adopt`、`MemoryPort.create_candidate/get_candidate/list_pending_candidates`、现有候选读取 API 和 `database_migrations.migrate`。新增领域值对象负责严格 JSON 往返，提取模块负责对实际窗口核验定位；不把 SQL、模型或后台调度放入领域对象。实现入口为[值对象](../../backend/src/notalone/memory/dimension_evidence.py)、[纯绑定](../../backend/src/notalone/memory/evidence_binding.py)、[实际装配](../../backend/src/notalone/memory_extraction/evidence.py)、[逐项门](../../backend/src/notalone/memory_extraction/dimensions.py)、[存储复核](../../backend/src/notalone/persistence/dimension_evidence.py)与[056迁移](../../backend/database/migrations/056_memory_candidate_dimension_evidence.sql)；决策见[ADR-046](../../architecture/adr/046-source-bound-dimension-evidence.md)，批准状态见[放行台账](../../docs/memory-adoption-dimension-release-ledger.md)。

`dimension_evidence` 版本1有10个顶层字段：`version/scope/candidate_sha256/window_sha256/pragmatics/messages/paraphrase/reference/media/reported`。语用快照是三个受控枚举，不能从没有这些标签的旧候选重建。候选共有字段摘要覆盖正文、类别、主题、主体、直接来源、日期、置信度、风险、备选和理由；Fact核验另与快照逐项比对语用标签，只有标签改变也不能复用旧依据。

完整窗口消息保存稳定消息／活动来源引用标识、说话人、来源时间、实际类型／文字表示及正文摘要，另保存既有原资料`content_sha256`、引用原始载荷及定位的合成摘要；JSONB仅有最终摘要，没有原载荷副本，也没有读源文件。依据中的日期和来源时间摘要统一UTC瞬间，等价时区表示不应导致失效，真实时间变化仍拒绝；原窗口、E／Gold时间表示和raw载荷不归一，载荷字面变化仍失效。持久来源指纹一致不认证外部文件未变或真实来源真实性。片段是半开字符区间及摘要。四类依据表达逐字对应、指代提及／目标、实际媒体类型及文字／占位表示、直接来源说话人及被转述主体关系，全部可空；未知、歧义、来源失效、时间过期、摘要或任一语用标签变化、跨范围依赖均不能通过。

相关维度不能由模型自行声明以排除门槛。当前`required_dimensions`是保守超集：固定主体、语用、保真、指代、转述5项；日期或近期状态加时间，缺少受控纯文字表示加媒体，最多7项。它不是已证完整的语义相关性分类器，缺依据不能作为“无关”证据。每项须同范围、当前且有效，再与逐类批准表做AND；任何未获批或未知项保持待确认。运维显式旧回退继续按原三门语义运行，默认空表不变。

生产`build_dimension_evidence`只从实际loader与窗口装配：完全同字的整条V片段可生成对齐；实际文字消息类型及表示可以投影；`reference/reported`仍是None，当前没有这两类生产valid路径。合成完整锚点只测AND协议，不是独立来源消歧、转述质量或四类producer完成证据。新`source_bound`仅为当前运行复核状态，不能由JSON输入，JSON往返重新置false，实际存储回读再核；它不是模型语义真值。

旧NULL读为未知，新字段可经现有候选API查看和JSON导出；本片没有App界面验收或新的编辑入口。手动候选不伪造证据。保存后自动确认在同联系人事务锁下复查，来源变化／证明丢失则保留pending，不能先失效旧记忆。来源删除清除依赖该来源的候选依据，包含仅上下文消息；多来源消息仍按原规则保留，不以保留一来源恢复旧证明。拒绝／删除候选清除字段，删除完成验证检查残留依据。旧055结构可读NULL与人工确认，写新依据明确拒绝，不自动升级。

## 验证顺序

1. 先在公开领域／存储接缝写真实负控：缺字段版本、模型布尔代替锚点、跨范围／窗口引用、歧义及摘要漂移，验证旧 NULL 和严格日期槽仍拒绝。
2. 再逐片最小实现 DTO 往返、受控 loader 与 Flow 装配、AND 门及候选保存／读取。
3. 用新随机 `_test` 库执行原001–055前缀，插入合成旧候选，再执行056；复跑幂等，旧行保持 NULL，核新字段保存、API投影、来源删除和资源清理。
4. 各片只做相关 unit／隔离 PG／类型验证；所有模型、App、CLI、视觉采集和业务库操作为0。保存失败、实际时长及源码快照，完成后交两轴独审，由主 Agent 独立主题提交。

以上范围起初在实现前登记，以下是本片实际证据，不能代签真实模型质量或原03全部AC。

## 实际红绿与最终相关结果

全部输入是独立公开合成，Conda `NotAlone`，`NOTALONE_DISABLE_DOTENV=1`；私有验证器清除秘密环境键，并拒绝DNS、socket连接及HTTPX出站、`.env`读取。最终守卫同时覆盖`builtins.open/io.open`；早期只有前者的记录按其实际范围保留。PG连接仅允许`/tmp`的postgres管理连接和本片实际创建的随机`_test`库，不访问业务库。

| 验证 | 实际记录 |
| --- | --- |
| DTO／窗外锚／候选保存 | 缺DTO导入与窗外定位真实red后绿；旧NULL、模型true伪依据、bool／float版本、未知字段及来源／范围漂移拒绝 |
| Flow与AND | 缺装配与单time遮蔽门实际red→green；保留原缺日期槽拒绝、explicit-null等正控，逐项放行缺一不得AUTO |
| 主体／媒体 | 伪造来源sender、用audio标签冒processed_text、缺media掩盖unknown表示均实际red→green；未知不得排除媒体 |
| 语用标签绑定 | 仅改speech_act／assertion_status／figurative_type，正文及共有字段不变，1方法3subcase真实fail（0.031999833秒）→green（0.037424167秒）；重新绑定也拒绝 |
| 保存与AUTO提交 | 联系人和self存后来源失效实际red→green；PG事务复核联系人／owner来源，保留pending且不写AUTO，不先失效旧记忆 |
| 原来源指纹 | 正文不变、只改原资料指纹或ref原载荷，2subcase真实fail（2.413646250秒）→green（0.340243750秒），DB指纹不认证源文件真实性 |
| 明确跨时区回读 | 独立Spec发现isoformat字面摘要问题；实际Asia/Taipei装配→UTC保存及UTC／+08回读，两subcase真fail（1.096102000秒）→green（0.356986125秒），无日期／有日期均核；同一来源真实晚1秒仍拒旧证明 |
| API | 新JSON／source-current投影首KeyError→green；旧NULL省略附项，实际内存HTTP接缝，无供应商或真实网络 |
| 最终相关unit＋API（v2） | 8模块108／108，fail/error/skip均0，1.026555708秒；守卫尝试0，模型HTTP／App0 |
| 最终隔离PG（v2） | 12／12，3.547459167秒，12个精确自有库全部gone；迁移、旧NULL、幂等、scope／version／标签形状、明确UTC与+08回读、上下文删除、事务拒绝、残留验证、候选拒绝及055兼容通过 |
| 类型（v2） | 当前18显式运行源码mypy通过，0.980664125秒，前后源码SHA相同；server仅新投影经上述API模块验证，不称整App无历史类型问题 |

持久证据目录为`/private/tmp/notalone-dimension-evidence-20261013-dhov3q9v/`，顶层0700、证据0600。当前最终摘要分别为`final-related-units-v2.json`、`final-isolated-pg-v2.json`、`final-types-v2.json`；P2前108／12／18快照、1.050190084／3.335890375／8.662071166秒及全部早期失败同目录保留，不覆盖新结果。最终12个PG库逐名检查，进程全部有限入口退出；不清理或删除任何非本片库、私人资料或全局资源。

首mypy有8项错误后修复，后续17源绿是历史快照，最终18源另签。残留删除探针最初两次因为夹具被整行删除而没有真正注入残留，属于夹具失败，不是产品red；后来先给规范消息第二来源、assert实际UPDATE一行才签有效验证。原来源指纹首修因构造参数顺序错误产生1error，再修后绿，失败保留。早期名为时区等价的测试只含+08输入和默认会话，首次即green（0.419128917秒；原名`pg-timezone-red`），不能证明跨时区；独立Spec后补上述明确UTC红绿，原记录不改。补丁未匹配／重复目标的0写失败及只读路径错误另记工具失败，不冒产品证据。

## 已采纳资料上下文依赖的最小待评审接缝

本片候选依据清除通过，但confirmed／owner资料仍由原`source_ids`删除规则维护。未来若AUTO资料仅借未列入直接来源的上下文定位，清除proof不会自动清其已采纳正文；当前空表与未知producer不能消除这项结构缺口，原03不因此全过。

现有`source_candidate_id`可在清proof前定位依赖候选：先在同owner/contact筛含被删来源／消息的候选JSONB，再按该候选集合查同范围confirmed以及同owner、关联该联系人候选的owner资料，并只取`adoption_method=auto`。032与009已有此关联，无需新DDL。调用方已有contact→owner锁顺序；手工已确认资料与仅相同原文的资料必须独立保留，不能按正文或昵称匹配。

要实现还须决定：AUTO版本是不可检索失效，还是清正文／相关缓存及回复材料；失效不能冒物理删除完成。多来源主消息可保留，但丢失旧定位来源不能自动恢复proof；候选仍有直接来源时的confirmed／invalidated状态、关联外键及manual版本保留需明确。应先写两种主体、手工版本、多来源、只上下文与重复删除的隔离负控，再走现有revision与删除复核路径。本片只给结构方案，没有改该已采纳删除合同或实现。

## 仍未签的范围

生产reference／reported有效装配、完整语义相关性分类、已采纳资料上下文删除、App界面查看／导出与真实模型质量均未由本片通过。业务库迁移未获批／未运行，默认放行表仍空，没有逐类放行批准。原03状态与AC由Root按实际证据更新，本子Agent不勾全部字段能力。两轴独审及固定文件SHA随后收口，当前不操作GitIndex。
