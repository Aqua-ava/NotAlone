"""仅验证逻辑目录一致性，不编译DDL或声称业务集成通过。"""
from pathlib import Path
import collections
import json
import re

root = Path(__file__).resolve().parent
catalog = json.loads((root / 'consolidated-schema.json').read_text())
tables = catalog['tables']
by = {table['name']: table for table in tables}
assert len(tables) == len(by) == catalog['count']
assert dict(collections.Counter(t['group'] for t in tables)) == catalog['group_counts']
assert not set(by) & {'message_version', 'memory_candidate_version', 'material_set', 'material_reference'}
fk_count = 0
for table in tables:
    fields = {field['name']: field for field in table['field_contract']}
    assert len(fields) == len(table['field_contract']), table['name']
    assert {v.strip().rstrip('?') for v in table['fields'].split(';')} == fields.keys(), table['name']
    pk = table['primary_key'].split(',')
    assert set(pk) <= fields.keys(), table['name']
    assert all(not fields[key]['nullable'] for key in pk), table['name']
    assert len(table['foreign_keys']) == len(table['foreign_key_contracts']), table['name']
    for key in table.get('unique_keys', []):
        assert key and len(key) == len(set(key)) and set(key) <= fields.keys(), (table['name'], key)
    for fk in table['foreign_key_contracts']:
        target = by[fk['referenced_table']]
        parent_fields = {field['name'] for field in target['field_contract']}
        assert len(fk['columns']) == len(fk['referenced_columns']), (table['name'], fk)
        assert set(fk['columns']) <= fields.keys(), (table['name'], fk)
        assert set(fk['referenced_columns']) <= parent_fields, (table['name'], fk)
        expected = target['primary_key'].split(',')
        candidate_keys = target.get('unique_keys', [])
        assert fk['referenced_columns'] == expected or fk['referenced_columns'] in candidate_keys, (table['name'], fk)
        fk_count += 1
assert catalog['media_decisions']['confirmed'] == 'Q1-Q11'
assert set(['message_media','media_extraction_attempt','media_file']) <= by.keys()
assert 'message_identity' in {f['name'] for f in by['deletion_operation']['field_contract']}
assert catalog['group_counts']['媒体提取'] == 3
main = (root / 'greenfield-design.md').read_text()
cards = re.findall(r'^#### \d+\. `([^`]+)`$', main, re.M)
assert cards == [table['name'] for table in tables]
for table in tables:
    assert f"- 字段：`{table['fields']}`" in main, table['name']
    assert '- 约束：' + table['constraints'] in main, table['name']
# Every diagram edge must have a registered FK in either direction.
for left, right in re.findall(r'^  (\w+) [|o}{]+--[|o}{]+ (\w+) :', main, re.M):
    assert left in by and right in by, (left, right)
    assert any(fk['referenced_table'] == right for fk in by[left]['foreign_key_contracts']) or any(
        fk['referenced_table'] == left for fk in by[right]['foreign_key_contracts']), (left, right)
relations = (root / 'schema-relations.md').read_text()
local_nodes = re.findall(r'^  (\w+)\[.*\]:::local$', relations, re.M)
assert set(local_nodes) == by.keys() and len(local_nodes) == len(by)
expected_pairs = {(fk['referenced_table'], table['name']) for table in tables for fk in table['foreign_key_contracts']}
actual_pairs = set(re.findall(r'^  (\w+) --> (\w+)$', relations, re.M))
assert expected_pairs == actual_pairs
legacy = json.loads((root / 'legacy-coverage.json').read_text())['tables']
review = json.loads((root / 'consolidated-legacy-check.json').read_text())['tables']
assert {row['old_table'] for row in legacy} == {row['old_table'] for row in review}
assert len(review) == len({row['old_table'] for row in review})
assert all(set(row['targets']) <= by.keys() for row in review)
for filename in ['greenfield-design.md', 'sketch-review.md', 'consolidated-legacy-check.md', 'handoff.md', 'schema-relations.md']:
    for link in re.findall(r'\]\(([^)]+)\)', (root / filename).read_text()):
        if '://' not in link and not link.startswith('#'):
            assert (root / link.split('#')[0]).exists(), (filename, link)
assert len((root / 'handoff.md').read_text().splitlines()) <= 40
print(json.dumps({'result': 'pass', 'scope': 'logical_catalog_consistency_only',
    'tables': len(tables), 'fields': sum(len(t['field_contract']) for t in tables),
    'explicit_base_foreign_keys': fk_count, 'legacy_names_reviewed': len(review),
    'diagram_relations_have_registered_fk': True, 'ddl_executed': False,
    'runtime_integration_verified': False, 'media_Q11_integrated': True}, ensure_ascii=False))
