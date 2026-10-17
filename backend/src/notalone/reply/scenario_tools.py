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
                    require_scenario_receipts(self.material, (*self._reads, value))
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
    """逐次重算保存回执的真实累计量，不读取最新正文重建旧依据。"""
    def reject():
        raise ReplyContextInvariantError("正文工具回执与本次冻结范围或累计额度不一致。")

    if not isinstance(receipts, tuple) or any(type(item) is not dict for item in receipts):
        reject()
    if not receipts:
        return
    payload = material.to_payload()
    limits = payload.get("scenario_read_budget")
    directory = {item["scenario_id"]: item for item in payload["directory"]}
    if limits is None:
        reject()
    paragraphs = characters = 0
    seen = set()
    statuses = {"succeeded", "duplicate", "out_of_range", "not_in_directory", "invalid_arguments", "stale", "budget_exceeded"}
    for index, receipt in enumerate(receipts):
        expected_fields = {"schema_version", "status", "reason", "scenario_id", "paragraph_range", "budget"}
        status = receipt.get("status")
        if status == "succeeded":
            expected_fields.add("document")
        if (set(receipt) != expected_fields or type(receipt["schema_version"]) is not int
                or receipt["schema_version"] != 1 or status not in statuses
                or type(receipt["reason"]) is not str or not receipt["reason"].strip()):
            reject()
        if status == "succeeded":
            document = receipt["document"]
            entry = directory.get(receipt["scenario_id"])
            span = receipt["paragraph_range"]
            if (entry is None or type(span) is not list or len(span) != 2
                    or any(type(item) is not int for item in span)
                    or not 0 <= span[0] < span[1] <= entry["paragraph_count"]
                    or type(document) is not dict
                    or set(document) != {"scenario_id", "version_id", "title", "hint", "system_generated",
                                         "updated_at", "paragraphs", "paragraph_range", "organization_generation"}
                    or any(document.get(key) != entry[key] for key in ("scenario_id", "version_id", "title", "hint"))
                    or document["system_generated"] is not True
                    or document["organization_generation"] != material.snapshot.organization_generation
                    or document["paragraph_range"] != span or type(document["paragraphs"]) is not list
                    or len(document["paragraphs"]) != span[1] - span[0]
                    or any(type(item) is not dict or type(item.get("text")) is not str or not item["text"].strip()
                           or type(item.get("references")) is not list or not item["references"]
                           for item in document["paragraphs"])):
                reject()
            keys = {(entry["scenario_id"], number) for number in range(span[0], span[1])}
            if seen & keys or index >= limits["call_limit"]:
                reject()
            seen.update(keys)
            paragraphs += len(keys)
            characters += len(json.dumps(document, ensure_ascii=False))
        budget = receipt["budget"]
        expected = {**limits, "used_calls": min(index + 1, limits["call_limit"]),
                    "used_paragraphs": paragraphs, "used_characters": characters}
        if (type(budget) is not dict or set(budget) != set(expected)
                or any(type(budget[key]) is not int or budget[key] != value for key, value in expected.items())
                or paragraphs > limits["paragraph_limit"] or characters > limits["character_limit"]):
            reject()
