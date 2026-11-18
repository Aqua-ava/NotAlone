import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {StorageFailure} from '../../../src/storage/sqlite/contracts.ts';

const actions = [
  {name:'fixture.continuityDiagnosticSourceChanged',mode:'write',retryBusy:false,execute(tx,input){
    tx.run("UPDATE source_proof SET source_generation='synthetic-changed-generation' WHERE owner_id=? AND contact_id=?",[input.ownerId,input.contactId]);return true;
  }},
  {name: 'fixture.continuityDiagnosticRollback', mode: 'write', retryBusy: false, execute(tx, input) {
    tx.run("INSERT INTO source_proof(owner_id,contact_id,tables_json,state,reason) VALUES(?,?,'','needs_confirmation',?) ON CONFLICT(owner_id,contact_id) DO UPDATE SET state='needs_confirmation',reason=excluded.reason",[input.ownerId,input.contactId,'history_source_continuity_unverified']);
    tx.recordDiagnostic({kind: 'history_continuity_fence', contactPrefix: input.contactId.slice(0, 8), branch: 'L01'});
    throw new StorageFailure('synthetic_diagnostic_rollback');
  }},
  {name: 'fixture.continuityDiagnosticFences', mode: 'read', retryBusy: false, execute(tx, input) {
    return tx.all("SELECT contact_id FROM source_proof WHERE owner_id=? AND state='needs_confirmation' ORDER BY contact_id",[input.ownerId]);
  }},
];

export const registry = {...base, actions: [...base.actions, ...actions]};
