#!/usr/bin/env python3
"""对单一已确认联系人做一次真实聊天语用验证。

默认只取包含 ``--focus`` 的一条消息及其前后上下文，最多 80 条消息，
避免把整段历史一次性发给模型。脚本只读 PostgreSQL，绝不写入记忆或台账。
终端只输出统计和受控枚举，不输出聊天原文、命题文本或凭据。
"""

from __future__ import annotations

import argparse
import collections
import os
import sys
from typing import Any
from uuid import UUID

import psycopg

from notalone.memory_extraction.cli_support import load_contact_messages
from notalone.runtime_config import load_project_env
from notalone.scopes import ContactScope

from run_live_smoke import (
    BATCH_INTERPRETATION_SCHEMA,
    MODEL_DEFAULT,
    _build_model,
    _tool_args,
    decide_memory_action,
    validate_output,
)


REAL_WINDOW_SIZE = 80
REAL_FOCUS_DEFAULT = "贷款"
REAL_SYSTEM_PROMPT = """你是关系聊天中的语用解释器，不是记忆采纳器。
你正在分析一位已确认联系人聊天窗口中的真实消息。只提取值得长期记住的、与关系有关的命题；
寒暄、一次性细节和没有长期价值的闲聊返回空数组。
严格区分事实陈述、未来计划、条件假设、吹牛/夸张、第三方引用、不确定表达、纠正/撤回和后续证据。
必须结合整个窗口理解语气，不要把字面内容直接当成现实事实。
每条命题都必须引用当前窗口中的 message_id，并在 alternatives 中保留合理的其他解释。
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


def _run_window(model: Any, messages: tuple[Any, ...]) -> dict[str, Any]:
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
    for interpretation in interpretations:
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
    if "confirmed_memory" in actions:
        raise RuntimeError("安全闸门出现了 confirmed_memory，停止本次验证。")
    return {
        "interpretations": len(interpretations),
        "actions": dict(sorted(actions.items())),
        "fields": {field: dict(sorted(counter.items())) for field, counter in fields.items()},
        "blocked": blocked,
        "hard_cue_guarded": hard_cue_guarded,
        "schema_valid": all(
            not validate_output(interpretation, source_ids)
            for interpretation in interpretations
        ),
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
        window = _select_window(messages, args.focus, args.window_size)
        print(f"[scope] single_contact=True total_messages={len(messages)} window_messages={len(window)}")
        print(f"[scope] focus_match=True persistence=none model={args.model} thinking=disabled temperature=0.0")
        result = _run_window(_build_model(api_key, args.model), window)
    except Exception as error:  # noqa: BLE001 - CLI must return a concise safe failure
        print(f"[stop] {type(error).__name__}: {error}")
        return 1

    print(f"[result] interpretations={result['interpretations']} schema_valid={result['schema_valid']}")
    print(f"[result] actions={result['actions']}")
    print(f"[result] blocked={result['blocked']} hard_cue_guarded={result['hard_cue_guarded']}")
    for field, values in result["fields"].items():
        print(f"[field] {field}={values}")
    print("[done] 仅完成读取和模型分析，没有写入数据库、记忆或聊天发送。")
    return 0 if result["schema_valid"] and result["blocked"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
