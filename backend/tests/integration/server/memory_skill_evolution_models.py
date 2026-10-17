"""同源组合仅替换模型边界，保留生产 Grounded 编译与独立核验。"""

from copy import deepcopy

from langchain_core.outputs import ChatGeneration, ChatResult

from tests.integration.server.core_business_flow_support import tool_response
from tests.integration.server.grounded_upgrade_support import GroundedUpgradeModel


class EvolutionMemoryModel(GroundedUpgradeModel):
    """工具身份取本次冻结参数；学习提案与原文标签使用独立队列。"""

    learning_proposals: list[dict] = []
    started_calls: int = 0
    model_call_limit: int = 64
    learning_failures_remaining: int = 0

    def __init__(self):
        super().__init__()
        self.proposals = {}
        self.learning_proposals = []
        self.started_calls = 0
        self.learning_failures_remaining = 0

    def _generate(self, messages, stop=None, run_manager=None, **kwargs):
        with self.call_lock:
            if self.started_calls >= self.model_call_limit:
                raise AssertionError("同源组合模型达到显式调用上限。")
            self.started_calls += 1
        requested = tuple(tool["function"]["name"] for tool in kwargs.get("tools", ()))
        if requested != ("SkillLearningProposal",):
            return super()._generate(messages, stop, run_manager, **kwargs)

        self.wait_for_response()
        with self.call_lock:
            self.seen_calls.append(messages)
            self.requested_tools.append(requested)
            self.record_model_payload(messages, deepcopy(kwargs))
            if self.learning_failures_remaining:
                self.learning_failures_remaining -= 1
                raise RuntimeError("合成学习供应商暂时失败。")
            if not self.learning_proposals:
                raise AssertionError("组合学习没有已准备的合成提案，禁止额外调用。")
            proposal = self.learning_proposals.pop(0)
        return ChatResult(generations=[ChatGeneration(
            message=tool_response("SkillLearningProposal", proposal),
        )])
