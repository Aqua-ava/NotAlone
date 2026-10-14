# 原文兜底核对与腾讯提取层对照

## 本次范围

用户要求先核对原文兜底、补齐缺口，再用相同失败案例对测腾讯方案；随后明确只测公开合成案例。
不读取私人聊天、不操作 App、不写业务记忆、不改变自动采纳规则。公开模型输入只送既有 ECNU 端点。

## 原文兜底

已有链路：`PostgresIngestRepository` 独立保存规范消息与来源引用；`PostgresExtractionTraceStore`
提供记忆／消息反查；`HistoryToolAccess` 直接从规范消息 search、按本轮锚点 query 前后文；
`LangChainReplyRuntime` 返回本轮原文证据；`ReplyGenerator` 合并后用
`RetrievalReplyContext.validate_current` 再查正文、来源、时间与状态，然后校验引用并保存。
以上不是只检索已提炼记忆；没有候选或确认记忆也可以补查原文。

本次没有另建原文存储或新检索服务。补充模型使用说明：需历史细节时不把记忆为空当原文不存在，
使用短关键词，明确空格词为 AND，人物／否定／条件／计划阶段不明时展开前后文。
已有三次 Tool 预算、空结果停查、联系人隔离和改写历史授权继续有效。

新增 `test_original_message_fallback.py` 经 `ReplyGenerator.generate` 公共入口覆盖：

- 零候选／零确认记忆、初始上下文只有当前消息，search→query 找回旧计划及“还没定”限定，
  生成结果引用原消息，存储快照保留原文，另一联系人的同词消息不进入依据。
- 模型最后响应前模拟原来源消息消失，生产复验拒绝旧证据。

这两条是既有能力的贯通回归，首次运行即通过，不冒称先有功能红例再修复。
模型是合成脚本，验证工具装配、证据和复验行为，不证明真实模型必然选择正确查询或忠实措辞。
关键词子串检索仍可能漏掉同义表达，原文保留不等于保证召回；旧追踪缺失也没有被补造。

## 对照计划与判据

- 固定腾讯源码 commit：`fb0610ee19287a58a96d4b6ffae803aa581d53de`，
  [`src/core/prompts/l1-extraction.ts`](https://github.com/TencentCloud/TencentDB-Agent-Memory/blob/fb0610ee19287a58a96d4b6ffae803aa581d53de/src/core/prompts/l1-extraction.ts)。
- 固定既有公开 Gold 中 A01、A02、A05、A06、B01、B02，输入消息、目标、来源 ID、时间均不改。
  覆盖未知第三人、邀约阶段、借车方向、到达与当前状态、报价条件、第三人历史与当前未知。
- 两臂使用同一配置模型、temperature=0、thinking enabled，各窗口每臂一次，交替先后顺序。
  NotAlone 用当前生产提取提示和工具 schema；腾讯用原生提示及 JSON 文本输出。
  腾讯原框架面向人机对话；本适配保留两位真人的 `sender`，绝不把用户本人冒充 AI。
  target/context 分别映射新消息／背景消息，额外只解释双方 sender 和时区，不添加纠错示例。
- 空旧记忆库，腾讯无相似候选时按上游规则直接 store，因此本次只测提取层，未部署腾讯完整服务，
  不评估其已有记忆冲突合并、检索、L2/L3 或 NotAlone 的 V 核验及自动采纳。
- 按原 Gold 必需命题核对正文保留率、无依据扩写、人物、否定、条件、计划／完成阶段与来源。
  腾讯没有的产品字段单列“不适用／未测”，不因为不同 schema 判成语义错误；同样不能代签产品契约通过。
  不修改 Gold、不按结果补例、不把一个窗口的重复输出多计分。技术失败保留分母、单独报告。

运行器：`scripts/compare_tencent_extraction.py`；输入、提示、Gold、请求、原响应及收据保存在忽略目录
`desktop/artifacts/tencent-extraction-comparison-20261014/`。计划先于请求落盘，不输出凭据；每个原计划位置最多发一次。

首场 A01/NotAlone 返回 HTTP 500，实际 1 次，无重试。首收据保留。
继续阶段仅执行原计划剩余 11 个未发送位置，使用原请求字节（模型配置除外）和原 Gold；
此阶段总上限仍为 12 次，不补首例。后续每个 HTTP 错误同样单独记录，传输／落盘异常停止。

原计划最终腾讯六次返回，NotAlone 两次返回、四次 HTTP 500。工具 schema 经本地核对与
`convert_to_openai_tool(EXTRACTION_SCHEMA)` 完全一致。官方
[DeepSeek 协议](https://api-docs.deepseek.com/api/create-chat-completion/)
说明思考模式不支持强制工具选择；这支持兼容性假设，但不能单凭官方文档确认 ECNU 500 根因，
同场 B01/B02 强制协议实际成功也说明不能把全部返回视为同一后端行为。

为完成语义比较，单独冻结并执行 NotAlone 六次兼容变体：仅省略 `tool_choice`，原提示、
schema、输入不变，六次全部返回。它不是生产强制工具协议已通过的证据。
独审又发现首轮腾讯身份说明写 `owner=用户本人`，实际 sender 为 `self`；首轮六次不得用于
最终性能结论。单独修正为 `self=用户本人` 后，再执行腾讯六次；不改原消息、目标或 Gold，
不覆盖旧响应。最终实际 24 次：原计划12、兼容6、身份说明修正6；20次返回、4次HTTP500，
各阶段已关闭，没有自动重试或剩余调用。失败均来自原强制协议的 A01/A02/A05/A06。

请求模型别名沿根配置 `ecnu-max`，响应出现 `deepseek-flash` 和 `deepseek-v4-flash`。
因此只能称同一配置端点／别名下的提取层试验，不能证明各请求用了完全相同权重。
两套提示服务的产品目标也不同：腾讯筛选长期核心记忆，我们明确要求保留本批关系主张。
空结果反映此用途下的覆盖不足，不证明腾讯在其原生任务上的总体质量差。

## 验证与结果

### 原文链路与工程验证

- 新贯通回归首次 2/2 通过；完整回复单测 311/311 通过。
- 初次合并测试 88 项中 15 项在旧默认测试库的来源处理记录写入阶段失败，其余 73 项通过。
  随后创建独立随机 `_test` 库，应用全部 57 条迁移；检索、来源删除、导入追踪与提取追踪共
  74 项，其中 73 项通过，1 项的两个 subject 子场景失败。临时库已在 finally 中删除。
- 剩余失败是 `test_committed_invalidation_is_reconciled_after_receipt_fault_and_retry`：
  恢复事件返回全部提交收据，断言却与筛选后的单条失效收据比较。本次未修改该代码／测试，
  不将这项失败算作全部集成通过，也不扩展为本轮记忆恢复重构。
- 对测脚本与新增测试类型检查通过。回复 runtime 文件仍有六项类型错误；从 `HEAD` 导出
  修改前文件，以同一 `MYPYPATH` 核验有相同六项，均不在本次新增提示行。
- 未启动真实 App、微信、OCR 或业务 Worker；脚本模型回归不能证明真实回复模型一定补查。

实际命令（Python 均先加载 Conda shell 并 `conda activate NotAlone`；首条在 `backend/`，其余在仓库根目录）：

```bash
python -m unittest tests.unit.reply.test_original_message_fallback -v
python -m unittest discover -s backend/tests/unit/reply -t backend -q
MYPYPATH=backend/src:backend python -m mypy --follow-imports=silent scripts/compare_tencent_extraction.py backend/tests/unit/reply/test_original_message_fallback.py
```

数据库复测通过 Python 调用 `database_migrations.migrate`，再在 `backend/` 执行：

```bash
python -m unittest tests.integration.persistence.test_postgres_retrieval tests.integration.persistence.test_source_deletion tests.integration.ingest.test_source_processing_trace tests.integration.memory_extraction.test_extraction_trace -q
```

对测按顺序调用同一脚本的 `prepare`、`run`、`continue-unattempted`、`compatible`、
`corrected-tencent`，输出目录均为前述忽略目录。实际 HTTP 收据与最终响应保留在端侧，
未提交原始模型响应或 `.env`。源码与报告只包含合成资料和公开方法。

### 六窗口结果

最终比较使用 `compatible/` 和 `corrected-tencent/` 的独立结果；原场不混入新臂。
“核心信息出现”只问相应含义是否出现在记忆正文中，**不等于原 Gold 全条件通过率**：
新增无依据内容、错误标签、引用不全或错误时间仍独立记为缺陷。场景标题不算已保存记忆。

| 窗口／必需核心信息数 | NotAlone 兼容变体 | 腾讯修正适配后的提取 |
| --- | --- | --- |
| A01 未知第三人部门／2 | 两项出现；仍须按原 Gold 核对歧义槽 | 空记忆，0项 |
| A02 老李邀约／1 | 核心出现，但补了无来源的“邀约发生在9月15日前后” | 空记忆，0项 |
| A05 姐姐借车／1 | 借出人、车的归属和接收方均保留 | 空记忆，0项 |
| A06 到机场、等行李／2 | 两项出现，但历史到达与瞬时等待合并，共用有效区间，完整契约不通过 | 空记忆，0项 |
| B01 报价、报名未定、有空才咨询／3 | 三项出现；报价误归偏好，前两项缺恢复课程身份的背景来源 | 三项合并保留，含未决定与条件；缺恢复泥塑课身份的背景来源。独立状态／期限字段属 schema 差异，未测，不作为语义扣分 |
| B02 第三人历史、当前不知道／2 | 只保留历史，遗漏当前知识状态 | 两项合并保留，但 metadata 把暑假编为7月1日至8月31日的精确区间 |

NotAlone 核心信息出现 10/11，腾讯5/11；两边上述语义／来源／完整字段缺陷仍在，不能把
10/11或5/11称为保真通过率。腾讯保留了我方漏掉的“当前不知道”，说明不能只按总数判断
所有类型都更好。不签全链路保真通过，
未执行 V 核验或写入采纳路径，也不修改旧任务的真实聊天 6/12、可选 2/6 或任何放行表。
腾讯的短期信息筛选规则与 NotAlone 需要保留的内容有明显差别，不能直接整体替换。

### 评审

Standards 轴初审无标准违例；Spec 轴确认原文回归覆盖，并要求分开报告新增兼容调用与旧协议。
独立语义复核确认首轮适配缺陷、宽松出现数不能叫 Gold 通过率，以及报价的背景来源缺失。
修正后的腾讯六窗经独立 Spec 复核，确认出现5/11、暑假日期扩写及来源缺失；其提出的
schema差异不能计语义错误已在表中明确。比较仅针对一次小样本提取，不能推广为
腾讯原生系统或 NotAlone 的整体质量排名。

## 后续：修复记忆提取漏记与误解

用户进一步要求修复上述问题，再使用原六例验证。继续只向既有 ECNU 端点发送公开合成
窗口，没有读取私人聊天、启动 App、写入业务库或改变自动采纳放行表。

本次修改生产提取提示及三个字段的说明，14 个输出字段、解析和采纳规则保持原合同：

- 按独立主张检查否定、未决、知情状态及条件意向，区分“说话者不知道”与模型证据不足。
- 已完成动作与当前状态分别选择类别和时间；使用不同于原案例的入住／等电梯示例。
- 一次具体评价不推成长期偏好，补全事项时同时保留必要的背景引用。
- 消息观察日期不能冒充历史事件发生日；不从亲属性别推测联系人性别。
- `alternatives` 只说明实际歧义，`interpretation_reason` 不把单纯否定扩写成更正前情。
- 消除近期状态必须填失效日的冲突表述：决定／知情状态未说明期限时保留 null；
  瞬时状态与明确期间仍按原规则推算。

复测沿原 Gold、六个原窗口及工具结构，继续使用上文省略强制 `tool_choice` 的兼容协议。
新增 `prepare-repair` 在生成计划前核对原输入、参考文件摘要和工具结构，仅允许更改
系统提示与 schema 的说明文字；每场六次、零重试。它不证明生产强制工具协议、V 核验、
最终入库或完整产品链路已经通过。

前三轮的失败全部保留，没有挑选最好的一条拼成最终成绩：第一轮仍合并机场状态，且
补了联系人性别；第二轮核心含义11/11出现，但完整字段仅7/11通过，未知第三人的扩写
和历史／知情状态的主题、来源、期限仍错；第三轮修好第三人歧义说明，仍把未决定状态
错误设为当天过期。最后一次修改专门消除了期限规则冲突。

原基线按同一完整 Gold 重新独审为5/11项通过（A01两项、A05、B01条件咨询、B02历史），
不同于上文仅统计正文信息出现的10/11。评分检查正文、全部结构化字段、备选解释与理由；
同一核心命题的重复候选只计一次。所有这些都是已知失败案例的开发回归，不是独立留出
或真实聊天泛化评测，也不满足维度自动放行资格。

复测命令（每次使用尚不存在的新输出目录）：

```bash
python scripts/compare_tencent_extraction.py prepare-repair \
  --baseline desktop/artifacts/tencent-extraction-comparison-20261014/compatible \
  --output desktop/artifacts/memory-extraction-repair-20261014/round4
python scripts/compare_tencent_extraction.py run \
  --output desktop/artifacts/memory-extraction-repair-20261014/round4
```

本地验证命令：

```bash
python -m unittest discover -s backend/tests/unit/memory_extraction -t backend -q
python -m unittest discover -s backend/tests/unit/experiments -t backend -p test_extraction_repair_plan.py -q
MYPYPATH=backend/src:backend python -m mypy --follow-imports=silent scripts/compare_tencent_extraction.py backend/src/notalone/memory_extraction/adapters.py backend/tests/unit/experiments/test_extraction_repair_plan.py
```

392 个记忆提取单元测试、3 个复测计划测试及上述类型检查通过；计划测试只验证输入与
协议冻结，不冒充中文语义质量测试。模型请求、返回和收据保留在被忽略的
`desktop/artifacts/memory-extraction-repair-20261014/`，不提交原始模型返回。

### 最终复测结果与未完成项

本次新增四场、共24次请求，24次均返回，每场结束收据均为6次已执行、0次未用；没有
重试或替换失败位置。配置别名仍为 `ecnu-max`，四场均观察到 `deepseek-flash` 与
`deepseek-v4-flash` 两种响应标签，不能证明后台模型权重一致。第四场使用最终代码，
不拿第三场较好的单项输出代替第四场结果。

| 原窗口 | 第四场结果 | 仍需处理 |
| --- | --- | --- |
| A01 未知第三人 | 正负信息、未知身份及语用标签保留，无更正前情扩写 | 拆成两条后只靠共同来源关联，同一人的关系未在正文明确保留，完整保真不签通过 |
| A02 老李邀约 | 第一条正确保留邀请，没有补发生日 | 额外生成未来计划，标签与原 Gold 分支不一致；原核心只计一次，不以正确第一条抵消额外候选缺陷 |
| A05 姐姐借车 | 人物、所有权、接收者与历史阶段正确 | 添加非原低风险白名单的“借用”，产生无必要的保守降级；没有更改风险门来抹掉它 |
| A06 机场 | 到达与等行李分成历史／近期两条，各自使用正确时间槽 | 本窗通过；正文日期按观察日期理解，不认证实际到达时刻 |
| B01 课程 | 一次报价评价、报名未定均正确分类、补全引用，未定状态不再当天过期 | 条件咨询的两个时间槽错误留 null，原完整周末期间丢失；不修改 Gold 放宽 |
| B02 表弟 | 历史和“不知道当前工作”均保留且各用正确类别、观察点和期限 | 知情状态仍多引用早期历史消息，不符合原最小来源组合 |

这轮证明了具体漏记与一些误解有所改善，也证明了仅修改提示与说明尚不能稳定满足
整组完整判据。**本任务尚未达到“全部修好”**；不发布整组通过、真实聊天准确率或采纳
放行结论。剩余问题分别是拆分后的同一人物关联、冗余计划、无依据风险、条件期间遗漏
和多余来源，不能靠反复调用直到碰巧全绿来关闭。后续须继续在原判据下处理并验证稳定性。

本次计划 SHA-256（原始请求、输出与每场收据仍在端侧）：

- round1：`5e4ed15ecee977a5e164e44a9a9dd6b34ec11d93ee395267c233eb28a50e5fa4`
- round2：`c7e383f835f612b904625c02bd4db98e0eed981c76bfa21a2fb33402e03fa2a8`
- round3：`f122a02520fd82005f055bb77cde56f2b01c5e2014e364e6e7d2782ad6efc479`
- round4：`ec81e1da41623de319f8531b878b09fb283bc336e6ed52313bbea49ad883cb9d`

Standards 独审未发现代码标准问题；Spec 独审发现上述未完成项，结果没有被单元测试
或宽松的信息出现数覆盖。此次只验证提取层与计划保护，不重跑数据库或 App 验收。
