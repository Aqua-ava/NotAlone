import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {registry as historicalSeed} from '../memory-management/adjudication-upgrade-registry.mjs?mode=legacy';
import {memoryDocumentsUpgradeSteps} from '../../../src/memory/sqlite/documents/schema.ts';
let mutationBlocked=false;
const params=new URL(import.meta.url).searchParams,mode=params.get('mode')??'upgrade',fail=params.get('fail');
const migrations=base.migrations.slice(0,mode==='legacy11'?11:mode==='legacy'?12:13).map(m=>({...m}));
if(mode==='tamper')migrations[12].sql+='\n-- altered';
if(mode==='unmarked')delete migrations[12].rebuild;
const mutationProof={name:'fixture.documentsMutationBlocked',mode:'read',retryBusy:false,execute(){return mutationBlocked;}};
const inspect={name:'fixture.documentsUpgradeInspect',mode:'read',retryBusy:false,execute(tx){
 const tables=['processing_run','run_contact','run_input','processing_task','task_contribution','processing_step','step_input','step_attempt','model_operation','model_call','execution_event','execution_input','event_source','memory','memory_version','memory_candidate','memory_decision','memory_citation'];
 return {data:Object.fromEntries(tables.map(table=>[table,tx.all(`SELECT * FROM ${table}`)])),ledger:tx.all('SELECT version,checksum,applied_at FROM schema_migration ORDER BY version')};
}};
export const registry={...base,migrations,actions:[...base.actions,...historicalSeed.actions.filter(action=>['fixture.legacyHistorySeed','fixture.legacyCandidateSeed','fixture.upgradeFormalHistory'].includes(action.name)),inspect,mutationProof],migrationObserver(event){if(event.version===13&&event.phase==='prepare'&&mode==='mutate'){try{memoryDocumentsUpgradeSteps[1].sql='SELECT 1;';}catch{mutationBlocked=true;}}if(event.version===13&&event.phase===fail)throw Error('synthetic upgrade interruption');}};
