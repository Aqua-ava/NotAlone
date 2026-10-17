"""Skill 试用的应用层执行器：强制一个指定 Skill 并生成应用内候选预览。

预览只经过 SkillPort 与 Reply Runtime，不持久化、不写记忆、不发送消息。
"""

from __future__ import annotations

from typing import Callable
from uuid import UUID

from notalone.reply.context import ReplyContext
from notalone.reply.errors import ReplyInvariantError
from notalone.reply.runtime import (
    ReplyRuntime,
    ReplyRuntimeResult,
)
from notalone.scopes import ContactScope
from notalone.skills import (
    PreviewCandidate,
    SkillCatalog,
    SkillPort,
    SkillPreview,
    SkillResource,
    SkillVersion,
)


class SingleSkillCatalogPort:
    """只把本次指定 Skill 的单一目录暴露给运行时；读数仍受控委托底层 Port。"""

    __slots__ = ("_port", "_scope", "_catalog")

    def __init__(
        self,
        *,
        port: SkillPort,
        scope: ContactScope,
        catalog: SkillCatalog,
    ) -> None:
        self._port = port
        self._scope = scope
        self._catalog = catalog

    def catalog(self, scope: ContactScope) -> SkillCatalog:
        if scope != self._scope:
            raise PermissionError("试用的作用域不匹配。")
        return self._catalog

    def load_version(
        self,
        scope: ContactScope,
        version_id: UUID,
    ) -> SkillVersion:
        return self._port.load_version(scope, version_id)

    def load_resource(
        self,
        scope: ContactScope,
        version_id: UUID,
        relative_path: str,
    ) -> SkillResource:
        return self._port.load_resource(scope, version_id, relative_path)


class ReplySkillPreviewEngine:
    """通过 Reply Runtime 对指定 Skill 生成候选预览，不持久化、不改资料。"""

    __slots__ = ("_port", "_runtime_factory")

    def __init__(
        self,
        *,
        port: SkillPort,
        runtime_factory: Callable[[SkillPort], ReplyRuntime],
    ) -> None:
        if port is None or runtime_factory is None:
            raise TypeError("Skill 试用执行器必须显式注入 Port 与 Runtime 工厂。")
        self._port = port
        self._runtime_factory = runtime_factory

    def generate(
        self,
        *,
        scope: ContactScope,
        context: object,
        catalog: SkillCatalog,
    ) -> SkillPreview:
        if not isinstance(scope, ContactScope):
            raise TypeError("Skill 试用范围必须是 ContactScope。")
        if not isinstance(context, ReplyContext) or context.scope != scope:
            raise ReplyInvariantError("试用上下文超出当前联系人范围。")
        if not isinstance(catalog, SkillCatalog) or catalog.scope != scope:
            raise ReplyInvariantError("试用目录超出当前联系人范围。")
        single = SingleSkillCatalogPort(
            port=self._port,
            scope=scope,
            catalog=catalog,
        )
        result = self._runtime_factory(single).generate(context)
        if not isinstance(result, ReplyRuntimeResult):
            raise ReplyInvariantError("Skill 试用运行结果无效。")
        # 与正式候选共用确定性校验；试用不能借额外资料绕过冻结输入。
        from notalone.reply.generator import ReplyGenerator
        ReplyGenerator._validate_runtime_result(result)
        if result.additional_evidence or any(
            not set(candidate.citation_ids) <= {item.evidence_id for item in context.evidence}
            for candidate in result.candidates
        ):
            raise ReplyInvariantError('Skill 试用引用超出冻结输入。')
        return self._to_preview(scope, result)

    @staticmethod
    def _to_preview(
        scope: ContactScope,
        result: ReplyRuntimeResult,
    ) -> SkillPreview:
        candidates = tuple(
            PreviewCandidate(
                text=candidate.text,
                basis=candidate.basis,
                risk_notes=candidate.risk_notes,
            )
            for candidate in result.candidates
        )
        skill = result.used_skill
        if skill is None:
            return SkillPreview(
                scope=scope,
                skill_id=None,
                version_id=None,
                name=None,
                candidates=candidates,
                selection_reason="未使用 Skill。",
                resource_paths=(),
                load_state="not_used",
                fallback_reason="本次候选未使用任何 Skill。",
            )
        return SkillPreview(
            scope=scope,
            skill_id=skill.skill_id,
            version_id=skill.version_id,
            name=skill.name,
            candidates=candidates,
            selection_reason=skill.selection_reason,
            resource_paths=skill.resource_paths,
            load_state=skill.load_state,
            fallback_reason="",
            execution_view=skill.execution_view,
        )
