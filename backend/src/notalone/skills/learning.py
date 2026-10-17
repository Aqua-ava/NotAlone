"""有界学习输入与模型提案；逻辑方法身份由应用层分配。"""

from dataclasses import dataclass, field
from hashlib import sha256
import json
from typing import Any, Protocol
from uuid import UUID


MAX_LEARNING_MATERIALS = 8
MAX_LEARNING_INPUT_CHARS = 24000


def learning_input_text(materials, targets) -> str:
    """取材和模型入口共用实际JSON表示，完整计入转义、方法及目标元数据。"""
    return json.dumps({'materials':materials,'existing_skills':targets},ensure_ascii=False,default=str)


def content_digest(value: Any) -> str:
    return sha256(json.dumps(value, ensure_ascii=False, sort_keys=True,
                             default=str).encode()).hexdigest()


@dataclass(frozen=True)
class LearningBatch:
    materials: tuple[dict[str, Any], ...]
    targets: tuple[dict[str, Any], ...]
    dependency_ids: tuple[UUID, ...]
    library_revision: int
    scope_revision: int = 0
    source_generation: dict[str, Any] = field(default_factory=dict)
    material_budget_limited: bool = False

    @property
    def key(self) -> str:
        return content_digest({"materials": self.materials, "targets": self.targets,
                               "revision": self.library_revision, "scope_revision": self.scope_revision,
                               "source_generation": self.source_generation})

    @property
    def ready(self) -> bool:
        # 单份已占过半预算的合法材料单独处理，否则无法再合入相近大小的第二份。
        large_single = len(self.materials)==1 and MAX_LEARNING_INPUT_CHARS//2 < len(
            learning_input_text(self.materials,())) <= MAX_LEARNING_INPUT_CHARS
        return (len(self.materials) >= 2 or large_single
                or bool(self.materials) and self.material_budget_limited
                or any(item['priority'] == 'correction' for item in self.materials))


class SkillProposalRuntime(Protocol):
    def propose(self, *, scope, batch: LearningBatch) -> dict[str, Any]: ...


class SkillLearningInvalid(Exception):
    """材料或提案已失效；错误不携带私密正文。"""


class SkillLearningUnavailable(Exception):
    """学习用途未授权或资源暂不可用。"""
