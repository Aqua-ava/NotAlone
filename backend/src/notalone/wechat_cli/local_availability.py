"""仅为已授权会话的精确缺表失败核验本地历史状态。

本模块不执行命令；调用方负责沿用尾读的授权范围、严格只读模式和
剩余截止时间。缺表和缓存陈旧本身都不是本地无历史的证据。
"""

from __future__ import annotations

import json
import re
from typing import Literal


LocalHistoryCode = Literal["local_history_deleted", "local_history_empty"]


def _envelope(stdout: str) -> dict | None:
    try:
        value = json.loads(stdout)
    except (TypeError, ValueError):
        return None
    return value if isinstance(value, dict) else None


def is_exact_missing_message_table(stdout: str) -> bool:
    """只接纳成功打开明确数量分库后的缺表模板；附带警告时拒绝。"""

    value = _envelope(stdout)
    if value is None or value.get("ok") is not False or value.get("warnings"):
        return False
    data = value.get("data")
    if data is not None:
        # 失败不应夹带部分结果；分库读取失败可能藏在部分结果的警告中。
        return False
    error = value.get("error")
    if not isinstance(error, dict) or error.get("code") != "tool_error":
        return False
    if error.get("warnings") or error.get("details"):
        return False
    message = error.get("message")
    return isinstance(message, str) and re.fullmatch(
        r"table \S+ not found in [1-9]\d* message shards", message
    ) is not None


def local_history_probe_sql(talker: str) -> str:
    """只查询一个已授权稳定定位标识，返回计数，不返回名称或正文。"""

    if not isinstance(talker, str) or not talker.strip() or len(talker) > 1024:
        raise ValueError("会话定位标识无效。")
    if any(ord(character) < 32 or ord(character) == 127 for character in talker):
        raise ValueError("会话定位标识不能包含控制字符。")
    # CLI SQL 接口不支持绑定参数；固定标识符，值严格按 SQLite 字符串转义。
    literal = "'" + talker.replace("'", "''") + "'"
    return (
        "SELECT "
        f"(SELECT COUNT(*) FROM SessionDeleteTable WHERE username = {literal}) AS deleted_count, "
        f"(SELECT COUNT(*) FROM SessionTable WHERE username = {literal}) AS session_count, "
        "(SELECT COUNT(*) FROM SessionTable "
        f"WHERE username = {literal} AND last_msg_locald_id = 0 "
        "AND last_timestamp = 0 AND COALESCE(summary, '') = '') AS empty_session_count"
    )


def classify_local_history_probe(stdout: str) -> LocalHistoryCode | None:
    """只有实时单库只读查询的完整计数证据可分类；其余保持原错误。"""

    value = _envelope(stdout)
    if value is None or value.get("ok") is not True or value.get("warnings") or value.get("error"):
        return None
    data = value.get("data")
    if not isinstance(data, dict) or data.get("warnings") or data.get("error"):
        return None
    freshness, query, rows = data.get("freshness"), data.get("query"), data.get("rows")
    if not isinstance(freshness, dict) or freshness.get("message_source") != "live_selected_db_read_only":
        return None
    if not isinstance(query, dict) or query.get("has_more") is not False or type(query.get("returned")) is not int or query["returned"] != 1:
        return None
    if not isinstance(rows, list) or len(rows) != 1 or not isinstance(rows[0], dict):
        return None
    row = rows[0]
    if set(row) != {"deleted_count", "session_count", "empty_session_count"}:
        return None
    if any(type(number) is not int or number not in (0, 1) for number in row.values()):
        return None
    deleted, sessions, empty = row["deleted_count"], row["session_count"], row["empty_session_count"]
    if empty > sessions or sessions != empty:
        return None
    if deleted:
        return "local_history_deleted"
    if sessions == empty == 1:
        return "local_history_empty"
    return None
