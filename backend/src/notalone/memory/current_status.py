"""从既有资料派生时间核实状态，不修改事实、有效期或采纳决定。"""

from dataclasses import replace
from datetime import datetime, timedelta, timezone
import re
from collections.abc import Sequence

from notalone.memory.timing import MemoryTiming, UNKNOWN_CURRENT_REASON


_TEMPORAL = re.compile(
    r"最近|近来|近期|目前|现在|当下|这月|这个周|这(?:个)?星期|"
    r"昨天|去年|今年|过去|曾经|当时|那时|之前|正在|暂时|一度|即将"
)
_ATOM = r"[\u3400-\u9fffA-Za-z0-9·-]{1,32}"
_PLACE = rf"{_ATOM}(?:市|省|县|区|乡|镇|村|国|州|岛|郡|城)"
_STABLE_EXPRESSION = re.compile(
    rf"(?:[^是为在于而且并但：:，,；;。.!?！？]{{0,16}}(?:事实|经历)[：:]\s*)?"
    r"(?:(?:对方|联系人|本人|用户|我|他|她|双方|我们|孩子|甲|乙)\s*)?"
    r"(?:(?:去年|前年|过去|曾经|当时|以前|之前|曾|已|已经)\s*)*"
    rf"(?:出生于(?P<birth>春天|夏天|秋天|冬天|春季|夏季|秋季|冬季|\d{{4}}年|{_PLACE})"
    rf"|出生地(?:为|是)(?P<place>{_PLACE})|毕业于(?P<school>{_ATOM}(?:大学|学院|学校))"
    r"|已毕业|初次相识|首次见面|(?:拥有|持有)(?:博士|硕士|学士|本科|研究生)?(?:学位|学历)"
    rf"|(?:取得|获得)(?:了)?(?P<qualification>{_ATOM})?(?:学位|学历|资格))"
)
_NON_ATOMIC_OBJECT = re.compile(r"而|且|并|但|是|在|为|的|当|任职|担任|现在|目前")
_PROSPECTIVE_FACT = re.compile(r"计划|打算|准备|预计|即将|将要|可能|如果|假如|希望|想要")
_UNFINISHED_FACT = re.compile(
    r"尚未|还未|还没|没有|并未|并非|不是|不曾|从未|未能|没能|"
    r"未取得|未获得|未毕业|没毕业"
)
_FUTURE_FACT = re.compile(
    r"明(?:天|日|早|晚|年)|后(?:天|日|年)|来年|将来|未来|以后|"
    r"下(?:个)?(?:周|星期|月|季度|半年|年)|将(?:于|会|要)|"
    r"过(?:几|[一二两三四五六七八九十\d]+)(?:天|日|周|个月|年)"
)
_RELATIVE = re.compile(r"这个月|本月|本周|这周|今天|今日|明天|明日")
_ISO = r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})"
_ABSOLUTE_RANGE = re.compile(rf"(?:从|自)\s*({_ISO})\s*(?:到|至)\s*({_ISO})")
_DECLARATION = re.compile(rf"(?:{_ABSOLUTE_RANGE.pattern})|(?:{_RELATIVE.pattern})")
_DATE_FRAGMENT = re.compile(r"\d{4}-\d{2}(?:-\d{2})?|\d{2,4}年|\d{1,2}月")
_NARROW_TIME = re.compile(
    r"仅|只|部分|有时|偶尔|(?:上|中|下)旬|(?:前|后|上|下)半(?:天|日|月|周)|"
    r"(?:月|周)(?:初|中|末|底)|(?:早|晚|午)饭|(?:今|明|昨)(?:早|晚|晨|夜)|工作日|"
    r"(?:周|星期)[一二三四五六日天]|凌晨|清晨|早上|上午|中午|午后|下午|"
    r"傍晚|晚上|夜间|深夜|白天|夜里|半夜|之前|之后|以前|以后|直到|"
    r"\d{1,2}(?:日|号|时|点)|\d{1,2}:\d{2}"
)
_CONFLICTING_TIME = re.compile(
    r"(?:昨|前|后)(?:天|日)|(?:上|下)(?:个)?(?:月|周|星期|季度|年)|"
    r"(?:去|前|今)年|过去|曾经|当时|那时|之前|最近|近期|近来"
)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _stable_common_fact(text: str) -> bool:
    """只肯定可明确识别的稳定经历；未知分句或未完成计划不借相邻事实放行。"""
    if _PROSPECTIVE_FACT.search(text) or _UNFINISHED_FACT.search(text) or _FUTURE_FACT.search(text):
        return False
    claims = tuple(claim for claim in re.split(r"[，,；;。!?！？]+|但是|但|同时|并且|且", text) if claim.strip())
    for claim in claims:
        match = _STABLE_EXPRESSION.fullmatch(claim.strip())
        if match is None or any(_NON_ATOMIC_OBJECT.search(value) for value in match.groupdict().values() if value):
            return False
        birth = match.group("birth")
        if birth and re.fullmatch(r"\d{4}年", birth) and int(birth[:-1]) > _utc_now().year:
            return False
    return bool(claims)


def _has_time_scope(text: str) -> bool:
    """共享明确时段语法；只／仅等对象或频率限定不在稳定性门中当时间范围。"""
    return any(pattern.search(text) for pattern in (
        _DECLARATION, _FUTURE_FACT, _DATE_FRAGMENT, _CONFLICTING_TIME,
    ))


def _source_interval(text: str, anchor: datetime | None) -> tuple[datetime, datetime] | None:
    """只解析明确的完整时区区间或来源当地日／周／月，不猜统一有效天数。"""
    declarations = tuple(_DECLARATION.finditer(text))
    if len(declarations) != 1:
        return None
    declaration = declarations[0]
    remainder = text[:declaration.start()] + text[declaration.end():]
    # 日／周／月与完整区间只移除自身声明，统一拒绝剩余的第二种或更窄时段。
    if _has_time_scope(remainder) or _NARROW_TIME.search(remainder):
        return None
    if declaration.group(1) is not None:
        try:
            start, end = (datetime.fromisoformat(value) for value in declaration.groups())
        except ValueError:
            return None
        return (start, end) if start < end else None
    if anchor is None:
        return None
    start = anchor.replace(hour=0, minute=0, second=0, microsecond=0)
    cue = declaration.group()
    if cue in {"这个月", "本月"}:
        start = start.replace(day=1)
        end = (start.replace(year=start.year + 1, month=1) if start.month == 12
               else start.replace(month=start.month + 1))
    elif cue in {"本周", "这周"}:
        start -= timedelta(days=start.weekday())
        end = start + timedelta(days=7)
    else:
        if cue in {"明天", "明日"}:
            start += timedelta(days=1)
        end = start + timedelta(days=1)
    return start, end


def project_current_status(
    timing: MemoryTiming, *, category: str, text: str,
    valid_at: datetime | None = None, invalid_at: datetime | None = None,
    source_statements: Sequence[tuple[str, datetime | None]] = (),
) -> MemoryTiming:
    """只保留可判定的稳定主张；分类或词表未命中不证明持续性。"""
    unfinished = category == "common_fact" and _UNFINISHED_FACT.search(text)
    prospective = _PROSPECTIVE_FACT.search(text) or _FUTURE_FACT.search(text) or unfinished
    completed = category == "common_fact" and _stable_common_fact(text)
    stable = category in {"preference", "taboo"} or bool(completed)
    if (_has_time_scope(text) or _TEMPORAL.search(text) or prospective) and not completed:
        stable = False
    current = _utc_now()
    if invalid_at is not None and current >= invalid_at:
        return replace(timing, current_status="historical", current_status_reason=(
            "已离开资料声明的可引用区间；只保留历史，不据此认定约定完成或现实状态结束。"
        ))
    if valid_at is not None and current < valid_at:
        return replace(timing, current_status="current_unverified", current_status_reason="声明区间尚未开始；当前未核实。")
    intervals = tuple(_source_interval(*item) for item in source_statements)
    claim_intervals = tuple(_source_interval(text, item[1]) for item in source_statements)
    if (not stable and invalid_at is not None and timing.source_time_complete and intervals
            and all(interval is not None and interval == intervals[0] for interval in intervals)
            and all(interval == intervals[0] for interval in claim_intervals)):
        start, end = intervals[0]
        # 保存的区间必须与每条直接来源一致；允许从原话发送时才开始引用。
        lower = valid_at or start
        if (end == invalid_at and start <= lower < end and lower <= current < end
                and timing.source_ended_at is not None and timing.source_ended_at <= current):
            return replace(timing, current_status="current_verified", current_status_reason=(
                f"直接来源支持当期区间 [{lower.isoformat()}, {end.isoformat()})；"
                "仅核实原话的时间适用范围，不认证现实真伪。"
            ))
    return replace(
        timing,
        current_status="stable" if stable else "current_unverified",
        current_status_reason=(
            "稳定事实或明确偏好；继续受来源、采纳和有效期约束，不因日期未知降级。"
            if stable else (
                "无法从资料判定这项共同事实是否稳定持续；当前未核实，保存时间不证明现在仍成立。"
                if category == "common_fact" else UNKNOWN_CURRENT_REASON
            )
        ),
    )
