"""E2完整作者引句只补未解角色说明；给定响应不认证模型质量。"""

from __future__ import annotations

from contextlib import ExitStack
from copy import deepcopy
from dataclasses import replace
import json
import os
import socket
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx

from notalone.memory.adapters import InMemoryMemoryStore
from notalone.memory_extraction.command import run_extraction
from notalone.memory_extraction.grounded import (
    compile_draft, compile_labels, compile_labels_v3, compile_labels_v4, source_units,
)
from notalone.memory_extraction.grounded_adapter import GroundedV2ExtractionRuntime
from notalone.memory_extraction.models import MessageSender
from notalone.memory_extraction.source_proof import unresolved_author_quote_note
from notalone.memory_trace.adapters import InMemoryTraceStore
from notalone.memory_trace.transport import build_trace_http_client
from notalone.reply.adapters.deepseek_provider import build_deepseek_model
from notalone.scopes import ContactScope
from tests.unit.memory_extraction.test_grounded_extraction import row, window
from tests.unit.memory_extraction.test_grounded_v3 import labels
from tests.unit.memory_extraction.test_grounded_v3_runtime import response


OWNER_NOTE = "原句中的物品所有者在本窗口无法唯一确定；不因出借或接收认定所有者，保留原句。"
BENEFICIARY_NOTE = "原句中顶班事项的受益人在本窗口无法唯一确定；不因提出请托认定受益人，不补接受或履行，保留原句。"
GENERIC_NOTE = "原文指代在本窗口无法唯一确定，保留原句。"


class GroundedQuoteAlternativesTest(unittest.TestCase):
    def setUp(self) -> None:
        guards = ExitStack()
        self.addCleanup(guards.close)
        guards.enter_context(patch.dict(os.environ, {"NOTALONE_DISABLE_DOTENV": "1"}, clear=True))
        for owner, name in ((socket.socket, "connect"), (socket.socket, "connect_ex"),
                            (socket, "getaddrinfo")):
            guards.enter_context(patch.object(owner, name, side_effect=AssertionError("禁止真实网络")))

    def test_completed_lending_explains_unknown_owner_without_replacing_model_labels(self) -> None:
        source = window("我姐把她的车借给我了。")
        for unresolved in (False, True):
            with self.subTest(unresolved=unresolved):
                draft = labels(row("0:0", "relationship_event", unresolved=unresolved))
                original = deepcopy(draft)
                fact, = compile_labels(source, draft)
                self.assertEqual(fact["alternatives"],
                                 ([GENERIC_NOTE] if unresolved else []) + [OWNER_NOTE])
                self.assertEqual(draft, original)
                self.assertEqual((fact["text"], fact["subject"], fact["speech_act"],
                                  fact["assertion_status"], fact["valid_at"], fact["invalid_at"]),
                                 ("联系人原话：“我姐把她的车借给我了。”", "contact", "assertion",
                                  "asserted", None, None))

    def test_received_request_explains_unknown_beneficiary_without_inventing_acceptance(self) -> None:
        source = window("我同事让我周末帮他顶个班。")
        source = replace(source, messages=(replace(source.messages[0], sender=MessageSender.SELF),))
        for unresolved in (False, True):
            with self.subTest(unresolved=unresolved):
                draft = labels(row("0:0", "relationship_event", subject="self", unresolved=unresolved))
                original = deepcopy(draft)
                fact, = compile_labels(source, draft)
                self.assertEqual(fact["alternatives"],
                                 ([GENERIC_NOTE] if unresolved else []) + [BENEFICIARY_NOTE])
                self.assertEqual(draft, original)
                self.assertEqual((fact["text"], fact["subject"], fact["speech_act"],
                                  fact["assertion_status"], fact["valid_at"], fact["invalid_at"]),
                                 ("用户原话：“我同事让我周末帮他顶个班。”", "self", "assertion",
                                  "asserted", None, None))

    def test_sdk_e2_compilation_keeps_schema_and_explains_only_the_missing_role(self) -> None:
        for text, sender, note in (
            ("我姐把她的书借给我了。", MessageSender.CONTACT, OWNER_NOTE),
            ("我哥让我明天帮他顶个班。", MessageSender.SELF, BENEFICIARY_NOTE),
        ):
            with self.subTest(text=text):
                source = window(text)
                source = replace(source, messages=(replace(source.messages[0], sender=sender),))
                draft = labels(row("0:0", "relationship_event", subject=sender.value))
                original = deepcopy(draft)
                requests: list[dict] = []
                traces = InMemoryTraceStore()
                scope = ContactScope(source.owner_id, source.contact_id)

                def handler(request: httpx.Request) -> httpx.Response:
                    requests.append(json.loads(request.content))
                    return response(draft, name="GroundedMemoryLabels")

                with build_trace_http_client(transport=httpx.MockTransport(handler)) as client:
                    model = build_deepseek_model(api_key="synthetic-secret", base_url="http://127.0.0.1/v1",
                                                 http_client=client)
                    stats = run_extraction(
                        scope=scope, messages=source.messages, watermark_message_id=None,
                        runtime=GroundedV2ExtractionRuntime(model=model), memory_port=InMemoryMemoryStore(),
                        owner_memory_port=None, trace_store=traces,
                    )
                detail = traces.get_batch(scope, traces.list_batches(scope)[0]["trace_id"])
                events = {event["stage"]: event["payload"] for event in detail["events"]}
                fact, = events["grounded_compile"]["payloads"]
                self.assertEqual(fact["alternatives"], [note])
                self.assertEqual(events["grounded_draft"]["draft"], original)
                self.assertEqual(draft, original)
                self.assertEqual((stats.adopted, stats.pending), (0, 1))
                self.assertEqual(len(requests), 1)
                slot = requests[0]["tools"][0]["function"]["parameters"]["properties"]["units"]["properties"]["0:0"]
                self.assertEqual(set(slot["properties"]),
                                 {"kind", "subject", "topic", "dependency", "unresolved", "confidence", "sensitivity"})

    def test_parameter_variants_only_append_the_matching_role_note(self) -> None:
        controls = [
            (sender, f"{relative}{time}把{pronoun}的{item}借给我了。", OWNER_NOTE)
            for sender in (MessageSender.SELF, MessageSender.CONTACT)
            for relative, pronoun in (("我姐", "她"), ("我哥", "他"))
            for item in ("车", "书", "雨伞") for time in ("", "昨天", "前天")
        ]
        controls += [(MessageSender.CONTACT, "我姐昨天没有把她的书借给我。", OWNER_NOTE),
                     (MessageSender.SELF, "我哥前天没把他的雨伞借给我。", OWNER_NOTE)]
        controls += [(MessageSender.SELF, f"{relative}让我{time}帮{pronoun}顶个班。", BENEFICIARY_NOTE)
                     for relative, pronoun in (("我姐", "她"), ("我哥", "他"), ("我同事", "他"))
                     for time in ("周末", "明天", "后天")]
        for sender, text, note in controls:
            for unresolved in (False, True):
                with self.subTest(sender=sender, text=text, unresolved=unresolved):
                    source = window(text)
                    source = replace(source, messages=(replace(source.messages[0], sender=sender),))
                    item = row("0:0", "relationship_event", subject=sender.value,
                               unresolved=unresolved, confidence=0.73, sensitivity="health")
                    baseline, = compile_draft(source, {"units": [item]})
                    self.assertEqual(baseline["alternatives"], [GENERIC_NOTE] if unresolved else [])
                    fact, = compile_labels(source, labels(item))
                    self.assertEqual(fact, {**baseline, "alternatives": baseline["alternatives"] + [note]})

    def test_partial_quotes_extra_context_and_observation_prefix_are_outside_compiler_scope(self) -> None:
        for text, kind, sender, extra in (
            ("我姐把她的书借给我了。这里的“她”指我姐。", "relationship_event", MessageSender.CONTACT, False),
            ("我姐把她的书借给我了。还有其他事情。", "relationship_event", MessageSender.CONTACT, False),
            ("我哥把他的雨伞借给我了。", "relationship_event", MessageSender.CONTACT, True),
            ("我同事让我明天帮他顶个班。", "request", MessageSender.SELF, False),
            ("我同事让我明天帮他顶个班。", "relationship_event", MessageSender.CONTACT, False),
            ("我姐明天把她的车借给我。", "relationship_event", MessageSender.CONTACT, False),
            ("我哥把我姐的雨伞借给我了。", "relationship_event", MessageSender.CONTACT, False),
            ("老李借我钱了。", "relationship_event", MessageSender.CONTACT, False),
        ):
            with self.subTest(text=text, kind=kind, sender=sender, extra=extra):
                source = window(text)
                message = replace(source.messages[0], sender=sender)
                source = replace(source, messages=(message,))
                if extra:
                    source = replace(source, messages=(replace(message, message_id=uuid4(), text="另一个话题。"), message))
                items = [row(unit.id, kind, subject=sender.value, unresolved=True)
                         for unit in source_units(source) if unit.target]
                facts = compile_labels(source, labels(*items))
                self.assertTrue(facts)
                self.assertTrue(all(fact["alternatives"] == [GENERIC_NOTE] for fact in facts))

    def test_note_requires_actual_author_full_quote_target_and_unique_source(self) -> None:
        source = window("我姐把她的车借给我了。")
        message = source.messages[0]
        quote = "联系人原话：“" + message.text + "”"
        controls = [
            (source, "用户原话：“" + message.text + "”", (message.message_id,)),
            (source, "联系人原话：“她的车”", (message.message_id,)),
            (source, quote + "还有其他事情。", (message.message_id,)),
            (source, "截至2026-10-14，" + quote, (message.message_id,)),
            (source, quote, ()),
            (source, quote, (uuid4(),)),
            (source, quote, (message.message_id, message.message_id)),
            (source, quote, (message.message_id, uuid4())),
            (replace(source, messages=(message, replace(message, message_id=uuid4()))), quote, (message.message_id,)),
        ]
        for text in (
            "我姐把她的车借给我了。这里的“她”指我姐。",
            "我同事让我周末帮他顶个班。这里的“他”指我同事。",
        ):
            known = replace(message, text=text, sender=MessageSender.SELF)
            controls.append((replace(source, messages=(known,)), "用户原话：“" + text + "”", (known.message_id,)))
        for actual, text, sources in controls:
            with self.subTest(text=text, sources=sources):
                self.assertIsNone(unresolved_author_quote_note(actual, text, sources))

    def test_v1_v3_v4_keep_their_original_compilation_without_e2_role_notes(self) -> None:
        for text, sender in (("我姐把她的车借给我了。", MessageSender.CONTACT),
                             ("我哥让我后天帮他顶个班。", MessageSender.SELF)):
            for unresolved in (False, True):
                with self.subTest(text=text, unresolved=unresolved):
                    source = window(text)
                    source = replace(source, messages=(replace(source.messages[0], sender=sender),))
                    item = row("0:0", "relationship_event", subject=sender.value, unresolved=unresolved)
                    legacy, = compile_draft(source, {"units": [item]})
                    self.assertEqual(legacy["alternatives"], [GENERIC_NOTE] if unresolved else [])
                    typed = labels({**item, "ambiguity_codes": ["other_unresolved"] if unresolved else []})
                    for compiler in (compile_labels_v3, compile_labels_v4):
                        typed_fact, = compiler(source, typed)
                        self.assertEqual(typed_fact["alternatives"],
                                         ["原句在本窗口仍有其他未决解释，保留原句。"] if unresolved else [])
