"""讨论快照的纯载荷协议；不读取业务库，不持久化正文。"""

from __future__ import annotations

import json
import unittest
from dataclasses import replace
from uuid import UUID

from notalone.reply import assistant_discussion as discussion
from notalone.scopes import ContactScope


class DiscussionSnapshotSerializationTest(unittest.TestCase):
    def _snapshot(self):
        return discussion.DiscussionSnapshot(
            ContactScope(UUID(int=1), UUID(int=2)), UUID(int=3), UUID(int=4),
            UUID(int=5), UUID(int=6), "a" * 64,
            (
                discussion.DiscussionIdentity("discussion_input", UUID(int=7), "b" * 64),
                discussion.DiscussionIdentity("generation_input", UUID(int=8), "c" * 64, UUID(int=9)),
                discussion.DiscussionIdentity("candidate_version", UUID(int=8), "d" * 64,
                                              UUID(int=9), UUID(int=10), UUID(int=10)),
                discussion.DiscussionIdentity("candidate_version", UUID(int=8), "e" * 64,
                                              UUID(int=9), UUID(int=10), UUID(int=11)),
            ),
        )

    def test_json_roundtrip_contains_only_version_scope_and_captured_identity(self):
        snapshot = self._snapshot()
        payload = discussion.discussion_snapshot_to_payload(snapshot)
        self.assertEqual(payload["version"], 1)
        self.assertEqual(set(payload), {"version", "scope", "session_id", "request_key",
                                       "current_input_version_id", "current_turn_id",
                                       "current_payload_sha256", "records"})
        self.assertEqual(payload["scope"], {"owner_id": str(UUID(int=1)), "contact_id": str(UUID(int=2))})
        self.assertEqual(payload["records"][0], {
            "kind": "discussion_input", "input_version_id": str(UUID(int=7)), "payload_sha256": "b" * 64,
            "turn_id": None, "candidate_id": None, "version_id": None,
        })
        reconstructed = discussion.discussion_snapshot_from_payload(json.loads(json.dumps(payload)))
        self.assertEqual(reconstructed, snapshot)
        self.assertEqual(discussion.discussion_snapshot_to_payload(reconstructed), payload)

    def test_unknown_and_noninteger_format_versions_are_rejected(self):
        for version in (0, 2, True, "1", None, 1.0):
            with self.subTest(version=version):
                payload = discussion.discussion_snapshot_to_payload(self._snapshot())
                payload["version"] = version
                with self.assertRaises(ValueError):
                    discussion.discussion_snapshot_from_payload(payload)

    def test_unknown_text_fields_missing_fields_and_non_json_shapes_are_rejected(self):
        for level in ("snapshot", "scope", "record"):
            for operation in ("extra", "missing"):
                with self.subTest(level=level, operation=operation):
                    payload = discussion.discussion_snapshot_to_payload(self._snapshot())
                    target = payload if level == "snapshot" else payload["scope"] if level == "scope" else payload["records"][0]
                    if operation == "extra":
                        target["text"] = "不允许进入快照的合成正文。"
                    else:
                        target.pop(next(iter(target)))
                    with self.assertRaises(ValueError) as caught:
                        discussion.discussion_snapshot_from_payload(payload)
                    self.assertNotIn("合成正文", str(caught.exception))
        for records in ({}, (), None, "records"):
            with self.subTest(records=records):
                payload = discussion.discussion_snapshot_to_payload(self._snapshot())
                payload["records"] = records
                with self.assertRaises(ValueError):
                    discussion.discussion_snapshot_from_payload(payload)

    def test_uuid_fields_require_canonical_json_strings(self):
        for value in ("not-uuid", UUID(int=1), 1, True, str(UUID(int=1)).replace("-", ""),
                      "{" + str(UUID(int=1)) + "}", " " + str(UUID(int=1))):
            for location in ("anchor", "scope", "record"):
                with self.subTest(value=value, location=location):
                    payload = discussion.discussion_snapshot_to_payload(self._snapshot())
                    target = payload if location == "anchor" else payload["scope"] if location == "scope" else payload["records"][0]
                    field = "current_turn_id" if location == "anchor" else "owner_id" if location == "scope" else "input_version_id"
                    target[field] = value
                    with self.assertRaises(ValueError):
                        discussion.discussion_snapshot_from_payload(payload)

    def test_hashes_must_be_canonical_sha256_hex_in_payload_and_original_dataclasses(self):
        for value in ("z" * 64, "A" * 64, "f" * 63, "f" * 65, None, 123):
            for field in ("current_payload_sha256", "record"):
                with self.subTest(value=value, field=field):
                    payload = discussion.discussion_snapshot_to_payload(self._snapshot())
                    target = payload if field == "current_payload_sha256" else payload["records"][0]
                    target[field if field != "record" else "payload_sha256"] = value
                    with self.assertRaises(ValueError):
                        discussion.discussion_snapshot_from_payload(payload)
            with self.subTest(value=value, origin="snapshot"):
                with self.assertRaises(TypeError):
                    replace(self._snapshot(), current_payload_sha256=value)
            with self.subTest(value=value, origin="record"):
                with self.assertRaises(TypeError):
                    replace(self._snapshot().records[0], payload_sha256=value)

    def test_each_record_kind_enforces_its_required_and_nullable_identity_fields(self):
        cases = (
            (0, "turn_id", UUID(int=20)), (0, "candidate_id", UUID(int=20)), (0, "version_id", UUID(int=20)),
            (1, "turn_id", None), (1, "candidate_id", UUID(int=20)), (1, "version_id", UUID(int=20)),
            (2, "turn_id", None), (2, "candidate_id", None), (2, "version_id", None),
        )
        for index, field, value in cases:
            with self.subTest(index=index, field=field):
                payload = discussion.discussion_snapshot_to_payload(self._snapshot())
                payload["records"][index][field] = str(value) if isinstance(value, UUID) else value
                with self.assertRaises(ValueError):
                    discussion.discussion_snapshot_from_payload(payload)
                with self.assertRaises(TypeError):
                    replace(self._snapshot().records[index], **{field: value})

    def test_duplicate_capture_identity_is_rejected_even_when_digest_differs(self):
        snapshot = self._snapshot()
        for index in range(len(snapshot.records)):
            with self.subTest(index=index):
                duplicate = replace(snapshot.records[index], payload_sha256="0" * 64)
                with self.assertRaises(TypeError):
                    replace(snapshot, records=(*snapshot.records, duplicate))
                payload = discussion.discussion_snapshot_to_payload(snapshot)
                extra = dict(payload["records"][index], payload_sha256="0" * 64)
                payload["records"].append(extra)
                with self.assertRaises(ValueError):
                    discussion.discussion_snapshot_from_payload(payload)

    def test_duplicate_object_identity_cannot_be_hidden_by_conflicting_parent_ids(self):
        snapshot = self._snapshot()
        for duplicate in (
            replace(snapshot.records[1], turn_id=UUID(int=30)),
            replace(snapshot.records[2], candidate_id=UUID(int=30)),
        ):
            with self.subTest(kind=duplicate.kind):
                with self.assertRaises(TypeError):
                    replace(snapshot, records=(*snapshot.records, duplicate))

    def test_capture_records_cannot_reenter_their_own_current_input_or_turn(self):
        snapshot = self._snapshot()
        cases = (
            (0, "input_version_id", snapshot.current_input_version_id),
            (1, "input_version_id", snapshot.current_input_version_id),
            (2, "input_version_id", snapshot.current_input_version_id),
            (1, "turn_id", snapshot.current_turn_id),
            (2, "turn_id", snapshot.current_turn_id),
        )
        for index, field, value in cases:
            with self.subTest(index=index, field=field):
                record = replace(snapshot.records[index], **{field: value})
                with self.assertRaises(TypeError):
                    replace(snapshot, records=tuple(record if i == index else existing
                                                    for i, existing in enumerate(snapshot.records)))
                payload = discussion.discussion_snapshot_to_payload(snapshot)
                payload["records"][index][field] = str(value)
                with self.assertRaises(ValueError):
                    discussion.discussion_snapshot_from_payload(payload)

    def test_strict_encoding_revalidates_snapshot_and_nested_identity(self):
        for level in ("snapshot", "record", "scope"):
            with self.subTest(level=level):
                snapshot = self._snapshot()
                if level == "snapshot":
                    object.__setattr__(snapshot, "current_payload_sha256", "不允许被编码的合成正文。")
                elif level == "record":
                    object.__setattr__(snapshot.records[0], "payload_sha256", "不允许被编码的合成正文。")
                else:
                    object.__setattr__(snapshot.scope, "owner_id", "不允许被编码的合成正文。")
                with self.assertRaises(TypeError) as caught:
                    discussion.discussion_snapshot_to_payload(snapshot)
                self.assertNotIn("合成正文", str(caught.exception))
