"""有界来源日历核对；不以运行日期或数据库时区填造事实日期。"""
from dataclasses import replace
from datetime import datetime, timedelta
import re
from collections.abc import Mapping
from uuid import UUID
from notalone.memory_extraction.models import ExtractedFact, ExtractionWindow, MessageRef
from notalone.memory.events import MemoryEvent
from notalone.memory_extraction.source_proof import bounded_source_occurred_at


def source_calendar_time(message: MessageRef) -> datetime | None:
    return bounded_source_occurred_at(message)


def checked_event_calendar(event: MemoryEvent, messages: Mapping[UUID, MessageRef],
                           source_ids: tuple[UUID, ...]) -> MemoryEvent:
    if event.version == 1:
        return event
    anchor = messages.get(event.anchor_message_id)
    expression = event.occurrence_expression
    if anchor is None or anchor.message_id not in source_ids:
        if event.anchor_message_id is not None or expression is not None:
            raise ValueError("时间锚点必须属于实际候选来源。")
        return _unknown(event)
    positions = [item for item in event.occurrence_evidence if item.message_id == anchor.message_id]
    matches = [item.char_start + anchor.text[item.char_start:item.char_end].find(expression) for item in positions
               if expression and expression in anchor.text[item.char_start:item.char_end]]
    if not expression or not matches:
        raise ValueError("原始时间表达必须出自发生时段依据片段。")
    actual = source_calendar_time(anchor)
    # 转述中的相对日历可能属于被转述的时点，不机械套发送日。
    prefixes = [re.split(r"[。！？；;\n]", anchor.text[:index])[-1] for index in matches]
    if any(re.search(r"(?:说|表示|告诉|提到|转述|问)", prefix) for prefix in prefixes):
        return _unknown(event)
    try:
        expected = _calendar(expression, actual)
    except (ValueError, OverflowError):
        expected = None
    if expected is None:
        return _unknown(event)
    precision, start, end = expected
    if (not event.occurrence_verified or event.occurrence_precision != precision
            or event.occurrence_start != start or event.occurrence_end != end
            or event.occurrence_start.utcoffset() != start.utcoffset()
            or end is not None and event.occurrence_end.utcoffset() != end.utcoffset()):
        return _unknown(event)
    return event


def _unknown(event: MemoryEvent) -> MemoryEvent:
    return replace(event, occurrence_start=None, occurrence_end=None,
                   occurrence_precision="unknown", occurrence_verified=False)


def _calendar(expression: str, anchor: datetime | None) -> tuple[str, datetime, datetime | None] | None:
    # 绝对时刻自带时区；没有来源时区时不解释年/月/日的当地边界。
    try:
        instant = datetime.fromisoformat(expression)
        if "T" in expression and instant.utcoffset() is not None:
            return "instant", instant, None
    except ValueError:
        pass
    parts = re.split(r"(?:到|至|—|~)", expression)
    if len(parts) == 2 and all(parts):
        first, last = _calendar(parts[0].strip(), anchor), _calendar(parts[1].strip(), anchor)
        if first is not None and last is not None and first[0] == last[0]:
            end = last[1] if last[0] == "instant" else last[2]
            if end is not None and end > first[1]:
                return first[0], first[1], end
    if anchor is None:
        return None
    day = anchor.replace(hour=0, minute=0, second=0, microsecond=0)
    relative_clock = re.fullmatch(r"(前天|昨天|今天|明天|后天)(?:上午|下午|晚上)?(\d{1,2})(?:[:：]|点)(\d{2})?(?:分)?", expression)
    if relative_clock:
        relative, hour, minute = relative_clock.groups()
        base = _calendar(relative, anchor)
        clock_hour = int(hour)
        if ("下午" in expression or "晚上" in expression) and clock_hour < 12:
            clock_hour += 12
        return "instant", base[1].replace(hour=clock_hour, minute=int(minute or 0)), None
    explicit = re.fullmatch(r"(\d{4})(?:年|-)(\d{1,2})(?:月|-)(\d{1,2})日?(?:[ T]?(\d{1,2})(?:[:：]|点)(\d{2})?(?:分)?(?::(\d{2}))?(?:到|至|—|~)?(?:(\d{1,2})(?:[:：]|点)(\d{2})?(?:分)?(?::(\d{2}))?)?)?", expression)
    if explicit:
        year, month, date, hour, minute, second, end_hour, end_minute, end_second = explicit.groups()
        start = day.replace(year=int(year), month=int(month), day=int(date),
                            hour=int(hour or 0), minute=int(minute or 0), second=int(second or 0))
        if hour is None:
            return "day", start, start + timedelta(days=1)
        end = start.replace(hour=int(end_hour), minute=int(end_minute or 0), second=int(end_second or 0)) if end_hour else None
        if end is not None and end <= start:
            return None
        return "instant", start, end
    offsets = {"前天": -2, "昨天": -1, "今天": 0, "明天": 1, "后天": 2}
    if expression in offsets:
        start = day + timedelta(days=offsets[expression])
        return "day", start, start + timedelta(days=1)
    if expression in {"去年", "今年", "明年"}:
        year = day.year + {"去年": -1, "今年": 0, "明年": 1}[expression]
        return "year", day.replace(year=year, month=1, day=1), day.replace(year=year+1, month=1, day=1)
    if expression in {"上月", "上个月", "本月", "这个月", "下月", "下个月"}:
        number = day.year * 12 + day.month - 1 + {"上月": -1, "上个月": -1, "本月": 0, "这个月": 0, "下月": 1, "下个月": 1}[expression]
        return "month", day.replace(year=number//12, month=number%12+1, day=1), day.replace(year=(number+1)//12, month=(number+1)%12+1, day=1)
    if expression in {"上周", "本周", "这周", "下周"}:
        start = day + timedelta(days=-day.weekday()+7*{"上周":-1,"本周":0,"这周":0,"下周":1}[expression])
        return "day", start, start+timedelta(days=7)
    match = re.fullmatch(r"(\d{4})年(?:(\d{1,2})月(?:(\d{1,2})日)?)?", expression)
    if match:
        year, month, date = match.groups()
        try:
            start = day.replace(year=int(year), month=int(month or 1), day=int(date or 1))
            if date:
                return "day", start, start+timedelta(days=1)
            if month:
                return "month", start, start.replace(year=start.year+(start.month==12),month=start.month%12+1)
            return "year", start, start.replace(year=start.year+1)
        except ValueError:
            return None
    return None


def source_grounded_validity(fact: ExtractedFact, window: ExtractionWindow) -> ExtractedFact:
    """正式直接提取不生成观察点默认期限；明确日历期间另作有界检查。"""
    if not fact.requires_all_sources or (fact.valid_at is None and fact.invalid_at is None):
        return fact
    relevant = [message for message in window.messages if message.message_id in fact.source_message_ids]
    # 明确数字日期与复杂期间交给独立语义核验，不在这里扩展自然语言规则大全。
    if any(re.search(r"\d{1,4}(?:年|月|日|号|[-/:])", message.text) for message in relevant):
        return fact
    found = []
    for message in relevant:
        expressions = re.findall(r"(?:前天|昨天|今天|明天|后天|去年|今年|明年|上个月|这个月|下个月|上月|本月|下月|上周|本周|这周|下周)(?![一二三四五六日天])", message.text)
        for expression in expressions:
            if re.search(r"(?:说|表示|转述)", message.text[:message.text.find(expression)]):
                continue
            try:
                value = _calendar(expression, source_calendar_time(message))
            except (ValueError, OverflowError):
                value = None
            if value is not None:
                found.append(value)
    if len(found) == 1:
        _, start, end = found[0]
        if (fact.valid_at == start and fact.invalid_at == end
                and fact.valid_at.utcoffset() == start.utcoffset()
                and fact.invalid_at.utcoffset() == end.utcoffset()):
            return fact
    return replace(fact, valid_at=None, invalid_at=None)
