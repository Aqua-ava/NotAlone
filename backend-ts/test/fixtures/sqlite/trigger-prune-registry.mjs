import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {skillActions} from '../../../src/skills/sqlite/storage.ts';

const defaultEnable=skillActions.find(action=>action.name==='skills.defaultEnable');
export const registry={...base,migrations:base.migrations.filter(migration=>migration.version<=49),actions:[...base.actions,
 {name:'fixture.triggerNames',mode:'read',retryBusy:false,execute(tx){return tx.all("SELECT name,sql FROM sqlite_schema WHERE type='trigger' ORDER BY name");}},
 {name:'fixture.triggerSeed',mode:'write',retryBusy:false,execute(tx){
  tx.run("INSERT INTO owner(owner_id,created_at) VALUES('owner-a',0)");
  tx.run("INSERT INTO contact(owner_id,id,display_name) VALUES('owner-a','contact-a','合成联系人')");
  tx.run("INSERT INTO skill_package(owner_id,id,directory_name,directory_identity,display_name,description,enabled_state,enabled_origin,verification_state,verification_reason,current_revision_no,head_revision) VALUES('owner-a','skill-a','synthetic-skill','synthetic-directory','合成策略','合成策略说明','unknown',NULL,'verified',NULL,NULL,1)");
  tx.run("INSERT INTO skill_package_revision VALUES('owner-a','skill-a',1,?,?,'user_directory','verified',0,'unavailable')",['a'.repeat(64),'b'.repeat(64)]);
  tx.run("UPDATE skill_package SET current_revision_no=1 WHERE owner_id='owner-a' AND id='skill-a'");
 }},
 {name:'fixture.triggerState',mode:'read',retryBusy:false,execute(tx){return {
  owners:tx.all('SELECT owner_id FROM owner ORDER BY owner_id'),
  skill:tx.get("SELECT default_enabled,head_revision FROM skill_package WHERE owner_id='owner-a' AND id='skill-a'"),
  migrations:tx.all('SELECT version,checksum FROM schema_migration ORDER BY version'),
 };}},
 {name:'fixture.rollbackInvalidSkill',mode:'write',retryBusy:false,execute(tx,input,lease){
  tx.run("INSERT INTO owner(owner_id,created_at) VALUES('rollback-marker',0)");
  return defaultEnable.execute(tx,input,lease);
 }},
 {name:'fixture.invalidContact',mode:'write',retryBusy:false,execute(tx){
  tx.run("INSERT INTO contact(owner_id,id,display_name) VALUES('missing-owner','bad-contact','合成坏输入')");
 }},
 {name:'fixture.timelineWrites',mode:'write',retryBusy:false,execute(tx,input){
  tx.run('UPDATE memory SET management_timeline_dirty=? WHERE owner_id=? AND id=?',[input.dirty,'owner-a',input.memoryId]);
  const revision=()=>tx.get(input.self?"SELECT management_revision n FROM owner WHERE owner_id='owner-a'":"SELECT management_revision n FROM contact WHERE owner_id='owner-a' AND id='contact-a'").n;
  const before=revision(),writes=tx.get('SELECT total_changes() n').n;
  for(let n=0;n<input.count;n++)tx.run("UPDATE memory SET state=state WHERE owner_id='owner-a' AND id=?",[input.memoryId]);
  const writeDelta=tx.get('SELECT total_changes() n').n-writes;
  if(input.fail)throw Object.assign(new Error('fixture_rollback'),{code:'fixture_rollback'});
  return {revisionDelta:revision()-before,writeDelta,dirty:tx.get("SELECT management_timeline_dirty n FROM memory WHERE owner_id='owner-a' AND id=?",[input.memoryId]).n};
 }},
 {name:'fixture.timelineState',mode:'read',retryBusy:false,execute(tx,input){return {
  memory:tx.get("SELECT management_timeline_dirty FROM memory WHERE owner_id='owner-a' AND id=?",[input.memoryId]),
  owner:tx.get("SELECT management_revision FROM owner WHERE owner_id='owner-a'"),
  contact:tx.get("SELECT management_revision FROM contact WHERE owner_id='owner-a' AND id='contact-a'"),
 };}},
]};
