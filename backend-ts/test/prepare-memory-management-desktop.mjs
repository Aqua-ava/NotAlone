/** 仅准备本票隔离合成资料，不启动App、不读取微信或外部模型。 */
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
import {prepareMemoryDesktop} from './prepare-memory-desktop.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';import {owner,modelPort} from './fixtures/memory-sqlite/support.mjs';import {supplier} from './fixtures/memory-management/supplier.mjs';
import {adjudicationSupplier} from './fixtures/memory-management/adjudication-support.mjs';
import {SqliteMemoryAdjudication} from '../src/memory/sqlite/management/adjudication-service.ts';
import {SqliteContactService} from '../src/contacts/sqlite/service.ts';import {SqliteHistoryService} from '../src/history/sqlite/service.ts';import {ActiveHolders} from '../src/storage/sqlite/deletion/holders.ts';import {record} from './fixtures/memory-sqlite/support.mjs';
const f=await prepareMemoryDesktop();const plan=JSON.parse(await readFile(f.planPath,'utf8'));
let storage,extraction,adjudication,contacts,history;
try{
 storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:plan.databaseId});
 const normal=supplier();extraction=new SqliteMemoryExtraction(storage,owner,modelPort(()=>extraction.accounting,async(request,input)=>{
  if(request.purpose!=='extraction')return normal.respond(request,input);const payload=JSON.parse(request.user);
  return normal.respond({...request,user:JSON.stringify({...payload,messages:payload.messages.filter(m=>payload.target_message_ids.includes(m.message_id))})},input);
 }));const run=await extraction.start('08-desktop-normal-candidates');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(storage,owner);await management.importRun(run.runId);
 const directory=await storage.execute('identity.directory',{ownerId:owner}),[a,b]=directory.contacts.map(c=>c.contact_id);
 const candidateA=(await management.read({scopeKind:'contact',contactId:a})).candidates[0],candidateB=(await management.read({scopeKind:'contact',contactId:b})).candidates[0];
 await management.automatic({requestKey:'08-desktop-first-auto',action:'auto_accept',candidateIds:[candidateA.id],candidateRevisions:[candidateA.stateRevision]});
 const holders=new ActiveHolders();contacts=new SqliteContactService(storage,owner,{account:async()=>{throw Error('synthetic_metadata_unused');},sessions:async()=>{throw Error('synthetic_metadata_unused');}});
 const report={protocol:'private-history-v1',profileId:'synthetic-v1',adapterVersion:'1',status:'supported',reason:null,programVersion:'synthetic',build:'1',artifactSha256:'a'.repeat(64),schemaFingerprint:'b'.repeat(64),declaredPrimaryKey:['local_id'],identity:'source-table-local-v1',statusSemantics:'synthetic-final-rows',continuity:'synthetic-generation-1'};
 const target={protocol:'private-history-v1',descriptor:'08-synthetic-new-evidence',partitions:['shard-a'],tables:[{partition:'shard-a',instance:'table-instance-1'}],sourceGeneration:'source-1'};
 history=new SqliteHistoryService(storage,contacts,{inspect:async scope=>({...report,accountKey:scope.accountKey,conversationKey:scope.conversationKey,sourceGeneration:scope.token.source_generation}),target:async()=>target,page:async()=>({target:target.descriptor,cursorIn:null,cursorOut:null,records:[record('3',{text:'我现在长期住在台南。',sentAt:'1700000010000'})],completedPartitions:['shard-a'],exhausted:true})},holders);
 await contacts.setReading(true);await history.synchronize(a);await contacts.setReading(false);
 const updated=await extraction.start('08-desktop-new-evidence');await extraction.waitForIdle();
 adjudication=new SqliteMemoryAdjudication(storage,owner,{...modelPort(()=>extraction.accounting,adjudicationSupplier({action:'update'})),close:async()=>{}},holders);await adjudication.initialize();await adjudication.publishRun(updated.runId);
 const m=(await management.read({scopeKind:'contact',contactId:a})).memories[0];if(m?.current?.versionNo!=='2'||m.current.adoptionMode!=='auto'||m.current.body!=='联系人现在长期住在台南。')throw Error('synthetic_desktop_real_update_missing');
 const evidence={synthetic:true,userData:f.root,databaseId:plan.databaseId,planPath:f.planPath,contactA:a,contactB:b,memoryA:m.id,sourceA:candidateA.sources[0].recordId,sourceB:candidateB.sources[0].recordId,runId:run.runId,reading:false,preparedModel:'synthetic-only',appSupplierRequests:f.counts.requests};
 await adjudication.close();await extraction.close();await history.close();await contacts.close();await storage.check();await storage.close();await writeFile('/tmp/notalone08-management-prepared.json',JSON.stringify(evidence),{mode:0o600});console.log(JSON.stringify(evidence));
 let closing;const close=()=>closing??=f.close().then(()=>console.log(JSON.stringify({supplierStopped:true,appSupplierRequests:f.counts.requests})));process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
}catch(error){await adjudication?.close();await extraction?.close();await history?.close();await contacts?.close();await storage?.close();await f.close();throw error;}
