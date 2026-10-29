import { registry as base } from '../../../src/storage/sqlite/registry.ts';
import { createDeletionActions } from '../../../src/storage/sqlite/deletion/actions.ts';

const sampleMigration = { version: base.migrations.length + 1, sql: `
CREATE TABLE sample_scope(owner TEXT PRIMARY KEY,generation INTEGER NOT NULL) STRICT;
CREATE TABLE sample_body(owner TEXT NOT NULL,contact TEXT NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,body TEXT NOT NULL,eligible INTEGER NOT NULL,PRIMARY KEY(owner,id)) STRICT;
CREATE TABLE sample_ledger(owner TEXT NOT NULL,contact TEXT NOT NULL,id TEXT PRIMARY KEY) STRICT;
CREATE TABLE sample_file(id TEXT PRIMARY KEY,payload TEXT NOT NULL,cleared INTEGER NOT NULL) STRICT;
CREATE TABLE sample_control(slot INTEGER PRIMARY KEY,value INTEGER NOT NULL) STRICT;
` };
const matches = (op) => op.scope.kind === 'account' ? [op.ownerId] : op.scope.kind === 'source' ? [op.ownerId, op.scope.sourceId] : [op.ownerId, op.scope.contactId];
const where = op => op.scope.kind === 'account' ? 'owner=?' : op.scope.kind === 'source' ? 'owner=? AND source=?' : 'owner=? AND contact=?';
const okay = { result: 'passed', proof: 'sample_verified' };
const domain = {
  id: 'sample', rowKinds: { sample_body: {keys: ['owner', 'id'], ownerKey: 'owner'}, sample_ledger: {keys: ['owner', 'id'], ownerKey: 'owner'} },
  fence(tx, op) { tx.run(`UPDATE sample_body SET eligible=0 WHERE ${where(op)}`, matches(op)); return [{ namespace: 'sample.process', key: 'old-request' }]; },
  collect(tx, op) {
    const targets = tx.all(`SELECT owner,id FROM sample_body WHERE ${where(op)}`, matches(op)).map(r => ({ kind: 'row', domain: 'sample', rowKind: 'sample_body', key: r, identity: 'v1', holderKeys: ['sample:copy'] }));
    if (['contact', 'account'].includes(op.scope.kind)) for (const row of tx.all(`SELECT owner,id FROM sample_ledger WHERE ${op.scope.kind === 'account' ? 'owner=?' : 'owner=? AND contact=?'}`, op.scope.kind === 'account' ? [op.ownerId] : [op.ownerId, op.scope.contactId])) targets.push({ kind: 'row', domain: 'sample', rowKind: 'sample_ledger', key: row, identity: 'v1', holderKeys: [] });
    targets.push(...tx.all('SELECT payload FROM sample_file WHERE cleared=0').map(r => JSON.parse(r.payload)));
    return targets;
  },
  clearRow(tx, op, target) {
    tx.run(`DELETE FROM ${target.rowKind} WHERE owner=? AND id=?`, [op.ownerId, target.key.id]);
    if (tx.get('SELECT 1 FROM sample_control WHERE value=1')) {
      tx.run('UPDATE sample_control SET value=0');
      tx.run("INSERT INTO sample_body VALUES('o','b','discovered','r1','合成新发现闭包',0)");
    }
  },
  fileCleared(tx, op, target) { tx.run('UPDATE sample_file SET cleared=1,payload=\'{}\' WHERE id=?', [target.fileId]); },
  authorizeFile(tx, op, target) { if (tx.get('SELECT 1 FROM sample_control WHERE value=2')) throw new Error('synthetic_file_retained'); },
  verify(tx, op) {
    const noRows = tx.get(`SELECT count(*) n FROM sample_body WHERE ${where(op)}`, matches(op)).n === 0n;
    return { database_rows: noRows ? okay : { result: 'blocked', proof: 'rows_remain' }, derived_eligibility: okay, trace_payloads: okay, request_replay: okay, scope_suppression: { result: 'not_applicable', proof: 'synthetic_no_channel' } };
  },
};
const authority = {
  fence(tx, owner) { tx.run('UPDATE sample_scope SET generation=generation+1 WHERE owner=?', [owner]); return tx.get('SELECT generation FROM sample_scope WHERE owner=?', [owner]).generation; },
  verify(tx, op) { return tx.get('SELECT generation FROM sample_scope WHERE owner=?', [op.ownerId]).generation >= op.acceptedGeneration ? okay : { result: 'blocked', proof: 'fence_missing' }; },
};
export const registry = { migrations: [...base.migrations, sampleMigration], actions: [
  ...base.actions.filter(a => !a.name.startsWith('deletion.')), ...createDeletionActions({ authority, domains: [domain], requiredDomains: ['sample'] }),
  { name: 'sample.seed', mode: 'write', retryBusy: false, execute(tx) {
    tx.run("INSERT INTO sample_scope VALUES('o',0)");
    tx.run("INSERT INTO sample_body VALUES('o','a','x','r1','合成来源正文',1)");
    tx.run("INSERT INTO sample_body VALUES('o','b','cross','r1','合成本人跨联系人贡献',1)");
    tx.run("INSERT INTO sample_ledger VALUES('o','a','call')");
  } },
  { name: 'sample.write', mode: 'write', retryBusy: false, execute(tx, input, lease) {
    if (tx.get("SELECT generation FROM sample_scope WHERE owner='o'").generation !== input.generation) return 'stale';
    return 'committed';
  } },
  { name: 'sample.read', mode: 'read', retryBusy: false, execute(tx) { return { bodies: tx.all('SELECT body,eligible FROM sample_body'), ledger: tx.get('SELECT count(*) n FROM sample_ledger').n, generation: tx.get("SELECT generation FROM sample_scope WHERE owner='o'").generation }; } },
  { name: 'sample.file', mode: 'write', retryBusy: false, execute(tx, input) { tx.run('INSERT INTO sample_file VALUES(?,?,0)', [input.fileId, JSON.stringify(input)]); } },
  { name: 'sample.replaceFileTarget', mode: 'write', retryBusy: false, execute(tx, input) { tx.run('UPDATE sample_file SET payload=? WHERE id=?', [JSON.stringify(input), input.fileId]); } },
  { name: 'sample.spawnOnClear', mode: 'write', retryBusy: false, execute(tx) { tx.run('INSERT INTO sample_control VALUES(1,1)'); } },
  { name: 'sample.retainFile', mode: 'write', retryBusy: false, execute(tx) { tx.run('INSERT INTO sample_control VALUES(1,2)'); } },
  { name: 'sample.large', mode: 'write', retryBusy: false, execute(tx) { tx.run("INSERT INTO sample_body VALUES('o','a','large','r1',?,1)", ['合成大正文'.repeat(100000)]); } },
  { name: 'sample.refill', mode: 'write', retryBusy: false, execute(tx) { tx.run("INSERT INTO sample_body VALUES('o','a','fresh','r3','新独立合成资料',1)"); } },
] };
