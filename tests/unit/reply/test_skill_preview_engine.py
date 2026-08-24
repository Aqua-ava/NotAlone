"""Skill 试用执行器的公共 seam 单元测试。

使用假 Runtime 和合成数据，验证强制单 Skill、回退与范围校验。
"""

from __future__ import annotations

import unittest
from typing import Any
from uuid import UUID

from notalone.reply.adapters.skill_preview import (
    ReplySkillPreviewEngine,
    SingleSkillCatalogPort,
)
from notalone.reply.context import (
    ContextEvidence,
    ReplyContext,
)
from notalone.reply.interface import (
    ConfirmedDirection,
    DirectionSource,
    GenerateReply,
    ReplyToMessage,
    SkillUse,
)
from notalone.reply.runtime import (
    ReplyRuntimeResult,
    RuntimeCandidate,
)
from notalone.reply.errors import ReplyInvariantError
from notalone.scopes import ContactScope
from notalone.skills import (
    SkillCatalog,
    SkillCatalogEntry,
    SkillPreview,
)


OWNER_ID = UUID("aaaaaaaa-1111-1111-1111-111111111111")
CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-222222222222")
OTHER_CONTACT_ID = UUID("bbbbbbbb-2222-2222-2222-333333333333")
MESSAGE_ID = UUID("dddddddd-4444-4444-4444-444444444444")
REQUEST_ID = UUID("ffffffff-6666-6666-6666-666666666666")
SKILL_ID = UUID("22222222-8888-8888-8888-888888888888")
VERSION_ID = UUID("33333333-9999-9999-9999-999999999999")


class RecordingRuntime:
    """记录用到的 SkillPort 与上下文，并返回合成运行结果。"""

    def __init__(
        self,
        *,
        used_skill: SkillUse | None,
        context: ReplyContext,
    ) -> None:
        self.used_skill = used_skill
        self.prepared = context
        self.seen_catalog: SkillCatalog | None = None

    def generate(self, context: ReplyContext) -> ReplyRuntimeResult:
        if context.scope != self.prepared.scope:
            raise ReplyInvariantError("synthetic scope mismatch")
        self.seen_catalog = getattr(self, "port", None).catalog(context.scope)
        candidates = (
            RuntimeCandidate(
                text="可以呀，明天见。",
                basis="合成预览",
                citation_ids=(MESSAGE_ID,),
                risk_notes=("请核实时间。",),
            ),
        )
        return ReplyRuntimeResult(
            candidates=candidates,
            used_skill=self.used_skill,
        )


class RecordingRuntimeFactory:
    def __init__(
        self,
        *,
        used_skill: SkillUse | None,
        context: ReplyContext,
    ) -> None:
        self.used_skill = used_skill
        self.context = context
        self.created_runtime: RecordingRuntime | None = None

    def __call__(self, port: Any) -> RecordingRuntime:
        runtime = RecordingRuntime(
            used_skill=self.used_skill,
            context=self.context,
        )
        runtime.port = port
        self.created_runtime = runtime
        return runtime


class NoopSkillPort:
    """预览引擎只要求底层 Port 在 load 时可用；目录由 SingleSkillCatalogPort 提供。"""

    def catalog(self, scope: ContactScope) -> SkillCatalog:
        del scope
        raise AssertionError("preview must not load the full catalog")

    def load_version(self, scope: ContactScope, version_id: UUID):
        del scope, version_id
        return None

    def load_resource(self, scope: ContactScope, version_id: UUID, relative_path: str):
        del scope, version_id, relative_path
        return None


class ReplySkillPreviewEngineTest(unittest.TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(OWNER_ID, CONTACT_ID)
        self.direction = ConfirmedDirection(
            text="温和地答应",
            source=DirectionSource.DIRECT_INPUT,
        )
        self.command = GenerateReply(
            idempotency_key=REQUEST_ID,
            scope=self.scope,
            conversation_binding_id=UUID(
                "cccccccc-3333-3333-3333-333333333333"
            ),
            content=ReplyToMessage(MESSAGE_ID, self.direction),
        )
        self.context = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=self.command,
            scope=self.scope,
            current_text="明天一起吃饭吗？",
            direction=self.direction,
            evidence=(
                ContextEvidence(
                    evidence_id=MESSAGE_ID,
                    kind="message",
                    text="明天一起吃饭吗？",
                    scope=self.scope,
                ),
            ),
            skill_library_revision=3,
        )

    def _entry(self) -> SkillCatalogEntry:
        return SkillCatalogEntry(
            skill_id=SKILL_ID,
            version_id=VERSION_ID,
            name="warm-reply",
            description="温和回应",
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
        )

    def test_engine_forces_single_skill_catalog_and_maps_preview(self) -> None:
        catalog = SkillCatalog(self.scope, 3, (self._entry(),))
        used_skill = SkillUse(
            skill_id=SKILL_ID,
            version_id=VERSION_ID,
            name="warm-reply",
            selection_method="user",
            selection_reason="用户指定 Skill 试用。",
            resource_paths=("references/cases.md",),
            load_state="loaded",
        )
        factory = RecordingRuntimeFactory(
            used_skill=used_skill,
            context=self.context,
        )
        engine = ReplySkillPreviewEngine(
            port=NoopSkillPort(),
            runtime_factory=factory,
        )

        preview = engine.generate(
            scope=self.scope,
            context=self.context,
            catalog=catalog,
        )

        self.assertIsNotNone(factory.created_runtime)
        self.assertEqual(
            factory.created_runtime.seen_catalog,
            catalog,
        )
        self.assertIsInstance(preview, SkillPreview)
        self.assertEqual(preview.skill_id, SKILL_ID)
        self.assertEqual(preview.name, "warm-reply")
        self.assertEqual(
            preview.resource_paths,
            ("references/cases.md",),
        )
        self.assertEqual(preview.load_state, "loaded")
        self.assertEqual(preview.candidates[0].text, "可以呀，明天见。")
        self.assertEqual(
            preview.selection_reason,
            "用户指定 Skill 试用。",
        )

    def test_engine_maps_no_skill_fallback_with_candidates(self) -> None:
        catalog = SkillCatalog(self.scope, 3, (self._entry(),))
        factory = RecordingRuntimeFactory(
            used_skill=None,
            context=self.context,
        )
        engine = ReplySkillPreviewEngine(
            port=NoopSkillPort(),
            runtime_factory=factory,
        )

        preview = engine.generate(
            scope=self.scope,
            context=self.context,
            catalog=catalog,
        )

        self.assertEqual(preview.load_state, "not_used")
        self.assertEqual(preview.skill_id, None)
        self.assertTrue(preview.fallback_reason)
        self.assertEqual(preview.candidates[0].text, "可以呀，明天见。")

    def test_engine_rejects_out_of_scope_context_or_catalog(self) -> None:
        other_scope = ContactScope(OWNER_ID, OTHER_CONTACT_ID)
        engine = ReplySkillPreviewEngine(
            port=NoopSkillPort(),
            runtime_factory=lambda port: RecordingRuntime(
                used_skill=None,
                context=self.context,
            ),
        )
        catalog = SkillCatalog(self.scope, 3, (self._entry(),))
        with self.assertRaises(ReplyInvariantError):
            engine.generate(
                scope=self.scope,
                context=self.context,
                catalog=SkillCatalog(other_scope, 3, ()),
            )
        other_context = ReplyContext(
            reply_request_id=REQUEST_ID,
            command=self.command,
            scope=other_scope,
            current_text="合成",
            direction=self.direction,
            evidence=(
                ContextEvidence(
                    MESSAGE_ID,
                    "message",
                    "合成",
                    other_scope,
                ),
            ),
            skill_library_revision=3,
        )
        with self.assertRaises(ReplyInvariantError):
            engine.generate(
                scope=self.scope,
                context=other_context,
                catalog=catalog,
            )


if __name__ == "__main__":
    unittest.main()
