import {registry as base} from '../../../src/storage/sqlite/registry.ts';

/** 合成回归：统计每次 history.acceptPage 内对 sqlite_schema 的建表探测次数；不改变任何生产动作。 */
const counters={pages:0,probes:0};
const accept=base.actions.find(action=>action.name==='history.acceptPage');
export const registry={...base,actions:[...base.actions.map(action=>action===accept?{...action,execute(tx,input,lease){
 counters.pages++;
 const counting={...tx,get(sql,values){if(/FROM sqlite_schema WHERE type='table'/.test(sql))counters.probes++;return tx.get(sql,values);}};
 return action.execute(counting,input,lease);
}}:action),{
 name:'fixture.schemaProbeCounters',mode:'read',retryBusy:false,
 execute(){return {...counters};},
}]};
