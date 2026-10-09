"""只替换外部模型返回；来源、回复、依据与删除全部走生产服务和持久层。"""

import json
from unittest.mock import patch

from langchain_core.messages import HumanMessage

from notalone.server.command import main
from tests.integration.server.core_business_flow_support import ScriptedCoreModel, tool_response


class SourceDeletionModel(ScriptedCoreModel):
    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(item.content) for item in messages if isinstance(item, HumanMessage))
        evidence = payload["evidence"]
        primary = next(item for item in evidence if item["kind"] == "user_draft")
        related = next((item for item in evidence if item["kind"] == "owner_memory"), None)
        if related is None:
            related = next((item for item in evidence if item["kind"] == "message"), None)
        citations = [primary["evidence_id"]] + ([related["evidence_id"]] if related else [])
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{"text": "来源引用合成候选。", "basis": "仅引用本次实际提供的合成依据。",
                            "citation_ids": citations, "risk_notes": []}],
            "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


if __name__ == "__main__":
    with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=SourceDeletionModel()):
        raise SystemExit(main())
