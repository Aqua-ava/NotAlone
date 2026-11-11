import {registry as base} from '../../../src/storage/sqlite/registry.ts';
let attempts=0;
const event={event:'processing.task_changed',caller:'memory_task',fromState:'running',toState:'completed',reasonCode:'completed'};
export const registry={migrations:[base.migrations[0],{version:2,sql:'CREATE TABLE diagnostic_fact(value INTEGER NOT NULL) STRICT; INSERT INTO diagnostic_fact VALUES(7);'}],actions:[
 {name:'diagnostic.commit',mode:'write',retryBusy:false,execute(tx){tx.run('UPDATE diagnostic_fact SET value=8');tx.recordUnifiedDiagnostic?.(event);return true;}},
 {name:'diagnostic.rollback',mode:'write',retryBusy:false,execute(tx){tx.recordUnifiedDiagnostic?.(event);tx.run('UPDATE diagnostic_fact SET value=9');throw new Error('合成敏感异常正文');}},
 {name:'diagnostic.retry',mode:'write',retryBusy:true,execute(tx){tx.recordUnifiedDiagnostic?.(event);if(attempts++===0)throw {errcode:5};return true;}},
 {name:'diagnostic.read',mode:'read',retryBusy:false,execute(tx){for(let i=0;i<100;i++)tx.get('SELECT value FROM diagnostic_fact');return tx.get('SELECT value FROM diagnostic_fact').value;}},
 {name:'diagnostic.invalid',mode:'write',retryBusy:false,execute(tx){tx.recordUnifiedDiagnostic?.({...event,body:'合成敏感正文'});return true;}},
]};
