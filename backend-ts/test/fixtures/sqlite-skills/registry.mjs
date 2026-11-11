import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';
import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {skillActions,skillSchemaSql,skillDefaultEnablementMigration,skillDefaultQualificationMigration,requireSkillRevision,requireSkillRun} from '../../../src/skills/sqlite/storage.ts';
import {skillMetadataDeletionDomain} from '../../../src/skills/sqlite/deletion.ts';
import {skillGroupMigration,skillGroupAllPackagesMigration,skillGroupActions} from '../../../src/skills/sqlite/groups.ts';
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
`}, {version:version+3,sql:skillDefaultEnablementMigration.sql}, {version:version+4,sql:skillDefaultQualificationMigration.sql},
 // 隔离夹具只需要联系人的最小外键目标；生产 contact 由身份迁移提供。
 {version:version+5,sql:"CREATE TABLE contact(owner_id TEXT NOT NULL,id TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','deleting','deleted')),PRIMARY KEY(owner_id,id)) STRICT;"},
 {version:version+6,sql:skillGroupMigration(version+6).sql+`
CREATE TRIGGER fixture_all_group_follow AFTER INSERT ON skill_package
BEGIN INSERT INTO skill_group_package SELECT NEW.owner_id,id,NEW.id FROM skill_group WHERE owner_id=NEW.owner_id AND name='fixture-all'; END;`},
 {version:version+7,sql:skillGroupAllPackagesMigration(version+7).sql}],actions:[...skillActions,...skillGroupActions,
 {name:'fixture.contact',mode:'write',retryBusy:false,execute(tx,i){tx.run('INSERT OR IGNORE INTO contact(owner_id,id) VALUES(?,?)',[i.ownerId,i.contactId]);}},
 {name:'fixture.contactState',mode:'write',retryBusy:false,execute(tx,i){tx.run('UPDATE contact SET state=? WHERE owner_id=? AND id=?',[i.state,i.ownerId,i.contactId]);}},
 {name:'fixture.deleteContact',mode:'write',retryBusy:false,execute(tx,i){tx.run('DELETE FROM contact WHERE owner_id=? AND id=?',[i.ownerId,i.contactId]);}},
 {name:'fixture.owner',mode:'write',retryBusy:false,execute(tx,i){tx.run('INSERT INTO owner(owner_id) VALUES(?)',[i.ownerId]);}},
 {name:'fixture.skillFence',mode:'write',retryBusy:false,execute(tx,i){return skillDeletion.fence(tx,i);}},
 {name:'fixture.skillTargets',mode:'read',retryBusy:false,execute(tx,i){return skillDeletion.collect(tx,i);}},
 {name:'fixture.skillClear',mode:'write',retryBusy:false,execute(tx,i){skillDeletion.clearRow(tx,i.operation,i.target);}},
 {name:'fixture.skillVerify',mode:'read',retryBusy:false,execute(tx,i){return skillDeletion.verify(tx,i);}},
 {name:'fixture.skillCounts',mode:'read',retryBusy:false,execute(tx,i){return tx.get('SELECT (SELECT count(*) FROM skill_package WHERE owner_id=?)+(SELECT count(*) FROM skill_package_revision WHERE owner_id=?) AS n',[i.ownerId,i.ownerId]).n;}},
 {name:'fixture.ownerState',mode:'write',retryBusy:false,execute(tx,i){tx.run('UPDATE owner SET state=? WHERE owner_id=?',[i.state,i.ownerId]);}},
 {name:'fixture.invalidEnabledOrigin',mode:'write',retryBusy:false,execute(tx,i){tx.run("UPDATE skill_package SET enabled_state='enabled',enabled_origin=NULL WHERE owner_id=? AND id=?",[i.ownerId,i.id]);}},
 {name:'fixture.forceDefaultEnable',mode:'write',retryBusy:false,execute(tx,i){tx.run('UPDATE skill_package SET default_enabled=1 WHERE owner_id=? AND id=?',[i.ownerId,i.id]);}},
 {name:'fixture.mutateAnchor',mode:'write',retryBusy:false,execute(tx,i){tx.run("UPDATE skill_package_revision SET content_digest=? WHERE owner_id=? AND package_id=?",['0'.repeat(64),i.ownerId,i.id]);}},
 {name:'fixture.scope',mode:'write',retryBusy:false,execute(tx,i){
  tx.run('INSERT INTO fixture_scope VALUES(?,?,?,1)',[i.ownerId,i.contactId,i.callId]);
  // 既有 Skill 机制测试默认让联系人使用全部 Skill；分组门禁由专门测试验证，可用 noGroup 关闭。
  if(i.noGroup)return;
  tx.run('INSERT OR IGNORE INTO contact(owner_id,id) VALUES(?,?)',[i.ownerId,i.contactId]);
  let group=tx.get("SELECT id FROM skill_group WHERE owner_id=? AND name='fixture-all'",[i.ownerId]);
  if(!group){
   tx.run("INSERT INTO skill_group(owner_id,id,name,revision,created_at) VALUES(?,'fixture-all-group','fixture-all',1,0)",[i.ownerId]);
   tx.run("INSERT INTO skill_group_package SELECT owner_id,'fixture-all-group',id FROM skill_package WHERE owner_id=?",[i.ownerId]);
   group={id:'fixture-all-group'};
  }
  tx.run('INSERT OR IGNORE INTO contact_skill_group(owner_id,contact_id,group_id) VALUES(?,?,?)',[i.ownerId,i.contactId,group.id]);
 }},
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
