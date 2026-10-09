"""本人修正验收沿用正式后端；仅外部回复模型返回合成结果。"""

import json
from unittest.mock import patch

from langchain_core.messages import HumanMessage

from notalone.server.command import main
from tests.integration.server.core_business_flow_support import ScriptedCoreModel, tool_response


class MemoryContextModel(ScriptedCoreModel):
    """生成结果引用实际召回的本人资料，可从公开回复和依据核对。"""

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        payload = next(json.loads(item.content) for item in messages if isinstance(item, HumanMessage))
        memory = next(item for item in payload["evidence"] if item["kind"] == "owner_memory")
        self.responses.append(tool_response("ReplyRuntimeOutput", {
            "candidates": [{"text": memory["text"], "basis": "依据本次召回的本人资料。",
                            "citation_ids": [memory["evidence_id"]], "risk_notes": []}],
            "used_skill_version_id": None,
        }))
        return super()._generate(messages, stop, run_manager, **kwargs)


if __name__ == "__main__":
    with patch("notalone.server.reply_wiring.build_deepseek_model", return_value=MemoryContextModel()):
        raise SystemExit(main())
