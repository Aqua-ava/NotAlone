"""用户手动指定 Skill 版本的目录锁定行为测试。"""

from __future__ import annotations

import unittest
from uuid import UUID, uuid4

from notalone.reply.adapters.langchain_runtime import apply_user_skill_choice
from notalone.reply.interface import AutoSkill, UserSkillChoice
from notalone.scopes import ContactScope
from notalone.skills.models import SkillCatalog, SkillCatalogEntry


OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
CONTACT_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
SCOPE = ContactScope(owner_id=OWNER_ID, contact_id=CONTACT_ID)


def _entry(*, version_id: UUID, name: str) -> SkillCatalogEntry:
    return SkillCatalogEntry(
        skill_id=uuid4(),
        version_id=version_id,
        name=name,
        description=f"{name} 描述",
        owner_id=OWNER_ID,
        contact_id=CONTACT_ID,
    )


def _catalog(*entries: SkillCatalogEntry) -> SkillCatalog:
    return SkillCatalog(
        scope=SCOPE,
        revision=3,
        entries=entries,
    )


class ApplyUserSkillChoiceTest(unittest.TestCase):
    def test_auto_selection_keeps_catalog(self) -> None:
        entries = (_entry(version_id=uuid4(), name="warm-reply"),)
        catalog = _catalog(*entries)

        result = apply_user_skill_choice(catalog, AutoSkill())

        self.assertEqual(result, catalog)

    def test_user_choice_locks_to_matching_version(self) -> None:
        first = _entry(version_id=uuid4(), name="warm-reply")
        second = _entry(version_id=uuid4(), name="cold-reply")
        catalog = _catalog(first, second)

        result = apply_user_skill_choice(
            catalog,
            UserSkillChoice(version_id=second.version_id),
        )

        self.assertEqual(result.entries, (second,))

    def test_missing_version_fails_closed_to_empty_catalog(self) -> None:
        catalog = _catalog(
            _entry(version_id=uuid4(), name="warm-reply")
        )

        result = apply_user_skill_choice(
            catalog,
            UserSkillChoice(version_id=uuid4()),
        )

        self.assertEqual(result.entries, ())
        self.assertEqual(result.scope, SCOPE)
        self.assertEqual(result.revision, 3)


if __name__ == "__main__":
    unittest.main()