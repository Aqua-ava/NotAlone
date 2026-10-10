"""主动保存样本的有界说法参考；独立于事实依据和方向探索。"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol
from uuid import UUID

from notalone.reply.errors import ReplyContextInvariantError
from notalone.scopes import ContactScope


STYLE_REFERENCE_LIMIT = 5
STYLE_REFERENCE_CHAR_BUDGET = 600


@dataclass(frozen=True, slots=True, repr=False)
class StyleReference:
    """本次实际选取的完整样本，来源只用于删除依赖，不作事实引用。"""

    sample_id: UUID
    scope: ContactScope
    text: str
    source_ids: tuple[UUID, ...] = ()


class StyleReferencePort(Protocol):
    """只读有效样本；总请求预算仍在最终模型调用入口核验。"""

    def select_references(self, scope: ContactScope) -> tuple[StyleReference, ...]: ...

    def validate_references(self, scope: ContactScope, references: tuple[StyleReference, ...]) -> None: ...


def require_reference_contract(scope: ContactScope, references: tuple[StyleReference, ...]) -> None:
    """拒绝越界、重复或不完整的参考；不判断自然语言语义。"""

    if not isinstance(references, tuple) or len(references) > STYLE_REFERENCE_LIMIT:
        raise ReplyContextInvariantError("表达参考数量或结构无效。")
    identifiers: set[UUID] = set()
    characters = 0
    for item in references:
        if (not isinstance(item, StyleReference) or item.scope != scope
                or not isinstance(item.sample_id, UUID) or item.sample_id in identifiers
                or not isinstance(item.text, str) or not item.text.strip()
                or not isinstance(item.source_ids, tuple)
                or any(not isinstance(value, UUID) for value in item.source_ids)):
            raise ReplyContextInvariantError("表达参考不属于当前有效范围。")
        identifiers.add(item.sample_id)
        characters += len(item.text)
    if characters > STYLE_REFERENCE_CHAR_BUDGET:
        raise ReplyContextInvariantError("表达参考超过取数预算。")
