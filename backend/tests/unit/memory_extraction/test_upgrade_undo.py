"""本批连续自动版本的撤销顺序；原版本证明另由公开PG用例覆盖。"""

from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import UUID, uuid4

from notalone.memory.upgrade import UpgradeConflict
from notalone.memory.upgrade_snapshot import upgrade_digest
from notalone.persistence.memory_upgrade_apply import undo_batch


class ChainPort:
    def __init__(self, rows):
        self.rows = rows
        self.changes = []

    def revert_auto_update(self, *, memory_id, expected_revision, **scope):
        row = self.rows[memory_id]
        if row['status'] != 'active' or row['revision'] != expected_revision:
            raise UpgradeConflict('合成版本端口拒绝旧修订。')
        previous = self.rows[UUID(row['supersedes_memory_id'])]
        row['status'] = 'deleted'
        row['revision'] += 1
        previous['status'], previous['revision'] = 'active', expected_revision + 1
        self.changes.append(('revert', memory_id))
        return SimpleNamespace(memory_id=UUID(previous['id']), revision=previous['revision'])

    def delete(self, *args, **kwargs):
        identifier = kwargs.get('memory_id') or args[1]
        if any(row['supersedes_memory_id'] == str(identifier) for row in self.rows.values()):
            raise UpgradeConflict('原公开删除门拒绝仍有后代的资料。')
        self.rows[identifier]['status'] = 'deleted'
        self.changes.append(('delete', identifier))


class UndoQueries:
    def __init__(self, batch, port):
        self.batch, self.port = batch, port
        self.detached = []

    def execute(self, query, params):
        if query.startswith('UPDATE public.confirmed_memory SET supersedes_memory_id=NULL') or query.startswith('UPDATE public.owner_memory SET supersedes_memory_id=NULL'):
            if "status='deleted'" not in query or "adoption_method='auto'" not in query:
                raise AssertionError('仅可脱离本批已撤销的自动后代。')
            owner_id, children, parent, *contact = params
            if owner_id != self.batch['owner_id'] or contact and contact != [self.batch['contact_id']]:
                raise AssertionError('撤销不能越过原范围。')
            count = 0
            for identifier in children:
                row = self.port.rows[identifier]
                if row['status'] == 'deleted' and row['supersedes_memory_id'] == str(parent):
                    row['supersedes_memory_id'] = None
                    count += 1
                    self.detached.append(identifier)
            return SimpleNamespace(rowcount=count)
        if query.startswith("UPDATE public.memory_upgrade_batch SET state='undone'"):
            return SimpleNamespace(rowcount=1)
        raise AssertionError('撤销出现未声明查询。')


class UpgradeUndoTest(unittest.TestCase):
    def _chain(self, *, kind, existing=False):
        table = 'owner_memory' if kind == 'owner' else 'confirmed_memory'
        identifiers = [uuid4() for _ in range(3)]
        rows = {identifier: {'id': str(identifier), 'status': 'active' if index == 2 else 'invalidated',
            'revision': 3 if index else 2, 'adoption_method': 'auto', 'source_candidate_id': None,
            'supersedes_memory_id': str(identifiers[index-1]) if index else None,
            'text_content': '合成自动版本'+str(index)} for index, identifier in enumerate(identifiers)}
        batch = {'id': uuid4(), 'owner_id': uuid4(), 'contact_id': uuid4(), 'applied_records': [
            {'table': table, 'id': str(identifier), 'revision': row['revision'],
             'supersedes': row['supersedes_memory_id'], 'digest': upgrade_digest(row)}
            for identifier, row in rows.items() if not existing or identifier != identifiers[0]]}
        return identifiers, batch, ChainPort(rows), table

    def _undo(self, batch, port, table):
        connection = UndoQueries(batch, port)
        with patch('notalone.persistence.memory_upgrade_apply._records', side_effect=lambda *_:
                   [(table, identifier, deepcopy(row)) for identifier, row in port.rows.items()]), \
                patch('notalone.persistence.memory_upgrade_apply._ports', return_value=(port, port)), \
                patch('notalone.persistence.memory_upgrade_traces.erase_upgrade_traces'):
            undo_batch(connection, 'synthetic-only', batch, 'owner' if table == 'owner_memory' else 'contact')
        return connection

    def test_whole_batch_chain_uses_restored_revision_and_preserves_public_delete_gate(self):
        for kind in ('contact', 'owner'):
            with self.subTest(kind=kind):
                ids, batch, port, table = self._chain(kind=kind)
                connection = self._undo(batch, port, table)
                self.assertEqual(port.changes, [('revert', ids[2]), ('revert', ids[1]), ('delete', ids[0])])
                self.assertTrue(all(row['status'] == 'deleted' for row in port.rows.values()))
                self.assertEqual(connection.detached, [ids[1]])

    def test_preexisting_ancestor_is_restored_without_detaching_its_version_history(self):
        ids, batch, port, table = self._chain(kind='contact', existing=True)
        connection = self._undo(batch, port, table)
        self.assertEqual(port.rows[ids[0]]['status'], 'active')
        self.assertEqual(connection.detached, [])
        self.assertEqual(port.rows[ids[1]]['supersedes_memory_id'], str(ids[0]))

    def test_user_change_still_rejects_entire_batch_before_any_revert(self):
        ids, batch, port, table = self._chain(kind='contact')
        port.rows[ids[1]]['text_content'] = '合成人工修改'
        with self.assertRaises(UpgradeConflict):
            self._undo(batch, port, table)
        self.assertEqual(port.changes, [])
