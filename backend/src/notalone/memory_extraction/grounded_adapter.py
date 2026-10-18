"""一次模型标注原文分句，再由程序编译；不允许模型直接改写候选正文。"""
from __future__ import annotations

from copy import deepcopy
import hashlib
import json
from typing import Any
from collections.abc import Iterable
from langchain_core.language_models import BaseChatModel

from notalone.memory.events import EventStage
from notalone.memory_extraction.errors import ExtractionInvalidOutputError, ExtractionRuntimeError
from notalone.memory_extraction.grounded import (
    AMBIGUITY_CODES, KINDS, OMISSIONS, SENSITIVITY, V4_AMBIGUITY_CODES, V4_KIND_EXTENSIONS,
    V4_STRUCTURAL_KINDS, GROUNDED_COMPILER_VERSION, GROUNDED_EXTRACTION_PROTOCOL,
    compile_event_labels, compile_labels, compile_labels_v3, compile_labels_v4,
    source_units, needs_reference, reference_choices,
)
from notalone.memory_extraction.models import ExtractionWindow, MemoryTopic
from notalone.memory_extraction.runtime import ExtractionPayload
from notalone.memory_trace import TraceWriteError
from notalone.memory_trace.context import record
from notalone.memory_trace.transport import invoke_traced_model

GROUNDED_EVENT_PROMPT = """event为null或受控对象：stage取planned计划、agreed约定、rescheduled改期、cancelled取消、occurred发生、unknown未知。
stage只是提案，不能从kind或时间到期认证。occurrence只选本事实成员或依赖的原文分句编号，没有明确时段则null。
不能生成日期、正文、位置或核验位；程序只解析支持的完整日/周时段，不支持的时间保持未知，随后由独立来源核验。
"""

GROUNDED_PROMPT = """对同一联系人的原文分句进行结构化标注。只返回工具结构，不改写正文。
units是按工具预设字段填写的对象，每个target字段必填，不再输出unit编号；context 仅供理解，不单独输出。不能删除分句来掩盖不知道或未决定。
kind 表示本句所保存的阶段：
event=已完成普通动作；relationship_event=本人已参与的关系经历（含收到邀请、借用、赠予）；
reported_event=第三方历史经历；third_party_fact=第三方身份资料；assessment=针对具体事项的一次评价；
preference=有来源的长期习惯或偏好；taboo=长期禁忌；state=当前知情、决策或持续期未知的状态；
momentary_state=正在等待、路上等当天瞬时状态；plan=尚未实现的计划；hypothesis=假设；
明确尚未发生的既定日程、工作安排或约定也用plan，不要求自主打算或“准备／想”等意向词；时间已定或语气确定不等于当前持续的state。
先核候选保存的主张阶段，不能仅见未来时间词就标plan：当前知情、未决定或不知道仍用state；正在进行、已完成和长期身份分别沿原类型，不能因句中涉及未来事项就把主张阶段改为plan。
assessment也可表达对未来行为的当前明确判断或预测；未来时间词和简短肯定／否定本身不证明行动安排，按完整相连问答确定言语行为，省略回答保留理解必需的问句dependency。
明示未来日程、意图、安排或承诺仍用plan并保留原敏感性，当前不知道或未决定仍用state；来源仅表达可能性、假设、条件或转引时保留原限定并沿相应原类型，不能借assessment抹掉限定或改成确定结果。
尚未开始而即将执行的即时意向仍用plan，不因接近说话时刻就当作正在进行或已经完成；来源明确正在进行才用momentary_state，明确完成才按已完成动作处理。
request=暂时关系要求；correction=窗内有明确先前主张的更正；unknown=无法判断。
不能独立成立的时间/话题前缀（例如“前年冬天，”或“他现在的情况，”）用prefix，和紧邻的同消息事实合并。
纯条件前件用condition，紧邻其后的同消息动作必须用plan或hypothesis，程序会合并并保留条件。
question/greeting/nonliteral/not_memory是明确不提取的原因；说话者不知道他人情况是state，不是not_memory。
来源明确描述反复的日常行为且未限定资料期间时用preference；“现在”等陈述时点不把习惯变成state或momentary_state，无期限习惯沿双null，不从单次行为推长期习惯。
反问式强调按完整相连语境判断主张，不能当作字面否定或仅凭问号省略；真实询问和没有明示主张的质疑仍不提取。若有两种来源支持的读法，保留unresolved，不反转明确否定。
已完成动作与当前状态分别标注。已收到邀约是relationship_event，不额外产生一条未来参与计划。
subject为资料归属self/contact/shared，不能把第三人身份改成用户或联系人；其资料依原说话人范围保存。
候选保存对话一方直接提出的请求时，subject归请求者，不归受话者、被要求的执行者或受益者；联系人提出要求归contact，用户提出要求归self。
sender只是说话人，不必等于subject：转述第三方请求仍保留第三方称呼、原关系资料范围和转述边界；描述另一方事实仍归该方，共同约定才按共同主张判断。
topic只用受控主题；亲属历史用family，职业/职业知情用work，课程报名用study，价格判断可用finance。
dependency只选一条理解本句不可缺少的原文分句编号；可以是context或另一target。
相连问答已足够时不再引用更早的历史；不需要补全人物/事项时用null。若一条依赖不足以消歧，unresolved=true。
不确定的第三人指代unresolved=true，身份明确则false；不能从亲属性别推测说话者性别。
sensitivity只标原文实际的敏感风险：financial=真实金钱风险，health=健康，commitment=明确承诺，other=其他明确敏感性。
普通借用物品、报价判断、收到娱乐邀请本身不是敏感性，取none。不要增加原文没有的风险。
confidence是模型对标签的把握，不能代替证据。程序只保证定位、引用、字段组合与时间计算，不认证你的语义判断。
"""

# 合成教学仅说明局部标签；不进入当前窗口、来源或工具schema。
GROUNDED_E2_TEACHING_EXAMPLES = """
<e2_teaching_examples>
以下是独立教学微例，均由联系人说出，只展示局部标签，不是当前工具输出，也不是本次来源。
示例中的context仅为背景，只有target需要输出；当前任务只标注随后user消息里的实际target，完整字段按当前工具schema填写。
第一对：第三人事实与本人参与。
例一 target「隔壁摊主的职业是篆刻师。」：kind=third_party_fact，topic=work，unresolved=false。职业属于第三人，不能改成联系人的职业。
例二 target「隔壁摊主当面向我发出了联展邀请。」：kind=relationship_event，topic=other，unresolved=false。保存已收到邀请，不另造未来参与计划。
第二对：亲属关系主断言与关系背景下的普通完成。
例三 target「姨父送给了我一套雕刻工具。」：kind=relationship_event，topic=family，unresolved=false。
例四 context「这套雕刻工具是姨父送我的。」；唯一target「最后一块木版已经刻完了。」：kind=event，topic=other，unresolved=false。只保存完成主断言；不补具体雕刻者，不推断使用了所赠工具，背景不单独输出，也不作为不必要的dependency。
第三对：当前消息维护与真实未来计划／安排。
例五 target「稍等，我把这条消息的错字改一下。」：两分句均为not_memory，topic=other，unresolved=false；仅维护本次消息，没有独立可保存安排。
例六 target「下个月的古文字课上，我会替你演示拓印步骤。」：首分句kind=prefix、后句kind=plan，均topic=study、unresolved=false；前缀合并至未来计划。不补已完成或具体事件发生日期，其他字段沿原来源及时间规则。
第四对：事项未明与事项明确但尚未决定。
例七 target「我对先前说的安排仍拿不定主意。」（无其他context）：kind=state，topic=other，unresolved=true。保留犹豫状态，所指事项未明。
例八 target「我还没决定下学期是否转去夜校。」：kind=state，topic=study，unresolved=false。事项明确，未知的是决定结果，不能把当前未决定改为未来计划。
</e2_teaching_examples>
"""

# 已冻结的显式v3/v4保持原合同；默认提取的事件提案不混入旧评测协议。
# v3/v4继续从原基底派生；本次E2指导不重签它们的提示合同。
GROUNDED_V2_PROMPT = GROUNDED_PROMPT.replace(
    "event=已完成普通动作；",
    "event=对话一方的普通可复用事实，包含已完成动作及未限定短期期间的稳定身份、职业、专业；",
).replace(
    "kind 表示本句所保存的阶段：",
    "先判断是否有独立可保存信息，纳入判定优先于后续阶段：仅推进本次消息交换的动作，"
    "没有独立事实、明确承诺、关系约束或其他安排时用not_memory，不能仅凭将来时态或意向就纳入。"
    "真实计划、责任约定及承诺仍保留，是否有承诺不以出现保证词为条件；纯礼貌用greeting。"
    "通过纳入判定后，再按本句独立主断言选择kind及阶段：",
).replace(
    "relationship_event=本人已参与的关系经历（含收到邀请、借用、赠予）；",
    "relationship_event=主断言为本人已参与的互动关系经历（含收到邀请、借用、赠予）；"
    "主断言是普通动作的完成进度或结果时用event，人物关系或对象来历仅作背景不能把它改成relationship_event；",
).replace(
    "不确定的第三人指代unresolved=true，身份明确则false；不能从亲属性别推测说话者性别。",
    "逐项检查主断言及其必要限定中的人物、事项、对象及角色指称；任一所需指称无法唯一确定即unresolved=true，"
    "只有全部所需指称均明确才false。请求者和受话者明确不证明请求事项明确；保留已知部分和原类型。"
    "不能从亲属性别推测说话者性别。",
).replace(
    "topic只用受控主题；亲属历史用family，职业/职业知情用work，课程报名用study，价格判断可用finance。",
    "topic按主断言选择受控主题：主断言为明确亲属间互动优先family；亲属称呼仅为背景而主断言是职业、学习等资料时"
    "按work、study等实际主题，不因称呼强改family。职业/职业知情用work，课程报名用study，价格判断可用finance。"
    "地点是家里或有人来访本身不能证明亲属关系。",
).replace(
    "明确尚未发生的既定日程、工作安排或约定也用plan，",
    "已通过纳入判定时，明确尚未发生的既定日程、工作安排或约定也用plan，",
).replace(
    "明示未来日程、意图、安排或承诺仍用plan并保留原敏感性，",
    "已通过纳入判定时，明示未来日程、意图、安排或承诺仍用plan并保留原敏感性，",
).replace(
    "尚未开始而即将执行的即时意向仍用plan，",
    "已通过纳入判定时，尚未开始而即将执行的即时意向仍用plan，",
) + """
仅本E2的event沿既有普通事实映射；模型仍须依据完整原文选择，程序不把state自动改为event。
“目前／现在”仅表示陈述时点时，不把稳定资料改成临时state；不从此类资料推真实开始日、永久有效、能力或成果。
明确短期期间、当前知情／决策、身体近况和未来安排继续用原状态或计划类型；第三方身份仍用third_party_fact。
保留原文的否定、猜测、引语和未知，不把它们改成肯定身份；稳定资料标签也不认证现实真伪或来源可信。
unresolved不仅检查人物，也检查理解主张所需的事项、对象及角色；已有来源不能唯一确定时标true，保留原类型和已知部分，不用请求的受话者已知掩盖事项未知。
family须有原文亲属或家庭关系依据，不能仅因家里／住处或来访就选family；按实际主张选择已有依据的topic，没有更具体依据时用other。
先判断是否有值得保存的信息，再选事实或计划类型：仅推进当前对话的一次性消息传递动作（发送地址、文件等），且没有独立事实、明确承诺、关系约束或超出本次消息交换的安排时用not_memory；有信息的地址／文件内容及真实计划、承诺仍分别保留，不按物品词或短期性一概省略。
不含独立事实的纯礼貌谢语用greeting，不因存在依赖或前句已完成就另标event；同句或相邻句确有关系经历、完成动作或其他事实时，分别保留有信息的分句，不删除整条消息。
""" + GROUNDED_E2_TEACHING_EXAMPLES


BOUNDED_STAGE_PROMPT_PROFILE = "bounded-stage-teaching-v1"
BOUNDED_STAGE_TEACHING_V1 = """
<bounded_stage_teaching_v1>
以下独立教学对照只说明既有kind的阶段边界，不是本次来源或工具输出。
完成动作与持续活动：
「我已经把书架擦干净了。」保存已完成的清洁动作，kind=event；
「我正在擦书架。」保存仍在进行的活动，kind=momentary_state。
完成结果与身体状态：
「我已经量完体温了。」保存已完成的测量动作，kind=event；
「我现在有点头晕。」保存当前身体近况，kind=state。
动作发生得近不等于它仍在持续；当前状态也不能因可能短暂而编造已完成动作。
回到实际target及其必要上下文独立判断；其余槽位仍按原定义填写，不复制教学句或补出未明说的事实。
</bounded_stage_teaching_v1>
"""

BOUNDED_DEPENDENCY_PROMPT_PROFILE = "bounded-dependency-teaching-v2"
BOUNDED_DEPENDENCY_TEACHING_V2 = """
<bounded_dependency_teaching_v2>
以下独立对照只说明既有dependency槽，不是当前来源，不指定其它标签。
必要的明确别名映射：context 0:0「我把实验记录册叫作青签。」；target 1:0「青签已经编号好了。」。
虽然target字面是一句完整陈述，理解其中对象仍使用0:0的别名映射，因此该target的dependency为0:0。
无关背景：context 0:0「今天窗外有雾。」；target 1:0「实验记录册已经编号好了。」。
target的人物和事项无需该背景补全，因此该target的dependency为null。
必要的显式声明不因在另一条消息、另一个target或前文中就变成无关背景；一句话字面完整也不等于所需指称已独立明确。
只选择实际窗口中理解当前主张不可缺少的原文分句；不把所有背景加入依赖，不复制微例编号或正文。
微例不定义新的证明语法，也不认证别名、人物或任何关系；当前任务仍按原全部字段及未知规则输出。
</bounded_dependency_teaching_v2>
"""



BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE = "bounded-dependency-teaching-v3"
BOUNDED_DEPENDENCY_TEACHING_V3 = """
<bounded_dependency_teaching_v3>
以下独立交叉例只区分是否单独保存与是否提供必要上下文；不指定其它标签或置信度。
两个分句都是target：0:0「我把实验记录册叫作青签。」；1:0「青签已经编号好了。」。
若0:0已按原独立保存规则标为kind=not_memory，1:0理解对象仍需要该命名，dependency=0:0。
对照两个target：0:0「今天窗外有雾。」；1:0「实验记录册已经编号好了。」。
同样以0:0已按原独立保存规则标为kind=not_memory为前提，1:0无需该背景补全，dependency=null。
not_memory表示该分句不独立形成候选，不表示它不能被另一候选引用；是否选择依赖仍只取决于理解当前主张是否必需。
这不要求所有声明都标not_memory，也不把所有not_memory加入依赖；context与target的原角色不变，回到实际原文独立填写。
</bounded_dependency_teaching_v3>
"""


CORE_CURRENT_STATE_PROFILE = "core-current-state-v1"
CORE_CURRENT_STATE_GUIDANCE = """
<core_current_state_v1>
来源主断言若是当前条件下的能力、可行性或可用性，保存的是状态而非已经发生的动作，用state；保留原有的期间限定、理解所需前缀或dependency，沿state规则记录来源观察期，不当成event稳定事实，也不补成未来计划。
这不把长期技能或能力陈述一律临时化；已完成动作、明确未来安排、稳定身份与长期习惯仍沿原类型。按完整主张及条件判断，不能仅因“可以”“现在”等词选state或臆造失效日期；主题继续只采用来源依据，无具体依据沿other。
</core_current_state_v1>
"""

REFERENCE_KIND_PROMPT_PROFILE = "reference-kind-teaching-v1"
REFERENCE_KIND_TEACHING_V1 = """
<reference_kind_teaching_v1>
先按原规则判断纳入，再核所保存的主断言、原文明示的行动角色与阶段，最后选kind。第三人称、出现“我”、亲属称呼或否定词都不能单独决定类型。
第三人的身份资料（含否定身份）用third_party_fact，第三人历史行动的叙述用reported_event；来源明确本人已收到邀请、实际接收或参与借用等互动时仍可relationship_event。不能因第三人在场或身份未知一律改成转述，也不能因“我”是关系对象便补成已接收、已交付或已参与。
correction须有本窗明确先前主张及更正依据；单纯否定或同句正反对照不证明先前有人说错。未有更正依据时仍按原主张类型保留否定，不能补一次纠正行动。
主断言是普通动作的完成进度或结果时用event；关系人物、赠予来历只是背景，不把普通完成改成relationship_event。第三人身份资料与第三人已发生经历也不能混为同一kind。
只在未知影响当前保留主张必需的指称或行动角色，或当前主张包含所指未决的所有格时标unresolved=true；保留原句，不猜谁借入、借出或拥有物品。未主张所有权时，来源未说明所有者不单独构成未决；背景中另一主张的未知也不抹去当前已有依据的明确动作、数量或完成状态。仅有请求、打算、条件或未证交付时不升级成已完成互动。敏感性按实际来源保留，否定借贷也不消除financial范围；普通物品借用不凭空增加财务风险。
以下是现有kind的基础编译映射，顺序为category / speech_act / assertion_status；只说明标签的下游含义，不要求模型额外输出三字段，不证明现实真伪或来源可信。条件、未知及其他既有程序规则仍按原合同处理，不能用此表覆盖来源限定：
event → common_fact / assertion / asserted
relationship_event → relationship_note / assertion / asserted
reported_event → relationship_note / report / reported
third_party_fact → relationship_note / report / reported
assessment → relationship_note / assertion / asserted
preference → preference / assertion / asserted
taboo → taboo / assertion / asserted
state → recent_state / assertion / asserted
momentary_state → recent_state / assertion / asserted
plan → recent_state / plan / asserted
hypothesis → recent_state / plan / hypothetical
request → relationship_note / request / asserted
correction → relationship_note / correction / asserted
unknown → relationship_note / unknown / unknown
prefix、condition及省略原因沿原结构规则，不是额外关系事实；模型选择与程序字段合法不替代独立来源核验。
以下独立合成对照均由联系人说出，只示范局部标签，不是本次来源。context只供理解，实际仅输出user输入的target，不复制示例或虚构角色。
1. 无前文，target「隔壁住户并非兽医。」：third_party_fact。否定第三人职业，不能因“并非”选correction。
2. context「我报的场次是周二。」；target「我刚才把已报名的周三场次说成周二了。」：correction，必要dependency指向先前主张。保存有据更正，不从被更正日期推更正动作的有效期。
3. target「社区剧团已经邀请我参加读剧会。」：relationship_event。已收到邀请有据，不能补已答应或已参加，也不因邀请方是第三人改成纯第三人经历。
4. target「邻居上个月参加过读剧会。」：reported_event。保存第三人已发生经历，不能补联系人也参加。
5. target「舅舅已经把备用帐篷交给我了。」：relationship_event。出交者与接收者明确，保留本人接收；不据交付推赠予、产权转移或永久拥有。
6. 无前文，target「他借了我一套量具。」：reported_event，unresolved=true。只保留第三人借用行动的原述；人物与借入／借出方向未定，不补联系人已经收到或交付，也不能用低风险或完整句式消除歧义。
7. context「表哥送了我一张书桌。」；唯一target「抽屉已经装好了。」：event。主断言是装配完成，关系来历不是装配者证据，也不作为不必要的dependency。
8. target「邻居的职业是灯光师。」：third_party_fact。身份资料不因用过去经历类的关系标签更保守就改成reported_event；不把职业归给联系人。
9. target「邻居把露营炉借给我用了。」：relationship_event。本人借用方向有明确原文，不因“借”或第三人称统一改成reported_event；出借角色仍不证明炉具归属。
10. target「我打算下周送你一只保温杯。」：plan。保留未来打算，不能沿已发生接收示例补成交付；期间、敏感性及其他字段继续按本次原来源核对。
</reference_kind_teaching_v1>
"""


def grounded_v2_prompt(prompt_profile: str = "default", *, events: bool = False) -> str:
    """两个既有协议共享教学增量；默认提示逐字保留。"""
    if type(prompt_profile) is not str or prompt_profile not in {
            "default", BOUNDED_STAGE_PROMPT_PROFILE, BOUNDED_DEPENDENCY_PROMPT_PROFILE, BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE,
            CORE_CURRENT_STATE_PROFILE, REFERENCE_KIND_PROMPT_PROFILE}:
        raise ValueError("提取提示profile无效。")
    base = GROUNDED_V2_PROMPT + (GROUNDED_EVENT_PROMPT if events else "")
    if prompt_profile == CORE_CURRENT_STATE_PROFILE:
        return base + CORE_CURRENT_STATE_GUIDANCE
    if prompt_profile == REFERENCE_KIND_PROMPT_PROFILE:
        return base + REFERENCE_KIND_TEACHING_V1
    if prompt_profile == "default":
        return base
    return base + BOUNDED_STAGE_TEACHING_V1 + (
        BOUNDED_DEPENDENCY_TEACHING_V2 if prompt_profile in {BOUNDED_DEPENDENCY_PROMPT_PROFILE, BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE} else "") + (
        BOUNDED_DEPENDENCY_TEACHING_V3 if prompt_profile == BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE else "")


GROUNDED_V3_PROMPT = GROUNDED_PROMPT.replace(
    "sensitivity只标原文实际的敏感风险：financial=真实金钱风险，health=健康，commitment=明确承诺，other=其他明确敏感性。",
    "sensitivity按原文涉及的敏感事项标注：financial=借贷、负债、还款等金融敏感事项，"
    "health=健康，commitment=明确承诺，other=其他明确敏感性。\n"
    "即使原文否定发生借贷、负债或还款，financial也保留；它不表示已有负债或交易发生。",
) + """
relationship_event用于原文明示本人已参与的关系经历，已收到邀请、实际接收或借用有据时仍可使用。
reported_event可用于保存第三人行动的陈述；“我”仅作关系对象，不自动证明交易已完成或实际交付，也不能据此升级为本人已参与经历。
人物身份未知本身不要求一律转述；若本人参与已明确，仍可relationship_event。kind不能按“我”、未知人物或借钱等词语强转。
保留原文的否定、条件、引语及未证交付，不把提及行动自动当成已完成的本人经历。
本次为grounded-v3，每个target还须填写ambiguity_codes数组，只能选择以下受控类别：
entity_identity=原句所指人物或群体身份未明；place_ownership=所指地点／家里归属未明；
borrowing_direction=“向对方借”与“借给对方”两种方向无法唯一确定；other_unresolved=其他实质未知。
ambiguity_codes是非互斥多选，须逐类核对已有来源；身份、地点归属、借贷方向同时未定时全部选择。
只选择已有来源支持的未知，不能凭词语命中补猜；其他未知不能替代应列的具体类别。不能因为人物已知就忽略借贷方向未知。
unresolved=false时必须为空数组；unresolved=true时必须至少一类，不重复，不生成解释正文。
方向说明只解释原句的两种读法，不改变人物、肯定／否定、条件或完成程度，不断定交易发生。
来源已明确方向时不要增添两读。程序固定渲染解释，不提供消歧或来源语义证明。
"""

GROUNDED_V4_PROMPT = GROUNDED_V3_PROMPT.replace("本次为grounded-v3", "本次为grounded-v4") + """
仅本显式离线v4增加以下四个未知类型的完整封闭kind；仍不填写正文、日期、理由或独立语用字段：
figurative_unknown_plan=保留计划型原话，但来源语境使修辞真伪未定；原话仍是陈述，不认证其现实发生。
已明确玩笑、反讽或夸张仍用nonliteral省略；不能把确定的非字面内容降成修辞未知来保留。
uncertain_plan=是否会实现尚未知的未来可能性，不是已决定计划或纯条件；具体期间有据时仍保留原期间。
uncertain_state=当前状况是否成立尚未知，保存原文程度与可能性；不是已确认事实，也不推断结束时间。
stage_unknown_state=近况活动究竟已完成还是尚待安排未定，保留原句，不能因来源日期或时钟时间选定阶段。
单纯可能性未知不制造第二种指代解释；不能把上述kind与条件前件拼成另一个任意字段组合。
v4的ambiguity_codes另允许clock_period=原句时钟时制未定；event_stage=原句活动完成或安排阶段未定。
它们非互斥，逐类按已有来源选择，不靠时间词或动作词命中补猜；单纯未来、条件或可能性不自动需要这两类。
本次v4开发修订另允许object_ownership=物品所有者未明，不因出借或接收认定所有者。
物品所有权未知不能用place_ownership或other_unresolved替代；按来源选全适用类别，已明确的角色或所有权不额外标未知。
程序固定渲染并附实际原句，不补具体时刻、完成事实或另一身份。
下个月/下月只计算完整来源时区日历月的检索期间；否定、额外期间或未支持修饰仍保持未知，不由模型填日期。
correction保留已发生的更正动作及完整原定/更正内容；被更正的未来日期不是更正动作的生效或失效时间。
另以stable_fact=原文明示的稳定身份、职业、专业等客观事实，不是已完成动作。
稳定事实可描述当前仍成立的资料，不能仅因“目前”或“现在”就改用临时state；也不能标event来表示稳定身份。
程序将stable_fact编译为common_fact/assertion/asserted/literal、两时间槽均null，不从来源观察日猜真实开始日。
知情、决策、近况、短期身体状况继续使用相应state／未知状态类型；瞬时状态和未来计划继续使用各自原类型。
原文明示期间的短期资料仍按相应状态或计划保留期间，不能用stable_fact抹去时间限定。
stable_fact仍只是模型类型判断，不认证永久有效、现实身份或来源可信，也不提供typed依据。
另允许结构角色continuation=已完成普通event的紧邻后置附属数量，不是独立事件或前置prefix。
先依原文判断附属关系，不按数字或量词自动选择continuation；独立动作继续event，不删除数量。
主项须是同一target消息的前一相邻event，以中文逗号或中英文分号相连，不跨完整句末；context、省略项、其他kind、前置prefix或condition均不能作主项。
只允许一个附属项，subject与topic须和主项完全一致；不能以连续附属项吞掉另一独立主张。
仅支持半角阿拉伯整数0至9999（不允许前导零）或中文0至99（零／〇／一至九／两／十至十九／二十至九十九），数字紧接计数单位。
计数单位仅个、位、名、人、张、份、本、件、台、套、把、双、只、支、瓶、盒、袋、包、辆、枚、颗、条；可无句末标点或以。／！／!结束，验证时忽略原分句首尾空白，引用保留原分句。
金额、日期、谓词、小数、负数、范围、概数及其他尾句不在此有限语法内，不能标continuation。
程序按原顺序合并完整原引句与双方依赖，传播风险和歧义，并取最低confidence；不升置信度，也不提供来源语义证明。
另允许matter_reference=原句所指事项在本窗口无法唯一识别；不补事项内容或类型，不能用other_unresolved替代。
事项指称、人物身份与物品归属由模型逐项判断并显式选择；来源已唯一明确的事项或归属不额外标未知，不按关键词补码。
出借施事、接收者、物品所有者和代词指称分别核对；施事或接收角色不证明所有权，不能按代词性别或亲属称呼认定唯一指称。
所需指称或物品归属未被本窗来源唯一明确时，按实际未知分别选择entity_identity与object_ownership；角色已明确不因此变成未知，不因借用一概补码。
"""

DEFAULT_PROMPT_PROFILE = "default"
REFERENCE_UNIQUENESS_PROFILE = "reference-uniqueness-v1"
GROUNDED_V4_REFERENCE_UNIQUENESS_PROMPT = GROUNDED_V4_PROMPT + """
将第三人代词所称物品的所有权归到某个已知人物前，单独核对来源是否明确支持这条归属关系。最近出现的先行词、窗口只提及一个候选人、亲属称呼或代词性别本身，不能单独构成归属依据；出借、接收等已知行动角色也不能替代它。来源未明确该关系时，保留代词原字，并按实际未知选择物品归属及必要的人物指称类别；不补另一个所有者，也不反向断言不属于该人物。直接明示的所有者或有明确来源关系的指称不额外标未知。只核所保存主张实际依赖的关系，独立明确的动作、对象、数量、否定和历史性质继续保留。此处不要求每条消息另有固定 Identity 模板句，也不取消完整相连问答中已有的指称依据。
"""


def grounded_v4_prompt(profile: str) -> str:
    """运行时与评测冻结复用同一封闭提示选择。"""
    if type(profile) is str:
        if profile == DEFAULT_PROMPT_PROFILE:
            return GROUNDED_V4_PROMPT
        if profile == REFERENCE_UNIQUENESS_PROFILE:
            return GROUNDED_V4_REFERENCE_UNIQUENESS_PROMPT
    raise ValueError("未知的v4提取提示profile。")


def _enum(values: Iterable[str]) -> dict[str, Any]:
    return {"type": "string", "enum": sorted(values)}


GROUNDED_SCHEMA: dict[str, Any] = {
    "title": "GroundedMemoryDraft",
    "description": "原文分句标注；每个target恰好一条，禁止自由正文和日期。",
    "type": "object", "additionalProperties": False,
    "properties": {"units": {"type": "array", "maxItems": 512, "items": {
        "type": "object", "additionalProperties": False,
        "properties": {
            "unit": {"type": "string", "description": "输入中target的分句编号。"},
            "kind": _enum({*KINDS, *OMISSIONS, "condition", "prefix"}),
            "subject": _enum({"self", "contact", "shared"}),
            "topic": _enum({value.value for value in MemoryTopic}),
            "dependency": {"anyOf": [{"type": "string"}, {"type": "null"}]},
            "unresolved": {"type": "boolean"},
            "confidence": {"type": "number", "minimum": 0, "maximum": 1},
            "sensitivity": _enum(SENSITIVITY),
        },
        "required": ["unit", "kind", "subject", "topic", "dependency", "unresolved", "confidence", "sensitivity"],
    }}},
    "required": ["units"],
}



def grounded_schema(window: ExtractionWindow) -> dict[str, Any]:
    """模型只填写已命名的原文位置；编号和依赖取值由当前窗口提供。"""
    units = source_units(window)
    properties = {}
    for unit in units:
        if not unit.target:
            continue
        label = deepcopy(GROUNDED_SCHEMA["properties"]["units"]["items"])
        del label["properties"]["unit"]
        label["required"].remove("unit")
        choices = [other.id for other in units if other.id != unit.id]
        label["properties"]["dependency"] = {"enum": [None, *choices]}
        if needs_reference(unit):
            anchors = reference_choices(unit, units)
            branches: list[dict[str, Any]] = [
                {"properties": {"unresolved": {"const": True}}},
                {"properties": {"kind": _enum(OMISSIONS)}},
            ]
            if anchors:
                branches.append({"properties": {"dependency": _enum(anchors)}})
            label["anyOf"] = branches
            label["description"] = (
                "此原句含第三人指代：保存事实且unresolved=false时，dependency必须选择先前的独立依据。"
                "找不到可靠依据就unresolved=true；不能用后面的回答或另一个裸指代自证。"
            )
        properties[unit.id] = label
    return {
        "title": "GroundedMemoryLabels",
        "description": "填写程序指定的每个原文位置，不生成编号，不改写正文。",
        "type": "object", "additionalProperties": False,
        "properties": {"units": {
            "type": "object", "properties": properties,
            "required": list(properties), "additionalProperties": False,
        }},
        "required": ["units"],
    }


def grounded_event_schema(window: ExtractionWindow) -> dict[str, Any]:
    """默认事件提案使用独立合同，保持旧v2/v3/v4的冻结结构。"""
    schema = grounded_schema(window)
    units = source_units(window)
    for label in schema["properties"]["units"]["properties"].values():
        label["properties"]["event"] = {"anyOf": [{"type": "null"}, {
            "type": "object", "additionalProperties": False,
            "properties": {
                "stage": _enum(stage.value for stage in EventStage),
                "occurrence": {"enum": [None, *(unit.id for unit in units)]},
            },
            "required": ["stage", "occurrence"],
        }]}
        label["required"].append("event")
    return schema


def grounded_schema_v3(window: ExtractionWindow) -> dict[str, Any]:
    """v3复用精确位置与依赖约束，仅增加封闭的歧义类别。"""
    schema = grounded_schema(window)
    schema["title"] = "GroundedMemoryLabelsV3"
    for label in schema["properties"]["units"]["properties"].values():
        label["properties"]["ambiguity_codes"] = {
            "type": "array", "items": _enum(AMBIGUITY_CODES),
            "maxItems": len(AMBIGUITY_CODES), "uniqueItems": True,
        }
        label["required"].append("ambiguity_codes")
        label["allOf"] = [{"anyOf": [
            {"properties": {"unresolved": {"const": False}, "ambiguity_codes": {"maxItems": 0}}},
            {"properties": {"unresolved": {"const": True}, "ambiguity_codes": {"minItems": 1}}},
        ]}]
    return schema


def grounded_schema_v4(window: ExtractionWindow) -> dict[str, Any]:
    """独立v4开发合同；旧v3的实际枚举、提示和工具名保持原样。"""
    schema = grounded_schema_v3(window)
    schema["title"] = "GroundedMemoryLabelsV4"
    for label in schema["properties"]["units"]["properties"].values():
        label["properties"]["kind"] = _enum({
            *KINDS, *V4_KIND_EXTENSIONS, *V4_STRUCTURAL_KINDS, *OMISSIONS, "condition", "prefix",
        })
        codes = label["properties"]["ambiguity_codes"]
        codes["items"] = _enum(V4_AMBIGUITY_CODES)
        codes["maxItems"] = len(V4_AMBIGUITY_CODES)
    return schema


def grounded_input(window: ExtractionWindow) -> str:
    lines = []
    for unit in source_units(window):
        at = unit.message.occurred_at
        lines.append(f"[{unit.id}] [{'target' if unit.target else 'context'}] "
                     f"sender={unit.message.sender.value} occurred_at={at.isoformat() if at else 'unknown'} "
                     f"原文={unit.text}")
    return "\n".join(lines)


class GroundedExtractionRuntime:
    """生产与测试共用的单次结构提取接缝，保留原14槽下游接口。"""
    def __init__(self, *, model: BaseChatModel, prompt_profile: str = "default") -> None:
        grounded_v2_prompt(prompt_profile)
        self._model = model
        self._prompt_profile = prompt_profile

    @property
    def prompt_profile(self) -> str:
        return self._prompt_profile

    def for_prompt_profile(self, prompt_profile: str) -> GroundedExtractionRuntime:
        return type(self)(model=self._model, prompt_profile=prompt_profile)

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        return _extract_grounded(self._model, window, version3=False, prompt_profile=self._prompt_profile)


class GroundedV3ExtractionRuntime:
    """仅供显式选择的v3入口；生产默认仍使用v2。"""

    def __init__(self, *, model: BaseChatModel) -> None:
        self._model = model

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        return _extract_grounded(self._model, window, version3=True)


class GroundedV2ExtractionRuntime(GroundedExtractionRuntime):
    """已冻结的旧v2协议；供显式历史评测使用，不替代默认事件提取。"""

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        return _extract_grounded(self._model, window, version3=False, events=False,
                                 prompt_profile=self._prompt_profile)


class GroundedV4ExtractionRuntime:
    """显式v4提取；新增提示profile尚未绑定真实评测合同。"""

    def __init__(self, *, model: BaseChatModel, prompt_profile: str = DEFAULT_PROMPT_PROFILE) -> None:
        grounded_v4_prompt(prompt_profile)
        self._model = model
        self._prompt_profile = prompt_profile

    def extract(self, window: ExtractionWindow) -> ExtractionPayload:
        return _extract_grounded(self._model, window, version3=False, version4=True,
                                 prompt_profile=self._prompt_profile)


def _extract_grounded(
    model: BaseChatModel, window: ExtractionWindow, *, version3: bool, version4: bool = False,
    prompt_profile: str = DEFAULT_PROMPT_PROFILE,
    events: bool = True,
) -> ExtractionPayload:
    if version3 and prompt_profile != DEFAULT_PROMPT_PROFILE:
        raise ValueError("v3不接受提取提示profile。")
    if version4:
        protocol, prompt, schema_factory, compiler = (
            "grounded-v4", grounded_v4_prompt(prompt_profile), grounded_schema_v4, compile_labels_v4,
        )
    elif version3:
        protocol, prompt, schema_factory, compiler = (
            "grounded-v3", GROUNDED_V3_PROMPT, grounded_schema_v3, compile_labels_v3,
        )
    elif events:
        protocol, prompt, schema_factory, compiler = (
            GROUNDED_EXTRACTION_PROTOCOL, grounded_v2_prompt(prompt_profile, events=True),
            grounded_event_schema, compile_event_labels,
        )
    else:
        protocol, prompt, schema_factory, compiler = (
            "grounded-v2", grounded_v2_prompt(prompt_profile), grounded_schema, compile_labels,
        )
    try:
        schema = schema_factory(window)
        response = invoke_traced_model(
            model, purpose="extraction", schema=schema,
            messages=[{"role": "system", "content": prompt},
                      {"role": "user", "content": grounded_input(window)}],
        )
    except (ExtractionRuntimeError, TraceWriteError):
        raise
    except Exception:
        raise ExtractionRuntimeError("原文结构提取调用失败。") from None
    calls = getattr(response, "tool_calls", None)
    if not isinstance(calls, list) or len(calls) != 1 or calls[0].get("name") != schema["title"]:
        raise ExtractionInvalidOutputError("原文结构提取必须返回唯一的指定工具。")
    draft = calls[0].get("args")
    identity = {"protocol": protocol}
    if prompt_profile in {BOUNDED_STAGE_PROMPT_PROFILE, BOUNDED_DEPENDENCY_PROMPT_PROFILE, BOUNDED_DEPENDENCY_V3_PROMPT_PROFILE,
                          CORE_CURRENT_STATE_PROFILE, REFERENCE_KIND_PROMPT_PROFILE}:
        identity.update(prompt_profile=prompt_profile, prompt_sha256=hashlib.sha256(json.dumps(
            prompt, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False,
        ).encode("utf-8")).hexdigest())
    if not version3 and not version4 and events:
        identity["compiler_version"] = GROUNDED_COMPILER_VERSION
    record("grounded_draft", {**identity, "units": source_units(window), "draft": draft})
    try:
        payloads = compiler(window, draft)
    except ExtractionInvalidOutputError:
        record("grounded_compile", {"status": "rejected", **identity}, status="rejected")
        raise
    record("grounded_compile", {**identity, "status": "compiled", "payloads": payloads})
    return payloads
