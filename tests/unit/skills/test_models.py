"""验证 Skill 目录和不可变版本的联系人范围。"""

from __future__ import annotations

import unittest
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.skills import (
    SkillCatalog,
    SkillCatalogEntry,
    SkillVersion,
    validate_skill_version,
)


OWNER_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
CONTACT_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
OTHER_CONTACT_ID = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")
SKILL_ID = UUID("dddddddd-dddd-dddd-dddd-dddddddddddd")
VERSION_ID = UUID("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")


class SkillModelsTest(unittest.TestCase):
    def test_owner_wide_skill_can_be_projected_into_contact_catalog(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        entry = SkillCatalogEntry(
            SKILL_ID,
            VERSION_ID,
            "gentle-reply",
            "温和回复",
            OWNER_ID,
            None,
        )
        version = SkillVersion(
            OWNER_ID,
            None,
            SKILL_ID,
            VERSION_ID,
            "gentle-reply",
            "温和回复",
            "先回应，再明确表达。",
            True,
        )

        catalog = SkillCatalog(scope, 2, (entry,))

        self.assertEqual(catalog.entries, (entry,))
        self.assertIs(
            validate_skill_version(version, scope=scope, entry=entry),
            version,
        )

    def test_catalog_rejects_metadata_from_another_contact(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        entry = SkillCatalogEntry(
            SKILL_ID,
            VERSION_ID,
            "private-reply",
            "另一联系人的策略",
            OWNER_ID,
            OTHER_CONTACT_ID,
        )

        with self.assertRaises(ValueError):
            SkillCatalog(scope, 2, (entry,))

    def test_version_must_match_catalog_ownership_and_identity(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        entry = SkillCatalogEntry(
            SKILL_ID,
            VERSION_ID,
            "gentle-reply",
            "温和回复",
            OWNER_ID,
            CONTACT_ID,
        )
        leaked = SkillVersion(
            OWNER_ID,
            OTHER_CONTACT_ID,
            SKILL_ID,
            VERSION_ID,
            "gentle-reply",
            "温和回复",
            "另一联系人的正文",
            True,
        )

        with self.assertRaises(PermissionError):
            validate_skill_version(leaked, scope=scope, entry=entry)


if __name__ == "__main__":
    unittest.main()
