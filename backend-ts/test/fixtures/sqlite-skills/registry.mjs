import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {skillActions,skillSchemaSql,requireSkillRevision,requireSkillRun} from '../../../src/skills/sqlite/storage.ts';
import {skillMetadataDeletionDomain} from '../../../src/skills/sqlite/deletion.ts';
const skillDeletion=skillMetadataDeletionDomain();
// 仅隔离测试合同替身；生产 owner DDL 由实施02提供。
// 精确组合01底座，不重复正式registry已集成的02/14或其他领域。
const foundation=base.migrations.find(m=>m.version===1);
const version=foundation.version;
export const registry={migrations:[foundation,
 {version:version+1,sql:"CREATE TABLE owner(owner_id TEXT PRIMARY KEY,state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleting','deleted'))) STRICT;"},
 {version:version+2,sql:skillSchemaSql+`
CREATE TABLE fixture_scope(owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,call_id TEXT NOT NULL,active INTEGER NOT NULL, PRIMARY KEY(owner_id,contact_id,call_id)) STRICT;
CREATE TABLE fixture_input(owner_id TEXT NOT NULL,contact_id TEXT NOT NULL,call_id TEXT NOT NULL,input_no INTEGER NOT NULL,text TEXT NOT NULL,package_id TEXT NOT NULL,revision_no INTEGER NOT NULL,relative_path TEXT NOT NULL,PRIMARY KEY(owner_id,contact_id,call_id,input_no),FOREIGN KEY(owner_id,contact_id,call_id) REFERENCES fixture_scope(owner_id,contact_id,call_id)) STRICT;
`}],actions:[...skillActions,
 {name:'fixture.owner',mode:'write',retryBusy:false,execute(tx,i){tx.run('INSERT INTO owner(owner_id) VALUES(?)',[i.ownerId]);}},
 {name:'fixture.skillFence',mode:'write',retryBusy:false,execute(tx,i){return skillDeletion.fence(tx,i);}},
 {name:'fixture.skillTargets',mode:'read',retryBusy:false,execute(tx,i){return skillDeletion.collect(tx,i);}},
 {name:'fixture.skillClear',mode:'write',retryBusy:false,execute(tx,i){skillDeletion.clearRow(tx,i.operation,i.target);}},
 {name:'fixture.skillVerify',mode:'read',retryBusy:false,execute(tx,i){return skillDeletion.verify(tx,i);}},
 {name:'fixture.skillCounts',mode:'read',retryBusy:false,execute(tx,i){return tx.get('SELECT (SELECT count(*) FROM skill_package WHERE owner_id=?)+(SELECT count(*) FROM skill_package_revision WHERE owner_id=?) AS n',[i.ownerId,i.ownerId]).n;}},
 {name:'fixture.ownerState',mode:'write',retryBusy:false,execute(tx,i){tx.run('UPDATE owner SET state=? WHERE owner_id=?',[i.state,i.ownerId]);}},
 {name:'fixture.invalidEnabledOrigin',mode:'write',retryBusy:false,execute(tx,i){tx.run("UPDATE skill_package SET enabled_state='enabled',enabled_origin=NULL WHERE owner_id=? AND id=?",[i.ownerId,i.id]);}},
 {name:'fixture.mutateAnchor',mode:'write',retryBusy:false,execute(tx,i){tx.run("UPDATE skill_package_revision SET content_digest=? WHERE owner_id=? AND package_id=?",['0'.repeat(64),i.ownerId,i.id]);}},
 {name:'fixture.scope',mode:'write',retryBusy:false,execute(tx,i){tx.run('INSERT INTO fixture_scope VALUES(?,?,?,1)',[i.ownerId,i.contactId,i.callId]);}},
 {name:'fixture.checkScope',mode:'read',retryBusy:false,execute(tx,i){checkScope(tx,i.scope??i);if(i.revision)requireSkillRun(tx,(i.scope??i).ownerId,i.revision);}},
 {name:'fixture.input',mode:'write',retryBusy:false,execute(tx,i){
  checkScope(tx,i.scope);requireSkillRun(tx,i.scope.ownerId,i.runRevision);requireSkillRevision(tx,i.scope.ownerId,i.loaded);
  const count=tx.get('SELECT count(*) AS n FROM fixture_input WHERE owner_id=? AND contact_id=? AND call_id=?',[i.scope.ownerId,i.scope.contactId,i.scope.callId]).n;
  tx.run('INSERT INTO fixture_input VALUES(?,?,?,?,?,?,?,?)',[i.scope.ownerId,i.scope.contactId,i.scope.callId,count+1n,i.text,i.loaded.packageId,i.loaded.revisionNo,i.relativePath]);
 }},
 {name:'fixture.inputs',mode:'read',retryBusy:false,execute(tx,i){return tx.all('SELECT * FROM fixture_input WHERE owner_id=? AND contact_id=? AND call_id=?',[i.ownerId,i.contactId,i.callId]);}},
 {name:'fixture.revoke',mode:'write',retryBusy:false,execute(tx,i){
  tx.run('UPDATE fixture_scope SET active=0 WHERE owner_id=? AND contact_id=? AND call_id=?',[i.ownerId,i.contactId,i.callId]);
  tx.run('DELETE FROM fixture_input WHERE owner_id=? AND contact_id=? AND call_id=?',[i.ownerId,i.contactId,i.callId]);
 }},
]};
function checkScope(tx,i){
 const row=tx.get('SELECT active FROM fixture_scope WHERE owner_id=? AND contact_id=? AND call_id=?',[i.ownerId,i.contactId,i.callId]);
 if(row?.active!==1n)throw new StorageFailure('fixture_scope_revoked');
}
