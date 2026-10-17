"""E2私有的有限来源语义；不决定身份、采纳或来源信用。"""
from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

from notalone.memory_extraction.models import ExtractionWindow, MessageSender

if TYPE_CHECKING:
    from notalone.memory_extraction.grounded import SourceUnit

_SUBJECT = r"(?:我们|我|你)?"
_UNCERTAIN = r"(?:可能|也许|不一定)"
_STATE = re.compile(
    rf"{_SUBJECT}{_UNCERTAIN}(?:有点|有些|稍微)?"
    r"(?:感冒|发烧|咳嗽|头疼|头晕|不舒服)[，。]?"
)
_BARE_CLOCK = re.compile(
    r"(?:今天)?(?:我)?(?:加班|工作|值班|学习|等候)到"
    r"(?:十一|十二|一|二|两|三|四|五|六|七|八|九|十)点[，。]?"
)
_AMOUNT = r"[1-9][0-9]{0,5}(?:\.[0-9]{1,2})?(?:w|万|元)"
_MODALS = ("", "计划", "打算", "准备", "要", "会", "约好", "一起", "都", "临时",
           "只", "就", "才", "可能", "也许", "不一定")
_SUBJECTS = ("", "我", "你", "我们")
_WEATHER_SCENARIO = re.compile(
    r"(?P<time>今天|明天|后天|本周|这周|下周|本周末|这周末|周末|下周末|下个月|下月)"
    r"(?:下雨|降雨|不下雨|不降雨|天晴)"
)
_NUMBER = r"(?:[0-9一二两三四五六七八九十百]+(?:多|来|几)?|半|几|数|若干)"
_PHASE = r"(?:之前|之后|以前|以后|以内|左右|期间|中旬|[上中下]旬|初|底|末|前|后|起|内)"
_WEEK_DAY = r"(?:本|这|下)?周[一二三四五六日天]"
_SINGLE_DAY = rf"(?:今天|明天|后天|{_WEEK_DAY})"
_FINITE_CLOCK = (r"(?:上午(?:十一|一|二|三|四|五|六|七|八|九|十)|"
                 r"下午[一二三四五六]|晚上(?:十一|六|七|八|九|十)|中午十二)点")
_FINANCIAL_TP = re.compile(
    rf"{_SINGLE_DAY}(?:{_FINITE_CLOCK})?|{_WEEK_DAY}(?:到|至){_WEEK_DAY}|"
    r"(?:本|这|下)周|(?:本|这|下)?周末|下个月|下月"
)
_DAY_WORD = r"(?:[上下前后本这每大小]+个?)?(?:周末|周[一二三四五六日天]?|今天|明天|后天)"
_CLOCK_WORD = rf"(?:(?:上午|下午|晚上|中午|凌晨|午夜|早上|傍晚)?{_NUMBER}点(?:半|{_NUMBER}分)?|[0-9]{{1,2}}:[0-9]{{2}})"
_TIME_WORD = re.compile(
    rf"(?:(?:{_DAY_WORD})(?:(?:到|至){_WEEK_DAY})?(?:{_CLOCK_WORD})?(?:{_PHASE})?)|"
    rf"(?:(?:[上下前后本这每大小再隔另]+|{_NUMBER})个?月(?:份)?(?:{_PHASE})?|月{_PHASE})|"
    rf"(?:{_NUMBER}个?(?:年|周末|星期|礼拜|周|天|日|号|小时|时|点|分钟|分|秒))|"
    r"(?:[前去今明后本这每]+年|星期|礼拜|以后|将来|之前|之后|"
    r"上旬|中旬|下旬|月初|月中|月底|月末|期间|以内|左右)"
)
_RESERVED = (
    "我们", "我", "你", "不", "没", "非", "除", "别", "勿", "如果", "假如", "要是", "倘若",
    "然后", "但是", "不过", "另外", "其实", "并且", "还要", "已经", "刚刚", "刚", "曾经",
    "取消", "改期", "去", "回", "来", "到", "在", "玩", "旅行", "出差", "发展", "参加",
    "工作", "值班", "入职", "出发", "休息", "露营", "爬山", "吃饭", "请", "带", "吃",
    "之前", "之后", "起", "左右", "期间", "以内", "可能", "也许", "一定", "会", "准备",
)


@dataclass(frozen=True)
class _Action:
    time: str | None
    modal: str
    family: str


@dataclass(frozen=True)
class _Condition:
    outer_time: str | None
    condition_time: str | None
    action: _Action
    scenario_time: str | None = None


def _body(text: str) -> str:
    return text[:-1] if text.endswith(("，", "。")) else text


def _opaque(text: str) -> bool:
    return (re.fullmatch(r"[\u4e00-\u9fff]{1,32}", text) is not None
            and not any(word in text for word in _RESERVED)
            and _TIME_WORD.search(text) is None)


def _event(text: str) -> str | None:
    if text in {"入职", "出发", "休息", "露营", "爬山", "吃饭", "去露营", "去爬山", "去吃饭"}:
        return "activity"
    if text in {"请你吃饭", "请你喝茶", "请你爬山", "请你露营"}:
        return "response"
    if text.startswith("带你去吃") and _opaque(text[4:]):
        return "response"
    if text.startswith("参加") and _opaque(text[2:]):
        return "activity"
    choices = []
    if text.startswith(("去", "回", "来", "到")):
        rest = text[1:]
        for suffix in ("", "玩", "旅行", "出差", "发展"):
            place = rest[:-len(suffix)] if suffix and rest.endswith(suffix) else rest if not suffix else ""
            if _opaque(place):
                choices.append("move")
        if "参加" in rest:
            place, _, obj = rest.partition("参加")
            if _opaque(place) and _opaque(obj):
                choices.append("move")
    if text.startswith("在"):
        for suffix in ("", "工作", "值班"):
            place = text[1:-len(suffix)] if suffix and text.endswith(suffix) else text[1:] if not suffix else ""
            if _opaque(place):
                choices.append("location")
    return choices[0] if len(choices) == 1 else None


def _action(text: str, *, conditional: bool = False) -> _Action | None:
    body = _body(text)
    times = list(_TIME_WORD.finditer(body))
    choices: set[_Action] = set()
    modals = (*_MODALS, "一定") if conditional else _MODALS
    for subject in _SUBJECTS:
        for before in modals if times else (("", "一定", "就", "才", "只") if conditional else ("",)):
            prefix = subject + before
            if not body.startswith(prefix):
                continue
            if times:
                if len(times) != 1 or times[0].start() != len(prefix):
                    continue
                time = times[0].group()
                rest = body[times[0].end():]
            else:
                time, rest = None, body[len(prefix):]
            for after in modals if time is not None and not before else ("",):
                if not rest.startswith(after):
                    continue
                event = rest[len(after):]
                if event.startswith("不会"):
                    event = event[2:]
                elif event.startswith("不"):
                    event = event[1:]
                family = _event(event)
                if family is not None:
                    choices.add(_Action(time, before or after, family))
    return next(iter(choices)) if len(choices) == 1 else None


def _precondition(text: str) -> tuple[bool, str | None]:
    # 先核完整天气，避免把“下周天晴”的“天”误吞成星期日。
    for weather in ("下雨", "降雨", "不下雨", "不降雨", "天晴"):
        if text.endswith(weather):
            weather_time = text[:-len(weather)]
            if not weather_time or _TIME_WORD.fullmatch(weather_time):
                return True, weather_time or None
    match = _TIME_WORD.match(text)
    time = match.group() if match else None
    rest = text[match.end():] if match else text
    if time is None or time.endswith("前"):
        if rest == "能完工" or any(rest.startswith(prefix) and _opaque(rest[len(prefix):])
                                  for prefix in ("能完成", "能做完")):
            return True, time
    if time is None and rest.startswith(("我", "你")) and rest[1:2] in {"来", "去", "到"}:
        return _opaque(rest[2:]), None
    return False, None


def _condition(first: str, second: str) -> _Condition | None:
    if not first.endswith("，") or first.endswith("，，"):
        return None
    action = _action(second, conditional=True)
    if action is None:
        return None
    body = first[:-1]
    match = _TIME_WORD.match(body)
    outer = match.group() if match else None
    rest = body[match.end():] if match else body
    for connector in ("如果", "假如", "要是", "倘若", "若"):
        if rest.startswith(connector):
            valid, inner = _precondition(rest[len(connector):])
            if valid:
                scenario = _WEATHER_SCENARIO.fullmatch(rest[len(connector):])
                body_action = _body(second)
                complete_response = not any(marker in body_action for marker in ("吧", "了", "吗")) and any(
                    body_action.startswith(subject + "就")
                    and _event(body_action[len(subject) + 1:]) is not None for subject in _SUBJECTS
                )
                scenario_time = scenario["time"] if outer is None and scenario and complete_response else None
                return _Condition(outer, inner, action, scenario_time)
    if outer is None and body.endswith("的话"):
        valid, inner = _precondition(body[:-2])
        if valid:
            return _Condition(None, inner, action)
    if body.startswith("你要是") and body[3:4] in {"来", "去", "到"} and _opaque(body[4:]):
        return _Condition(None, None, action)
    return None


def _eligible(
    window: ExtractionWindow, members: list[SourceUnit], dependencies: list[SourceUnit],
    candidate_chars: int,
) -> bool:
    """只处理显式实际目标和当前renderer完整保留的有限依赖。"""
    messages = window.messages
    ids = [message.message_id for message in messages]
    return (
        window.target_message_ids is not None and 0 < len(messages) <= 4
        and len(ids) == len(set(ids))
        and all(isinstance(message.sender, MessageSender) and len(message.text) <= 4096
                for message in messages)
        and 0 < len(members) <= 2 and len(dependencies) <= 4 and candidate_chars <= 4096
        and all(member.message.message_id == members[0].message.message_id and member.target
                for member in members)
        and all(unit.message.message_id in ids for unit in [*members, *dependencies])
    )


def _uncertain_state(text: str) -> bool:
    return _STATE.fullmatch(text) is not None


def _uncertain_plan(text: str) -> bool:
    action = _action(text)
    if action is not None and action.modal in {"可能", "也许", "不一定"}:
        return True
    match = re.fullmatch(rf"{_SUBJECT}(?:以后|将来)?{_UNCERTAIN}(?:不)?(?P<event>.+?)[，。]?", text)
    return match is not None and _event(match["event"]) is not None


def _bare_clock(text: str) -> bool:
    return _BARE_CLOCK.fullmatch(text) is not None


def _financial_atom(text: str) -> bool:
    if re.fullmatch(rf"(?:我)?贷款 ?{_AMOUNT} ?(?:加仓|投资|周转)", text):
        return True
    match = _TIME_WORD.match(text)
    if match:
        if _FINANCIAL_TP.fullmatch(match.group()) is None:
            return False
        text = text[match.end():]
        if text.startswith(" "):
            text = text[1:]
    return re.fullmatch(rf"{_AMOUNT} ?到手", text) is not None


def _financial_challenge(
    window: ExtractionWindow, unit: SourceUnit, dependencies: list[SourceUnit],
) -> bool:
    if len(window.messages) != 2 or len(dependencies) != 1:
        return False
    claim, challenge = window.messages
    dep = dependencies[0]
    if (unit.message.message_id != claim.message_id or claim.sender == challenge.sender
            or dep.message.message_id != challenge.message_id
            or dep.start != 0 or dep.end != len(challenge.text)
            or re.fullmatch(r"你(?:又)?(?:开始)?(?:吹|吹牛)(?:了)?[。]?", challenge.text) is None):
        return False
    atoms = _body(claim.text).split("，")
    return (1 <= len(atoms) <= 2 and all(_financial_atom(atom) for atom in atoms)
            and _financial_atom(_body(unit.text)))


def _unique_local(value: datetime) -> bool:
    try:
        return (value.utcoffset() is not None
                and value.replace(fold=0).utcoffset() == value.replace(fold=1).utcoffset()
                and value.astimezone(timezone.utc).astimezone(value.tzinfo) == value)
    except (ValueError, OverflowError):
        return False


def _weekday(token: str, day: datetime, *, inherited: str | None = None) -> datetime | None:
    match = re.fullmatch(r"(?P<week>本|这|下)?周(?P<day>[一二三四五六日天])", token)
    if match is None:
        return None
    week = match["week"] or inherited
    number = "一二三四五六日".index("日" if match["day"] == "天" else match["day"])
    result = day + timedelta(days=-day.weekday() + number + (7 if week == "下" else 0))
    if week is None and result < day:
        return None
    return result


def _day_interval(token: str, day: datetime) -> tuple[datetime, datetime] | None:
    if token in {"今天", "明天", "后天"}:
        start = day + timedelta(days={"今天": 0, "明天": 1, "后天": 2}[token])
    else:
        weekday = _weekday(token, day)
        if weekday is None:
            return None
        start = weekday
    return start, start + timedelta(days=1)


def _calendar(token: str, anchor: datetime | None) -> tuple[datetime, datetime] | None:
    if anchor is None or anchor.utcoffset() is None:
        return None
    try:
        day = anchor.replace(hour=0, minute=0, second=0, microsecond=0, fold=0)
        interval = _day_interval(token, day)
        if token in {"下个月", "下月"}:
            start = day.replace(year=day.year + (day.month == 12), month=day.month % 12 + 1, day=1)
            interval = start, start.replace(year=start.year + (start.month == 12), month=start.month % 12 + 1)
        elif token in {"本周", "这周", "下周", "本周末", "这周末", "周末", "下周末"}:
            start = day + timedelta(days=-day.weekday() + (7 if token.startswith("下") else 0)
                                    + (5 if token.endswith("末") else 0))
            interval = start, start + timedelta(days=2 if token.endswith("末") else 7)
        else:
            span = re.fullmatch(rf"(?P<first>{_WEEK_DAY})(?:到|至)(?P<last>{_WEEK_DAY})", token)
            clock = re.fullmatch(rf"(?P<day>今天|明天|后天|{_WEEK_DAY})"
                                 r"(?P<part>上午|下午|晚上|中午)(?P<hour>十一|十二|一|二|三|四|五|六|七|八|九|十)点", token)
            if span:
                first = _weekday(span["first"], day)
                inherited = span["first"][0] if span["first"][0] != "周" else None
                last = _weekday(span["last"], day, inherited=inherited)
                if (first is None or last is None or first > last
                        or first.date() - timedelta(days=first.weekday())
                        != last.date() - timedelta(days=last.weekday())):
                    return None
                interval = first, last + timedelta(days=1)
            elif clock:
                single_day = _day_interval(clock["day"], day)
                hours = {word: number for number, word in enumerate(
                    ("零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"))}
                hour = hours[clock["hour"]]
                part = clock["part"]
                if (single_day is None or not (
                    part == "上午" and 1 <= hour <= 11 or part == "下午" and 1 <= hour <= 6
                    or part == "晚上" and 6 <= hour <= 11 or part == "中午" and hour == 12
                )):
                    return None
                interval = single_day[0].replace(hour=hour + (12 if part in {"下午", "晚上"} else 0)), single_day[1]
        if interval is None or interval[0] >= interval[1] or not all(_unique_local(edge) for edge in interval):
            return None
        return interval
    except (ValueError, OverflowError):
        return None


def _dates(
    unit: SourceUnit, dependencies: list[SourceUnit], *, kind: str,
    valid: datetime | None, invalid: datetime | None, frame: _Condition | None,
) -> tuple[datetime | None, datetime | None]:
    """完整接管后计算；UNKNOWN只清本动作已证明不可靠的旧period。"""
    previous = valid, invalid
    if kind not in {"plan", "hypothesis", "state"} or any(_TIME_WORD.search(dep.text) for dep in dependencies):
        return previous
    action_text = unit.text
    if frame is None and any(marker in action_text for marker in ("吧", "了", "吗")):
        particle = re.fullmatch(r"(?P<action>[^吧了吗]+)吧。?", action_text)
        if (kind not in {"plan", "hypothesis"} or unit.end != len(unit.message.text)
                or particle is None):
            return previous
        action_text = particle["action"]
    action = frame.action if frame is not None else _action(action_text)
    if action is None:
        return previous
    anchor = unit.message.occurred_at
    time = action.time
    unreliable = False
    if frame is not None:
        if frame.outer_time is not None and time is not None:
            outer_period = _calendar(frame.outer_time, anchor)
            action_period = _calendar(time, anchor)
            contained = (outer_period is not None and action_period is not None
                         and outer_period[0] <= action_period[0] and action_period[1] <= outer_period[1])
            if outer_period != action_period and not contained:
                return (None, None) if kind in {"plan", "hypothesis"} else previous
        time = time or frame.outer_time or frame.scenario_time
        unreliable = time is None and frame.condition_time is not None
    if time is None:
        return (None, None) if unreliable and kind in {"plan", "hypothesis"} else previous
    interval = _calendar(time, anchor)
    if interval is not None:
        if kind in {"plan", "hypothesis"}:
            return interval
        if re.fullmatch(rf"{_WEEK_DAY}(?:到|至){_WEEK_DAY}", time):
            return interval
        if action.family == "location":
            if (action.modal == "临时" and time in {"本周", "这周"}
                    and anchor is not None and interval[0] <= anchor < interval[1]):
                return anchor, interval[1]
        return previous
    # 只有同一完整TP的旧短日/周结果或无效本地边界构成清除见证。
    unreliable = (re.fullmatch(rf"(?:{_DAY_WORD})(?:{_CLOCK_WORD}|{_PHASE})", time) is not None
                  or any(edge is not None and not _unique_local(edge) for edge in previous))
    return (None, None) if unreliable and kind in {"plan", "hypothesis"} else previous
