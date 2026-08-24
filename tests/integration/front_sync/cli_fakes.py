"""front_sync 集成测试共享的脚本化 fake CLI 与输出构造。

只用于合成测试：按命令分发脚本化输出，不连接真实微信或数据库。
"""

from __future__ import annotations

import json
from collections import defaultdict, deque
from collections.abc import Sequence
from dataclasses import dataclass


@dataclass(frozen=True)
class FakeCommandResult:
    returncode: int
    stdout: str
    stderr: str = ""


def candidate_json(
    username: str, display_name: str, chat_type: str = "private"
) -> dict:
    """构造一个 resolve-chat/sessions 候选的 JSON 对象。"""

    return {
        "username": username,
        "display_name": display_name,
        "match": "display_name_exact",
        "chat_type": chat_type,
        "last_timestamp": 1787486383,
    }


def tail_stdout(
    talker: str,
    events: Sequence[tuple[int, str, bool]],
    *,
    base_time: int = 2_000_000_000,
) -> str:
    """按 (local_id, 正文, 是否我方) 生成文字消息的 tail JSONL 输出。

    消息原始时间为 ``base_time + local_id``，便于围绕开关时刻构造窗口。
    """

    lines = []
    for local_id, text, is_from_me in events:
        lines.append(
            json.dumps(
                {
                    "type": "message",
                    "cursor": f"local_id:{local_id}",
                    "message": {
                        "id": {"local_id": local_id, "talker": talker},
                        "kind": "text",
                        "text": text,
                        "is_from_me": is_from_me,
                        "create_time": base_time + local_id,
                    },
                },
                ensure_ascii=False,
            )
        )
    return "\n".join(lines)


class ScriptedCliRunner:
    """按命令分发的脚本化 CLI；tail 输出按 talker 排队消费。"""

    def __init__(self) -> None:
        self.candidates_by_query: dict[str, list[dict]] = {}
        self.tail_queues: dict[str, deque[str]] = defaultdict(deque)
        self.tail_calls: list[tuple[str, str | None]] = []
        self.tail_error: Exception | None = None
        self.version_error: Exception | None = None
        self.version_calls = 0

    def __call__(self, command: tuple[str, ...]) -> FakeCommandResult:
        subcommand = command[1]
        if subcommand == "--version":
            self.version_calls += 1
            if self.version_error is not None:
                error, self.version_error = self.version_error, None
                raise error
            return FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {"ok": True, "data": {"version": "1.6.20-test"}}
                ),
            )
        if subcommand == "resolve-chat":
            query = command[2]
            return FakeCommandResult(
                returncode=0,
                stdout=json.dumps(
                    {
                        "ok": True,
                        "data": {
                            "query": query,
                            "candidates": self.candidates_by_query.get(query, []),
                        },
                    },
                    ensure_ascii=False,
                ),
            )
        if subcommand == "tail":
            if self.tail_error is not None:
                error, self.tail_error = self.tail_error, None
                raise error
            talker = command[2]
            cursor = None
            if "--cursor" in command:
                cursor = command[command.index("--cursor") + 1]
            self.tail_calls.append((talker, cursor))
            queue = self.tail_queues[talker]
            stdout = queue.popleft() if queue else ""
            return FakeCommandResult(returncode=0, stdout=stdout)
        raise AssertionError(f"测试未预期的 CLI 命令：{subcommand}")
