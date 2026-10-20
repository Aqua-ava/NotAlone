"""现行直接提取与显式历史 Grounded 夹具共用的合成事件模型；不调用外部服务。"""

import json
import re
from datetime import datetime, timedelta, timezone

from langchain_core.outputs import ChatGeneration, ChatResult

from tests.integration.server.core_business_flow_support import ScriptedCoreModel, tool_response


class GroundedEventModel(ScriptedCoreModel):
    """仅为明确列出的合成原句提供标签，V独立返回受控裁决。"""

    proposals: dict[str, dict] = {}
    adjudication: dict[str, object] = {"action": "add", "replaced_memory_id": None}
    verify_events: bool = True
    verify_occurrence: bool = True

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        del stop, run_manager
        names = [item.get('function', {}).get('name') for item in kwargs.get('tools', [])]
        self.seen_calls.append(messages)
        content = str(messages[-1].content)
        if names == ['DirectMemoryExtractionOutput']:
            response = self._direct_response(content)
        elif names == ['BatchMemoryAdjudicationOutput']:
            response = tool_response('BatchMemoryAdjudicationOutput', {'decisions': [
                {**self.adjudication, 'candidate_index': item['candidate_index']}
                for item in json.loads(content)]})
        elif " 原文=" in content:
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

    def _direct_response(self, content):
        """只为列明原句构造完整合成记忆；日期来自本夹具明确的今天/明天文本。"""
        facts = []
        for identifier, occurred_at, sender, raw in re.findall(
                r"\[target\] \[message_id=([^]]+)\] occurred_at=(\S+) sender=(contact|self): (.*)", content):
            proposal = self.proposals.get(raw)
            if proposal is None:
                continue
            kind = proposal['kind']
            event = None
            if proposal.get('stage'):
                position = {'message_id': identifier, 'char_start': 0, 'char_end': len(raw)}
                start = end = None
                if proposal.get('period'):
                    if not ('今天' in raw or '明天' in raw):
                        raise AssertionError('合成直接事件必须明确今天或明天，不推断未知日期。')
                    day = datetime.fromisoformat(occurred_at).astimezone(timezone(timedelta(hours=8))).replace(
                        hour=0, minute=0, second=0, microsecond=0)
                    if '明天' in raw:
                        day += timedelta(days=1)
                    start, end = day.isoformat(), (day + timedelta(days=1)).isoformat()
                event = {'version': 1, 'stage': proposal['stage'], 'stage_evidence': [position],
                         'occurrence_start': start, 'occurrence_end': end,
                         'occurrence_evidence': [position] if start else []}
            facts.append({'text': ('联系人' if sender == 'contact' else '本人') + '原话：“' + raw + '”',
                'category': 'preference' if kind == 'preference' else 'relationship_note',
                'subject': sender, 'topic': 'other', 'source_message_ids': [identifier],
                'confidence': 0.95, 'risk_flags': [], 'valid_at': None, 'invalid_at': None,
                'speech_act': 'plan' if kind == 'plan' else 'assertion', 'assertion_status': 'asserted',
                'figurative_type': 'literal', 'alternatives': [], 'interpretation_reason': '合成来源中的完整陈述。',
                'event': event})
        return tool_response('DirectMemoryExtractionOutput', {'scenes': [{'scene_name': '合成事件', 'memories': facts}]})
