"""验证 Skill 目录、不可变版本和受控辅助资源的所有权与范围。"""

from __future__ import annotations

import hashlib
import unittest
from uuid import UUID

from notalone.scopes import ContactScope
from notalone.skills import (
    SkillCatalog,
    SkillCatalogEntry,
    SkillResource,
    SkillVersion,
    validate_skill_version,
)


OWNER_ID = UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
CONTACT_ID = UUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
OTHER_CONTACT_ID = UUID("cccccccc-cccc-cccc-cccc-cccccccccccc")
SKILL_ID = UUID("dddddddd-dddd-dddd-dddd-dddddddddddd")
VERSION_ID = UUID("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee")


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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

    def test_catalog_keeps_lightweight_version_status_and_scene_metadata(self) -> None:
        entry = SkillCatalogEntry(
            SKILL_ID,
            VERSION_ID,
            "gentle-reply",
            "温和回复",
            OWNER_ID,
            CONTACT_ID,
            version_number=3,
            applicable_scenes=("邀约", "需要边界"),
        )

        self.assertEqual(entry.version_number, 3)
        self.assertEqual(entry.status, "active")
        self.assertEqual(entry.applicable_scenes, ("邀约", "需要边界"))

        with self.assertRaises(ValueError):
            SkillCatalogEntry(
                SKILL_ID,
                VERSION_ID,
                "gentle-reply",
                "温和回复",
                OWNER_ID,
                CONTACT_ID,
                status="disabled",
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

    def test_version_rejects_invalid_or_duplicate_resource_paths(self) -> None:
        base = (
            OWNER_ID,
            CONTACT_ID,
            SKILL_ID,
            VERSION_ID,
            "gentle-reply",
            "温和回复",
            "先回应，再明确表达。",
            True,
        )
        SkillVersion(*base, resource_paths=("references/a.md", "assets/b.txt"))
        SkillVersion(*base, resource_paths=())
        with self.assertRaises(ValueError):
            SkillVersion(*base, resource_paths=("references/../escape.md",))
        with self.assertRaises(ValueError):
            SkillVersion(*base, resource_paths=("SKILL.md",))
        with self.assertRaises(ValueError):
            SkillVersion(
                *base,
                resource_paths=("references/a.md", "references/a.md"),
            )

    def test_resource_applies_to_scope_and_matches_version_allowlist(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        version = SkillVersion(
            OWNER_ID,
            CONTACT_ID,
            SKILL_ID,
            VERSION_ID,
            "gentle-reply",
            "温和回复",
            "先回应，再明确表达。",
            True,
            ("references/cases.md",),
        )
        content = "长案例正文。".encode("utf-8")
        resource = SkillResource(
            owner_id=OWNER_ID,
            contact_id=CONTACT_ID,
            skill_id=SKILL_ID,
            version_id=VERSION_ID,
            relative_path="references/cases.md",
            resource_kind="reference",
            media_type="text/markdown",
            content=content,
            content_sha256=_sha256(content),
        )

        self.assertTrue(resource.applies_to(scope))
        self.assertTrue(resource.matches(version))
        self.assertNotIn("references/other.md", version.resource_paths)

    def test_resource_from_another_contact_does_not_apply_to_scope(self) -> None:
        scope = ContactScope(OWNER_ID, CONTACT_ID)
        content = b"private"
        other = SkillResource(
            owner_id=OWNER_ID,
            contact_id=OTHER_CONTACT_ID,
            skill_id=SKILL_ID,
            version_id=VERSION_ID,
            relative_path="references/cases.md",
            resource_kind="reference",
            media_type="text/markdown",
            content=content,
            content_sha256=_sha256(content),
        )

        self.assertFalse(other.applies_to(scope))

    def test_resource_rejects_kind_path_mismatch_or_bad_hash(self) -> None:
        content = b"asset"
        with self.assertRaises(ValueError):
            SkillResource(
                OWNER_ID,
                CONTACT_ID,
                SKILL_ID,
                VERSION_ID,
                "references/cases.md",
                "asset",
                "text/plain",
                content,
                _sha256(content),
            )
        with self.assertRaises(ValueError):
            SkillResource(
                OWNER_ID,
                CONTACT_ID,
                SKILL_ID,
                VERSION_ID,
                "references/cases.md",
                "reference",
                "text/markdown",
                content,
                "0" * 64,
            )


if __name__ == "__main__":
    unittest.main()
