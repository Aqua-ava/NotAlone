import {sha256} from '../platform/sha256.ts';
import type {DiagnosticEvent,DiagnosticModule} from './unified-contract.mjs';

/** 只保留模板指纹和数字；参数从不交给聚合器，单动作最多128个模板。 */
export class SqlDiagnosticSummary {
 private readonly rows=new Map<string,{sqlFingerprint:string;count:number;durationMs:number}>();
 private readonly module:DiagnosticModule;
 private readonly caller:'sqlite_worker'|'sqlite_readonly_worker';
 private readonly traceId?:string;
 constructor(module:DiagnosticModule,caller:'sqlite_worker'|'sqlite_readonly_worker',traceId?:string){this.module=module;this.caller=caller;this.traceId=traceId;}
 measure<T>(sql:string,work:()=>T):T {
  const started=performance.now();
  try{return work();}finally{
   try{
    let row=this.rows.get(sql);
    if(!row&&this.rows.size<128){row={sqlFingerprint:sha256(sql),count:0,durationMs:0};this.rows.set(sql,row);}
    if(row){row.count++;row.durationMs+=Math.max(0,performance.now()-started);}
   }catch{}
  }
 }
 events():DiagnosticEvent[]{
  try{return [...this.rows.values()].map(row=>({event:row.durationMs>=1000?'sql.slow':'sql.summary',module:this.module,caller:this.caller,
   ...(this.traceId?{traceId:this.traceId}:{}),sqlFingerprint:row.sqlFingerprint,count:row.count,durationMs:Math.round(row.durationMs*1000)/1000,
   ...(row.durationMs>=1000?{reasonCode:'sql_slow'}:{})}));}catch{return [];}
 }
}

export function storageDiagnosticModule(action:string):DiagnosticModule {
 if(/^(?:history|sync|identity)\./.test(action))return 'history.sync';
 if(/^(?:reply|discussion|runtime|skills)\./.test(action))return 'reply';
 if(/^(?:deletion|delete)\./.test(action))return 'deletion';
 if(/^media\./.test(action))return 'media';
 return 'memory.management';
}
