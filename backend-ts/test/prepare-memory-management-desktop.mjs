/** 仅准备本票隔离合成资料，不启动App、不读取微信或外部模型。 */
import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
import {prepareMemoryDesktop} from './prepare-memory-desktop.mjs';
import {SqliteStorage} from '../src/storage/sqlite/client.ts';import {SqliteMemoryExtraction} from '../src/memory/sqlite/service.ts';
import {SqliteMemoryManagement} from '../src/memory/sqlite/management/service.ts';import {owner,modelPort} from './fixtures/memory-sqlite/support.mjs';import {supplier} from './fixtures/memory-management/supplier.mjs';
const f=await prepareMemoryDesktop();const plan=JSON.parse(await readFile(f.planPath,'utf8'));
let storage,extraction;
try{
 storage=await SqliteStorage.open({userData:f.root,intent:'open',role:'test',expectedDatabaseId:plan.databaseId});
 extraction=new SqliteMemoryExtraction(storage,owner,modelPort(()=>extraction.accounting,supplier().respond));const run=await extraction.start('08-desktop-normal-candidates');await extraction.waitForIdle();
 const management=new SqliteMemoryManagement(storage,owner);await management.importRun(run.runId);
 const directory=await storage.execute('identity.directory',{ownerId:owner}),[a,b]=directory.contacts.map(c=>c.contact_id);
 const candidateA=(await management.read({scopeKind:'contact',contactId:a})).candidates[0],candidateB=(await management.read({scopeKind:'contact',contactId:b})).candidates[0];
 const manual=await management.decide({requestKey:'08-desktop-independent-original',action:'manual',scope:{scopeKind:'contact',contactId:a},body:'联系人此前自述长期住在台北。'});
 const m=(await management.read({scopeKind:'contact',contactId:a})).memories.find(m=>m.id===manual.memoryId);
 await management.automatic({requestKey:'08-desktop-auto-update',action:'auto_update',candidateIds:[candidateA.id],candidateRevisions:[candidateA.stateRevision],memoryId:m.id,expectedVersionNo:'1',expectedHeadRevision:m.headRevision});
 const evidence={synthetic:true,userData:f.root,databaseId:plan.databaseId,planPath:f.planPath,contactA:a,contactB:b,memoryA:m.id,sourceA:candidateA.sources[0].recordId,sourceB:candidateB.sources[0].recordId,runId:run.runId,reading:false,preparedModel:'synthetic-only',appSupplierRequests:f.counts.requests};
 await extraction.close();await storage.check();await storage.close();await writeFile('/tmp/notalone08-management-prepared.json',JSON.stringify(evidence),{mode:0o600});console.log(JSON.stringify(evidence));
 let closing;const close=()=>closing??=f.close().then(()=>console.log(JSON.stringify({supplierStopped:true,appSupplierRequests:f.counts.requests})));process.once('SIGTERM',()=>void close());process.once('SIGINT',()=>void close());
}catch(error){await extraction?.close();await storage?.close();await f.close();throw error;}
