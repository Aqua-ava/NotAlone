"""只读本次实际目录；锁内结算、去重并保存真实工具回执。"""

import json
from threading import RLock
from uuid import UUID

from notalone.memory.layered import LayeredMemoryConflict
from notalone.reply.context import ToolCallTrace
from notalone.reply.errors import ReplyContextInvariantError


class ScenarioToolAccess:
    def __init__(self, *, material, port):
        self.material, self.port = material, port
        payload = material.to_payload()
        self.directory = {item["scenario_id"]: item for item in payload["directory"]}
        self.limits = payload["scenario_read_budget"]
        self._lock = RLock()
        self._reads = []
        self._seen = set()
        self._calls = self._paragraphs = self._characters = 0

    @property
    def receipts(self):
        with self._lock:
            return tuple(json.loads(json.dumps(item, ensure_ascii=False)) for item in self._reads)

    @property
    def tool_calls(self):
        return tuple(ToolCallTrace(tool_name="read_scenario",
            status=("succeeded" if item["status"] == "succeeded" else
                    "budget_exceeded" if item["status"] == "budget_exceeded" else "failed"),
            evidence_ids=()) for item in self.receipts)

    def read(self, *, scenario_id=None, paragraph_start=None, paragraph_end=None, **extra):
        # 框架可能并发执行同轮工具；检查、读取、去重及扣额须为同一原子区间。
        with self._lock:
            identifier = None
            try:
                if type(scenario_id) is str:
                    identifier = str(UUID(scenario_id))
            except ValueError:
                pass
            valid_range = (type(paragraph_start) is int and type(paragraph_end) is int)
            selected_range = [paragraph_start, paragraph_end] if valid_range else None
            def finish(status, reason, document=None):
                value = {"schema_version": 1, "status": status, "reason": reason,
                    "scenario_id": identifier, "paragraph_range": selected_range,
                    "budget": {**self.limits, "used_calls": self._calls,
                        "used_paragraphs": self._paragraphs, "used_characters": self._characters}}
                if document is not None:
                    value["document"] = document
                self._reads.append(value)
                return json.dumps(value, ensure_ascii=False)
            if self._calls >= self.limits["call_limit"]:
                return finish("budget_exceeded", "正文工具调用额度已用尽；请使用已有依据完成候选。")
            self._calls += 1
            if extra or identifier is None or not valid_range:
                return finish("invalid_arguments", "只接受目录稳定ID和整数段落范围；不得提供路径、身份或版本。")
            allowed = self.directory.get(identifier)
            if allowed is None:
                return finish("not_in_directory", "主题不在本次实际提供的目录内。")
            if not 0 <= paragraph_start < paragraph_end <= allowed["paragraph_range"][1]:
                return finish("out_of_range", "段落范围必须位于本次目录允许的零基左闭右开范围内。")
            keys = {(identifier, index) for index in range(paragraph_start, paragraph_end)}
            if keys & self._seen:
                return finish("duplicate", "本次已读取这些段落；请使用已有正文，不重复读取。")
            if self._paragraphs + len(keys) > self.limits["paragraph_limit"]:
                return finish("budget_exceeded", "正文工具累计段落额度不足；不截断段落。")
            try:
                document = self.port.read_scenario(self.material.snapshot, UUID(identifier),
                                                  (paragraph_start, paragraph_end))
            except (LayeredMemoryConflict, LookupError, PermissionError):
                return finish("stale", "冻结资料已失效；请重新准备，不读取后继版本。")
            characters = len(json.dumps(document, ensure_ascii=False))
            if self._characters + characters > self.limits["character_limit"]:
                return finish("budget_exceeded", "正文工具累计正文JSON字符额度不足；不截断段落。")
            self._seen.update(keys)
            self._paragraphs += len(keys)
            self._characters += characters
            return finish("succeeded", "已读取本次冻结主题的完整段落；仅供事实与说明参考。", document)


def require_scenario_receipts(material, receipts):
    """实际保存输入的结构和范围；不读取最新正文来重建旧依据。"""
    if not isinstance(receipts, tuple) or any(type(item) is not dict for item in receipts):
        raise ReplyContextInvariantError("正文工具回执结构无效。")
    if not receipts:
        return
    payload = material.to_payload()
    limits = payload.get("scenario_read_budget")
    directory = {item["scenario_id"]: item for item in payload["directory"]}
    if limits is None:
        raise ReplyContextInvariantError("本次未授权正文工具。")
    for receipt in receipts:
        budget = receipt.get("budget", {})
        if (receipt.get("schema_version") != 1 or any(budget.get(key) != value for key, value in limits.items())
                or any(type(budget.get(key)) is not int or not 0 <= budget[key] <= limits[limit]
                       for key, limit in (("used_calls", "call_limit"), ("used_paragraphs", "paragraph_limit"),
                                          ("used_characters", "character_limit")))):
            raise ReplyContextInvariantError("正文工具预算回执无效。")
        if receipt.get("status") != "succeeded":
            if "document" in receipt:
                raise ReplyContextInvariantError("未成功读取的工具不能保存正文。")
            continue
        document = receipt.get("document", {})
        entry = directory.get(receipt.get("scenario_id"))
        span = receipt.get("paragraph_range")
        if (entry is None or type(span) is not list or len(span) != 2
                or any(type(item) is not int for item in span)
                or not 0 <= span[0] < span[1] <= entry["paragraph_count"]
                or document.get("scenario_id") != entry["scenario_id"]
                or document.get("version_id") != entry["version_id"]
                or document.get("paragraph_range") != span
                or len(document.get("paragraphs", [])) != span[1] - span[0]):
            raise ReplyContextInvariantError("正文工具没有使用本次目录冻结版本。")
