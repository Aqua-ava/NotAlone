"""记忆与消息的可解释中文词法评分。

评分只依赖确定性规则：CJK 连续段取 unigram 与 bigram，拉丁字母与数字按
小写词切分；query token 去重后，以命中权重占 query 总权重的比例作为覆盖率。
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

MAX_QUERY_CHARS = 200
UNIGRAM_WEIGHT = 0.5
BIGRAM_WEIGHT = 1.0
WORD_WEIGHT = 1.0
RELEVANCE_THRESHOLD = 0.15

_CJK_RANGE = (
    "\u2e80-\u2eff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff"
    "\U00020000-\U0003ffff"
)
_WORD_RANGE = "a-z0-9\u00c0-\u024f"
_TOKEN_RUN = re.compile(
    f"(?P<cjk>[{_CJK_RANGE}]+)|(?P<word>[{_WORD_RANGE}]+)"
)


@dataclass(frozen=True, slots=True)
class LexicalToken:
    """query 或正文中的一个词法单位及其权重。"""

    text: str
    weight: float

    def __post_init__(self) -> None:
        if not self.text:
            raise ValueError("词法 token 文本不能为空。")
        if not self.weight > 0:
            raise ValueError("词法 token 权重必须为正数。")


@dataclass(frozen=True, slots=True)
class LexicalScore:
    """一条正文相对 query 的覆盖率与命中词。"""

    score: float
    matched_terms: tuple[str, ...]


def tokenize(text: str) -> tuple[LexicalToken, ...]:
    """按确定性规则切分文本；标点、空白与 emoji 只作分隔。"""

    return _tokenize_normalized(_normalize(text))


def build_query_tokens(query: str) -> tuple[LexicalToken, ...]:
    """归一化后截取前 200 字符并去重，得到评分用的 token 序列。"""

    normalized = _normalize(query)[:MAX_QUERY_CHARS]
    seen: set[str] = set()
    tokens: list[LexicalToken] = []
    for token in _tokenize_normalized(normalized):
        if token.text in seen:
            continue
        seen.add(token.text)
        tokens.append(token)
    return tuple(tokens)


def score_tokens(
    query_tokens: tuple[LexicalToken, ...],
    memory_text: str,
) -> LexicalScore:
    """用预构建的 query token 计算记忆正文覆盖率。"""

    if not isinstance(query_tokens, tuple) or any(
        not isinstance(token, LexicalToken) for token in query_tokens
    ):
        raise TypeError("query token 必须是 LexicalToken 元组。")
    if not query_tokens:
        return LexicalScore(0.0, ())
    memory_tokens = {token.text for token in tokenize(memory_text)}
    matched = tuple(
        token for token in query_tokens if token.text in memory_tokens
    )
    if not matched:
        return LexicalScore(0.0, ())
    total_weight = sum(token.weight for token in query_tokens)
    matched_weight = sum(token.weight for token in matched)
    return LexicalScore(
        score=matched_weight / total_weight,
        matched_terms=tuple(token.text for token in matched),
    )


def score(query: str, text: str) -> LexicalScore:
    """一次计算 query 对正文的覆盖率，便于小规模直接调用。"""

    return score_tokens(build_query_tokens(query), text)


def _normalize(text: str) -> str:
    if not isinstance(text, str):
        raise TypeError("词法评分文本必须是字符串。")
    return unicodedata.normalize("NFKC", text).casefold()


def _tokenize_normalized(normalized: str) -> tuple[LexicalToken, ...]:
    tokens: list[LexicalToken] = []
    for match in _TOKEN_RUN.finditer(normalized):
        run = match.group()
        if match.lastgroup == "cjk":
            if len(run) == 1:
                tokens.append(LexicalToken(run, UNIGRAM_WEIGHT))
                continue
            tokens.extend(
                LexicalToken(character, UNIGRAM_WEIGHT) for character in run
            )
            tokens.extend(
                LexicalToken(run[index : index + 2], BIGRAM_WEIGHT)
                for index in range(len(run) - 1)
            )
        else:
            tokens.append(LexicalToken(run, WORD_WEIGHT))
    return tuple(tokens)
