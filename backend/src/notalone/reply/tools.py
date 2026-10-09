"""候选回复使用的联系人历史只读 Tool。

Tool 只接收模型表达的查询意图；owner、contact 和会话绑定由创建运行时的
应用代码固定注入。历史结果先经过 RetrievalPort 的来源与范围校验，再作为
本轮临时证据返回，不能执行任何写入、发送或权限变化。
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from notalone.reply.context import ContextEvidence, ToolCallTrace
from notalone.memory.timing import MemoryTiming
from notalone.reply.errors import ReplyContextError, ReplyContextInvariantError
from notalone.retrieval import RetrievalError, RetrievalPort, RetrievedMessage
from notalone.scopes import ContactScope


MAX_HISTORY_TOOL_CALLS = 3
MAX_SEARCH_RESULTS = 8
MAX_QUERY_WINDOW = 10
MAX_HISTORY_TIMEOUT_MS = 1500
MAX_HISTORY_TOKEN_BUDGET = 2048
# 进入证据的历史条数上限（与 token 预算独立）。
# 运行时最多调用 3 次、每次最多返回 8 条；16 条上限会拒绝第三次大结果。
# 此前把 token 预算 2048 当作条数上限比较，实际不可达。
MAX_HISTORY_EVIDENCE_COUNT = 16
# 非成功状态的 Tool 返回必须给模型可操作的下一步指令，
# 否则模型会把未命中或预算耗尽当作重试信号，耗尽运行步骤上限。
_STATUS_GUIDANCE: dict[str, str] = {
    "empty": (
        "未命中不代表消息不存在，也不是继续搜索的理由。不要重复相同或相近的查询；"
        "如确需更多语境，最多再换一个明显不同的查询词，然后必须停止调用任何工具，"
        "立即基于当前消息、表达方向和已有证据返回结构化候选。"
    ),
    "budget_exceeded": (
        "历史检索调用预算已用尽。禁止再调用任何历史工具；"
        "立即基于当前消息、表达方向和已有证据返回结构化候选。"
    ),
    "failed": (
        "历史工具本次调用失败。不要依赖该结果，也不要反复重试；"
        "基于已有证据直接返回结构化候选。"
    ),
    "timeout": (
        "历史工具本次调用超时。不要等待或重试；"
        "基于已有证据直接返回结构化候选。"
    ),
}


def _parse_datetime(value: str | None) -> datetime | None:
    if value is None or not value.strip():
        return None
    if not isinstance(value, str):
        raise ValueError("时间参数结构无效。")
    normalized = value.strip().replace("Z", "+00:00")
    parsed = datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        raise ValueError("时间参数必须带时区。")
    return parsed


def _parse_uuid(value: str | None, *, name: str) -> UUID | None:
    if value is None or not value.strip():
        return None
    if not isinstance(value, str):
        raise ValueError(f"{name} 结构无效。")
    try:
        return UUID(value.strip())
    except ValueError:
        raise ValueError(f"{name} 结构无效。") from None


def _estimate_tokens(text: str) -> int:
    return max(1, (len(text) + 3) // 4)


class HistoryToolAccess:
    """绑定一个已验证联系人范围的历史 Tool 执行器。"""

    __slots__ = (
        "_retrieval",
        "_scope",
        "_conversation_binding_id",
        "_known_message_ids",
        "_evidence",
        "_tool_calls",
        "_token_count",
        "_max_calls",
    )

    def __init__(
        self,
        *,
        retrieval: RetrievalPort,
        scope: ContactScope,
        conversation_binding_id: UUID,
        initial_evidence_ids: tuple[UUID, ...] = (),
        max_calls: int = MAX_HISTORY_TOOL_CALLS,
    ) -> None:
        if retrieval is None:
            raise TypeError("历史 Tool 必须注入 RetrievalPort。")
        if not isinstance(scope, ContactScope):
            raise TypeError("历史 Tool 必须绑定联系人范围。")
        if not isinstance(conversation_binding_id, UUID):
            raise TypeError("历史 Tool 必须绑定已验证会话。")
        if not isinstance(max_calls, int) or not 1 <= max_calls <= MAX_HISTORY_TOOL_CALLS:
            raise ValueError("历史 Tool 调用预算无效。")
        if not isinstance(initial_evidence_ids, tuple) or any(
            not isinstance(item, UUID) for item in initial_evidence_ids
        ):
            raise TypeError("历史 Tool 初始证据引用结构无效。")
        self._retrieval = retrieval
        self._scope = scope
        self._conversation_binding_id = conversation_binding_id
        self._known_message_ids = set(initial_evidence_ids)
        self._evidence: list[ContextEvidence] = []
        self._tool_calls: list[ToolCallTrace] = []
        self._token_count = 0
        self._max_calls = max_calls

    @property
    def evidence(self) -> tuple[ContextEvidence, ...]:
        return tuple(self._evidence)

    @property
    def tool_calls(self) -> tuple[ToolCallTrace, ...]:
        return tuple(self._tool_calls)

    def search(
        self,
        *,
        query: str,
        top_k: int = 5,
        occurred_after: str | None = None,
        occurred_before: str | None = None,
        timeout_ms: int = 500,
    ) -> str:
        """搜索当前联系人范围内的相关历史消息。"""

        if not self._begin_call("conversation_search"):
            return self._status_result("budget_exceeded", "tool_call_budget")
        started = time.perf_counter()
        try:
            if not isinstance(query, str) or not query.strip():
                raise ValueError("empty_query")
            if len(query.strip()) > 200:
                raise ValueError("query_too_long")
            if not isinstance(top_k, int) or not 1 <= top_k <= MAX_SEARCH_RESULTS:
                raise ValueError("top_k_out_of_range")
            if not isinstance(timeout_ms, int) or not 1 <= timeout_ms <= MAX_HISTORY_TIMEOUT_MS:
                raise ValueError("timeout_out_of_range")
            after = _parse_datetime(occurred_after)
            before = _parse_datetime(occurred_before)
            if after is not None and before is not None and before < after:
                raise ValueError("invalid_time_window")
            messages = self._retrieval.search_messages(
                scope=self._scope,
                query=query.strip(),
                limit=top_k,
                occurred_after=after,
                occurred_before=before,
                timeout_ms=timeout_ms,
            )
            return self._finish_messages(
                tool_name="conversation_search",
                messages=messages,
                started=started,
                timeout_ms=timeout_ms,
                selection_reason="本轮相关性搜索返回的联系人历史消息。",
            )
        except ReplyContextInvariantError:
            raise
        except (RetrievalError, ValueError, TypeError, AttributeError):
            self._finish_call("conversation_search", "failed", (), started)
            return self._status_result("failed", "history_search_failed")
        except Exception:
            self._finish_call("conversation_search", "failed", (), started)
            return self._status_result("failed", "history_search_failed")

    def query(
        self,
        *,
        session_id: str,
        anchor_message_id: str | None = None,
        before: int = 3,
        after: int = 3,
        timeout_ms: int = 500,
    ) -> str:
        """读取当前已验证会话中一个命中位置附近的有限连续消息。"""

        if not self._begin_call("conversation_query"):
            return self._status_result("budget_exceeded", "tool_call_budget")
        started = time.perf_counter()
        try:
            parsed_session = _parse_uuid(session_id, name="session_id")
            if parsed_session != self._conversation_binding_id:
                raise ReplyContextInvariantError("历史 Tool 会话范围不匹配。")
            anchor = _parse_uuid(anchor_message_id, name="anchor_message_id")
            if anchor is not None and anchor not in self._known_message_ids:
                raise ValueError("anchor_not_from_current_turn")
            if not isinstance(before, int) or not 0 <= before <= MAX_QUERY_WINDOW:
                raise ValueError("before_out_of_range")
            if not isinstance(after, int) or not 0 <= after <= MAX_QUERY_WINDOW:
                raise ValueError("after_out_of_range")
            if not isinstance(timeout_ms, int) or not 1 <= timeout_ms <= MAX_HISTORY_TIMEOUT_MS:
                raise ValueError("timeout_out_of_range")
            messages = self._retrieval.query_messages(
                scope=self._scope,
                anchor_message_id=anchor,
                before=before,
                after=after,
                limit=min(20, before + after + 1),
                timeout_ms=timeout_ms,
            )
            return self._finish_messages(
                tool_name="conversation_query",
                messages=messages,
                started=started,
                timeout_ms=timeout_ms,
                selection_reason="本轮时间顺序查询返回的联系人历史消息。",
            )
        except ReplyContextInvariantError:
            raise
        except (RetrievalError, ValueError, TypeError, AttributeError):
            self._finish_call("conversation_query", "failed", (), started)
            return self._status_result("failed", "history_query_failed")
        except Exception:
            self._finish_call("conversation_query", "failed", (), started)
            return self._status_result("failed", "history_query_failed")

    def _begin_call(self, tool_name: str) -> bool:
        if len(self._tool_calls) >= self._max_calls:
            self._tool_calls.append(
                ToolCallTrace(
                    tool_name=tool_name,
                    status="budget_exceeded",
                    evidence_ids=(),
                    latency_ms=0,
                )
            )
            return False
        return True

    def _finish_messages(
        self,
        *,
        tool_name: str,
        messages: object,
        started: float,
        timeout_ms: int,
        selection_reason: str,
    ) -> str:
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        if elapsed_ms > timeout_ms:
            self._finish_call(tool_name, "timeout", (), started)
            return self._status_result("timeout", "history_timeout")
        validated = self._validate_messages(messages)
        if not validated:
            self._finish_call(tool_name, "empty", (), started)
            return self._status_result("empty", "no_matching_history")
        estimated = sum(_estimate_tokens(item.text) for item in validated)
        if self._token_count + estimated > MAX_HISTORY_TOKEN_BUDGET or (
            len(self._evidence) + len(validated) > MAX_HISTORY_EVIDENCE_COUNT
        ):
            self._finish_call(tool_name, "budget_exceeded", (), started)
            return self._status_result("budget_exceeded", "history_token_budget")

        evidence_ids: list[UUID] = []
        payload_messages: list[dict[str, Any]] = []
        for message in validated:
            is_new_evidence = message.message_id not in self._known_message_ids
            self._known_message_ids.add(message.message_id)
            evidence_ids.append(message.message_id)
            payload_messages.append(self._message_payload(message))
            if is_new_evidence:
                self._evidence.append(
                    ContextEvidence(
                        evidence_id=message.message_id,
                        kind="message",
                        text=message.text,
                        scope=message.scope,
                        source_ids=message.source_ids,
                        selection_reason=selection_reason,
                        status=message.status,
                        valid_at=message.valid_at,
                        invalid_at=message.invalid_at,
                        timing=MemoryTiming.from_source_times((message.occurred_at,)),
                    )
                )
        self._token_count += estimated
        self._finish_call(tool_name, "succeeded", tuple(evidence_ids), started)
        return json.dumps(
            {
                "status": "ok",
                "evidence_type": "raw_message_evidence",
                "executable": False,
                "not_found_is_not_evidence": True,
                "messages": payload_messages,
            },
            ensure_ascii=False,
        )

    def _validate_messages(
        self,
        messages: object,
    ) -> tuple[RetrievedMessage, ...]:
        if not isinstance(messages, tuple):
            raise ReplyContextInvariantError("历史 Tool 返回结构无效。")
        for message in messages:
            if (
                not isinstance(message, RetrievedMessage)
                or message.scope != self._scope
                or not message.source_ids
                or message.status != "active"
                or (
                    message.invalid_at is not None
                    and datetime.now(timezone.utc) >= message.invalid_at
                )
            ):
                raise ReplyContextInvariantError(
                    "历史 Tool 返回了越权或已失效消息。"
                )
        return messages

    def _message_payload(self, message: RetrievedMessage) -> dict[str, Any]:
        return {
            "evidence_id": str(message.message_id),
            "message_id": str(message.message_id),
            "role": message.role,
            "occurred_at": (
                message.occurred_at.isoformat()
                if message.occurred_at is not None
                else None
            ),
            # 只透传检索层给出的真实会话标识；缺失时如实为 null，
            # 不能把同联系人其他会话的消息标成当前绑定会话。
            "session_id": (
                str(message.session_id)
                if message.session_id is not None
                else None
            ),
            "source_ids": [str(source_id) for source_id in message.source_ids],
            "status": message.status,
            "text": message.text,
        }

    def _finish_call(
        self,
        tool_name: str,
        status: str,
        evidence_ids: tuple[UUID, ...],
        started: float,
    ) -> None:
        latency_ms = max(0, int((time.perf_counter() - started) * 1000))
        self._tool_calls.append(
            ToolCallTrace(
                tool_name=tool_name,
                status=status,  # type: ignore[arg-type]
                evidence_ids=evidence_ids,
                latency_ms=latency_ms,
            )
        )

    @staticmethod
    def _status_result(status: str, reason: str) -> str:
        guidance = _STATUS_GUIDANCE.get(status)
        payload: dict[str, Any] = {
            "status": status,
            "evidence_type": "raw_message_evidence",
            "executable": False,
            "not_found_is_not_evidence": True,
            "reason": reason,
            "messages": [],
        }
        if guidance is not None:
            payload["guidance"] = guidance
        return json.dumps(payload, ensure_ascii=False)
