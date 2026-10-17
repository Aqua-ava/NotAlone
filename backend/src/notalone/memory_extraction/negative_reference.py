"""E2完整来源与候选的有限负向说明；不绑定身份或提供正向依据。"""

from __future__ import annotations

import re
from uuid import UUID

from notalone.memory_extraction.models import ExtractionWindow, MessageRef, MessageSender
from notalone.memory_extraction.source_proof import unresolved_author_quote_note


_VISIT = re.compile(r"(?:他们|她们)(?:周末|明天|后天)(?:要|会|不|不会)?(?:来家里|来家中)。?")
_QUESTION = re.compile(r"(?P<label>[老小][\u4e00-\u9fff])借你钱了吗[？?]")
_ANSWER = re.compile(r"借了，(?P<label>[老小][\u4e00-\u9fff])(?:没借|没有借)。?")
_VISIT_NOTES = (
    "原句中的复数代词未在本窗口绑定到具体来访者；不补人物身份，来访与否及时间仍以原句为准。",
    "原句只写家里／家中，地点属于谁的家在本窗口未明确；不认定用户、联系人或其他人的住处，也不认定产权。",
)
_DIRECTION_NOTES = (
    "所引原句中的“借”，一种可能的方向是向对方借入；人物与肯定／否定仍以所附原句为准，"
    "本窗不确认此方向，也不把否定解释为发生。 所附原引句及上下文：",
    "所引原句中的“借”，另一种可能的方向是借给对方；人物与肯定／否定仍以所附原句为准，"
    "本窗不确认此方向，也不把否定解释为发生。 所附原引句及上下文：",
)


def _author(message: MessageRef) -> str:
    return "用户" if message.sender is MessageSender.SELF else "联系人"


def _whole_quote_matches(text: str, message: MessageRef, main: str, context: str = "") -> bool:
    body = _author(message) + "原话：“" + main + "”" + context
    if text == body:
        return True
    at = message.occurred_at
    return (at is not None and at.utcoffset() is not None
            and text == f"截至{at.date().isoformat()}，" + body)


def bounded_negative_reference_notes(
    window: ExtractionWindow, *, text: str, source_message_ids: tuple[UUID, ...],
) -> tuple[str, ...]:
    """只追加完整文法已明确未绑定的关系说明；范围外为空，不裁剪或修复输入。"""
    messages = window.messages
    if any(type(message.sender) is not MessageSender for message in messages):
        return ()
    # 原产权／受益人分支沿原合同；新增文法不改变V已有负向识别范围。
    previous = unresolved_author_quote_note(window, text, source_message_ids)
    if previous is not None:
        return (previous,)
    if (
        len(messages) not in {1, 2}
        or window.target_message_ids != (messages[-1].message_id,)
        or len({message.message_id for message in messages}) != len(messages)
        or any(type(message.sender) is not MessageSender or not 1 <= len(message.text) <= 4096
               for message in messages)
        or not 1 <= len(text) <= 4096
    ):
        return ()
    # 延迟读取实际分句接口，避免将新说明挂入共享编译路径。
    from notalone.memory_extraction.grounded import source_units

    if len(messages) == 1:
        message = messages[0]
        if (source_message_ids != (message.message_id,)
                or _VISIT.fullmatch(message.text) is None):
            return ()
        units = source_units(window)
        if (len(units) != 1 or units[0].start != 0 or units[0].end != len(message.text)
                or not _whole_quote_matches(text, message, units[0].text)):
            return ()
        return _VISIT_NOTES
    question, answer = messages
    asked, replied = _QUESTION.fullmatch(question.text), _ANSWER.fullmatch(answer.text)
    if (
        question.sender is answer.sender or source_message_ids != (answer.message_id, question.message_id)
        or asked is None or replied is None or asked["label"] == replied["label"]
    ):
        return ()
    units = source_units(window)
    question_units = tuple(unit for unit in units if unit.message.message_id == question.message_id)
    answer_units = tuple(unit for unit in units if unit.message.message_id == answer.message_id)
    if (
        len(question_units) != 1 or question_units[0].start != 0
        or question_units[0].end != len(question.text)
        or len(answer_units) != 2 or answer_units[0].start != 0 or answer_units[0].text != "借了，"
        or answer_units[1].start != answer_units[0].end or answer_units[1].end != len(answer.text)
        or answer_units[1].text != answer.text[len("借了，"):]
    ):
        return ()
    context = "（相关原文：" + _author(question) + "说“" + question.text + "”）"
    if not any(_whole_quote_matches(text, answer, unit.text, context) for unit in answer_units):
        return ()
    notes = tuple(prefix + text for prefix in _DIRECTION_NOTES)
    return notes if all(len(note) <= 8400 for note in notes) else ()
