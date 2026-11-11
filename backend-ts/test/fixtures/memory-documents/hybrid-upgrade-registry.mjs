import {loadHybridProcessingModule} from '../sqlite/pre-source-proof-registry.mjs';
const {registry:base}=await loadHybridProcessingModule('storage/sqlite/registry.ts');
import {nextMessageDisplayNo} from '../../../src/storage/sqlite/message-order.ts';
const legacy=new URL(import.meta.url).searchParams.get('legacy')==='true';
export const registry={...base,migrations:base.migrations.filter(migration=>migration.version<=(legacy?26:28)),
 actions:[...base.actions,{name:'fixture.hybridUpgradeInspect',mode:'read',retryBusy:false,execute(tx){
  const names=['message','capture_record','sync_capture','read_goal','run_input','processing_run','processing_task','processing_item','model_call','execution_event','memory'];
  return {tables:Object.fromEntries(names.map(name=>[name,tx.all(`SELECT * FROM ${name} ORDER BY rowid`)])),ledger:tx.all('SELECT version,checksum,applied_at FROM schema_migration ORDER BY version')};
 }},{name:'fixture.nextDisplay',mode:'read',retryBusy:false,execute:tx=>({remaining:tx.get('SELECT count(*) AS n FROM message').n,next:nextMessageDisplayNo(tx),baseline:tx.get('SELECT memory_incremental_baseline_display_no AS n FROM database_instance WHERE slot=1').n})}]};
