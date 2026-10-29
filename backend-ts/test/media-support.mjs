import {mkdtemp,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';
import {SqliteHistoryService} from '../src/history/sqlite/service.ts';
import {SqliteMediaService} from '../src/media/sqlite/service.ts';
export async function fixture(t,adapter=null){
 const root=await realpath(await mkdtemp(join(tmpdir(),'notalone-media-')));
 const storage=await SqliteStorage.open({userData:root,intent:'create',role:'test',registryModule:new URL('./fixtures/media/registry.mjs',import.meta.url).href});
 const owner='00000000-0000-4000-8000-000000000001';
 const metadata={account:async()=>({externalKey:'synthetic-account',identityScheme:'wechat.account.v1',sourceGeneration:'source-1',assurance:'verified',supportProfile:'synthetic-metadata-v1'}),sessions:async()=>[{externalKey:'friend-a',displayName:'合成甲',kind:'private',identityAssurance:'verified'},{externalKey:'friend-b',displayName:'合成乙',kind:'private',identityAssurance:'verified'}]};
 const contacts=new SqliteContactService(storage,owner,metadata);await contacts.initialize();const candidate=await contacts.detectAccount();await contacts.confirmAccount(candidate.candidate_token);await contacts.setReading(true);const snapshot=await contacts.candidates(true);const saved=await contacts.confirm(snapshot.snapshot_token,snapshot.sessions.map(s=>({locator:s.username,observed_display_name:s.display_name,expected_selection_generation:s.selection_generation})));
 const report={protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'synthetic-1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};
 const target={protocol:'private-history-v1',descriptor:'synthetic-fixed',partitions:['a'],tables:[{partition:'a',instance:'one'}],sourceGeneration:'source-1'};
 const channel={inspect:async s=>({...report,accountKey:s.accountKey,conversationKey:s.conversationKey,sourceGeneration:s.token.source_generation}),target:async()=>target,page:async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:['image','voice','video','text'].map((kind,i)=>({partition:'a',table:'one',localId:String(i+1),serverId:'0',sender:'contact',kind,text:kind==='text'?'合成文字':null,originalType:kind,sentAt:null,timePrecision:null,orderScheme:null,orderKey:null})),completedPartitions:['a'],exhausted:true})};
 const history=new SqliteHistoryService(storage,contacts,channel);const contact=saved.bindings[0].contact_id;await history.synchronize(contact);const messages=(await history.read(contact)).messages;
 const media=new SqliteMediaService({storage,contacts,history,userData:root,adapters:adapter?[adapter]:[]});await media.initialize();
 t.after(async()=>{await media.close();await history.close();await contacts.close();await storage.close();await rm(root,{recursive:true,force:true});});
 return {root,storage,contacts,history,media,owner,contact,messages,saved:saved.bindings};
}
