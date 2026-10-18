"""逐字段诊断只绑定证据，不认证模型语义或修改候选。"""
from copy import deepcopy
import unittest

from notalone.memory_extraction.evaluation_reference_field_diagnostic import (
    prepare_reference_field_diagnostic_input,
    validate_reference_field_diagnostic,
)


FIELDS = ("meaning", "subject", "category", "speech_act", "assertion_status", "figurative_type", "time", "dependency")


class ReferenceFieldDiagnosticTest(unittest.TestCase):
    def setUp(self):
        self.original = {"messages": [
            {"message_id": "context", "role": "context", "sender": "self", "text": "面试通过了吗？", "occurred_at": "2026-09-15T00:00:00+00:00"},
            {"message_id": "target", "role": "target", "sender": "contact", "text": "下周一入职。", "occurred_at": "2026-09-15T00:01:00+00:00"},
            {"message_id": "other", "role": "context", "sender": "self", "text": "还有别的事吗？", "occurred_at": "unknown"}],
            "candidates": [{"candidate_index": 0, "text": "联系人原话：“下周一入职。”", "source_message_ids": ["context", "target"],
                "subject": "contact", "category": "recent_state", "topic": "work", "speech_act": "plan", "assertion_status": "asserted", "figurative_type": "literal", "valid_at": None, "invalid_at": None}]}

    def response(self, prepared):
        evidence = {"kind": "text", "message_id": "target", "start": 0, "end": 6,
                    "quote": "下周一入职。", "value": None, "scope": "candidate_source"}
        return {"input_sha256": prepared["input_sha256"], "results": [{"candidate_index": 0,
            "fields": {field: {"state": "supported", "evidence": [deepcopy(evidence)]} for field in FIELDS}}]}

    def test_preserves_original_input_and_marks_supported_diagnostic_unverified(self):
        before = deepcopy(self.original)
        prepared = prepare_reference_field_diagnostic_input(self.original)
        self.assertEqual(prepared["input"], before)
        self.assertIsNot(prepared["input"]["candidates"], self.original["candidates"])
        output = self.response(prepared)
        result = validate_reference_field_diagnostic(prepared, output)
        self.assertEqual(result["results"][0]["diagnostic_verdict"], "supported")
        self.assertFalse(result["semantic_verified"])
        self.assertEqual(prepared["input"], before)
        self.assertEqual(self.original, before)
        self.assertNotIn("diagnostic_verdict", output["results"][0])

    def test_rejects_forged_text_scope_and_metadata_evidence(self):
        prepared = prepare_reference_field_diagnostic_input(self.original)
        for change in ({"start": True}, {"end": 99}, {"start": 4, "end": 2}, {"quote": "不存在"},
                       {"message_id": "missing"}, {"scope": "window_context"}, {"value": "unexpected"},
                       {"kind": "occurred_at", "start": None, "end": None, "quote": None, "value": "2027-01-01"},
                       {"extra": True}):
            response = self.response(prepared)
            response["results"][0]["fields"]["meaning"]["evidence"][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                validate_reference_field_diagnostic(prepared, response)
        response = self.response(prepared)
        response["results"][0]["fields"]["time"]["evidence"] = [{"kind": "occurred_at", "message_id": "other",
            "start": None, "end": None, "quote": None, "value": "unknown", "scope": "window_context"}]
        response["results"][0]["fields"]["time"]["state"] = "mismatch"
        with self.assertRaises(ValueError):
            validate_reference_field_diagnostic(prepared, response)

    def test_context_support_and_source_metadata_need_only_candidate_level_target_union(self):
        prepared = prepare_reference_field_diagnostic_input(self.original)
        response = self.response(prepared)
        response["results"][0]["fields"]["subject"]["evidence"] = [{"kind": "text", "message_id": "context",
            "start": 0, "end": 2, "quote": "面试", "value": None, "scope": "candidate_source"}]
        response["results"][0]["fields"]["time"]["evidence"] = [{"kind": "occurred_at", "message_id": "context",
            "start": None, "end": None, "quote": None, "value": "2026-09-15T00:00:00+00:00", "scope": "candidate_source"}]
        response["results"][0]["fields"]["time"]["evidence"].extend(deepcopy(response["results"][0]["fields"]["subject"]["evidence"]))
        result = validate_reference_field_diagnostic(prepared, response)
        self.assertEqual(result["results"][0]["diagnostic_verdict"], "supported")
        self.assertFalse(result["semantic_verified"])
        for field in response["results"][0]["fields"].values():
            field["evidence"] = deepcopy(response["results"][0]["fields"]["subject"]["evidence"])
        with self.assertRaises(ValueError):
            validate_reference_field_diagnostic(prepared, response)

    def test_context_counterevidence_is_not_added_to_candidate_sources(self):
        prepared = prepare_reference_field_diagnostic_input(self.original)
        response = self.response(prepared)
        response["results"][0]["fields"]["dependency"] = {"state": "mismatch", "evidence": [
            {"kind": "text", "message_id": "other", "start": 0, "end": 2, "quote": "还有", "value": None, "scope": "window_context"}]}
        result = validate_reference_field_diagnostic(prepared, response)
        self.assertEqual(result["results"][0]["diagnostic_verdict"], "unsupported")
        self.assertFalse(result["semantic_verified"])
        self.assertEqual(prepared["input"]["candidates"][0]["source_message_ids"], ["context", "target"])
        response["results"][0]["fields"]["dependency"]["state"] = "supported"
        with self.assertRaises(ValueError):
            validate_reference_field_diagnostic(prepared, response)

    def test_contract_reuses_semantics_but_replaces_legacy_output(self):
        from notalone.memory_extraction.evaluation_reference_field_diagnostic import reference_field_diagnostic_contract
        from notalone.memory_extraction.verification_adapters import source_verification_contract, REFERENCE_RETENTION_PROFILE
        prepared = prepare_reference_field_diagnostic_input(self.original)
        prompt, schema = reference_field_diagnostic_contract(prepared)
        baseline, _ = source_verification_contract("legacy-v4", prompt_profile=REFERENCE_RETENTION_PROFILE)
        self.assertTrue(prompt.startswith(baseline))
        self.assertEqual(prompt[:len(baseline)], baseline)
        self.assertIn("替换旧四槽输出合同", prompt)
        self.assertIn("诊断", prompt)
        self.assertEqual(set(schema["required"]), {"input_sha256", "results"})
        self.assertFalse(schema["additionalProperties"])
        row = schema["properties"]["results"]["items"]
        self.assertEqual(set(row["required"]), {"candidate_index", "fields"})
        self.assertFalse(row["additionalProperties"])
        fields = row["properties"]["fields"]
        self.assertEqual(set(fields["required"]), set(FIELDS))
        self.assertFalse(fields["additionalProperties"])
        for field in fields["properties"].values():
            self.assertFalse(field["additionalProperties"])
            evidence = field["properties"]["evidence"]
            self.assertEqual(evidence["maxItems"], 4)
            self.assertFalse(evidence["items"]["additionalProperties"])
        with self.assertRaises(ValueError):
            validate_reference_field_diagnostic(prepared, {"input_sha256": prepared["input_sha256"], "results": [
                {"candidate_index": 0, "verdict": "supported", "issues": [], "evidence": []}]})

    def test_bad_coverage_digest_and_extra_fields_fail_closed(self):
        prepared = prepare_reference_field_diagnostic_input(self.original)
        mutations = [lambda r: r.update(input_sha256="0" * 64), lambda r: r.update(verdict="supported"),
            lambda r: r.update(results=[]), lambda r: r["results"].append(deepcopy(r["results"][0])),
            lambda r: r["results"][0].update(candidate_index=True), lambda r: r["results"][0].update(candidate_index=1),
            lambda r: r["results"][0]["fields"].pop("time"), lambda r: r["results"][0]["fields"].update(topic={}),
            lambda r: r["results"][0]["fields"]["time"].update(state="wrong"),
            lambda r: r["results"][0]["fields"]["time"].update(evidence=[]),
            lambda r: r["results"][0]["fields"]["time"].update(state="mismatch", evidence=[]),
            lambda r: r["results"][0]["fields"]["time"].update(evidence=r["results"][0]["fields"]["time"]["evidence"]*5)]
        for index, mutate in enumerate(mutations):
            response = self.response(prepared)
            mutate(response)
            with self.subTest(index=index), self.assertRaises(ValueError):
                validate_reference_field_diagnostic(prepared, response)
        prepared["input"]["candidates"][0]["text"] = "改写"
        with self.assertRaises(ValueError):
            validate_reference_field_diagnostic(prepared, self.response(prepared))

    def test_duplicate_json_keys_and_input_aliases_are_rejected(self):
        import json
        with self.assertRaises(ValueError):
            prepare_reference_field_diagnostic_input('{"messages":[],"messages":[],"candidates":[]}')
        prepared = prepare_reference_field_diagnostic_input(self.original)
        encoded = json.dumps(self.response(prepared)).replace('"state": "supported"', '"state": "supported", "state": "supported"', 1)
        with self.assertRaises(ValueError):
            validate_reference_field_diagnostic(prepared, encoded)
        for change in ("message", "index", "source", "extra"):
            original = deepcopy(self.original)
            if change == "message":
                original["messages"][1]["message_id"] = "context"
            elif change == "index":
                original["candidates"][0]["candidate_index"] = True
            elif change == "source":
                original["candidates"][0]["source_message_ids"] = ["absent"]
            else:
                original["verdict"] = "supported"
            with self.subTest(change=change), self.assertRaises(ValueError):
                prepare_reference_field_diagnostic_input(original)

    def test_aggregation_and_unicode_spans_do_not_certify_semantics(self):
        self.original["messages"][1]["text"] = "🙂入职"
        prepared = prepare_reference_field_diagnostic_input(self.original)
        for state, verdict in (("insufficient", "uncertain"), ("ambiguous", "uncertain"), ("mismatch", "unsupported")):
            response = self.response(prepared)
            for field in response["results"][0]["fields"].values():
                field["evidence"][0].update(start=0, end=1, quote="🙂")
            response["results"][0]["fields"]["meaning"] = {"state": "ambiguous", "evidence": []}
            response["results"][0]["fields"]["time"] = {"state": state, "evidence": [] if state != "mismatch" else deepcopy(response["results"][0]["fields"]["category"]["evidence"])}
            result = validate_reference_field_diagnostic(prepared, response)
            self.assertEqual(result["results"][0]["diagnostic_verdict"], verdict)
            self.assertFalse(result["semantic_verified"])

    def test_timestamps_cannot_replace_text_or_target_coverage(self):
        prepared = prepare_reference_field_diagnostic_input(self.original)
        metadata = {"kind": "occurred_at", "message_id": "target", "start": None, "end": None, "quote": None,
                    "value": "2026-09-15T00:01:00+00:00", "scope": "candidate_source"}
        for name in FIELDS:
            response = self.response(prepared)
            response["results"][0]["fields"][name]["evidence"] = [deepcopy(metadata)]
            with self.subTest(field=name), self.assertRaises(ValueError):
                validate_reference_field_diagnostic(prepared, response)
        response = self.response(prepared)
        for field in response["results"][0]["fields"].values():
            field["evidence"] = [{"kind": "text", "message_id": "context", "start": 0, "end": 2,
                                  "quote": "面试", "value": None, "scope": "candidate_source"}]
        response["results"][0]["fields"]["time"]["evidence"].append(metadata)
        with self.assertRaises(ValueError):
            validate_reference_field_diagnostic(prepared, response)

    def test_two_candidates_need_unique_complete_indices_and_json_preserves_digest(self):
        import json
        self.original["candidates"].append({**deepcopy(self.original["candidates"][0]), "candidate_index": 1})
        prepared = prepare_reference_field_diagnostic_input(self.original)
        self.assertEqual(prepared, prepare_reference_field_diagnostic_input(json.dumps(self.original)))
        response = self.response(prepared)
        response["results"].append({**deepcopy(response["results"][0]), "candidate_index": 1})
        result = validate_reference_field_diagnostic(prepared, json.dumps(response))
        self.assertEqual([row["candidate_index"] for row in result["results"]], [0, 1])
        response["results"][1]["candidate_index"] = 0
        with self.assertRaises(ValueError):
            validate_reference_field_diagnostic(prepared, response)

    def test_window_context_cannot_claim_original_source_membership(self):
        prepared = prepare_reference_field_diagnostic_input(self.original)
        response = self.response(prepared)
        response["results"][0]["fields"]["dependency"] = {"state": "mismatch", "evidence": [
            {"kind": "text", "message_id": "other", "start": 0, "end": 2, "quote": "还有", "value": None, "scope": "candidate_source"}]}
        with self.assertRaises(ValueError):
            validate_reference_field_diagnostic(prepared, response)

    def test_missing_axis_input_or_target_context_cannot_be_diagnosed(self):
        for field in ("text", "subject", "category", "speech_act", "assertion_status", "figurative_type", "valid_at", "invalid_at"):
            original = deepcopy(self.original)
            original["candidates"][0].pop(field)
            with self.subTest(missing=field), self.assertRaises(ValueError):
                prepare_reference_field_diagnostic_input(original)
        mutations = [lambda v: v["candidates"][0].update(text=""),
            lambda v: v["candidates"][0].update(category=1), lambda v: v["candidates"][0].update(valid_at=True),
            lambda v: v["messages"][1].update(role="context"), lambda v: v["messages"][0].update(sender="third_party"),
            lambda v: v["messages"][0].update(occurred_at=None),
            lambda v: v["candidates"][0].update(source_message_ids=["context"])]
        for index, mutate in enumerate(mutations):
            original = deepcopy(self.original)
            mutate(original)
            with self.subTest(index=index), self.assertRaises(ValueError):
                prepare_reference_field_diagnostic_input(original)

    def test_time_metadata_is_auxiliary_in_every_state(self):
        prepared = prepare_reference_field_diagnostic_input(self.original)
        metadata = {"kind": "occurred_at", "message_id": "target", "start": None, "end": None, "quote": None,
                    "value": "2026-09-15T00:01:00+00:00", "scope": "candidate_source"}
        for state in ("mismatch", "insufficient", "ambiguous"):
            response = self.response(prepared)
            text = deepcopy(response["results"][0]["fields"]["time"]["evidence"][0])
            response["results"][0]["fields"]["time"] = {"state": state, "evidence": [deepcopy(metadata)]}
            with self.subTest(state=state), self.assertRaises(ValueError):
                validate_reference_field_diagnostic(prepared, response)
            response["results"][0]["fields"]["time"]["evidence"].append(text)
            result = validate_reference_field_diagnostic(prepared, response)
            self.assertEqual(result["results"][0]["diagnostic_verdict"], "unsupported" if state == "mismatch" else "uncertain")
            self.assertFalse(result["semantic_verified"])
            if state != "mismatch":
                response["results"][0]["fields"]["time"]["evidence"] = []
                self.assertEqual(validate_reference_field_diagnostic(prepared, response)["results"][0]["diagnostic_verdict"], "uncertain")
