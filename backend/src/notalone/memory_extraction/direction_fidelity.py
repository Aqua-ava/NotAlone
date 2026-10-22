"""确定性的金额收支方向检查。

记忆正文与来源引文对同一金额给出相反方向（收入/支出）时，说明改写可能已经
反转了原命题；这里只做"金额 + 邻近方向词"的受限检查，不承担给取、买卖、
借还等其他方向语义，也不处理否定作用域、同一金额双向并列等需要完整语义的
情况，那些由来源核验提示词覆盖。

已知盲区：单个"得"按口语"得到"记为收入，但"这课得3万"（děi，需支出）会误判；
"得花3万"由更近的"花"覆盖为支出；中文数字金额（如"三万"）与阿拉伯数字不做
换算，只能由来源核验发现差异。检查只用于降级（不通过自动采纳门），不会升级
任何候选，也不改写正文。
"""

from __future__ import annotations

import re
from typing import Final, Sequence

INCOME: Final = "income"
EXPENSE: Final = "expense"
_OPPOSITE: Final = {INCOME: EXPENSE, EXPENSE: INCOME}

# 方向词按"离金额最近"判定；"得花3万"由更近的"花"覆盖为支出。
_INCOME_CUES: Final = ("赚", "挣", "得", "收", "拿", "领")
_EXPENSE_CUES: Final = ("花", "付", "支出", "开销", "花销", "买", "交")

# 金额：阿拉伯数字（含 1、2万 这类范围写法、1.5万 这类小数与 1-2万）或中文数字，
# 后接金额单位。
_AMOUNT = re.compile(
    r"(?:\d+(?:[.,，、\-]\d+)*|[一二两三四五六七八九十百千万]+)"
    r"\s*(?:万元|万|千元|千|百元|百|块钱|块|元|w|k)"
)

# 方向词只回看金额前很短的窗口、后看金额后很短的窗口，避免跨分句误取。
_LOOKBACK = 8
_LOOKAHEAD = 4
# 这些词里的"得"不是"得到"，不参与收入判定。
_NON_INCOME_DE = "觉记懂值显"

DirectionFinding = tuple[str, str, str]  # (归一化金额, 正文方向, 来源方向)


def _normalize_amount(raw: str) -> str:
    """金额归一：顿号/全角逗号表示范围并保留为连接符，小数点保留，去掉货币单位。"""

    value = raw.strip().lower()
    value = value.replace("、", "-").replace("，", "-").replace(",", "")
    value = value.replace("钱", "").replace("元", "").replace("块", "")
    value = value.replace("w", "万").replace("k", "千")
    return re.sub(r"\s", "", value)


def _cue_direction(text: str, *, latest: bool) -> str | None:
    best: tuple[int, str] | None = None
    for cue, direction in (
        *((cue, INCOME) for cue in _INCOME_CUES),
        *((cue, EXPENSE) for cue in _EXPENSE_CUES),
    ):
        index = text.rfind(cue) if latest else text.find(cue)
        if index < 0:
            continue
        if cue == "得" and index > 0 and text[index - 1] in _NON_INCOME_DE:
            continue
        position = index if latest else -index
        if best is None or position >= best[0]:
            best = (position, direction)
    return None if best is None else best[1]


_CLAUSE_BREAK = "，。；！？,.;!?"


def _direction_near(text: str, start: int, end: int) -> str | None:
    """先看金额后同一分句内紧邻动作（如"3万去花"），否则看金额前最近的动词。"""

    tail = text[end:end + _LOOKAHEAD]
    for index, character in enumerate(tail):
        if character in _CLAUSE_BREAK:
            tail = tail[:index]
            break
    after = _cue_direction(tail, latest=False)
    if after is not None:
        return after
    return _cue_direction(text[max(0, start - _LOOKBACK):start], latest=True)


def amount_directions(text: str) -> tuple[tuple[str, str], ...]:
    """按出现顺序返回 (归一化金额, 方向)；没有方向词的金额不返回。"""

    findings: list[tuple[str, str]] = []
    for match in _AMOUNT.finditer(text):
        direction = _direction_near(text, match.start(), match.end())
        if direction is not None:
            findings.append((_normalize_amount(match.group()), direction))
    return tuple(findings)


def _directions_by_amount(text: str) -> dict[str, set[str]]:
    grouped: dict[str, set[str]] = {}
    for amount, direction in amount_directions(text):
        grouped.setdefault(amount, set()).add(direction)
    return grouped


def direction_conflicts(
    text: str, sources: Sequence[str]
) -> tuple[DirectionFinding, ...]:
    """正文与来源对同一金额给出唯一且相反的方向时返回 (金额, 正文方向, 来源方向)。

    同一金额在正文或来源里出现两个方向（否定、并列、前后转折）时无法只凭
    关键词判断，保持不降级，交给来源核验。
    """

    memory = _directions_by_amount(text)
    if not memory:
        return ()
    conflicts: list[DirectionFinding] = []
    for source in sources:
        source_directions = _directions_by_amount(source)
        for amount, memory_directions in memory.items():
            if len(memory_directions) != 1:
                continue
            source_set = source_directions.get(amount)
            if not source_set or len(source_set) != 1:
                continue
            memory_direction = next(iter(memory_directions))
            source_direction = next(iter(source_set))
            if source_direction != _OPPOSITE[memory_direction]:
                continue
            finding = (amount, memory_direction, source_direction)
            if finding not in conflicts:
                conflicts.append(finding)
    return tuple(conflicts)
