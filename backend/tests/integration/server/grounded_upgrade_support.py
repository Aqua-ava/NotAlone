"""升级合成模型沿实际Grounded/V/A协议；不改变生产默认门。"""

from __future__ import annotations

from copy import deepcopy
import json
import re

from langchain_core.outputs import ChatGeneration, ChatResult

from notalone.memory_extraction.dimensions import DimensionRelease
from tests.integration.server.core_business_flow_support import (
    CoreBusinessFlowFixture, tool_response,
)
from tests.integration.server.test_import_auto_flow import AutoMemoryModel, ModelGate


class GroundedUpgradeModel(AutoMemoryModel):
    """只标注已知合成原句；门闩与失败绑定实际调用序号和工具。"""

    requested_tools: list[tuple[str, ...]] = []
    adjudication_gate: ModelGate | None = None
    adjudication_action: str = "add"
    proposals: dict[str, dict] = {}

    def __init__(self):
        super().__init__()
        self.requested_tools = []
        self.adjudication_gate = None

    def block_adjudication(self):
        self.adjudication_gate = ModelGate()
        return self.adjudication_gate

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        del stop, run_manager
        self.wait_for_response()
        # 取本次Runnable实际绑定参数；其他线程后续bind不能改变本次工具身份。
        requested = tuple(tool["function"]["name"] for tool in kwargs.get("tools", ()))
        with self.call_lock:
            index = len(self.seen_calls)
            self.seen_calls.append(messages)
            self.requested_tools.append(requested)
            self.record_model_payload(messages, deepcopy(kwargs))
        gate = (self.adjudication_gate if requested == ("MemoryAdjudicationOutput",)
                and self.adjudication_gate is not None else self.gates.get(index))
        if gate is not None:
            gate.entered.set()
            if not gate.release.wait(60):
                raise TimeoutError("合成升级模型未在时限内释放。")
        if index in self.errors:
            raise self.errors[index]
        content = str(messages[-1].content)
        if requested == ("GroundedMemoryLabels",):
            response = tool_response("GroundedMemoryLabels", {"units": self._labels(content)})
        elif requested == ("SourceVerificationOutput",):
            payload = json.loads(content)
            result_properties = kwargs["tools"][0]["function"]["parameters"]["properties"]["results"]["items"]["properties"]
            response = tool_response("SourceVerificationOutput", {"results": [
                self._verification_result(candidate, payload, nullable="proof" in result_properties)
                for candidate in payload["candidates"]
            ]})
        elif requested == ("MemoryAdjudicationOutput",):
            replaced = None
            if self.adjudication_action == "update":
                match = re.search(r"\[memory_id=([0-9a-f-]+)\]", content)
                if match is None:
                    raise AssertionError("合成更新裁决必须引用本次实际相似资料。")
                replaced = match.group(1)
            response = tool_response("MemoryAdjudicationOutput", {
                "action": self.adjudication_action, "replaced_memory_id": replaced,
            })
        else:
            raise AssertionError("升级合成模型只接受当前Grounded、独立V和裁决协议。")
        return ChatResult(generations=[ChatGeneration(message=response)])

    def _labels(self, content):
        labels = {}
        for unit, sender, raw in re.findall(
            r"^\[([0-9]+:[0-9]+)\] \[target\] sender=(contact|self) .*? 原文=(.*)$",
            content, re.MULTILINE,
        ):
            proposal = self.proposals.get(raw)
            kind = (proposal["kind"] if proposal else
                    "event" if raw in {"我刚到家。", "我刚刚到家。"} else
                    "preference" if re.fullmatch(r"我(?:平时)?喜欢[^。！？!?]+。?", raw) else "not_memory")
            labels[unit] = {
                "kind": kind, "subject": sender, "topic": "other", "dependency": None,
                "unresolved": False, "confidence": 0.95, "sensitivity": "none",
                "event": ({"stage": proposal["stage"],
                           "occurrence": unit if proposal.get("period") else None}
                          if proposal and proposal.get("stage") else None),
            }
        return labels

    @staticmethod
    def _verification_result(candidate, payload, *, nullable=False):
        source = next(message for message in payload["messages"]
                      if message["message_id"] == candidate["source_message_ids"][0])
        result = {
            "candidate_index": candidate["candidate_index"], "verdict": "supported", "issues": [],
            "evidence": [{"message_id": source["message_id"], "quote": source["text"]}],
        }
        if nullable:
            # Grounded包装原话不属于旧有限改写语法，不伪造AUTHOR_ARRIVAL_H1证明。
            result["proof"] = None
        event = candidate.get("event")
        if event:
            result["event_verification"] = {
                "stage_verdict": "supported" if event["stage"] != "unknown" else "uncertain",
                "stage_evidence": event["stage_evidence"],
                "occurrence_verdict": "supported" if event["occurrence_start"] else "uncertain",
                "occurrence_evidence": event["occurrence_evidence"],
            }
        return result


class CurrentProofBusinessFlowFixture(CoreBusinessFlowFixture):
    """仅合成事务用例显式到达自动写入门；不宣称旧全文证明或语义质量。"""

    dimension_release = DimensionRelease(gate_enabled=False)
