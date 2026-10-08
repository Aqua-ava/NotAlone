"""CLI 私聊批量绑定接口测试。"""

from __future__ import annotations

import unittest
from dataclasses import dataclass
from uuid import UUID, uuid4

from notalone.front_sync.cli_binding import (
    CliBindingCoordinator,
    CliBindingSelection,
)
from notalone.scopes import ContactScope
from notalone.wechat_cli.models import ChatCandidate


OWNER_ID = UUID("22222222-2222-2222-2222-222222222222")


@dataclass(frozen=True)
class FakeBinding:
    conversation_locator: str
    contact_id: UUID

    @property
    def scope(self) -> ContactScope:
        return ContactScope(owner_id=OWNER_ID, contact_id=self.contact_id)


class FakeCli:
    def __init__(self) -> None:
        self.sessions_result = (
            ChatCandidate(
                username="wxid_a",
                display_name="甲",
                match=None,
                chat_type="private",
                last_timestamp=100,
                sort_timestamp=100,
                source="session",
            ),
            ChatCandidate(
                username="wxid_group",
                display_name="群聊",
                match=None,
                chat_type="group",
                last_timestamp=200,
                sort_timestamp=200,
                source="session",
            ),
            ChatCandidate(
                username="wxid_b",
                display_name="乙",
                match=None,
                chat_type="private",
                last_timestamp=300,
                sort_timestamp=300,
                source="session",
            ),
        )
        self.calls: list[dict[str, object]] = []

    def sessions(self, **kwargs):
        self.calls.append(kwargs)
        return self.sessions_result


class FakeBindings:
    def __init__(self, active: tuple[FakeBinding, ...] = ()) -> None:
        self.active = active

    def list_active_bindings(self, **kwargs):
        return self.active


class FakeBatchRepository:
    def __init__(self) -> None:
        self.calls: list[tuple[object, ...]] = []

    def create_cli_bindings_batch(self, **kwargs):
        self.calls.append(kwargs["items"])
        return tuple(
            FakeBinding(item.conversation_locator, item.contact_id or uuid4())
            for item in kwargs["items"]
        )


class CliBindingCoordinatorTest(unittest.TestCase):
    def setUp(self) -> None:
        self.cli = FakeCli()
        self.bindings = FakeBindings(
            active=(FakeBinding("wxid_a", UUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")),)
        )
        self.repository = FakeBatchRepository()
        self.coordinator = CliBindingCoordinator(
            owner_id=OWNER_ID,
            channel="wechat",
            account_scope="wx-account",
            cli=self.cli,
            bindings=self.bindings,
            batch_repository=self.repository,
        )

    def test_preview_filters_groups_and_marks_existing_binding(self) -> None:
        result = self.coordinator.list_candidates()

        self.assertEqual([item.username for item in result], ["wxid_a", "wxid_b"])
        self.assertEqual(result[0].bound_contact_id, str(self.bindings.active[0].contact_id))
        self.assertIsNone(result[1].bound_contact_id)
        self.assertEqual(self.cli.calls[0]["type_filter"], "private")
        self.assertEqual(self.cli.calls[0]["limit"], 5000)

    def test_confirm_creates_only_selected_unbound_sessions_with_one_batch_call(self) -> None:
        result = self.coordinator.confirm(
            (
                CliBindingSelection(locator="wxid_a"),
                CliBindingSelection(locator="wxid_b", display_name="乙的备注"),
            )
        )

        self.assertEqual(len(self.repository.calls), 1)
        items = self.repository.calls[0]
        self.assertEqual(len(items), 1)
        self.assertEqual(items[0].conversation_locator, "wxid_b")
        self.assertEqual(items[0].contact_id, None)
        self.assertEqual(items[0].display_name, "乙的备注")
        self.assertEqual(len(result), 1)

    def test_confirm_rejects_locator_not_in_private_preview_before_writing(self) -> None:
        with self.assertRaises(ValueError):
            self.coordinator.confirm((CliBindingSelection(locator="wxid_unknown"),))

        self.assertEqual(self.repository.calls, [])

    def test_confirm_requires_unique_nonempty_selection(self) -> None:
        with self.assertRaises(ValueError):
            self.coordinator.confirm(
                (
                    CliBindingSelection(locator="wxid_b"),
                    CliBindingSelection(locator="wxid_b"),
                )
            )
        self.assertEqual(self.repository.calls, [])


if __name__ == "__main__":
    unittest.main()
