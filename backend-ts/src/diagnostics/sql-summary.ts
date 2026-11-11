import {sha256} from '../platform/sha256.ts';
import type {DiagnosticEvent,DiagnosticModule} from './unified-contract.mjs';
import {diagnosticOverflow} from './buffer.mjs';

/** 只保留模板指纹和数字；参数从不交给聚合器，单动作最多128个模板。 */
export class SqlDiagnosticSummary {
 private readonly rows=new Map<string,{sqlFingerprint:string;count:number;durationMs:number}>();
 private dropped=0;
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
    if(row){row.count++;row.durationMs+=Math.max(0,performance.now()-started);}else this.dropped++;
   }catch{}
  }
 }
 events():DiagnosticEvent[]{
  try{const events:DiagnosticEvent[]=[...this.rows.values()].map(row=>({event:row.durationMs>=1000?'sql.slow':'sql.summary',module:this.module,caller:this.caller,
   ...(this.traceId?{traceId:this.traceId}:{}),sqlFingerprint:row.sqlFingerprint,count:row.count,durationMs:Math.round(row.durationMs*1000)/1000,
   ...(row.durationMs>=1000?{reasonCode:'sql_slow'}:{})}));if(this.dropped)events.push(diagnosticOverflow(this.caller,this.dropped,this.traceId));return events;}catch{return [];}
 }
}

export function storageDiagnosticModule(action:string):DiagnosticModule {
 if(/^memoryExtraction\./.test(action))return 'memory.processing';
 // 主题的正式页面集合读取属于管理，其余具名任务／调度／发布动作属于处理。
 if(/^memoryDocuments\./.test(action))return action==='memoryDocuments.read'?'memory.management':'memory.processing';
 // 联系人域在注册表使用 identity 前缀，不是 contact／contacts。
 if(/^identity\./.test(action))return 'contacts';
 if(/^(?:history|sync)\./.test(action))return 'history.sync';
 if(/^(?:reply|discussion|runtime|skills)\./.test(action))return 'reply';
 if(/^(?:deletion|delete)\./.test(action))return 'deletion';
 if(/^media\./.test(action))return 'media';
 return 'memory.management';
}
