"""本次检索的无正文回执；缺失回执保持未知，不从当前资料补造。"""

from dataclasses import dataclass, replace
import re
from typing import Literal
from uuid import UUID


def _integer(value: object, minimum: int, maximum: int) -> None:
    if type(value) is not int or not minimum <= value <= maximum:
        raise ValueError("检索回执的计费或修订字段无效。")


def _revision(value: object) -> None:
    if not isinstance(value, str) or re.fullmatch(r"[0-9a-f]{64}", value) is None:
        raise ValueError("概览导航修订摘要无效。")


def _uuid_tuple(value: object) -> None:
    if not isinstance(value, tuple) or any(not isinstance(item, UUID) for item in value) or len(value) != len(set(value)):
        raise ValueError("检索回执的依据身份无效。")


@dataclass(frozen=True, slots=True)
class OverviewRevision:
    projection_revision: str
    memory_revision: int

    def __post_init__(self) -> None:
        _revision(self.projection_revision)
        _integer(self.memory_revision, 0, 2**63 - 1)

    def to_payload(self) -> dict[str, object]:
        return {"projection_revision": self.projection_revision,
                "memory_revision": self.memory_revision}


@dataclass(frozen=True, slots=True)
class MemoryNavigation:
    scope_kind: Literal["contact", "owner"]
    projection_revision: str
    memory_id: UUID
    memory_revision: int
    provenance_kind: Literal["manual_entry", "source_supported"]
    source_message_ids: tuple[UUID, ...] = ()
    dependency_ids: tuple[UUID, ...] = ()

    def __post_init__(self) -> None:
        if self.scope_kind not in ("contact", "owner") or self.provenance_kind not in ("manual_entry", "source_supported"):
            raise ValueError("概览导航类型无效。")
        _revision(self.projection_revision)
        if not isinstance(self.memory_id, UUID):
            raise ValueError("概览导航记忆身份无效。")
        _integer(self.memory_revision, 1, 2**63 - 1)
        _uuid_tuple(self.source_message_ids)
        _uuid_tuple(self.dependency_ids)

    def to_payload(self) -> dict[str, object]:
        return {"scope_kind": self.scope_kind, "projection_revision": self.projection_revision,
                "memory_id": str(self.memory_id), "memory_revision": self.memory_revision,
                "provenance_kind": self.provenance_kind}

    def to_snapshot(self) -> dict[str, object]:
        return {**self.to_payload(), "source_message_ids": [str(item) for item in self.source_message_ids],
                "dependency_ids": [str(item) for item in self.dependency_ids]}

    @classmethod
    def from_snapshot(cls, value: object) -> "MemoryNavigation | None":
        if value is None:
            return None
        if not isinstance(value, dict) or set(value) != {
            "scope_kind", "projection_revision", "memory_id", "memory_revision", "provenance_kind",
            "source_message_ids", "dependency_ids",
        }:
            raise ValueError("概览导航快照结构无效。")
        if any(not isinstance(value[key], list) for key in ("source_message_ids", "dependency_ids")):
            raise ValueError("概览导航快照依据结构无效。")
        return cls(value["scope_kind"], value["projection_revision"], UUID(value["memory_id"]),
                   value["memory_revision"], value["provenance_kind"],
                   tuple(UUID(item) for item in value["source_message_ids"]),
                   tuple(UUID(item) for item in value["dependency_ids"]))


@dataclass(frozen=True, slots=True)
class RetrievalQuery:
    kind: Literal["confirmed_memory", "owner_memory", "pending_candidate", "message"]
    purpose: Literal["recall", "source_window"]
    status: Literal["succeeded", "empty", "budget_exceeded", "failed"]
    evidence_ids: tuple[UUID, ...]
    limit: int

    def __post_init__(self) -> None:
        if (self.kind not in ("confirmed_memory", "owner_memory", "pending_candidate", "message")
                or self.purpose not in ("recall", "source_window")
                or self.status not in ("succeeded", "empty", "budget_exceeded", "failed")):
            raise ValueError("检索回执查询类型无效。")
        _uuid_tuple(self.evidence_ids)
        _integer(self.limit, 1, 20)
        if (self.status == "succeeded") != bool(self.evidence_ids):
            raise ValueError("检索回执命中状态与实际依据不一致。")

    def to_payload(self) -> dict[str, object]:
        return {"kind": self.kind, "purpose": self.purpose, "status": self.status,
                "evidence_ids": [str(item) for item in self.evidence_ids], "limit": self.limit}


@dataclass(frozen=True, slots=True)
class RetrievalBudget:
    limit: int
    char_limit: int
    used_count: int
    used_chars: int
    exhausted: bool = False

    def __post_init__(self) -> None:
        _integer(self.limit, 1, 20)
        _integer(self.char_limit, 1, 10000)
        _integer(self.used_count, 0, self.limit)
        _integer(self.used_chars, 0, self.char_limit)
        if type(self.exhausted) is not bool:
            raise ValueError("检索回执预算标记无效。")

    def to_payload(self) -> dict[str, object]:
        return {"limit": self.limit, "char_limit": self.char_limit,
                "used_count": self.used_count, "used_chars": self.used_chars,
                "exhausted": self.exhausted}


@dataclass(frozen=True, slots=True)
class SourceMessageBudget:
    call_limit: int = 3
    item_limit: int = 16
    token_limit: int = 2048
    used_calls: int = 0
    used_count: int = 0
    used_tokens: int = 0
    exhausted: bool = False

    def __post_init__(self) -> None:
        for maximum, limit, used in ((3, self.call_limit, self.used_calls),
                                   (16, self.item_limit, self.used_count), (2048, self.token_limit, self.used_tokens)):
            _integer(limit, 1, maximum)
            _integer(used, 0, limit)
        if type(self.exhausted) is not bool:
            raise ValueError("原话补查预算标记无效。")

    def to_payload(self) -> dict[str, object]:
        return {"call_limit": self.call_limit, "item_limit": self.item_limit,
                "token_limit": self.token_limit, "used_calls": self.used_calls,
                "used_count": self.used_count, "used_tokens": self.used_tokens,
                "exhausted": self.exhausted}


@dataclass(frozen=True, slots=True)
class ReplyRetrievalReceipt:
    contact_overview: OverviewRevision | None
    owner_overview: OverviewRevision | None
    queries: tuple[RetrievalQuery, ...]
    contact_memory: RetrievalBudget
    owner_memory: RetrievalBudget
    pending_candidate: RetrievalBudget
    source_messages: SourceMessageBudget = SourceMessageBudget()
    status: Literal["succeeded", "empty", "budget_exhausted", "unavailable"] = "succeeded"

    def __post_init__(self) -> None:
        if (self.status not in ("succeeded", "empty", "budget_exhausted", "unavailable")
                or any(item is not None and not isinstance(item, OverviewRevision)
                       for item in (self.contact_overview, self.owner_overview))
                or not isinstance(self.queries, tuple) or len(self.queries) > 64
                or any(not isinstance(item, RetrievalQuery) for item in self.queries)
                or any(not isinstance(item, RetrievalBudget) for item in
                       (self.contact_memory, self.owner_memory, self.pending_candidate))
                or not isinstance(self.source_messages, SourceMessageBudget)):
            raise ValueError("检索回执结构无效。")

    def to_payload(self) -> dict[str, object]:
        return {"version": 1, "retriever_version": "lexical-v1", "status": self.status,
                "overview_revisions": {
                    "contact": self.contact_overview.to_payload() if self.contact_overview else None,
                    "owner": self.owner_overview.to_payload() if self.owner_overview else None,
                },
                "queries": [query.to_payload() for query in self.queries],
                "budgets": {"contact_memory": self.contact_memory.to_payload(),
                            "owner_memory": self.owner_memory.to_payload(),
                            "pending_candidate": self.pending_candidate.to_payload(),
                            "source_messages": self.source_messages.to_payload()}}

    @classmethod
    def from_payload(cls, value: object) -> "ReplyRetrievalReceipt | None":
        if value is None:
            return None
        if (not isinstance(value, dict) or set(value) != {
                "version", "retriever_version", "status", "overview_revisions", "queries", "budgets"}
                or type(value["version"]) is not int or value["version"] != 1
                or value["retriever_version"] != "lexical-v1"):
            raise ValueError("检索回执快照版本无效。")
        revisions, budgets = value["overview_revisions"], value["budgets"]
        if (not isinstance(revisions, dict) or set(revisions) != {"contact", "owner"}
                or not isinstance(budgets, dict) or set(budgets) != {
                    "contact_memory", "owner_memory", "pending_candidate", "source_messages"}
                or not isinstance(value["queries"], list)):
            raise ValueError("检索回执快照字段无效。")
        def revision(item):
            if item is None:
                return None
            if not isinstance(item, dict) or set(item) != {"projection_revision", "memory_revision"}:
                raise ValueError("概览修订快照字段无效。")
            return OverviewRevision(**item)
        queries = []
        for query in value["queries"]:
            if not isinstance(query, dict) or set(query) != {"kind", "purpose", "status", "evidence_ids", "limit"}:
                raise ValueError("检索查询快照字段无效。")
            if not isinstance(query["evidence_ids"], list):
                raise ValueError("检索查询快照引用无效。")
            queries.append(RetrievalQuery(**{**query, "evidence_ids": tuple(UUID(item) for item in query["evidence_ids"])}))
        return cls(revision(revisions["contact"]), revision(revisions["owner"]), tuple(queries),
                   RetrievalBudget(**budgets["contact_memory"]), RetrievalBudget(**budgets["owner_memory"]),
                   RetrievalBudget(**budgets["pending_candidate"]), SourceMessageBudget(**budgets["source_messages"]),
                   value["status"])


def require_receipt_evidence(receipt: ReplyRetrievalReceipt | None, evidence: tuple) -> None:
    """回执只解释本次实际可见依据，不把检索未用项或导航正文当作证据。"""
    if receipt is None:
        if any(item.navigation is not None for item in evidence):
            raise ValueError("概览导航缺少生成时回执。")
        return
    if not isinstance(receipt, ReplyRetrievalReceipt):
        raise ValueError("检索回执无效。")
    actual = {item.evidence_id: item for item in evidence if item.model_visible}
    for query in receipt.queries:
        if any(identifier not in actual or actual[identifier].kind != query.kind for identifier in query.evidence_ids):
            raise ValueError("检索回执引用未实际使用的依据。")
    for kind, budget in (("confirmed_memory", receipt.contact_memory), ("owner_memory", receipt.owner_memory),
                        ("pending_candidate", receipt.pending_candidate)):
        selected = [item for item in actual.values() if item.kind == kind]
        if len(selected) != budget.used_count or sum(len(item.text) for item in selected) != budget.used_chars:
            raise ValueError("检索回执预算不等于实际上下文。")
    for item in actual.values():
        navigation = item.navigation
        if navigation is None:
            continue
        expected = receipt.contact_overview if navigation.scope_kind == "contact" else receipt.owner_overview
        if (not isinstance(navigation, MemoryNavigation) or expected is None
                or item.kind != ("confirmed_memory" if navigation.scope_kind == "contact" else "owner_memory")
                or item.evidence_id != navigation.memory_id or item.revision != navigation.memory_revision
                or navigation.projection_revision != expected.projection_revision):
            raise ValueError("概览导航与实际依据不一致。")


def append_runtime_receipt(
    receipt: ReplyRetrievalReceipt | None, evidence: tuple, additions: tuple, tool_calls: tuple,
) -> ReplyRetrievalReceipt | None:
    """仅由实际 Tool 结果结算最终输入；估算计费沿既有历史 Tool 口径。"""
    if receipt is None:
        return None
    actual = {item.evidence_id: item for item in (*evidence, *additions) if item.model_visible}
    queries = tuple(RetrievalQuery("message", "source_window",
        "failed" if trace.status in ("failed", "timeout") else trace.status,
        trace.evidence_ids if trace.status == "succeeded" else (),
        8 if trace.tool_name == "conversation_search" else 20)
        for trace in tool_calls if trace.tool_name in ("conversation_search", "conversation_query"))
    used_tokens = receipt.source_messages.used_tokens + sum(
        max(1, (len(actual[identifier].text) + 3) // 4)
        for query in queries if query.status == "succeeded" for identifier in query.evidence_ids)
    budget = replace(receipt.source_messages,
        used_calls=min(receipt.source_messages.call_limit, receipt.source_messages.used_calls + len(queries)),
        used_count=receipt.source_messages.used_count + sum(item.kind == "message" and item.model_visible for item in additions),
        used_tokens=used_tokens,
        exhausted=receipt.source_messages.exhausted or any(query.status == "budget_exceeded" for query in queries))
    status = ("unavailable" if receipt.status == "unavailable" or any(query.status == "failed" for query in queries)
              else "budget_exhausted" if receipt.status == "budget_exhausted" or budget.exhausted
              else "succeeded" if any(query.status == "succeeded" for query in queries) else receipt.status)
    return replace(receipt, queries=receipt.queries + queries, source_messages=budget, status=status)
