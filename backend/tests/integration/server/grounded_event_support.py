"""默认生产装配共用的合成 Grounded 事件模型；不调用外部服务。"""

import json
import re

from langchain_core.outputs import ChatGeneration, ChatResult

from tests.integration.server.core_business_flow_support import ScriptedCoreModel, tool_response


class GroundedEventModel(ScriptedCoreModel):
    """仅为明确列出的合成原句提供标签，V独立返回受控裁决。"""

    proposals: dict[str, dict] = {}
    adjudication: dict[str, object] = {"action": "add", "replaced_memory_id": None}
    verify_events: bool = True
    verify_occurrence: bool = True

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        del stop, run_manager, kwargs
        self.seen_calls.append(messages)
        content = str(messages[-1].content)
        if " 原文=" in content:
            labels = {}
            for unit, sender, raw in re.findall(
                r"\[([0-9]+:[0-9]+)\] \[target\] sender=(contact|self) .*? 原文=(.*)", content,
            ):
                proposal = self.proposals.get(raw)
                labels[unit] = {
                    "kind": proposal["kind"] if proposal else "not_memory",
                    "subject": sender, "topic": "other", "dependency": None,
                    "unresolved": False, "confidence": 0.95, "sensitivity": "none",
                    "event": None if proposal is None or not proposal.get("stage") else {
                        "stage": proposal["stage"], "occurrence": unit if proposal.get("period") else None,
                    },
                }
            response = tool_response("GroundedMemoryLabels", {"units": labels})
        else:
            payload = json.loads(content)
            if "candidates" not in payload:
                response = tool_response("MemoryAdjudicationOutput", self.adjudication)
            else:
                results = []
                for candidate in payload["candidates"]:
                    message = next(row for row in payload["messages"]
                                   if row["message_id"] == candidate["source_message_ids"][0])
                    result = {"candidate_index": candidate["candidate_index"], "verdict": "supported",
                              "issues": [], "evidence": [{"message_id": message["message_id"], "quote": message["text"]}]}
                    event = candidate.get("event")
                    if self.verify_events and event:
                        result["event_verification"] = {
                            "stage_verdict": "supported" if event["stage"] != "unknown" else "uncertain",
                            "stage_evidence": event["stage_evidence"],
                            "occurrence_verdict": "supported" if event["occurrence_start"] and self.verify_occurrence else "uncertain",
                            "occurrence_evidence": event["occurrence_evidence"],
                        }
                    results.append(result)
                response = tool_response("SourceVerificationOutput", {"results": results})
        return ChatResult(generations=[ChatGeneration(message=response)])
