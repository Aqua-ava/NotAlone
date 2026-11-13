#!/usr/bin/env python3
"""对单一已确认联系人做一次真实聊天语用验证并可生成待确认候选。

默认只取包含 ``--focus`` 的一条消息及其前后上下文，最多 80 条消息，
避免把整段历史一次性发给模型。默认只读 PostgreSQL；显式添加
``--write-pending`` 后，才会把合约通过的结果写成 pending 候选。
终端只输出统计和受控枚举，不输出聊天原文、命题文本或凭据。
"""

from __future__ import annotations

import argparse
import collections
import os
import sys
from typing import Any
from uuid import UUID
from uuid import uuid4

import psycopg

from notalone.memory.models import (
    MemoryCandidate,
    MemoryCandidateStatus,
    MemoryCategory,
    MemoryTopic,
)
from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.persistence.memory_store import PostgresMemoryStore
from notalone.runtime_config import load_project_env
from notalone.scopes import ContactScope

from run_live_smoke import (
    BATCH_INTERPRETATION_SCHEMA,
    MODEL_DEFAULT,
    _build_model,
    _tool_args,
    decide_memory_action,
    MEMORY_CATEGORY_VALUES,
    MEMORY_TOPIC_VALUES,
    validate_output,
)


REAL_WINDOW_SIZE = 80
REAL_FOCUS_DEFAULT = "贷款"
REAL_SYSTEM_PROMPT = """你是关系聊天中的语用解释器，不是记忆采纳器。
你正在分析一位已确认联系人聊天窗口中的真实消息。只提取值得长期记住的、与关系有关的命题；
寒暄、一次性细节和没有长期价值的闲聊返回空数组。
严格区分事实陈述、未来计划、条件假设、吹牛/夸张、第三方引用、不确定表达、纠正/撤回和后续证据。
必须结合整个窗口理解语气，不要把字面内容直接当成现实事实。
每条命题都必须引用当前窗口中的 message_id，并在 alternatives 中保留合理的其他解释；还必须填写
category、subject、topic、risk_flags。subject=self 的命题不能当作联系人的记忆。
不要输出 memory action、confirmed_memory 或任何没有来源的命题；最终动作由外部确定性安全闸门决定。
必须通过工具返回结构化结果。
"""


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--contact-name",
        required=True,
        help="已确认联系人的精确展示名；不会写入结果。",
    )
    parser.add_argument(
        "--focus",
        default=REAL_FOCUS_DEFAULT,
        help=f"用于定位上下文的本地关键词，默认 {REAL_FOCUS_DEFAULT}。",
    )
    parser.add_argument(
        "--window-size",
        type=int,
        default=REAL_WINDOW_SIZE,
        help=f"发送给模型的最大消息数，默认 {REAL_WINDOW_SIZE}，范围 20-120。",
    )
    parser.add_argument(
        "--model",
        default=os.environ.get("NOTALONE_DEEPSEEK_MODEL") or MODEL_DEFAULT,
        help=f"模型名，默认 {MODEL_DEFAULT}。",
    )
    parser.add_argument(
        "--write-pending",
        action="store_true",
        help="将通过安全闸门的结果写入 pending memory_candidate；默认只读。",
    )
    return parser.parse_args()


def _find_contact_id(database_url: str, owner_id: UUID, display_name: str) -> UUID:
    with psycopg.connect(database_url) as connection:
        rows = connection.execute(
            """
            SELECT id
            FROM public.contact
            WHERE owner_id = %s AND display_name = %s
            """,
            (owner_id, display_name),
        ).fetchall()
    if len(rows) != 1:
        raise RuntimeError(f"联系人精确匹配数量为 {len(rows)}，拒绝继续，避免范围歧义。")
    return rows[0][0]


def _select_window(messages: tuple[Any, ...], focus: str, size: int) -> tuple[Any, ...]:
    if not 20 <= size <= 120:
        raise ValueError("window-size 必须在 20 到 120 之间。")
    matches = [index for index, message in enumerate(messages) if focus in message.text]
    if not matches:
        raise RuntimeError("没有找到 focus 对应的消息，拒绝发送不相关的真实上下文。")
    actual_size = min(size, len(messages))
    anchor = matches[0]
    start = max(0, anchor - actual_size // 2)
    start = min(start, len(messages) - actual_size)
    return messages[start : start + actual_size]


def _window_text(messages: tuple[Any, ...]) -> str:
    return "\n".join(
        f"{index}. [message_id={message.message_id}] sender={message.sender.value}: {message.text}"
        for index, message in enumerate(messages, start=1)
    )


def _validate_memory_output(output: Any, source_ids: set[str]) -> list[str]:
    errors = validate_output(output, source_ids)
    if not isinstance(output, dict):
        return errors
    if output.get("category") not in MEMORY_CATEGORY_VALUES:
        errors.append("category 不在记忆分类枚举中")
    if output.get("subject") not in {"self", "contact", "shared"}:
        errors.append("subject 不在主体枚举中")
    if output.get("topic") not in MEMORY_TOPIC_VALUES:
        errors.append("topic 不在记忆主题枚举中")
    risk_flags = output.get("risk_flags")
    if not isinstance(risk_flags, list) or not all(
        isinstance(flag, str) and flag.strip() for flag in risk_flags
    ):
        errors.append("risk_flags 必须是字符串数组")
    for source_id in output.get("source_message_ids") or []:
        try:
            UUID(source_id)
        except (TypeError, ValueError):
            errors.append("source_message_ids 必须是 UUID")
    return errors


def _candidate_key(text: str, source_ids: tuple[UUID, ...]) -> tuple[str, frozenset[UUID]]:
    return "".join(text.split()).lower(), frozenset(source_ids)


def _candidate_from_output(
    output: dict[str, Any],
    scope: ContactScope,
) -> MemoryCandidate:
    return MemoryCandidate(
        candidate_id=uuid4(),
        scope=scope,
        text=output["proposition"],
        category=MemoryCategory(output["category"]),
        topic=MemoryTopic(output["topic"]),
        source_ids=tuple(UUID(source_id) for source_id in output["source_message_ids"]),
        status=MemoryCandidateStatus.PENDING,
        confidence=float(output["model_confidence"]),
        risk_flags=tuple(output["risk_flags"]),
    )


def _run_window(
    model: Any,
    messages: tuple[Any, ...],
    scope: ContactScope,
    database_url: str,
    write_pending: bool,
) -> dict[str, Any]:
    source_ids = {str(message.message_id) for message in messages}
    texts = tuple(message.text for message in messages)
    bound = model.bind_tools([BATCH_INTERPRETATION_SCHEMA])
    response = bound.invoke(
        [
            {"role": "system", "content": REAL_SYSTEM_PROMPT},
            {"role": "user", "content": _window_text(messages)},
        ]
    )
    payload = _tool_args(response)
    interpretations = payload.get("interpretations")
    if not isinstance(interpretations, list):
        raise RuntimeError("模型未返回 interpretations 数组。")

    actions: collections.Counter[str] = collections.Counter()
    fields: dict[str, collections.Counter[str]] = {
        "dialogue_act": collections.Counter(),
        "assertion_status": collections.Counter(),
        "literalness": collections.Counter(),
        "evidence_relation": collections.Counter(),
    }
    blocked = 0
    hard_cue_guarded = 0
    schema_valid = True
    created = 0
    duplicates = 0
    skipped_self = 0
    pending_store = PostgresMemoryStore(database_url) if write_pending else None
    existing_keys: set[tuple[str, frozenset[UUID]]] = set()
    if pending_store is not None:
        existing_keys = {
            _candidate_key(candidate.text, candidate.source_ids)
            for candidate in pending_store.list_pending_candidates(scope)
        }
    for interpretation in interpretations:
        errors = _validate_memory_output(interpretation, source_ids)
        if errors:
            schema_valid = False
            decision = {
                "action": "blocked",
                "reason": "记忆候选结构不合约，停止写入。",
                "safety_flags": errors,
            }
        elif interpretation["subject"] == "self":
            skipped_self += 1
            decision = {
                "action": "blocked",
                "reason": "subject=self 应进入 owner 级记忆，当前脚本只生成联系人候选。",
                "safety_flags": ["subject:self_requires_owner_memory"],
            }
        else:
            decision = decide_memory_action(interpretation, source_ids, texts)
        action = decision["action"]
        actions[action] += 1
        blocked += int(action == "blocked")
        hard_cue_guarded += int(any(flag.startswith("hard_cue:") for flag in decision["safety_flags"]))
        if isinstance(interpretation, dict):
            for field, counter in fields.items():
                value = interpretation.get(field)
                if isinstance(value, str):
                    counter[value] += 1
        if pending_store is not None and action in {"candidate", "plan_candidate", "pending"}:
            candidate = _candidate_from_output(interpretation, scope)
            key = _candidate_key(candidate.text, candidate.source_ids)
            if key in existing_keys:
                duplicates += 1
            else:
                pending_store.create_candidate(candidate)
                existing_keys.add(key)
                created += 1
    if "confirmed_memory" in actions:
        raise RuntimeError("安全闸门出现了 confirmed_memory，停止本次验证。")
    return {
        "interpretations": len(interpretations),
        "actions": dict(sorted(actions.items())),
        "fields": {field: dict(sorted(counter.items())) for field, counter in fields.items()},
        "blocked": blocked,
        "hard_cue_guarded": hard_cue_guarded,
        "schema_valid": schema_valid,
        "created": created,
        "duplicates": duplicates,
        "skipped_self": skipped_self,
        "write_pending": write_pending,
    }


def main() -> int:
    load_project_env()
    args = _parse_args()
    api_key = os.environ.get("NOTALONE_DEEPSEEK_API_KEY", "").strip()
    database_url = os.environ.get("NOTALONE_DATABASE_URL", "").strip()
    owner_value = os.environ.get("NOTALONE_OWNER_ID", "").strip()
    if not api_key or not database_url or not owner_value:
        print("[stop] .env 必须提供 DeepSeek Key、NOTALONE_DATABASE_URL 和 NOTALONE_OWNER_ID。")
        return 2

    try:
        owner_id = UUID(owner_value)
        contact_id = _find_contact_id(database_url, owner_id, args.contact_name)
        messages = load_contact_messages(
            ContactScope(owner_id, contact_id), database_url
        )
        scope = ContactScope(owner_id, contact_id)
        window = _select_window(messages, args.focus, args.window_size)
        print(f"[scope] single_contact=True total_messages={len(messages)} window_messages={len(window)}")
        print(f"[scope] focus_match=True write_pending={args.write_pending} model={args.model} thinking=disabled temperature=0.0")
        result = _run_window(
            _build_model(api_key, args.model),
            window,
            scope,
            database_url,
            args.write_pending,
        )
    except Exception as error:  # noqa: BLE001 - CLI must return a concise safe failure
        print(f"[stop] {type(error).__name__}: {error}")
        return 1

    print(f"[result] interpretations={result['interpretations']} schema_valid={result['schema_valid']}")
    print(f"[result] actions={result['actions']}")
    print(f"[result] blocked={result['blocked']} hard_cue_guarded={result['hard_cue_guarded']}")
    print(f"[result] pending_created={result['created']} duplicates={result['duplicates']} self_skipped={result['skipped_self']}")
    for field, values in result["fields"].items():
        print(f"[field] {field}={values}")
    if result["write_pending"]:
        print("[done] 已写入 pending memory_candidate；没有写入 confirmed_memory，也没有发送聊天消息。")
    else:
        print("[done] 仅完成读取和模型分析，没有写入数据库、记忆或聊天发送。")
    return 0 if result["schema_valid"] and result["blocked"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
