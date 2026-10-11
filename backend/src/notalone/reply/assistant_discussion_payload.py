"""完整助手讨论的模型数据表示；不计量、不摘要、不存储或变成事实。"""

from __future__ import annotations

from typing import Any

from notalone.reply.assistant_discussion import DiscussionContext


def assistant_discussion_payload(discussion: DiscussionContext) -> dict[str, Any]:
    """保留读取顺序、全部版本及选择标记；旧 AI 选择不代表发送。"""

    return {
        "session_id": str(discussion.session_id),
        "request_key": str(discussion.request_key),
        "current_input_version_id": str(discussion.current_input_version_id),
        "factual_role": "assistant_discussion_reference",
        "weight": "low",
        "notice": discussion.notice,
        "items": [{
            "kind": item.kind,
            "role": "assistant_candidate" if item.kind in ("candidate_version", "candidate_carry") else "user",
            "text": item.text,
            "input_version_id": str(item.input_version_id),
            "turn_id": str(item.turn_id) if item.turn_id is not None else None,
            "reply_request_id": str(item.reply_request_id) if item.reply_request_id is not None else None,
            "candidate_id": str(item.candidate_id) if item.candidate_id is not None else None,
            "version_id": str(item.version_id) if item.version_id is not None else None,
            "parent_version_id": str(item.parent_version_id) if item.parent_version_id is not None else None,
            "candidate_number": item.candidate_number,
            "version_number": item.version_number,
            "is_default_display": item.is_default_display,
            "is_explicitly_selected": item.is_explicitly_selected,
            "is_sent": False,
        } for item in discussion.items],
    }
