"""单次Fake V与真实grounded编译/producer，供隔离来源链控制复用。"""
from notalone.memory_extraction.flow import ExtractionFlow
from notalone.memory_extraction.grounded import compile_labels_v3, source_units
from notalone.memory_extraction.verification_adapters import LangChainSourceVerificationRuntime
from tests.unit.memory_extraction.test_author_quote_proof import quote_proposal_payload
from tests.unit.memory_extraction.test_flow import RecordingRuntime
from tests.unit.memory_extraction.test_verification_adapters import structured_verification
from tests.unit.memory_extraction.verification_helpers import verification_result
from tests.unit.reply.test_langchain_vertical_slice import ToolCallingFakeModel


class ProofRecordingModel(ToolCallingFakeModel):
    seen_schemas: list[dict] = []

    def bind_tools(self, tools, **kwargs):
        self.seen_schemas = tools
        return super().bind_tools(tools, **kwargs)


def author_quote_producer(window, *, proof="complete", mode="nullable-proof-v2", confidence=.92,
                          sensitivity="none", verdict="supported", issues=()):
    message, = (message for message in window.messages if message.message_id in window.target_message_id_set)
    unit, = (unit for unit in source_units(window) if unit.target)
    compiled = compile_labels_v3(window, {"units": {unit.id: {
        "kind": "event", "subject": message.sender.value, "topic": "other", "dependency": None,
        "unresolved": False, "confidence": confidence, "sensitivity": sensitivity, "ambiguity_codes": [],
    }}})
    payload, = compiled
    proposed = quote_proposal_payload(message.text, payload["text"], message.message_id) if proof == "complete" else proof
    raw = verification_result(evidence=((message.message_id, message.text),), verdict=verdict, issues=issues)
    if proof != "omitted":
        raw["proof"] = proposed
    model = ProofRecordingModel(responses=[structured_verification((raw,))])
    verifier = LangChainSourceVerificationRuntime(model=model, verification_mode=mode)
    outcome = ExtractionFlow(runtime=RecordingRuntime(compiled), verification_runtime=verifier).run(window)
    return outcome, model, raw
