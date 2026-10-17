"""记忆提取的 LangChain 结构化输出运行时 adapter。"""

from __future__ import annotations

from typing import Any

from langchain_core.language_models import BaseChatModel

from notalone.memory.models import MemoryCategory
from notalone.memory.events import EVENT_PROPOSAL_SCHEMA
from notalone.memory_extraction.errors import (
    ExtractionInvalidOutputError,
    ExtractionRuntimeError,
)
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractionWindow,
    FigurativeType,
    MemoryTopic,
    SpeechAct,
)
from notalone.memory_extraction.runtime import ExtractionPayload
from notalone.memory_trace import TraceWriteError
from notalone.memory_trace.transport import invoke_traced_model

EXTRACTION_SYSTEM_PROMPT = """你从一位联系人的聊天消息窗口中提取值得复核的关系主张。
输出前按以下顺序检查，不输出检查过程：
1. 逐条 target 找出独立主张，包括否定、尚未决定、尚不知情，以及条件下才成立的意向。
   先确认主张是否有关系价值，再分别选字段；不能因同句另一主张已保存就漏掉它。
   说话者明确“不知道某人的当前情况”是说话者的知情状态，不是模型无法判断，
   也不是在断言那个人没有该情况。与纯粹质疑外部传闻的真假分开处理。
2. 每条候选只能使用一套一致的类别、阶段与有效期。已完成动作和仍持续的状态必须
   分成两条，不能合并后共同过期；当前知情或决策状态用 recent_state，正文写观察日期。
   例如“办完入住了，还在等电梯”：输出已办完入住的 common_fact（双 null），另输出
   在来源日期正在等电梯的 recent_state（观察点到当天结束），不是一条 recent_state。
   拆分也要保留同一人物关系；同一未知第三人的多项同阶段资料可以忠实合并。
3. 针对某一具体事项的一次评价用 relationship_note；只有来源明确支持可跨事项复用的
   习惯或偏好才用 preference。“觉得这个价格合适”本身不证明长期偏好。
4. 每条候选核对正文所用的人物、物品和事项来自哪些消息，补全名称所依赖的 context
   也必须进入 source_message_ids。所有文本字段只保留有来源的内容。
5. 消息日期只能标明观察或陈述的时间；来源未给历史事件发生日时，不能写成该事件
   在消息当天或前后发生。历史事件正文只保留原文时间精度，两时间槽无期限则留 null。
6. 用户和联系人始终使用这两个称呼，不换成带性别的他／她；亲属的性别不证明说话者
   的性别。第三方和物品的所属关系也用明确称呼，避免改写后出现新的代词歧义。
7. topic 优先使用来源明确支持的具体主题：课程学习及报名为 study，价格判断可为
   finance，亲属的历史经历为 family，职业与对职业的知情状态为 work；仅无适合的
   具体主题时使用 other。
先做语用解释，再决定是否输出：必须结合上下文理解语气，区分事实、计划、假设、转述、
问题、请求、纠正、玩笑、反讽和夸张。反讽、玩笑、抱怨不能按字面理解，如"你可真行啊"
不是赞赏。
speech_act 取值：assertion=直接陈述本人或双方的事实、经历、状态、习惯，含"我已经…"
"我平时…"；plan=尚待实现的打算；question=提问；request=请求或要求；report=转述第三方
的话或内容；correction=更正或撤回此前说法；unknown=无法判断。第一人称完成事实属于
assertion，不是 report。speech_act 描述发送者正在做什么：陈述用户、联系人或双方的
事实用 assertion，无论发送者是谁；本人明确参与的已发生接收、借用或赠予经历也沿
assertion + asserted，不因涉及第三方就改成转述。转引别人说法时先固定保存阶段：
若只保存已说／听闻的历史动作，用 report + reported，两时间槽沿无期限历史留null；
若保存真正被转引的未来安排本身，用 plan + reported，并沿该安排的原完整期间，
日期无法核实时留null。不能强迫report、升级asserted或把历史双null与未来期间混搭。
直接表达的第三方未来安排仍沿 plan + asserted，保留未知身份，不把未来事件写成
已完成或把纯第三方事件归给联系人本人。
否定陈述本身不是纠正动作，也不证明此前有人误认或提出过相反说法；只有本窗明示
更正／撤回，或提供先前主张与纠正关系，才用correction。否定句同时给出肯定信息，
也不能据此补出先前误认；只有所引用的窗内消息确有该前情时，才可在输出中说明。
身份未明第三人的职业／部门资料仍用relationship_note + report + reported，保留否定与
未知身份，不因陈述语气确定就改成common_fact或asserted。
尚未发生的日程、安排、约定、打算
一律属于 plan，即使语气确定、时间已定，如“我年底去哈尔滨看雪”“月底要交报告”
“这周末得加班”；只有已经发生或当前持续的事实才用 assertion。
状态必须双向保真：计划不能写成已经完成，已完成或当前状态也不能改成准备、打算或想要。
省略回答的物品、人物与状态应依据相连问题恢复；原文没有计划含义时不能为使句子完整补计划。
assertion_status 取值：asserted=把内容当作已成立的事实；hypothetical=假设；
conditional=条件；reported=转述；unknown=无法判断。
明确表达的打算是 plan + asserted：意向的存在明确不等于未来事件已完成。hypothetical
只用于原话的假设，conditional只用于原话带条件，不能把所有未发生的计划统称假设或条件。
figurative_type 取值：literal=按字面理解；joke=玩笑；sarcasm=反讽（字面褒义实为贬义或
相反）；hyperbole=夸张（"累死了""饿死了"）；unknown=无法判断。
category 只能取 common_fact、preference、taboo、recent_state、relationship_note 之一；
topic 只能取 health、work、family、travel、finance、study、emotion、other 之一；不要把
topic 的词（如 family、health、travel）填进 category。分类示例：习惯与口味用
preference，禁忌用 taboo，共同经历用 common_fact，近况与未来安排用 recent_state，
家人、朋友与关系动态用 relationship_note。
没有明确资料期限的已完成普通动作或经历用 common_fact，两时间槽均null；“刚／已经
完成”只限定历史动作，不证明当前仍持续，不因发生时间很近就用 recent_state。只有
原话说明现在仍持续的临时状态才沿 recent_state／观察点分支。
已收到邀约、本人参与的亲友借用或赠予等已发生关系经历用 relationship_note，不从
结果可能延续推断当前仍持续，也不证明已接受邀约或所有权转移。保存未来安排时用
recent_state + plan + asserted；保存已发生邀约的经历或转述时分别沿本人参与或
report + reported 标注，不把历史经历、未来期间和不同标签拼成一个字段分支。
先固定候选记的是邀约已经发生，还是未来安排：前者即使提到未来活动期间，两时间槽
仍沿历史经历留null；该期间属于邀约的内容，不是邀约事件的生效期。若另存未来安排，
则完整沿recent_state／plan分支和原期间，不能只把未来日期接到历史转述分支。
值得保留的暂时关系要求须保留“先／暂时”，用 relationship_note，不升级为长期 taboo。
示例：对方帮倒忙后说"你太厉害了，真是帮了我大忙"是 sarcasm；"你可真行，又给我添乱"这类挖苦抱怨只表达情绪，是 sarcasm，不要提取其中的字面事实；
"累死了"是 hyperbole；"我妈让我…"是 report + reported；反问句（如"我什么时候骗过你"）不要提取事实；一次性邀约（如"要不要一起去看展"）
同样不提取，无论标为 question 还是 request；被点破的吹牛（"你又开始吹了"）标 figurative_type=unknown。
confidence 反映你对事实与标签的把握，而不是事实的重要性：语气确定、证据在 target
消息里直接出现时应不低于 0.8；只有存在真实不确定时才低于 0.7。
风险标记只取主张及来源实际支持的风险；普通见面或娱乐邀约本身不证明敏感风险，
不能补潜在后果作风险，真实借款等敏感性仍须保留。
每条事实必须标注主体：这件事是谁的（self=用户本人，contact=联系人，shared=双方共同），
消息的发送者标注是判断依据，不得把用户自己说的内容记成联系人的事。用“我们”表达的
双方共同经历、约定或计划，主体标为 shared，不要记成单方的事。双方讨论、询问进度或
一方赠送物品，不足以把接收者的单方状态记成双方共同经历。原话未明确谁执行维修等动作
时，保留被动结果，不补执行者。窗口只有两位发送者不代表话题里只有两个人。
“他/她/那个人”的归属必须有原文或相连上下文的明确支持，
不能默认改写成用户或联系人。身份未明而值得复核的第三方主张保留第三方称呼，
否定归属中的人物也须保留：不能因为物品归第三人，就把原话否定的所有者换成另一方。
用 report + reported 并填写身份歧义的 alternatives；subject=contact 只表示联系人
范围的关系资料，不代表第三方就是联系人本人；用户明确讲自己的亲友时，其第三方
关系资料范围用self，仍须保留亲友称呼与report/reported，不能默认归到contact。
命题文本不写用户或联系人的
名字、昵称或备注，统一用“用户”“联系人”称呼双方，涉及第三方时沿用消息里的称呼。
只提取值得跨对话长期记住、或值得用户确认的主张；纯问题、寒暄（"吃了吗""在吗"）、
纯表情或语气词、一次性安排的细节、纯玩笑和夸张、转发或引用外部内容（视频、文章、
传闻）的命题、双方对外部信息的情绪反应、对第三方的情绪反应不要输出，如对方转来一条
“牛奶能助眠”的链接并说“不知道真的假的”，不要提取。不要从对话形式推断事实（如“某人向
另一人提起过某事”），也不要臆测双方亲友之间的互动。计划、假设、条件、转述、纠正或无法判断的内容如果对关系理解有帮助，可以输出，
但必须准确标注状态，不能写成确定事实。提到学校、公司或机构不证明说话者在那里
就读、任职或拥有某种身份；一次口号、玩笑、抱怨或操作建议不证明长期偏好、人格或
价值观。没有明确自述或相连证据时，不要补出这些结论。每条主张保留原文的否定、
程度、数量、条件与时间限定；同一句里的已发生事实和未来打算、长期偏好和临时状态
分开提取并分别标注，不能用 assertion 将整条未来安排升级为已发生。已完成动作
与现在仍持续的状态也分别形成候选，各自选择类别与时间槽，不以状态观察期代替
历史动作的双null，不能靠一条合并候选冒充两个完整字段分支。
假设与条件句（如“如果项目成了，我就换车”）
只要与关系理解有关，就应当输出并标 hypothetical 或 conditional，不要省略。
“我准备贷款30万加仓”应标记为计划或歧义，不得改写成“已经贷款30万”。
媒体占位文本（如"[图片]""[语音]"）只能推断发送行为偏好，不得推测消息内容。
窗口行里的 occurred_at 是消息时间，用来推算相对时间。occurred_at=unknown 表示
消息时间无法核实，不用当前时间或未引用上下文补出日期，也不据此推算相对日期。
无法核实的日期留空。valid_at 表示事实或安排的生效时间：未来计划、未来约定与
有时效的状态，在时间可核实时必须填写，按 occurred_at 推算带时区的 ISO 8601 时间，
例如“2026-10-01T09:00:00+08:00”，不能只写日期；已经发生
且没有明确时限的事实留空。
已发生且无明确期限的关系经历 valid_at、invalid_at 都为 null；正文可保留来源日期，
但消息观察日不是历史事件生效起点。暂时关系请求的 valid_at 取提出请求的来源观察点，
正文同时保留来源日期和暂时限定；持续期限无法推算时 invalid_at 留 null。
日期字段已有观察点也不能代替正文日期；暂时状态／关系请求须在正文中同时写明来源
日期或明确期间与“先／暂时”等原有限定，使跨期读取仍能辨认观察时点。
当前临时状态的 valid_at 使用该状态证据的 occurred_at，
这是观察时间，不得臆测更早的开始时间。临时状态的文本要带消息日期或明确期间，
不要让跨期检索仍把消息中的“现在”“本周”理解成查询当天的现状。
invalid_at 表示失效时间，格式相同。只有能按来源期间或下述瞬时状态规则推算时才填写。
recent_state 类别本身不代表当天过期：“尚未决定”“不知道某人的现况”等决策或知情
状态只确定观察点，未说明持续期限时 invalid_at 必须为 null，不套当天或固定天数。
当天或次日的日程、写明期间的短期安排和明确瞬时状态按 occurred_at 推算失效时间。
结束时间按消息表达推：写明期间时取该
期间结束的下一刻，“今天”“本周”或“下周恢复”已经限定期间；“周”按当地历周从周一零点
计到下一周一零点，下一周一不是消息时间加七天。只写日期或只写“明天”而没有结束点的
日程，取该日程所指日期的次日零点（当地）；这里的日期基准是日程本身的日期，不是
occurred_at 当天，所以“明天”的日程在明天结束前仍然有效。瞬时状态（如“还没吃饭”
“现在在路上”）仍可入库，但其 invalid_at 不得晚于 occurred_at 当天结束，不得按周或
按月延长。
没有明示资料期限的已发生历史事实或经历也留双null；真正长期有效的事实（如固定
习惯、长期偏好、稳定的家庭与工作信息）同样留空，不能为历史动作套临时状态有效期；
结束时间无法按上述规则推算时也留空，不为所有近况套固定过期天数。
“当地”以该事实来源 occurred_at 自带的 UTC 偏移为参考，用它推算“当天／次日／本周”
的边界；occurred_at=unknown、naive 或无法核实时不推算、留空，不得猜测或用当前
时间补出边界。当前状态的观察时间只取 occurred_at，不用该历周起点替代。
没有时间值的字段必须输出
JSON null，不能输出空字符串或字符串“null”。取消或撤回的记录为已发生
的事实，不要用 valid_at、invalid_at 表达取消。
只有标记为 target 的消息可以作为该候选的主证据；上下文消息只能辅助理解，不要只凭
上下文消息提取事实，候选必须由 target 消息直接支持。每条事实的 source_message_ids
只能填写输入中标注的 message_id，且至少包含一个 target 消息 ID。
恢复人物、物品、事项或必要限定确实用到上下文时，也必须引用对应上下文消息 ID，
不能只引用省略回答的 target；不将无关上下文全加进来源作为兜底。一条候选只能由
语义相连的消息支撑：不得把窗口里不同话题的人、地点、事件或结论拼成同一条事实；
无法由相连消息说明来源时，宁可不提取。
alternatives 只在该表达可能不是字面事实、或存在实质歧义时填写少量其他解释；语气明确、
证据直接时留空数组。
指代目标无法唯一定位时只说明该身份或事项在本窗无法确定，不猜职业、亲友角色或
事项类型；仅有身份未知时，alternatives保留这种不确定，不展开为可能是用户或联系人
认识的某个人，也不补窗外前情；即使写成“可能”，无来源的关系、角色或故事仍须省略。
正文已经写“身份／事项未明”仍须独立填写非空alternatives；subject资料范围及语用标签
确定，不代表该指代已经唯一定位。这些槽分别核对，不能互相代填或省略。
如果 speech_act、assertion_status、figurative_type 与主体已经
确定，不要再用 alternatives 复述与标签或主体判断矛盾的其他猜测。对方在祝贺或回应
里提到用户的已完成事实，按字面事实处理，不要用 alternatives 质疑证据来源。text、alternatives与interpretation_reason都只能保留所引用消息直接支持的内容；
身份未知时不得添加属于用户或联系人圈子的猜测，subject资料范围不是这类关系的证据。
三者逐槽核对来源：正文或标签正确，不能抵消备选或理由中新增的前情、身份或关系。
interpretation_reason只说明有据的语用与来源，不把否定解释为未获来源支持的此前误认，
不添加未给出的当面、通话等沟通场景，
也不添加原话没有的人物关系或互动。它仍只写一句简短依据，不输出模型内部思考过程。
"""

# 历史协议仅供显式兼容与评测；生产 builder 继续使用 Grounded。
EXTRACTION_SYSTEM_PROMPT += """
event是可空事件提案，阶段与发生时段必须分别给出来源位置，不能用当前时间认证发生。
stage取planned/agreed/rescheduled/cancelled/occurred/unknown；没有依据时留unknown或null。
stage_evidence与occurrence_evidence使用原消息UUID及Unicode码点半开位置，不输出核验位。
"""

EXTRACTION_SCHEMA: dict[str, Any] = {
    "title": "MemoryExtractionOutput",
    "description": "从消息窗口提取的关系事实列表；必须以结构化工具调用返回。",
    "type": "object",
    "additionalProperties": False,
    "properties": {
        "facts": {
            "description": (
                "事实对象数组。每项必须是对象并包含全部字段；"
                "没有可提取的事实时为空数组；禁止使用字符串代替对象。"
            ),
            "type": "array",
            "items": {
                "type": "object",
                "description": "一条带来源的关系事实。",
                "additionalProperties": False,
                "properties": {
                    "text": {
                        "description": "事实文本，例：他不爱发语音，爱直接打电话。",
                        "type": "string",
                    },
                    "category": {
                        "description": (
                            "五类分类之一：common_fact、preference、taboo、"
                            "recent_state、relationship_note；不要填 topic 的词。"
                        ),
                        "type": "string",
                        "enum": [item.value for item in MemoryCategory],
                    },
                    "subject": {
                        "description": (
                            "事实主体：self（用户）、contact（联系人）、shared（共同）。"
                        ),
                        "type": "string",
                        "enum": ["self", "contact", "shared"],
                    },
                    "topic": {
                        "description": (
                            "受控主题（health、work、family、travel、finance、"
                            "study、emotion、other），只用于缩小后续裁决范围。"
                        ),
                        "type": "string",
                        "enum": [item.value for item in MemoryTopic],
                    },
                    "source_message_ids": {
                        "description": (
                            "完整支持该事实的最小消息 ID 集合，只能填输入中的 message_id。"
                            "至少一个 target；恢复身份或事项所需的 context 也要引用。"
                            "相连问答已完整支持时，不再重复引用只提供同一身份的更早消息。"
                        ),
                        "type": "array",
                        "minItems": 1,
                        "items": {"type": "string"},
                    },
                    "confidence": {
                        "description": "置信度，0 到 1 之间的小数。",
                        "type": "number",
                    },
                    "risk_flags": {
                        "description": (
                            "风险标记数组（转账/借款/健康/承诺/见面等），可为空。"
                        ),
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "valid_at": {
                        "description": (
                            "带时区的 ISO 8601 生效时间；未来计划、未来约定、当天或次日的"
                            "日程以及短期安排，都按消息 occurred_at 自带的 UTC 偏移推算填写；"
                            "瞬时状态（如“还没吃饭”）以该状态的证据时间 occurred_at 为观察"
                            "起点，不臆测更早的开始时间。已发生且无时限的事实用 "
                            "JSON null，不用空字符串。"
                        ),
                        "anyOf": [{"type": "string"}, {"type": "null"}],
                    },
                    "invalid_at": {
                        "description": (
                            "带时区的 ISO 8601 失效时间，按 occurred_at 的 UTC 偏移推算。"
                            "category=recent_state 的临时状态、当天或次日的日程与写明期间的"
                            "短期安排在结束时间可推算时必须填写；只写日期或“明天”的日程"
                            "取该日程所指日期的次日零点（当地）；瞬时状态取 occurred_at "
                            "当天结束，不得更晚。"
                            "真正长期有效的事实、没有明示资料期限的已发生历史事实或经历"
                            "用 JSON null，不能为历史动作套临时状态有效期；结束时间无法"
                            "按上述规则推算时也用 JSON null，不套固定过期天数。"
                            "来源时间缺失、naive 或无法核实时不推算、留空，不用当前时间补。"
                            "取消事件不以有效期表达。"
                        ),
                        "anyOf": [{"type": "string"}, {"type": "null"}],
                    },
                    "speech_act": {
                        "description": (
                            "消息执行的说话行为。assertion=直接陈述本人或双方的事实、"
                            "经历、状态、习惯，含“我已经…”“我平时…”；plan=未来打算；"
                            "question=提问；request=请求或要求；report=转述第三方内容；"
                            "correction=更正或撤回；unknown=无法判断。"
                        ),
                        "type": "string",
                        "enum": [item.value for item in SpeechAct],
                    },
                    "assertion_status": {
                        "description": (
                            "消息对主张的承诺状态。asserted=当作已成立的事实；"
                            "hypothetical=假设；conditional=条件；reported=第三方说法或事件；"
                            "unknown=无法判断。"
                        ),
                        "type": "string",
                        "enum": [item.value for item in AssertionStatus],
                    },
                    "figurative_type": {
                        "description": (
                            "消息的字面或非字面表达状态。literal=按字面理解；"
                            "joke=玩笑；sarcasm=反讽；hyperbole=夸张；unknown=无法判断。"
                        ),
                        "type": "string",
                        "enum": [item.value for item in FigurativeType],
                    },
                    "alternatives": {
                        "description": (
                            "语气明确、证据直接时为空数组。指代身份无法确定时必须非空，"
                            "仅说明本窗无法确定所指身份，不猜与双方的认识关系、亲友角色或前情。"
                            "其他实质歧义只能列来源支持的解释，不能因字段名而编造可能性。"
                        ),
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "interpretation_reason": {
                        "description": (
                            "一句有来源的简短语用依据，不是内部思考过程。"
                            "单纯否定不说明此前误认或更正；不添加未给出的前情、关系或场景。"
                        ),
                        "type": "string",
                    },
                    "event": EVENT_PROPOSAL_SCHEMA,
                },
                "required": [
                    "text",
                    "category",
                    "subject",
                    "topic",
                    "source_message_ids",
                    "confidence",
                    "risk_flags",
                    "valid_at",
                    "invalid_at",
                    "speech_act",
                    "assertion_status",
                    "figurative_type",
                    "alternatives",
                    "interpretation_reason",
                ],
            },
        }
    },
    "required": ["facts"],
}


class LangChainExtractionRuntime:
    """把消息窗口交给模型，返回未经外壳校验的原始事实候选。"""

    __slots__ = ("_model",)

    def __init__(self, *, model: BaseChatModel) -> None:
        if model is None:
            raise TypeError("必须显式注入模型。")
        self._model = model

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        try:
            message = invoke_traced_model(
                self._model,
                purpose="extraction",
                schema=EXTRACTION_SCHEMA,
                tool_options={"tool_choice": EXTRACTION_SCHEMA["title"]},
                messages=[
                    {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                    {"role": "user", "content": _window_text(window)},
                ],
            )
        except (ExtractionRuntimeError, TraceWriteError):
            raise
        except Exception as error:
            raise ExtractionRuntimeError(
                "模型调用失败，未生成记忆。"
            ) from None
        tool_calls = getattr(message, "tool_calls", None)
        if not tool_calls:
            raise ExtractionInvalidOutputError("模型未返回可解析的结构化事实。")
        args = tool_calls[0].get("args")
        facts_payload = args.get("facts") if isinstance(args, dict) else None
        if not isinstance(facts_payload, list):
            raise ExtractionInvalidOutputError("模型未返回可解析的结构化事实。")
        return tuple(
            item if isinstance(item, dict) else {"_invalid": item}
            for item in facts_payload
        )


def _window_text(window: ExtractionWindow) -> str:
    target_ids = window.target_message_id_set
    lines = [
        f"{index + 1}. "
        f"[{('target' if message.message_id in target_ids else 'context')}] "
        f"[message_id={message.message_id}] "
        f"occurred_at={message.occurred_at.isoformat() if message.occurred_at else 'unknown'} "
        f"sender={message.sender.value}: {message.text}"
        for index, message in enumerate(window.messages)
    ]
    return "\n".join(lines)
