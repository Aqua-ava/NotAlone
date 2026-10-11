"""同一owner事务内读取讨论及复验已使用历史；不另开连接或提交。"""

from __future__ import annotations

import hashlib
import json
from typing import Any
from uuid import UUID

from psycopg.rows import dict_row

from notalone.application.assistant_session_service import (
    AssistantSessionNotFound, AssistantSessionRejected,
)
from notalone.persistence.assistant_candidate_versions import (
    AssistantCandidateHistory, AssistantCandidateVersion, AssistantCandidateVersionError,
    read_candidate_versions,
)
from notalone.persistence.assistant_session_inputs import (
    require_current_input, verified_discussion_dependencies,
)
from notalone.persistence.assistant_session_store import (
    _dependencies_available, _partition_assistant_dependencies, _reply_dependencies,
)
from notalone.persistence.style_sample_store import captured_reply_sources, require_reply_sources_current
from notalone.persistence.reply_discussion_dependencies import reply_style_sample_dependencies
from notalone.reply.assistant_discussion import (
    DiscussionContext, DiscussionDependencies, DiscussionIdentity, DiscussionItem,
    DiscussionSnapshot,
)
from notalone.reply.errors import ReplyStoreInvariantError
from notalone.scopes import ContactScope


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), default=str)


def _fingerprint(value: Any) -> str:
    return hashlib.sha256(_json_text(value).encode("utf-8")).hexdigest()


def _captured_anchor(connection: Any, scope: ContactScope, request_key: UUID) -> dict[str, Any] | None:
    if not isinstance(scope, ContactScope) or not isinstance(request_key, UUID):
        raise ReplyStoreInvariantError("助手讨论请求结构无效。")
    row = connection.execute(
        "SELECT turn.*,input.state AS anchor_input_state, "
        "input.conversation_binding_id AS anchor_binding_id FROM public.assistant_session_turn AS turn "
        "JOIN public.assistant_session_input AS input ON input.id=turn.input_version_id "
        "AND input.turn_id=turn.id AND input.owner_id=turn.owner_id "
        "AND input.contact_id=turn.contact_id AND input.session_id=turn.session_id "
        "WHERE turn.owner_id=%s AND turn.contact_id=%s AND turn.idempotency_key=%s",
        (scope.owner_id, scope.contact_id, request_key),
    ).fetchone()
    return row


def _anchor(connection: Any, scope: ContactScope, request_key: UUID) -> dict[str, Any] | None:
    row = _captured_anchor(connection, scope, request_key)
    if row is None:
        return None
    try:
        require_current_input(connection.connection, scope, row["session_id"], row["input_version_id"])
    except (AssistantSessionNotFound, AssistantSessionRejected):
        raise ReplyStoreInvariantError("助手会话当前输入已失效。") from None
    return row


def _current_fingerprint(row: dict[str, Any]) -> str:
    return _fingerprint((row["input_digest"], row["input_payload"], row["conversation_binding_id"]))


def _input_rows(connection: Any, scope: ContactScope, session_id: UUID) -> list[dict[str, Any]]:
    return connection.execute(
        "SELECT input.*,turn.state AS turn_state,turn.input_payload,turn.input_digest, "
        "turn.dependency_ids AS turn_dependencies,request.id AS reply_request_id,request.state AS request_state "
        "FROM public.assistant_session_input AS input "
        "LEFT JOIN public.assistant_session_turn AS turn ON turn.id=input.turn_id "
        "AND turn.input_version_id=input.id AND turn.owner_id=input.owner_id "
        "AND turn.contact_id=input.contact_id AND turn.session_id=input.session_id "
        "LEFT JOIN public.reply_request AS request ON (turn.reply_request_id IS NULL OR request.id=turn.reply_request_id) "
        "AND request.owner_id=turn.owner_id AND request.contact_id=turn.contact_id "
        "AND request.conversation_binding_id=turn.conversation_binding_id "
        "AND request.idempotency_key=turn.idempotency_key "
        "WHERE input.owner_id=%s AND input.contact_id=%s AND input.session_id=%s "
        "ORDER BY input.created_at,coalesce(input.turn_id,input.id)",
        (scope.owner_id, scope.contact_id, session_id),
    ).fetchall()


def _discussion_identity(row: dict[str, Any]) -> DiscussionIdentity:
    return DiscussionIdentity(
        "discussion_input", row["id"],
        _fingerprint((row["content"], row["conversation_binding_id"], sorted(row["dependency_ids"]))),
    )


def _discussion_available(connection: Any, scope: ContactScope, row: dict[str, Any]) -> bool:
    if row["state"] != "active" or row["content"] is None:
        return False
    try:
        if row["input_type"] == "candidate_carry":
            from notalone.persistence.assistant_candidate_carry import read_candidate_carry_in_transaction
            read_candidate_carry_in_transaction(
                connection.connection, scope, row["content"],
                dependency_ids=tuple(row["dependency_ids"]),
                conversation_binding_id=row["conversation_binding_id"],
            )
        else:
            verified_discussion_dependencies(connection, scope, tuple(row["dependency_ids"]))
    except (AssistantSessionNotFound, AssistantSessionRejected):
        return False
    return True


def _generation_input_available(connection: Any, scope: ContactScope, row: dict[str, Any]) -> bool:
    if (row["state"] != "active" or row["turn_state"] not in ("running", "failed", "completed")
            or row["input_payload"] is None
            or not _dependencies_available(connection, scope, set(row["turn_dependencies"] or ()))):
        return False
    try:
        dependencies = set(row["turn_dependencies"] or ())
        if row["reply_request_id"] is not None:
            dependencies.update(require_reply_sources_current(
                connection, owner_id=scope.owner_id, request_id=row["reply_request_id"],
            ))
            dependencies.update(_reply_dependencies(connection, scope, row["reply_request_id"]))
        elif row["turn_state"] == "completed":
            return False
        typed = _partition_assistant_dependencies(connection, scope, dependencies)
        verified_discussion_dependencies(connection, scope, typed.source_ids)
    except (ReplyStoreInvariantError, AssistantSessionRejected):
        return False
    return True


def _candidate_generation_available(row: dict[str, Any]) -> bool:
    return row["turn_state"] == "completed" and row["request_state"] == "completed"


def _generation_dependencies(connection: Any, scope: ContactScope, row: dict[str, Any]) -> DiscussionDependencies:
    sources = set(row["turn_dependencies"] or ())
    inherited = _partition_assistant_dependencies(connection, scope, sources)
    sources = set(inherited.source_ids)
    if row["reply_request_id"] is None:
        return inherited
    sources.update(_reply_dependencies(connection, scope, row["reply_request_id"]))
    sources.update(captured_reply_sources(connection, owner_id=scope.owner_id, request_id=row["reply_request_id"]))
    typed = _partition_assistant_dependencies(connection, scope, sources)
    samples = (set(inherited.style_sample_ids) | set(typed.style_sample_ids)
               | set(reply_style_sample_dependencies(connection, scope, row["reply_request_id"])))
    return DiscussionDependencies(typed.source_ids, tuple(sorted(samples)))


def _generation_identity(row: dict[str, Any], dependencies: DiscussionDependencies) -> DiscussionIdentity:
    return DiscussionIdentity(
        "generation_input", row["id"],
        _fingerprint((row["input_payload"], row["input_digest"], row["conversation_binding_id"],
                      row["reply_request_id"], dependencies.source_ids, dependencies.style_sample_ids)),
        turn_id=row["turn_id"],
    )


def _candidate_text(version: AssistantCandidateVersion) -> str:
    return _json_text({"messages": [{"message_id": str(message.message_id), "text": message.text}
                                    for message in version.messages], "requirements": version.requirements})


def _candidate_identity(row: dict[str, Any], history: AssistantCandidateHistory,
                        version: AssistantCandidateVersion) -> DiscussionIdentity:
    return DiscussionIdentity(
        "candidate_version", row["id"],
        _fingerprint((_candidate_text(version), version.version_number, version.parent_version_id,
                      history.candidate_group_id, history.candidate_number)),
        row["turn_id"], history.candidate_id, version.version_id,
    )


def _candidate_records(connection: Any, scope: ContactScope, row: dict[str, Any]) -> list[AssistantCandidateHistory]:
    rows = connection.execute(
        "SELECT id FROM public.reply_candidate WHERE owner_id=%s AND contact_id=%s "
        "AND reply_request_id=%s ORDER BY ordinal,id",
        (scope.owner_id, scope.contact_id, row["reply_request_id"]),
    ).fetchall()
    return [_candidate_history(connection.connection, scope, row["session_id"], candidate["id"])
            for candidate in rows]


def _candidate_history(connection: Any, scope: ContactScope, session_id: UUID,
                       candidate_id: UUID) -> AssistantCandidateHistory:
    try:
        return read_candidate_versions(connection, scope, session_id, candidate_id)
    except AssistantCandidateVersionError:
        raise ReplyStoreInvariantError("本次使用的旧候选历史已失效。") from None


def read_assistant_discussion_in_transaction(
    connection: Any, scope: ContactScope, request_key: UUID,
) -> DiscussionContext | None:
    """调用方已持有owner锁；仅在本次真实generation输入仍当前时读取完整历史。"""

    with connection.cursor(row_factory=dict_row) as cursor:
        current = _anchor(cursor, scope, request_key)
        if current is None:
            return None
        items: list[DiscussionItem] = []
        records: list[DiscussionIdentity] = []
        for row in _input_rows(cursor, scope, current["session_id"]):
            if row["id"] == current["input_version_id"]:
                continue
            if row["input_type"] != "generation":
                if _discussion_available(cursor, scope, row):
                    if row["input_type"] == "candidate_carry":
                        from notalone.persistence.assistant_candidate_carry import read_candidate_carry_in_transaction
                        carry = read_candidate_carry_in_transaction(
                            cursor.connection, scope, row["content"],
                            dependency_ids=tuple(row["dependency_ids"]),
                            conversation_binding_id=row["conversation_binding_id"],
                        )
                        messages = [{"message_id": str(message.message_id), "text": message.text}
                                    for message in carry.messages]
                        items.append(DiscussionItem(
                            "candidate_carry", _json_text({"messages": messages}), row["id"],
                            carry.origin.origin_turn_id, carry.origin.origin_reply_request_id,
                            carry.origin.origin_candidate_id, carry.origin.origin_version_id,
                            carry.parent_version_id, carry.candidate_number, carry.version_number,
                            False, True,
                        ))
                    else:
                        items.append(DiscussionItem("discussion_input", _json_text(row["content"]), row["id"]))
                    records.append(_discussion_identity(row))
                continue
            if not _generation_input_available(cursor, scope, row):
                continue
            dependencies = _generation_dependencies(cursor, scope, row)
            items.append(DiscussionItem("generation_input", _json_text(row["input_payload"]), row["id"],
                                        row["turn_id"], row["reply_request_id"]))
            records.append(_generation_identity(row, dependencies))
            if not _candidate_generation_available(row):
                continue
            for history in _candidate_records(cursor, scope, row):
                for version in history.versions:
                    items.append(DiscussionItem(
                        "candidate_version", _candidate_text(version), row["id"], row["turn_id"],
                        row["reply_request_id"], history.candidate_id, version.version_id,
                        version.parent_version_id, history.candidate_number, version.version_number,
                        version.version_id == history.default_display_version_id,
                        version.version_id == history.selected_version_id,
                    ))
                    records.append(_candidate_identity(row, history, version))
        snapshot = DiscussionSnapshot(
            scope, current["session_id"], request_key, current["input_version_id"],
            current["id"], _current_fingerprint(current), tuple(records),
        )
        return DiscussionContext(scope, current["session_id"], request_key,
                                 current["input_version_id"], tuple(items), snapshot)


def require_assistant_discussion_current(
    connection: Any, scope: ContactScope, snapshot: DiscussionSnapshot,
) -> DiscussionDependencies:
    """只复验本次读取的历史身份，后续新增且未使用的版本不自动使快照失效。"""

    if not isinstance(snapshot, DiscussionSnapshot) or snapshot.scope != scope:
        raise ReplyStoreInvariantError("助手讨论快照不属于当前范围。")
    with connection.cursor(row_factory=dict_row) as cursor:
        current = _anchor(cursor, scope, snapshot.request_key)
        if current is None or (
            current["session_id"], current["input_version_id"], current["id"], _current_fingerprint(current),
        ) != (
            snapshot.session_id, snapshot.current_input_version_id, snapshot.current_turn_id,
            snapshot.current_payload_sha256,
        ):
            raise ReplyStoreInvariantError("助手讨论当前输入已改变。")
        return _require_captured_records(cursor, scope, snapshot)


def require_assistant_discussion_available(
    connection: Any, scope: ContactScope, snapshot: DiscussionSnapshot,
) -> DiscussionDependencies:
    """历史读取/重放/继续只复验捕获身份；新输入和绑定撤销不抹去有效捕获。

    调用方持有owner锁并核验完成回复本身的C来源；此处不再次进入同一C请求守卫。
    当前生成和保存必须使用require_assistant_discussion_current的输入CAS。
    """

    if not isinstance(snapshot, DiscussionSnapshot) or snapshot.scope != scope:
        raise ReplyStoreInvariantError("助手讨论快照不属于当前范围。")
    with connection.cursor(row_factory=dict_row) as cursor:
        anchor = _captured_anchor(cursor, scope, snapshot.request_key)
        if anchor is None or (
            anchor["session_id"], anchor["input_version_id"], anchor["id"], _current_fingerprint(anchor),
        ) != (
            snapshot.session_id, snapshot.current_input_version_id, snapshot.current_turn_id,
            snapshot.current_payload_sha256,
        ):
            raise ReplyStoreInvariantError("助手讨论捕获输入已失效。")
        # 失败仍保留有效用户输入；AI候选必须另行证明生成已完成。
        if (anchor["anchor_input_state"] != "active" or anchor["state"] not in ("running", "failed", "completed")
                or anchor["input_payload"] is None
                or anchor["anchor_binding_id"] != anchor["conversation_binding_id"]
                or not _dependencies_available(cursor, scope, set(anchor["dependency_ids"]))):
            raise ReplyStoreInvariantError("助手讨论捕获输入来源已失效。")
        return _require_captured_records(cursor, scope, snapshot)


def _require_captured_records(
    cursor: Any, scope: ContactScope, snapshot: DiscussionSnapshot,
) -> DiscussionDependencies:
    dependencies: set[UUID] = set()
    samples: set[UUID] = set()
    input_rows = {row["id"]: row for row in _input_rows(cursor, scope, snapshot.session_id)}
    captured_by_input: dict[UUID, DiscussionDependencies] = {}
    histories: dict[UUID, AssistantCandidateHistory] = {}
    for identity in snapshot.records:
        row = input_rows.get(identity.input_version_id)
        if row is None:
            raise ReplyStoreInvariantError("本次使用的助手讨论已失效。")
        if identity.kind == "discussion_input":
            if not _discussion_available(cursor, scope, row) or _discussion_identity(row) != identity:
                raise ReplyStoreInvariantError("本次使用的助手讨论已失效。")
            dependencies.update(row["dependency_ids"])
            if row["input_type"] == "candidate_carry":
                from notalone.persistence.assistant_candidate_carry import read_candidate_carry_in_transaction
                carry = read_candidate_carry_in_transaction(
                    cursor.connection, scope, row["content"],
                    dependency_ids=tuple(row["dependency_ids"]),
                    conversation_binding_id=row["conversation_binding_id"],
                )
                samples.update(carry.dependencies.style_sample_ids)
            continue
        if identity.input_version_id not in captured_by_input:
            if not _generation_input_available(cursor, scope, row):
                raise ReplyStoreInvariantError("本次使用的旧轮生成已失效。")
            captured_by_input[identity.input_version_id] = _generation_dependencies(cursor, scope, row)
        captured = captured_by_input[identity.input_version_id]
        dependencies.update(captured.source_ids)
        samples.update(captured.style_sample_ids)
        if identity.kind == "generation_input":
            current_identity = _generation_identity(row, captured)
        else:
            if not _candidate_generation_available(row) or identity.candidate_id is None:
                raise ReplyStoreInvariantError("助手讨论候选身份无效。")
            if identity.candidate_id not in histories:
                histories[identity.candidate_id] = _candidate_history(
                    cursor.connection, scope, snapshot.session_id, identity.candidate_id,
                )
            history = histories[identity.candidate_id]
            version = next((version for version in history.versions if version.version_id == identity.version_id), None)
            if version is None:
                raise ReplyStoreInvariantError("本次使用的旧候选版本已失效。")
            current_identity = _candidate_identity(row, history, version)
        if current_identity != identity:
            raise ReplyStoreInvariantError("本次使用的助手历史内容已改变。")
    return DiscussionDependencies(tuple(sorted(dependencies)), tuple(sorted(samples)))
