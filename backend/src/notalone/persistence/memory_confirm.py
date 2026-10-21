"""contact 与 owner 两个记忆存储共用的候选确认事务。

两个 store 的确认路径原本是两份 230~270 行的复制事务，校验时点与
来源查询已经开始漂移。这里只保留一份状态机：候选加锁读取 → 保护与
人工决定校验 → 幂等重放或新建版本 → 来源合并与校验 → 版本回执 →
写入与旧版失效。表名、行投影、对象构造等差异由各 store 的
`ConfirmFlavor` 适配器提供；两侧独有规则（如 owner 只接受 self 主体）
仍留在各自的适配器或薄包装中。

统一约定：
- `expected_dimension_evidence` 在保护判定之后、幂等重放与新建分支
  之前校验；重放同样 fail-closed。
- 事务边界、来源合并与版本回执语义与合并前一致；删除与失效仍走
  同一事务。
"""

from __future__ import annotations

from dataclasses import replace
from typing import Any, Protocol
from uuid import UUID

from notalone.memory.correction import MemoryCorrectionConflictError
from notalone.memory.dimension_evidence import require_current_dimension_evidence
from notalone.memory.evolution import MemoryEvolution
from notalone.memory.models import (
    AdoptionMethod,
    MemoryCandidate,
    MemoryCandidateStatus,
    SourceDependencyMode,
)
from notalone.memory.versions import (
    MemoryVersionConflict,
    require_auto_previous,
    require_auto_update_previous,
    require_auto_update_receipt,
    require_version_receipt,
)
from notalone.persistence.locks import lock_contact_scope, lock_owner_scope
from notalone.persistence.memory_correction import (
    persist_protection,
    protect_candidate,
    require_reviewed_decisions,
)
from notalone.persistence.memory_evolution import (
    require_replacement_evolution,
    validate_evolution,
)
from notalone.persistence.memory_versions import (
    create_version_evidence,
    validate_version_sources,
)
from notalone.scopes import ContactScope


class ConfirmFlavor(Protocol):
    """确认事务里两个 store 的表结构、行投影与对象构造差异。"""

    scope: ContactScope

    def load_candidate(self, connection: Any) -> tuple[dict, MemoryCandidate]:
        """加范围锁读取候选行并构造领域对象；缺失/越界时按 store 规则抛错。"""

    def candidate_status(self, row: dict) -> MemoryCandidateStatus: ...

    def read_confirmed_memory(self, connection: Any) -> Any:
        """幂等重放：按候选读取已有记忆；缺失时按 store 规则抛错。"""

    def load_previous_row(self, connection: Any, memory_id: UUID) -> dict | None:
        """读取被替代的上一个版本行；保留原 store 的范围过滤与锁。"""

    def ensure_previous_scope(self, row: dict) -> None: ...

    def shape_previous(self, connection: Any, row: dict) -> Any: ...

    def ensure_previous_sources(self, connection: Any, row: dict) -> None:
        """新建版本前对旧版来源的 store 专属复验；contact 无需额外步骤。"""

    def candidate_source_ids(self, row: dict) -> tuple[UUID, ...]: ...

    def has_active_child(self, connection: Any, memory_id: UUID) -> bool: ...

    def dependency_mode(self, row: dict) -> SourceDependencyMode: ...

    def requires_all_sources(self, row: dict) -> bool: ...

    def confirmation_candidate(self, connection: Any, row: dict) -> MemoryCandidate:
        """按 store 既有读取方式重新绑定候选（含锁定来源）。"""

    def enforce_locked_evidence(
        self, connection: Any, *, row: dict, candidate: MemoryCandidate,
        adoption_method: AdoptionMethod, mode: SourceDependencyMode,
        expected_dimension_evidence: Any,
    ) -> None:
        """写入前的依据锁定复验；两侧规则不同，但都 fail-closed。"""

    def validate_sources(
        self, connection: Any, source_ids: tuple[UUID, ...],
        mode: SourceDependencyMode,
    ) -> None: ...

    def new_memory_id(self) -> UUID: ...

    def build_memory(
        self, *, memory_id: UUID, candidate: MemoryCandidate,
        source_ids: tuple[UUID, ...], adoption_method: AdoptionMethod,
        expected_previous: Any, mode: SourceDependencyMode,
        requires_all_sources: bool,
    ) -> Any: ...

    def insert_memory(
        self, connection: Any, *, memory: Any, candidate: MemoryCandidate, row: dict,
    ) -> dict:
        """写入新版本并返回答复行；空结果由 store 规则抛错。"""

    def erase_dependencies_after_insert(
        self, connection: Any, *, candidate_id: UUID,
        source_ids: tuple[UUID, ...],
    ) -> None: ...

    def erase_previous_dependencies(self, connection: Any, *, previous: Any) -> None: ...

    def invalidate_previous(
        self, connection: Any, *, previous: Any, retirement_reason: str,
    ) -> None: ...

    def mark_candidate_confirmed(
        self, connection: Any, *, candidate_id: UUID, row: dict,
    ) -> None: ...

    def after_confirm(self, connection: Any) -> None: ...

    def shape_memory(self, connection: Any, row: dict) -> Any: ...


def confirm_candidate_in_transaction(
    connection: Any,
    *,
    flavor: ConfirmFlavor,
    adoption_method: AdoptionMethod,
    expected_correction_decision_ids: tuple[UUID, ...] | None = None,
    expected_previous: Any = None,
    expected_dimension_evidence: Any = None,
) -> Any:
    """在调用方已开启的写事务内确认候选；两侧共用同一状态机。"""

    scope = flavor.scope
    lock_contact_scope(
        connection, owner_id=scope.owner_id, contact_id=scope.contact_id,
    )
    lock_owner_scope(connection, owner_id=scope.owner_id)
    row, current_candidate = flavor.load_candidate(connection)
    protected, snapshot = protect_candidate(connection, current_candidate)
    # 统一校验时点：调用方给出预期依据时，新确认与幂等重放都先核对；
    # 未给出预期时保留两侧原有的确认后锁定复验。
    if expected_dimension_evidence is not None:
        require_current_dimension_evidence(
            protected.dimension_evidence, expected_dimension_evidence,
        )
    require_reviewed_decisions(
        protected, adoption_method, expected_correction_decision_ids,
    )
    status = flavor.candidate_status(row)
    if status is MemoryCandidateStatus.CONFIRMED:
        return _replay_confirmed(
            connection, flavor=flavor, adoption_method=adoption_method,
            expected_previous=expected_previous,
        )
    if status is not MemoryCandidateStatus.PENDING:
        raise RuntimeError("关系记忆候选当前不可确认。")
    return _confirm_pending(
        connection, flavor=flavor, row=row,
        protected=protected, snapshot=snapshot, adoption_method=adoption_method,
        expected_previous=expected_previous,
        expected_dimension_evidence=expected_dimension_evidence,
    )


def _replay_confirmed(
    connection: Any, *, flavor: ConfirmFlavor,
    adoption_method: AdoptionMethod, expected_previous: Any,
) -> Any:
    actual = flavor.read_confirmed_memory(connection)
    if expected_previous is not None:
        if adoption_method is AdoptionMethod.AUTO:
            require_auto_update_receipt(actual, expected_previous)
        else:
            require_version_receipt(actual, expected_previous, adoption_method)
        previous_row = flavor.load_previous_row(connection, expected_previous.memory_id)
        if previous_row is None:
            raise MemoryCorrectionConflictError("原资料已删除，自动回执不可复用。")
        flavor.ensure_previous_scope(previous_row)
        require_auto_update_previous(
            flavor.shape_previous(connection, previous_row), expected_previous,
            allow_manual=adoption_method is AdoptionMethod.MANUAL,
        )
    return actual


def _confirm_pending(
    connection: Any, *, flavor: ConfirmFlavor, row: dict,
    protected: MemoryCandidate, snapshot: Any,
    adoption_method: AdoptionMethod, expected_previous: Any,
    expected_dimension_evidence: Any,
) -> Any:
    scope = flavor.scope
    if expected_previous is not None:
        previous_row = flavor.load_previous_row(connection, expected_previous.memory_id)
        if previous_row is None:
            raise MemoryCorrectionConflictError("原资料已删除，自动替代未应用。")
        flavor.ensure_previous_scope(previous_row)
        require_auto_previous(
            flavor.shape_previous(connection, previous_row), expected_previous,
            allow_manual=adoption_method is AdoptionMethod.MANUAL,
        )
        flavor.ensure_previous_sources(connection, previous_row)
    if snapshot is not None:
        persist_protection(connection, protected, snapshot)
    source_ids = flavor.candidate_source_ids(row)
    if expected_previous is not None:
        if ((adoption_method is AdoptionMethod.AUTO
                and not set(source_ids) - set(expected_previous.source_ids))
                or flavor.has_active_child(connection, expected_previous.memory_id)):
            raise MemoryVersionConflict("自动更新需要新依据和当前叶子版本。")
        source_ids = tuple(dict.fromkeys(
            (*expected_previous.source_ids, *source_ids),
        ))
    mode = flavor.dependency_mode(row)
    if (expected_previous is not None
            and expected_previous.source_dependency_mode is SourceDependencyMode.ALL):
        mode = SourceDependencyMode.ALL
    requires_all_sources = flavor.requires_all_sources(row) or bool(
        expected_previous and expected_previous.requires_all_sources
    )
    confirmation_candidate = flavor.confirmation_candidate(connection, row)
    flavor.enforce_locked_evidence(
        connection, row=row, candidate=confirmation_candidate,
        adoption_method=adoption_method, mode=mode,
        expected_dimension_evidence=expected_dimension_evidence,
    )
    flavor.validate_sources(connection, source_ids, mode)
    if adoption_method is AdoptionMethod.AUTO and expected_previous is not None:
        require_replacement_evolution(
            connection, confirmation_candidate, (expected_previous,),
        )
    memory_id = flavor.new_memory_id()
    memory = flavor.build_memory(
        memory_id=memory_id, candidate=confirmation_candidate,
        source_ids=source_ids, adoption_method=adoption_method,
        expected_previous=expected_previous, mode=mode,
        requires_all_sources=requires_all_sources,
    )
    if memory.evolution is not None:
        validate_evolution(
            connection, owner_id=scope.owner_id, evolution=memory.evolution,
            candidate=confirmation_candidate, lock=True,
        )
    if expected_previous is not None:
        proof = create_version_evidence(
            connection, previous=expected_previous, current=memory,
        )
        if adoption_method is AdoptionMethod.AUTO:
            validate_version_sources(
                connection, owner_id=scope.owner_id, evidence=proof,
            )
        memory = replace(memory, version_evidence=proof)
    written = flavor.insert_memory(
        connection, memory=memory, candidate=confirmation_candidate, row=row,
    )
    flavor.erase_dependencies_after_insert(
        connection, candidate_id=confirmation_candidate.candidate_id,
        source_ids=source_ids,
    )
    if expected_previous is not None:
        flavor.erase_previous_dependencies(connection, previous=expected_previous)
        flavor.invalidate_previous(
            connection, previous=expected_previous,
            retirement_reason=(
                "error_correction"
                if isinstance(memory.evolution, MemoryEvolution)
                and memory.evolution.kind == "error_correction"
                else "state_changed"
            ),
        )
    flavor.mark_candidate_confirmed(
        connection, candidate_id=confirmation_candidate.candidate_id, row=written,
    )
    flavor.after_confirm(connection)
    return flavor.shape_memory(connection, written)
