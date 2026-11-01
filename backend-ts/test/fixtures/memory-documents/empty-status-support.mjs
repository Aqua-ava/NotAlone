import {fixture,modelPort,owner} from '../memory-sqlite/support.mjs';
import {SqliteMemoryExtraction} from '../../../src/memory/sqlite/service.ts';
import {SqliteMemoryDocuments} from '../../../src/memory/sqlite/documents/service.ts';

const registryModule=new URL('./later-schedule-registry.mjs',import.meta.url).href;
export async function emptyDocumentFixture(t,{enroll=true}={}){
 const cleanups=[],f=await fixture({after:cleanup=>cleanups.push(cleanup)},{registryModule});
 let extraction;
 const documents=new SqliteMemoryDocuments(f.storage,owner,undefined);
 extraction=new SqliteMemoryExtraction(f.storage,owner,modelPort(()=>extraction.accounting),undefined,enroll?runId=>documents.enrollRun(runId):undefined);
 t.after(async()=>{await extraction.close();await documents.close();await f.service.close();await f.contacts.close();for(const cleanup of cleanups.reverse())await cleanup();});
 await f.service.synchronize(f.saved[0].contact_id);await f.contacts.setReading(false);
 return {...f,owner,extraction,documents,contactId:f.saved[0].contact_id,otherContactId:f.saved[1].contact_id,
  async runEmpty(key){const run=await extraction.start(key);await extraction.waitForIdle(run.runId);return extraction.read(run.runId);}};
}
