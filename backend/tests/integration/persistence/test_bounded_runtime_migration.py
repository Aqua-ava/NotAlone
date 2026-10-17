"""060的自有隔离结构控制；手注JSON不认证来源、模型或正向语义。"""
from __future__ import annotations

from copy import deepcopy
from pathlib import Path
import shutil
import tempfile
from typing import ClassVar
import unittest
from uuid import UUID, uuid4

import psycopg
from psycopg import sql
from psycopg.conninfo import make_conninfo
from psycopg.types.json import Jsonb

from notalone.database_migrations import migrate


MIGRATIONS = Path(__file__).resolve().parents[3] / "database/migrations"
SHA = "a" * 64


class BoundedRuntimeMigrationTest(unittest.TestCase):
    name: ClassVar[str]
    admin: ClassVar[psycopg.Connection]
    url: ClassVar[str]
    old_applied: ClassVar[tuple[str, ...]]
    applied: ClassVar[tuple[str, ...]]
    owner: ClassVar[UUID]
    contact: ClassVar[UUID]
    message: ClassVar[UUID]
    source: ClassVar[UUID]
    task: ClassVar[UUID]

    @classmethod
    def setUpClass(cls) -> None:
        cls.name = f"notalone_bounded_migration_{uuid4().hex}_test"
        cls.admin = psycopg.connect("host=/tmp dbname=postgres", autocommit=True)
        cls.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(cls.name)))
        cls.addClassCleanup(cls._drop_database)
        cls.url = make_conninfo("host=/tmp", dbname=cls.name)
        print(f"isolated_database_created={cls.name}")
        with tempfile.TemporaryDirectory(prefix="notalone-bounded-old-") as directory:
            for source in MIGRATIONS.glob("*.sql"):
                if source.name[:3] <= "070":
                    shutil.copyfile(source, Path(directory) / source.name)
            cls.old_applied = migrate(cls.url, Path(directory))
        cls.owner, cls.contact, cls.message, cls.source, cls.task = (uuid4() for _ in range(5))
        with psycopg.connect(cls.url) as connection:
            connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成用户')", (cls.owner,))
            connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成联系人')",
                               (cls.owner, cls.contact))
            connection.execute("""INSERT INTO public.source_document(id,owner_id,contact_id,source_type,
                file_name,content_sha256,record_count) VALUES(%s,%s,%s,'wechat_jsonl','synthetic.jsonl',%s,1)""",
                               (cls.source, cls.owner, cls.contact, SHA))
            connection.execute("""INSERT INTO public.background_task(id,owner_id,contact_id,source_document_id,
                task_type,current_step,message_count) VALUES(%s,%s,%s,%s,'import','parse',1)""",
                               (cls.task, cls.owner, cls.contact, cls.source))
            for table in ("memory_candidate", "confirmed_memory", "owner_memory"):
                extra = sql.SQL("") if table == "memory_candidate" else sql.SQL(",adoption_method")
                extra_value = sql.SQL("") if table == "memory_candidate" else sql.SQL(",'manual'")
                contact_column = sql.SQL("") if table == "owner_memory" else sql.SQL(",contact_id")
                contact_value = sql.SQL("") if table == "owner_memory" else sql.SQL(",{}").format(sql.Literal(cls.contact))
                connection.execute(sql.SQL("INSERT INTO public.{}(id,owner_id{},text_content,category,source_ids{}) "
                    "VALUES(%s,%s{},'旧合成资料','common_fact',%s{})").format(sql.Identifier(table), contact_column,
                    extra, contact_value, extra_value), (uuid4(), cls.owner, [cls.message]))
        cls.applied = migrate(cls.url, MIGRATIONS)

    @classmethod
    def _drop_database(cls) -> None:
        try:
            cls.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(cls.name)))
            row = cls.admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s", (cls.name,)).fetchone()
            assert row is not None
            residual = row[0]
            if residual != 0:
                raise AssertionError("自有隔离库未清理")
            print(f"isolated_database_cleaned={cls.name};residual={residual}")
        finally:
            cls.admin.close()

    def setUp(self) -> None:
        self.connection = psycopg.connect(self.url)
        self.addCleanup(self.connection.close)
        self.addCleanup(self.connection.rollback)
        self.connection.execute("SELECT 1")

    def _reject(self, query: str | sql.SQL | sql.Composed, params: tuple) -> None:
        with self.assertRaises(psycopg.errors.CheckViolation):
            with self.connection.transaction():
                self.connection.execute(query, params)

    def _snapshot(self) -> dict:
        return {"version": 4, "scope": {"owner_id": str(self.owner), "contact_id": str(self.contact)},
            "candidate_sha256": SHA, "window_sha256": SHA, "pragmatics": None,
            "messages": [{"message_id": str(self.message), "text_sha256": SHA, "text_length": 40,
                "sender": "contact", "message_type": "text", "text_representation": "text",
                "source_state_sha256": SHA, "occurred_at": "2026-10-17T20:00:00+08:00",
                "source_refs": [{"ref_id": str(self.source), "source_id": str(self.source)}]}],
            "target_message_ids": [str(self.message)], "paraphrase": None, "reference": None,
            "media": None, "reported": None, "semantic_basis": None}

    def _shape(self, payload: object, length: int = 20) -> bool:
        result = self.connection.execute("SELECT public.notalone_dimension_evidence_v4_shape(%s,%s)",
                                         (Jsonb(payload), length)).fetchone()
        assert result is not None
        return result[0]

    def _basis(self) -> dict:
        def text(start: int, end: int) -> dict:
            return {"start": start, "end": end, "sha256": SHA}

        def source(start: int, end: int) -> dict:
            return {"message_id": str(self.message), "span": text(start, end)}

        return {"version": 3, "rule_set_sha256": SHA,
            "rules": [{"rule_id": "BR_AUTHOR_ARRIVAL_V1", "rule_version": 1}],
            "roles": [{"role_id": 0, "kind": "author", "owner": "contact", "sender": "contact",
                       "source": source(0, 1), "candidate": text(0, 3)},
                      {"role_id": 1, "kind": "home", "owner": None, "sender": None,
                       "source": source(3, 4), "candidate": text(10, 11)}],
            "atoms": [{"atom_id": 0, "predicate": "arrive", "phase": "completed",
                "roles": {"agent": None, "recipient": None, "object": None, "property_owner": None,
                          "beneficiary": None, "actor": 0, "destination": 1},
                "source": source(0, 4), "candidate": text(7, 11)}],
            "qualifiers": [{"qualifier_id": 0, "kind": "time", "atom_id": 0, "slot": "event_time",
                            "value_sha256": SHA, "source": source(1, 2), "candidate": text(8, 9)}],
            "reference_bindings": [{"role_id": 0, "method": "actual_sender", "mention": source(0, 1),
                                    "target": source(0, 1), "binding": None}],
            "frame": "direct", "unresolved": [], "source_graph_sha256": SHA, "candidate_graph_sha256": SHA,
            "representation": {"version": 1, "kind": "grounded_window_quote_v1", "target_message_id": str(self.message),
                "source_full": [source(0, 5)], "whole": text(0, 13), "observation": None,
                "author": text(0, 3), "quote": text(7, 12), "quote_sources": [source(0, 5)], "contexts": []},
            "capabilities": ["subject_binding", "event_preservation", "reference_resolution",
                             "direct_attribution", "temporal_preservation"]}

    def _basis_shape(self, payload: object) -> bool:
        result = self.connection.execute("SELECT public.notalone_semantic_basis_v3_valid(%s)",
                                         (Jsonb(payload),)).fetchone()
        assert result is not None
        return result[0]

    def _proved_shape_snapshot(self) -> dict:
        value = self._snapshot()
        value["messages"][0]["text_length"] = 5
        value["semantic_basis"] = self._basis()
        value["pragmatics"] = {"speech_act": "assertion", "assertion_status": "asserted", "figurative_type": "literal"}
        return value

    def test_059_v1_extra_survives_migration_without_becoming_basis3(self) -> None:
        name = f"notalone_bounded_migration_{uuid4().hex}_test"
        url = make_conninfo("host=/tmp", dbname=name)
        self.admin.execute(sql.SQL("CREATE DATABASE {} TEMPLATE template0").format(sql.Identifier(name)))
        print(f"isolated_database_created={name}")
        try:
            with tempfile.TemporaryDirectory(prefix="notalone-bounded-v1-extra-") as directory:
                for source in MIGRATIONS.glob("*.sql"):
                    if source.name[:3] <= "059":
                        shutil.copyfile(source, Path(directory) / source.name)
                self.assertEqual(len(migrate(url, Path(directory))), 59)
            legacy = self._snapshot()
            legacy["version"] = 1
            del legacy["target_message_ids"]
            legacy["semantic_basis"] = {"version": 3, "historical_extra": "v1附加字段不解释为新依据"}
            with psycopg.connect(url) as connection:
                connection.execute("INSERT INTO public.owner(id,display_name) VALUES(%s,'合成用户')", (self.owner,))
                connection.execute("INSERT INTO public.contact(owner_id,id,display_name) VALUES(%s,%s,'合成联系人')",
                                   (self.owner, self.contact))
                connection.execute("""INSERT INTO public.memory_candidate(owner_id,contact_id,text_content,category,
                    source_ids,dimension_evidence) VALUES(%s,%s,'旧合成资料','common_fact',%s,%s)""",
                                   (self.owner, self.contact, [self.message], Jsonb(legacy)))
                self.assertEqual(connection.execute("SELECT dimension_evidence FROM public.memory_candidate").fetchone(), (legacy,))
            self.assertEqual(migrate(url, MIGRATIONS), tuple(source.name for source in sorted(MIGRATIONS.glob("*.sql")) if source.name[:3] > "059"))
            self.assertEqual(migrate(url, MIGRATIONS), ())
            with psycopg.connect(url) as connection:
                self.assertEqual(connection.execute("SELECT dimension_evidence,source_dependency_mode FROM public.memory_candidate").fetchone(),
                                 (legacy, "any"))
                connection.execute("UPDATE public.memory_candidate SET dimension_evidence=%s", (Jsonb(legacy),))
                shape = connection.execute("SELECT public.notalone_dimension_evidence_v4_shape(%s,20)",
                                           (Jsonb(legacy),)).fetchone()
                self.assertEqual(shape, (False,))
                with self.assertRaises(psycopg.errors.CheckViolation):
                    with connection.transaction():
                        connection.execute("UPDATE public.memory_candidate SET source_dependency_mode='all'")
                for changed in ({**legacy, "version": 2}, {**legacy, "version": 3},
                                {**self._snapshot(), "semantic_basis": legacy["semantic_basis"]}):
                    with self.assertRaises(psycopg.errors.CheckViolation):
                        with connection.transaction():
                            connection.execute("UPDATE public.memory_candidate SET dimension_evidence=%s", (Jsonb(changed),))
                with self.assertRaises(psycopg.errors.CheckViolation):
                    with connection.transaction():
                        connection.execute("UPDATE public.memory_candidate SET dimension_evidence=%s,source_dependency_mode='all'",
                                           (Jsonb({**self._snapshot(), "semantic_basis": legacy["semantic_basis"]}),))
        finally:
            self.admin.execute(sql.SQL("DROP DATABASE {} WITH (FORCE)").format(sql.Identifier(name)))
            residual = self.admin.execute("SELECT count(*) FROM pg_database WHERE datname=%s", (name,)).fetchone()
            self.assertEqual(residual, (0,))
            print(f"isolated_database_cleaned={name};residual=0")

    def test_forward_columns_old_defaults_and_repeat(self) -> None:
        self.assertEqual(len(self.old_applied), 70)
        self.assertEqual(self.applied, ("071_bounded_runtime_evidence.sql", "072_scoped_media_lifecycle.sql",
                                        "073_layered_scenario_documents.sql", "074_layered_memory_coverage.sql", "075_layered_profile_generation.sql", "076_layered_memory_maintenance.sql"))
        self.assertEqual(migrate(self.url, MIGRATIONS), ())
        result = self.connection.execute("SELECT extraction_runtime_config FROM public.background_task "
                                        "WHERE id=%s", (self.task,)).fetchone()
        self.assertEqual(result, (None,))
        for table in ("memory_candidate", "confirmed_memory", "owner_memory"):
            rows = self.connection.execute(sql.SQL("SELECT source_dependency_mode FROM public.{}").format(
                sql.Identifier(table))).fetchall()
            self.assertEqual(rows, [("any",)])
        constraints = {row[0] for row in self.connection.execute("SELECT conname FROM pg_constraint")}
        self.assertTrue({"background_task_extraction_runtime_config_check",
            "memory_candidate_source_dependency_mode_check", "confirmed_memory_source_dependency_mode_check",
            "owner_memory_source_dependency_mode_check", "memory_candidate_dimension_evidence_version4_check"} <= constraints)

    def test_task_configuration_is_nullable_closed_and_strict(self) -> None:
        update = "UPDATE public.background_task SET extraction_runtime_config=%s WHERE id=%s"
        for config in (None, {"version": 1, "mode": "legacy", "rule_set_sha256": None},
                       {"version": 1, "mode": "bounded-runtime-v1", "rule_set_sha256": SHA}):
            self.connection.execute(update, (None if config is None else Jsonb(config), self.task))
        valid = {"version": 1, "mode": "bounded-runtime-v1", "rule_set_sha256": SHA}
        invalid = [True, [], {}, {**valid, "extra": 1}, {**valid, "version": True},
            {**valid, "version": 1.0}, {**valid, "version": "1"}, {**valid, "version": 2},
            {**valid, "mode": "other"}, {**valid, "rule_set_sha256": None},
            {**valid, "rule_set_sha256": "A" * 64}, {**valid, "mode": "legacy"}]
        for bad_config in invalid:
            with self.subTest(config=bad_config):
                self._reject(update, (Jsonb(bad_config), self.task))

    def test_dependency_modes_allow_null_evidence_but_not_null_or_unknown_mode(self) -> None:
        for table in ("memory_candidate", "confirmed_memory", "owner_memory"):
            query = sql.SQL("UPDATE public.{} SET source_dependency_mode=%s").format(sql.Identifier(table))
            self.connection.execute(query, ("all",))
            self.connection.execute(query, ("any",))
            with self.assertRaises(psycopg.errors.NotNullViolation):
                with self.connection.transaction():
                    self.connection.execute(query, (None,))
            self._reject(query, ("ALL",))
        self.connection.execute("UPDATE public.memory_candidate SET source_dependency_mode='all',dimension_evidence=NULL")

    def test_unknown_v4_snapshot_is_bounded_and_has_no_legacy_proof_fields(self) -> None:
        value = self._snapshot()
        self.assertTrue(self._shape(value))
        for changed in (None, {}, {**value, "extra": 1}, {**value, "version": True},
                        {**value, "version": 4.0}, {**value, "version": 3},
                        {**value, "reference": []}, {**value, "reported": []},
                        {**value, "target_message_ids": []}, {**value, "target_message_ids": [str(uuid4())]},
                        {**value, "target_message_ids": [str(self.message)] * 2},
                        {**value, "messages": value["messages"] * 2}, {**value, "semantic_basis": {"version": 2}}):
            with self.subTest(changed=changed):
                self.assertFalse(self._shape(changed))
        for length in (0, 4097):
            self.assertFalse(self._shape(value, length))
        for key, bad in (("text_length", True), ("text_length", 1.0), ("text_length", 0),
                         ("text_length", 4097), ("occurred_at", "2026-10-17T20:00:00"),
                         ("occurred_at", "2026-02-30T20:00:00+08:00"), ("source_refs", [])):
            changed = deepcopy(value)
            changed["messages"][0][key] = bad
            with self.subTest(key=key, bad=bad):
                self.assertEqual(self._shape(changed), key == "source_refs")

    def test_basis3_is_a_closed_independent_shape_with_linked_ordered_members(self) -> None:
        value = self._basis()
        self.assertTrue(self._basis_shape(value))
        bad = [None, {}, {**value, "extra": True}, {**value, "version": 2}, {**value, "version": 3.0},
               {**value, "version": True}, {**value, "rules": []}, {**value, "roles": []},
               {**value, "unresolved": [{}]}, {**value, "frame": "reported_request"},
               {**value, "capabilities": list(reversed(value["capabilities"]))},
               {**value, "capabilities": ["direct_attribution", "reported_attribution"]},
               {**value, "candidate_graph_sha256": "b" * 64}]
        changes = [
            (("rules", 0, "rule_version"), True), (("rules", 0, "rule_version"), 1.0),
            (("rules", 0, "rule_id"), "AUTHOR_ARRIVAL_H1"),
            (("roles", 0, "role_id"), 1), (("roles", 0, "owner"), "self"),
            (("roles", 1, "kind"), "vehicle"), (("roles", 1, "sender"), "contact"),
            (("roles", 0, "source", "span", "start"), True),
            (("roles", 0, "source", "message_id"), str(uuid4())),
            (("roles", 0, "candidate", "end"), 4097),
            (("roles", 0, "candidate", "end"), 14),
            (("atoms", 0, "atom_id"), 1.0), (("atoms", 0, "phase"), "planned"),
            (("atoms", 0, "roles", "destination"), 0), (("atoms", 0, "roles", "object"), 1),
            (("atoms", 0, "roles", "actor"), None),
            (("qualifiers", 0, "atom_id"), 8), (("qualifiers", 0, "slot"), "requested_time"),
            (("reference_bindings", 0, "method"), "source_identity"),
            (("representation", "quote_sources", 0, "message_id"), str(uuid4())),
            (("representation", "whole", "start"), 1), (("representation", "quote", "end"), 11),
        ]
        for path, replacement in changes:
            changed = deepcopy(value)
            target = changed
            for component in path[:-1]:
                target = target[component]
            target[path[-1]] = replacement
            bad.append(changed)
        for invalid_payload in bad:
            with self.subTest(changed=invalid_payload):
                self.assertFalse(self._basis_shape(invalid_payload))

    def test_v4_checks_actual_member_window_target_and_candidate_ranges(self) -> None:
        value = self._proved_shape_snapshot()
        self.assertTrue(self._shape(value, 13))
        self.assertFalse(self._shape(value, 14))
        changes: list[tuple[tuple[str | int, ...], object]] = [
            (("pragmatics",), None), (("messages", 0, "source_refs"), []),
            (("messages", 0, "text_representation"), "processed_text"),
            (("messages", 0, "source_state_sha256"), None),
            (("semantic_basis", "roles", 0, "source", "message_id"), str(uuid4())),
            (("semantic_basis", "roles", 0, "source", "span", "end"), 6),
            (("semantic_basis", "roles", 0, "candidate", "end"), 14),
            (("semantic_basis", "representation", "source_full", 0, "span", "end"), 4),
            (("semantic_basis", "representation", "source_full", 0, "span", "sha256"), "b" * 64),
            (("semantic_basis", "representation", "target_message_id"), str(uuid4()))]
        for path, replacement in changes:
            changed = deepcopy(value)
            target = changed
            for component in path[:-1]:
                target = target[component]
            target[path[-1]] = replacement
            with self.subTest(path=path):
                self.assertFalse(self._shape(changed, 13))

    def test_table_pairs_all_with_only_v4_and_retains_old_any_contract(self) -> None:
        query = "UPDATE public.memory_candidate SET dimension_evidence=%s,source_dependency_mode=%s,text_content=%s"
        body = "联系人原话：“我刚到家。”"
        self.assertEqual(len(body), 13)
        value = self._proved_shape_snapshot()
        self.connection.execute(query, (Jsonb(value), "all", body))
        self._reject(query, (Jsonb(value), "any", body))
        legacy_extra = {**deepcopy(value), "version": 1}
        del legacy_extra["target_message_ids"]
        # 旧v1宽字段保持；其中附加的semantic_basis不被解释为新依据。
        self.connection.execute(query, (Jsonb(legacy_extra), "any", body))
        self._reject(query, (Jsonb(legacy_extra), "all", body))
        self.connection.execute(query, (Jsonb(value), "all", body))
        self.connection.execute("UPDATE public.memory_candidate SET dimension_evidence=NULL")
        self.assertEqual(self.connection.execute("SELECT source_dependency_mode FROM public.memory_candidate").fetchone(), ("all",))
        for version in (1, 2, 3):
            old = self._snapshot()
            old["version"] = version
            del old["target_message_ids"]
            if version == 1:
                old["legacy_extra"] = "原先允许的字段不在新版本重解释"
            with self.subTest(version=version):
                self.connection.execute(query, (Jsonb(old), "any", body))
                self._reject(query, (Jsonb(old), "all", body))
        for field, replacement in (("owner_id", str(uuid4())), ("contact_id", str(uuid4()))):
            changed = deepcopy(value)
            changed["scope"][field] = replacement
            self._reject(query, (Jsonb(changed), "all", body))
        self.connection.execute(query, (Jsonb(value), "all", body))
        self._reject("UPDATE public.memory_candidate SET source_ids=%s", ([uuid4()],))

    def test_nested_unknown_keys_never_become_partial_valid_basis_or_snapshot(self) -> None:
        value = self._proved_shape_snapshot()
        paths = [("scope",), ("messages", 0), ("messages", 0, "source_refs", 0), ("pragmatics",),
            ("semantic_basis",), ("semantic_basis", "rules", 0), ("semantic_basis", "roles", 0),
            ("semantic_basis", "roles", 0, "source"), ("semantic_basis", "roles", 0, "source", "span"),
            ("semantic_basis", "atoms", 0), ("semantic_basis", "atoms", 0, "roles"),
            ("semantic_basis", "qualifiers", 0), ("semantic_basis", "reference_bindings", 0),
            ("semantic_basis", "representation"), ("semantic_basis", "representation", "whole")]
        for path in paths:
            changed = deepcopy(value)
            target = changed
            for component in path:
                target = target[component]
            target["unknown"] = True
            with self.subTest(path=path):
                self.assertFalse(self._shape(changed, 13))

    def test_full_window_background_does_not_become_a_body_source_but_used_context_does(self) -> None:
        value = self._proved_shape_snapshot()
        other = str(uuid4())
        message = deepcopy(value["messages"][0])
        message["message_id"] = other
        value["messages"].insert(0, message)
        rep = value["semantic_basis"]["representation"]
        full = deepcopy(rep["source_full"][0])
        full["message_id"] = other
        rep["source_full"].insert(0, full)
        self.assertTrue(self._shape(value, 13))
        query = "UPDATE public.memory_candidate SET dimension_evidence=%s,source_dependency_mode='all',text_content=%s"
        self.connection.execute(query, (Jsonb(value), "联系人原话：“我刚到家。”"))
        changed = deepcopy(value)
        changed["semantic_basis"]["roles"][1]["source"]["message_id"] = other
        self.assertTrue(self._shape(changed, 13))
        self._reject(query, (Jsonb(changed), "联系人原话：“我刚到家。”"))
        self.connection.execute("UPDATE public.memory_candidate SET source_ids=%s", ([self.message, UUID(other)],))
        self.connection.execute(query, (Jsonb(changed), "联系人原话：“我刚到家。”"))
        changed["target_message_ids"] = [str(self.message), other]
        self.assertFalse(self._shape(changed, 13))
        changed["target_message_ids"] = [other, str(self.message)]
        self.assertTrue(self._shape(changed, 13))
        changed["semantic_basis"]["representation"]["source_full"].reverse()
        self.assertFalse(self._shape(changed, 13))

    def test_all_six_rule_member_shapes_and_qualifier_order_remain_distinct(self) -> None:
        base = self._basis()
        for rule in ("BR_AUTHOR_ARRIVAL_V1", "BR_COMPLETED_QA_V1", "BR_KIN_LEND_V1",
                     "BR_TWO_ROLES_V1", "BR_REQUEST_V1", "BR_COND_RUN_V1"):
            value = deepcopy(base)
            value["rules"][0]["rule_id"] = rule
            if rule in {"BR_KIN_LEND_V1", "BR_TWO_ROLES_V1", "BR_REQUEST_V1"}:
                for identifier, kind in ((1, "elder_sister"), (2, "elder_brother")):
                    role = deepcopy(base["roles"][0])
                    role.update(role_id=identifier, kind=kind, sender=None)
                    if identifier == 1:
                        value["roles"][1] = role
                    else:
                        value["roles"].append(role)
                binding = deepcopy(base["reference_bindings"][0])
                binding.update(role_id=2, method="source_identity", binding=deepcopy(binding["mention"]))
                value["reference_bindings"].append(binding)
            if rule in {"BR_KIN_LEND_V1", "BR_TWO_ROLES_V1"}:
                object_role = deepcopy(base["roles"][1])
                object_role.update(role_id=3, kind="book")
                value["roles"].append(object_role)
                atom = value["atoms"][0]
                atom["predicate"] = "lend"
                atom["roles"] = {"agent": 1, "recipient": 0, "object": 3, "property_owner": 2,
                                 "beneficiary": None, "actor": None, "destination": None}
                value["qualifiers"][0].update(kind="polarity", slot="predicate")
            elif rule == "BR_REQUEST_V1":
                value["frame"] = "reported_request"
                value["capabilities"][3] = "reported_attribution"
                outer = value["atoms"][0]
                outer.update(predicate="request", phase="historical")
                outer["roles"] = {"agent": 1, "recipient": 0, "object": None, "property_owner": None,
                                  "beneficiary": None, "actor": None, "destination": None}
                inner = deepcopy(outer)
                inner.update(atom_id=1, predicate="cover_shift", phase="requested")
                inner["roles"].update(agent=None, recipient=None, actor=0, beneficiary=2)
                value["atoms"].append(inner)
                qualifier = deepcopy(value["qualifiers"][0])
                qualifier.update(qualifier_id=1, atom_id=1, slot="requested_time")
                value["qualifiers"].append(qualifier)
            elif rule == "BR_COND_RUN_V1":
                value["roles"] = value["roles"][:1]
                first = value["atoms"][0]
                first.update(predicate="clear_weather", phase="condition")
                first["roles"] = {key: None for key in first["roles"]}
                second = deepcopy(first)
                second.update(atom_id=1, predicate="run", phase="planned")
                second["roles"]["actor"] = 0
                value["atoms"].append(second)
                quantity = deepcopy(value["qualifiers"][0])
                quantity.update(kind="quantity", atom_id=1, slot="distance")
                degree = {key: deepcopy(quantity[key]) for key in ("source", "candidate", "value_sha256")}
                degree.update(qualifier_id=1, kind="degree", quantity_qualifier_id=0, modifier="only")
                approximate = {**deepcopy(degree), "qualifier_id": 2, "modifier": "approx"}
                condition = {key: deepcopy(quantity[key]) for key in ("source", "candidate")}
                condition.update(qualifier_id=3, kind="condition", condition_atom_id=0, action_atom_id=1, relation="requires")
                time = {**deepcopy(quantity), "qualifier_id": 4, "kind": "time", "slot": "event_time"}
                value["qualifiers"] = [quantity, degree, approximate, condition, time]
            with self.subTest(rule=rule):
                self.assertTrue(self._basis_shape(value))
                bad = deepcopy(value)
                bad["atoms"][0]["phase"] = "requested"
                self.assertFalse(self._basis_shape(bad))
                if rule == "BR_REQUEST_V1":
                    received = deepcopy(value)
                    received["frame"] = "received_request"
                    received["atoms"][0]["predicate"] = "receive_request"
                    self.assertTrue(self._basis_shape(received))
                if len(value["qualifiers"]) > 1:
                    value["qualifiers"].reverse()
                    for index, qualifier in enumerate(value["qualifiers"]):
                        qualifier["qualifier_id"] = index
                    self.assertFalse(self._basis_shape(value))

    def test_v4_limits_source_order_context_sources_and_oversize_null(self) -> None:
        value = self._snapshot()
        messages = []
        for _ in range(5):
            message = deepcopy(value["messages"][0])
            message["message_id"] = str(uuid4())
            messages.append(message)
        self.assertFalse(self._shape({**value, "messages": messages, "target_message_ids": [messages[0]["message_id"]]}))
        refs = [{"ref_id": str(uuid4()), "source_id": str(uuid4())} for _ in range(65)]
        refs.sort(key=lambda item: item["ref_id"])
        for bad_refs in (refs, [refs[0], refs[0]], [refs[1], refs[0]]):
            changed = deepcopy(value)
            changed["messages"][0]["source_refs"] = bad_refs
            self.assertFalse(self._shape(changed))
        value = self._proved_shape_snapshot()
        other = deepcopy(value["messages"][0])
        other.update(message_id=str(uuid4()), sender="self")
        value["messages"].append(other)
        rep = value["semantic_basis"]["representation"]
        full = deepcopy(rep["source_full"][0])
        full["message_id"] = other["message_id"]
        rep["source_full"].append(full)
        context = {"source": {"message_id": other["message_id"], "span": {"start": 0, "end": 3, "sha256": SHA}},
                   "whole": {"start": 19, "end": 27, "sha256": SHA},
                   "author": {"start": 19, "end": 21, "sha256": SHA},
                   "quote": {"start": 23, "end": 26, "sha256": SHA}}
        rep["contexts"] = [context]
        rep["whole"]["end"] = 28
        self.assertTrue(self._shape(value, 28))
        body = "联系人原话：“我刚到家。”（相关原文：用户说“说明。”）"
        query = "UPDATE public.memory_candidate SET dimension_evidence=%s,source_dependency_mode='all',text_content=%s"
        self._reject(query, (Jsonb(value), body))
        self.connection.execute("UPDATE public.memory_candidate SET source_ids=%s", ([self.message, UUID(other["message_id"])],))
        self.connection.execute(query, (Jsonb(value), body))
        duplicate = deepcopy(value)
        second = deepcopy(context)
        for part in ("whole", "author", "quote"):
            second[part]["start"] += 9
            second[part]["end"] += 9
        duplicate["semantic_basis"]["representation"]["contexts"].append(second)
        duplicate["semantic_basis"]["representation"]["whole"]["end"] = 37
        self.assertFalse(self._shape(duplicate, 37))
        rep["contexts"][0]["author"]["end"] = 22
        self.assertFalse(self._shape(value, 28))
        self.connection.execute("UPDATE public.memory_candidate SET source_dependency_mode='all',dimension_evidence=NULL,text_content=%s", ("字" * 4097,))
        self.assertEqual(self.connection.execute("SELECT source_dependency_mode,dimension_evidence FROM public.memory_candidate").fetchone(), ("all", None))

    def test_unknown_snapshot_still_requires_a_body_source_from_actual_targets(self) -> None:
        value = self._snapshot()
        other = deepcopy(value["messages"][0])
        other["message_id"] = str(uuid4())
        value["messages"].append(other)
        self.assertTrue(self._shape(value))
        self._reject("UPDATE public.memory_candidate SET source_ids=%s,dimension_evidence=%s,source_dependency_mode='all'",
                     ([UUID(other["message_id"])], Jsonb(value)))
