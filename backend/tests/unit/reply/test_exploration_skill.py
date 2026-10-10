"""合成策略目录的范围、实际版本和关闭状态通过正式Skill边界核对。"""

from dataclasses import replace
from unittest import TestCase
from uuid import UUID, uuid4

from notalone.reply.exploration import ExplorationInput, ExplorationStale
from notalone.reply.exploration_skill import select_exploration_skill
from notalone.reply.interface import NoSkill, UserSkillChoice
from notalone.scopes import ContactScope
from notalone.skills import SkillCatalog, SkillCatalogEntry, SkillVersion


class SyntheticSkills:
    def __init__(self, scope: ContactScope) -> None:
        self.scope = scope
        self.entry = SkillCatalogEntry(
            skill_id=uuid4(), version_id=uuid4(), name="synthetic-scene",
            description="合成主动聊聊场景说明", owner_id=scope.owner_id,
            contact_id=scope.contact_id, version_number=2,
            applicable_scenes=("恢复联系",),
        )
        self.catalog_value = SkillCatalog(scope, 8, (self.entry,))
        self.version = SkillVersion(
            owner_id=scope.owner_id, contact_id=scope.contact_id,
            skill_id=self.entry.skill_id, version_id=self.entry.version_id,
            name=self.entry.name, description=self.entry.description,
            content="合成静态策略：列明未知并让用户选择不同目的。", enabled=True,
        )
        self.loaded_versions: list[UUID] = []

    def catalog(self, scope: ContactScope) -> SkillCatalog:
        return self.catalog_value

    def load_version(self, scope: ContactScope, version_id: UUID) -> SkillVersion:
        self.loaded_versions.append(version_id)
        return self.version


class ExplorationSkillTest(TestCase):
    def setUp(self) -> None:
        self.scope = ContactScope(uuid4(), uuid4())
        self.skills = SyntheticSkills(self.scope)
        self.content = ExplorationInput(scene="initiate_conversation", purpose_hint="想了解合成近况",
                                        skill_mode="user", skill_version_id=self.skills.entry.version_id)

    def test_foreign_catalog_is_rejected_before_loading_static_text(self) -> None:
        self.skills.catalog_value = SkillCatalog(ContactScope(uuid4(), uuid4()), 8, ())
        with self.assertRaises(ExplorationStale):
            select_exploration_skill(skills=self.skills, scope=self.scope, content=self.content)
        self.assertEqual(self.skills.loaded_versions, [])

    def test_foreign_or_disabled_static_version_is_rejected(self) -> None:
        original = self.skills.version
        for change in ({"owner_id": uuid4()}, {"contact_id": uuid4()}, {"enabled": False}, {"version_id": uuid4()}):
            with self.subTest(change=tuple(change)):
                self.skills.version = replace(original, **change)
                with self.assertRaises(ExplorationStale):
                    select_exploration_skill(skills=self.skills, scope=self.scope, content=self.content)

    def test_disabled_choice_never_loads_or_falls_back_to_auto(self) -> None:
        selected = select_exploration_skill(skills=self.skills, scope=self.scope,
                                            content=replace(self.content, skill_mode="disabled", skill_version_id=None))
        self.assertIsInstance(selected.generation_selection, NoSkill)
        self.assertIsNone(selected.model_payload)
        self.assertEqual(self.skills.loaded_versions, [])

    def test_one_actual_version_is_pinned_for_generation(self) -> None:
        selected = select_exploration_skill(skills=self.skills, scope=self.scope, content=self.content)
        self.assertEqual(self.skills.loaded_versions, [self.skills.entry.version_id])
        self.assertEqual(selected.generation_selection, UserSkillChoice(self.skills.entry.version_id))
        self.assertEqual(selected.model_payload["version_id"], str(self.skills.entry.version_id))
        self.assertEqual(selected.entry.version_number, 2)

    def test_obsolete_explicit_version_cannot_fall_back(self) -> None:
        with self.assertRaises(ExplorationStale):
            select_exploration_skill(skills=self.skills, scope=self.scope,
                                     content=replace(self.content, skill_mode="user", skill_version_id=uuid4()))
        self.assertEqual(self.skills.loaded_versions, [])

    def test_no_scene_match_uses_generic_flow(self) -> None:
        entry = replace(self.skills.entry, description="合成其他场景", applicable_scenes=("rewrite_draft",))
        self.skills.catalog_value = SkillCatalog(self.scope, 8, (entry,))
        selected = select_exploration_skill(skills=self.skills, scope=self.scope,
                                            content=replace(self.content, skill_mode="auto", skill_version_id=None))
        self.assertIsInstance(selected.generation_selection, NoSkill)
        self.assertEqual(self.skills.loaded_versions, [])

    def test_explicit_scenes_override_free_description_text(self) -> None:
        entry = replace(self.skills.entry, applicable_scenes=("rewrite_draft",))
        self.skills.catalog_value = SkillCatalog(self.scope, 8, (entry,))
        selected = select_exploration_skill(skills=self.skills, scope=self.scope,
                                            content=replace(self.content, skill_mode="auto", skill_version_id=None))
        self.assertIsInstance(selected.generation_selection, NoSkill)
        self.assertEqual(self.skills.loaded_versions, [])

    def test_description_is_not_an_authorization_to_match_a_scene(self) -> None:
        entry = replace(self.skills.entry, description="合成策略不适用于主动聊聊", applicable_scenes=())
        self.skills.catalog_value = SkillCatalog(self.scope, 8, (entry,))
        selected = select_exploration_skill(skills=self.skills, scope=self.scope,
                                            content=replace(self.content, skill_mode="auto", skill_version_id=None))
        self.assertIsInstance(selected.generation_selection, NoSkill)
        self.assertEqual(self.skills.loaded_versions, [])

    def test_closed_or_auto_selection_cannot_carry_a_hidden_version(self) -> None:
        for mode in ("auto", "disabled"):
            with self.subTest(mode=mode):
                with self.assertRaises(ValueError):
                    replace(self.content, skill_mode=mode, skill_version_id="hidden-version")

    def test_entry_mode_does_not_identify_a_communication_task(self) -> None:
        entry = replace(self.skills.entry, applicable_scenes=("initiate_conversation",))
        self.skills.catalog_value = SkillCatalog(self.scope, 8, (entry,))
        selected = select_exploration_skill(skills=self.skills, scope=self.scope,
                                            content=replace(self.content, skill_mode="auto", skill_version_id=None))
        self.assertIsInstance(selected.generation_selection, NoSkill)
        self.assertEqual(self.skills.loaded_versions, [])

    def test_known_communication_task_matches_metadata_without_guessing_a_stance(self) -> None:
        selected = select_exploration_skill(
            skills=self.skills, scope=self.scope,
            content=replace(self.content, skill_mode="auto", skill_version_id=None),
            communication_scene="恢复联系",
        )
        self.assertEqual(selected.generation_selection, UserSkillChoice(self.skills.entry.version_id))
        self.assertEqual(self.skills.loaded_versions, [self.skills.entry.version_id])
