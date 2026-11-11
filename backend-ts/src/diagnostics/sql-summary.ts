import {sha256} from '../platform/sha256.ts';
import type {DiagnosticEvent,DiagnosticModule} from './unified-contract.mjs';
import {diagnosticDecisionLimit,diagnosticDetailLimit,diagnosticOverflow} from './buffer.mjs';

type SqlStatistics={sqlFingerprint:string;count:number;durationMs:number};
const statisticLimit=4096,slowThresholdMs=1000;
/** 统计仅保留最多4096个指纹和数字；参数及原始SQL不进入聚合状态。 */
export class SqlDiagnosticSummary {
 private readonly rows=new Map<string,SqlStatistics>();
 // 统计封顶后仍保留有界的单次慢观察，不将未观察到的早期快调用算入该告警。
 private readonly extraSlow:SqlStatistics[]=[];
 private untracked=0;
 private readonly module:DiagnosticModule;
 private readonly caller:'sqlite_worker'|'sqlite_readonly_worker';
 private readonly traceId?:string;
 constructor(module:DiagnosticModule,caller:'sqlite_worker'|'sqlite_readonly_worker',traceId?:string){this.module=module;this.caller=caller;this.traceId=traceId;}
 measure<T>(sql:string,work:()=>T):T {
  const started=performance.now();
  try{return work();}finally{
   try{
    const durationMs=Math.max(0,performance.now()-started),sqlFingerprint=sha256(sql);
    let row=this.rows.get(sqlFingerprint);
    if(!row&&this.rows.size<statisticLimit){row={sqlFingerprint,count:0,durationMs:0};this.rows.set(sqlFingerprint,row);}
    if(row){row.count++;row.durationMs+=durationMs;}
    else if(durationMs>=slowThresholdMs&&this.extraSlow.length<diagnosticDetailLimit)this.extraSlow.push({sqlFingerprint,count:1,durationMs});
    else this.untracked=Math.min(Number.MAX_SAFE_INTEGER,this.untracked+1);
   }catch{}
  }
 }
 events():DiagnosticEvent[]{
  try{
   const detail:SqlStatistics[]=[],slow:SqlStatistics[]=[];
   for(const row of this.rows.values()){
    if(row.durationMs>=slowThresholdMs)slow.push(row);
    // debug 是最多128条模板的采样，不占慢SQL预算，也不冒称统计损失。
    else if(detail.length<diagnosticDetailLimit)detail.push(row);
   }
   const retainedExtra=Math.min(this.extraSlow.length,Math.max(0,diagnosticDecisionLimit-slow.length));
   slow.push(...this.extraSlow.slice(0,retainedExtra));
   const record=(row:SqlStatistics,isSlow:boolean):DiagnosticEvent=>({event:isSlow?'sql.slow':'sql.summary',module:this.module,caller:this.caller,
    ...(this.traceId?{traceId:this.traceId}:{}),sqlFingerprint:row.sqlFingerprint,count:row.count,durationMs:Math.round(row.durationMs*1000)/1000,
    ...(isSlow?{reasonCode:'sql_slow'}:{})});
   const events=[...detail.map(row=>record(row,false)),...slow.map(row=>record(row,true))];
   // count 仅计未统计的调用及被裁掉的单次慢观察，已保留的告警不重复计数。
   const lost=Math.min(Number.MAX_SAFE_INTEGER,this.untracked+this.extraSlow.length-retainedExtra);
   if(lost)events.push(diagnosticOverflow(this.caller,lost,this.traceId));
   return events;
  }catch{return [];}
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
