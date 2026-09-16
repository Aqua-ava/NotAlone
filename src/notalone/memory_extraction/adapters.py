"""记忆提取的 LangChain 结构化输出运行时 adapter。"""

from __future__ import annotations

from typing import Any

from langchain_core.language_models import BaseChatModel

from notalone.memory.models import MemoryCategory
from notalone.memory_extraction.errors import ExtractionRuntimeError
from notalone.memory_extraction.models import (
    AssertionStatus,
    ExtractionWindow,
    FigurativeType,
    MemoryTopic,
    SpeechAct,
)
from notalone.memory_extraction.runtime import ExtractionPayload


EXTRACTION_SYSTEM_PROMPT = """你从一位联系人的聊天消息窗口中提取值得复核的关系主张。
先做语用解释，再决定是否输出：必须结合上下文理解语气，区分事实、计划、假设、转述、
问题、请求、纠正、玩笑、反讽和夸张。反讽、玩笑、抱怨不能按字面理解，如"你可真行啊"
不是赞赏。
speech_act 取值：assertion=直接陈述本人或双方的事实、经历、状态、习惯，含"我已经…"
"我平时…"；plan=尚待实现的打算；question=提问；request=请求或要求；report=转述第三方
的话或内容；correction=更正或撤回此前说法；unknown=无法判断。第一人称完成事实属于
assertion，不是 report。speech_act 描述发送者正在做什么：陈述用户、联系人或双方的
事实用 assertion，无论发送者是谁；转引别人的话、传达第三方的说法或事件用 report +
reported，第三方的未来安排用 plan，不得把第三方的事件当作联系人本人的已成立事实。
尚未发生的日程、安排、约定、打算
一律属于 plan，即使语气确定、时间已定，如“我年底去哈尔滨看雪”“月底要交报告”
“这周末得加班”；只有已经发生或当前持续的事实才用 assertion。
assertion_status 取值：asserted=把内容当作已成立的事实；hypothetical=假设；
conditional=条件；reported=转述；unknown=无法判断。
figurative_type 取值：literal=按字面理解；joke=玩笑；sarcasm=反讽（字面褒义实为贬义或
相反）；hyperbole=夸张（"累死了""饿死了"）；unknown=无法判断。
category 只能取 common_fact、preference、taboo、recent_state、relationship_note 之一；
topic 只能取 health、work、family、travel、finance、study、emotion、other 之一；不要把
topic 的词（如 family、health、travel）填进 category。分类示例：习惯与口味用
preference，禁忌用 taboo，共同经历用 common_fact，近况与未来安排用 recent_state，
家人、朋友与关系动态用 relationship_note。
示例：对方帮倒忙后说"你太厉害了，真是帮了我大忙"是 sarcasm；"你可真行，又给我添乱"这类挖苦抱怨只表达情绪，是 sarcasm，不要提取其中的字面事实；
"累死了"是 hyperbole；"我妈让我…"是 report + reported；反问句（如"我什么时候骗过你"）不要提取事实；一次性邀约（如"要不要一起去看展"）
同样不提取，无论标为 question 还是 request；被点破的吹牛（"你又开始吹了"）标 figurative_type=unknown。
confidence 反映你对事实与标签的把握，而不是事实的重要性：语气确定、证据在 target
消息里直接出现时应不低于 0.8；只有存在真实不确定时才低于 0.7。
每条事实必须标注主体：这件事是谁的（self=用户本人，contact=联系人，shared=双方共同），
消息的发送者标注是判断依据，不得把用户自己说的内容记成联系人的事。用“我们”表达的
双方共同经历、约定或计划，主体标为 shared，不要记成单方的事。只有两人的窗口里，
未指明身份的“他/她/那个人”默认指联系人，不要按第三方处理，也不要为此填写
alternatives；上下文里出现了其他第三方时才需要区分身份。命题文本不写用户或联系人的
名字、昵称或备注，统一用“用户”“联系人”称呼双方，涉及第三方时沿用消息里的称呼。
只提取值得跨对话长期记住、或值得用户确认的主张；纯问题、寒暄（"吃了吗""在吗"）、
纯表情或语气词、一次性安排的细节、纯玩笑和夸张、转发或引用外部内容（视频、文章、
传闻）的命题、双方对外部信息的情绪反应、对第三方的情绪反应不要输出，如对方转来一条
“牛奶能助眠”的链接并说“不知道真的假的”，不要提取。不要从对话形式推断事实（如“某人向
另一人提起过某事”），也不要臆测双方亲友之间的互动。计划、假设、条件、转述、纠正或无法判断的内容如果对关系理解有帮助，可以输出，
但必须准确标注状态，不能写成确定事实。假设与条件句（如“如果项目成了，我就换车”）
只要与关系理解有关，就应当输出并标 hypothetical 或 conditional，不要省略。
“我准备贷款30万加仓”应标记为计划或歧义，不得改写成“已经贷款30万”。
媒体占位文本（如"[图片]""[语音]"）只能推断发送行为偏好，不得推测消息内容。
窗口行里的 occurred_at 是消息时间，用来推算相对时间。valid_at 表示事实或安排的生效
时间：未来计划、未来约定与有时效的状态必须填写 valid_at，按 occurred_at 推算带时区的
ISO 8601 时间，例如“2026-10-01T09:00:00+08:00”，不能只写日期、不能留空；已经发生
且没有明确时限的事实留空。
invalid_at 只在消息明确指出未来失效时间时填写，格式相同。取消或撤回的记录为已发生
的事实，不要用 valid_at、invalid_at 表达取消。
只有标记为 target 的消息可以作为该候选的主证据；上下文消息只能辅助理解，不要只凭
上下文消息提取事实，候选必须由 target 消息直接支持。每条事实的 source_message_ids
只能填写输入中标注的 message_id，且至少包含一个 target 消息 ID。一条候选只能由
语义相连的消息支撑：不得把窗口里不同话题的人、地点、事件或结论拼成同一条事实；
无法由相连消息说明来源时，宁可不提取。
alternatives 只在该表达可能不是字面事实、或存在实质歧义时填写少量其他解释；语气明确、
证据直接时留空数组。如果 speech_act、assertion_status、figurative_type 与主体已经
确定，不要再用 alternatives 复述与标签或主体判断矛盾的其他猜测。对方在祝贺或回应
里提到用户的已完成事实，按字面事实处理，不要用 alternatives 质疑证据来源。interpretation_reason 只写一句面向用户的简短依据，不要输出模型
内部思考过程。
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
                            "支持该事实的消息 ID 数组，只能填输入中的 message_id。"
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
                            "带时区的 ISO 8601 生效时间；未来计划与有时效状态按消息的 "
                            "occurred_at 推算填写，已发生且无时限的事实为空。"
                        ),
                        "anyOf": [{"type": "string"}, {"type": "null"}],
                    },
                    "invalid_at": {
                        "description": (
                            "带时区的 ISO 8601 失效时间；只在消息明确给出结束、取消或"
                            "失效时间时填写，可为空。"
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
                            "hypothetical=假设；conditional=条件；reported=转述；"
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
                            "只有该表达可能不是字面事实或存在实质歧义时才填写其他解释；"
                            "语气明确、证据直接时为空数组。"
                        ),
                        "type": "array",
                        "items": {"type": "string"},
                    },
                    "interpretation_reason": {
                        "description": "一条面向用户的简短语用判断依据，不是内部思考过程。",
                        "type": "string",
                    },
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
            bound = self._model.bind_tools([EXTRACTION_SCHEMA])
            message = bound.invoke(
                [
                    {"role": "system", "content": EXTRACTION_SYSTEM_PROMPT},
                    {"role": "user", "content": _window_text(window)},
                ]
            )
        except ExtractionRuntimeError:
            raise
        except Exception as error:
            raise ExtractionRuntimeError("模型调用失败，未生成记忆。") from error
        tool_calls = getattr(message, "tool_calls", None)
        if not tool_calls:
            raise ExtractionRuntimeError("模型未返回可解析的结构化事实。")
        args = tool_calls[0].get("args")
        facts_payload = args.get("facts") if isinstance(args, dict) else None
        if not isinstance(facts_payload, list):
            raise ExtractionRuntimeError("模型未返回可解析的结构化事实。")
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
        f"occurred_at={message.occurred_at.isoformat()} "
        f"sender={message.sender.value}: {message.text}"
        for index, message in enumerate(window.messages)
    ]
    return "\n".join(lines)
