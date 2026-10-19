"""探索只读一个不可变策略版本；生成使用同一选择或明确关闭。"""

from dataclasses import dataclass

from notalone.reply.exploration import ExplorationInput, ExplorationStale
from notalone.reply.interface import NoSkill, UserSkillChoice
from notalone.scopes import ContactScope
from notalone.skills import SkillCatalog, SkillCatalogEntry, SkillPort, SkillVersion, validate_skill_version


@dataclass(frozen=True, slots=True, repr=False)
class ExplorationSkillSelection:
    catalog: SkillCatalog
    entry: SkillCatalogEntry | None
    version: SkillVersion | None

    @property
    def generation_selection(self) -> NoSkill | UserSkillChoice:
        return UserSkillChoice(self.entry.version_id) if self.entry else NoSkill()

    @property
    def model_payload(self) -> dict | None:
        if self.version is None:
            return None
        return {"version_id": str(self.version.version_id), "name": self.version.name,
                "content": self.version.content}


def select_exploration_skill(
    *, skills: SkillPort, scope: ContactScope, content: ExplorationInput,
    communication_scene: str | None = None,
) -> ExplorationSkillSelection:
    skills = skills.for_scene(content.skill_scene) if hasattr(skills, 'for_scene') else skills
    catalog = skills.catalog(scope)
    if not isinstance(catalog, SkillCatalog) or catalog.scope != scope:
        raise ExplorationStale("Skill目录不属于当前联系人。")
    selected = None
    if content.skill_mode == "user":
        selected = next((entry for entry in catalog.entries if entry.version_id == content.skill_version_id), None)
        if selected is None:
            raise ExplorationStale("所选Skill当前不可用。")
    elif content.skill_mode == "auto" and communication_scene:
        # 沟通任务只用于相关性判断；显式 skill_scene 只负责目录权限。
        selected = next((entry for entry in catalog.entries
                         if communication_scene in entry.applicable_scenes), None)
    version = None
    if selected:
        try:
            version = validate_skill_version(skills.load_version(scope, selected.version_id), scope=scope, entry=selected)
        except (PermissionError, TypeError, ValueError):
            raise ExplorationStale("所选Skill版本当前不可用。") from None
    return ExplorationSkillSelection(catalog, selected, version)
