/** 显式诊断才启用：与既有问题 SQLite 总账共用发送前预留，不依赖 Python。 */
import {lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export class DiagnosticProblemBudgetError extends Error {
 readonly code:string;
 constructor(code:string){super(code);this.code=code;}
}
const stop=(code:string):never=>{throw new DiagnosticProblemBudgetError(code);};
function privateFile(path:string) {
 const file=lstatSync(path),directory=lstatSync(dirname(path)),uid=process.getuid?.();
 if(!file.isFile()||file.isSymbolicLink()||(file.mode&0o077)!==0
  ||!directory.isDirectory()||(directory.mode&0o077)!==0
  ||uid!==undefined&&(file.uid!==uid||directory.uid!==uid))stop('problem_budget_not_private');
 return {dev:file.dev,ino:file.ino,path:realpathSync(path)};
}

/** 配置在安装 provider 时绑定；后续修改 cwd、prompt 或撤去 env 都不会解除限制。 */
export function bindDiagnosticProblemBudget(environment:Readonly<NodeJS.ProcessEnv>=process.env):{reserve():()=>void}|null {
 const path=environment.NOTALONE_PROBLEM_BUDGET,round=environment.NOTALONE_PROBLEM_ROUND;
 if(path===undefined&&round===undefined)return null;
 if(!path||!round?.trim()||!isAbsolute(path))return stop('problem_budget_binding_invalid');
 const boundPath=path,boundRound=round;
 let pinned:ReturnType<typeof privateFile>;
 try{pinned=privateFile(path);}catch(error){if(error instanceof DiagnosticProblemBudgetError)throw error;return stop('problem_budget_unavailable');}
 function transaction<T>(work:(db:DatabaseSync)=>T):T {
  let db:DatabaseSync|undefined;
  try {
   const current=privateFile(boundPath);
   if(current.dev!==pinned.dev||current.ino!==pinned.ino||current.path!==pinned.path)stop('problem_budget_replaced');
   db=new DatabaseSync(pinned.path,{timeout:1000});
   const opened=privateFile(boundPath);
   if(opened.dev!==pinned.dev||opened.ino!==pinned.ino)stop('problem_budget_replaced');
   db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
   const result=work(db);db.exec('COMMIT');return result;
  }catch(error){
   if(db?.isTransaction)db.exec('ROLLBACK');
   if(error instanceof DiagnosticProblemBudgetError)throw error;
   return stop('problem_budget_unavailable');
  }finally{db?.close();}
 }
 function check(db:DatabaseSync,checkLimit:boolean) {
   const rows=db.prepare('SELECT problem,max_calls,deadline,used,streak FROM budget').all();
   const budget=rows[0];
   if(rows.length!==1||!budget||typeof budget.problem!=='string'||!budget.problem.trim()
    ||!Number.isSafeInteger(budget.max_calls)||Number(budget.max_calls)<1
    ||typeof budget.deadline!=='number'||!Number.isFinite(budget.deadline)
    ||!Number.isSafeInteger(budget.used)||Number(budget.used)<0
    ||!Number.isSafeInteger(budget.streak)||Number(budget.streak)<0)stop('problem_budget_invalid');
   if(checkLimit&&Number(budget.used)>=Number(budget.max_calls))stop('problem_budget_exhausted');
   const hasContinuations=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='continuations'").get();
   const continuation=hasContinuations?db.prepare('SELECT existing_rounds,max_new_rounds,deadline FROM continuations ORDER BY id DESC LIMIT 1').get():undefined;
   if(continuation){
    if(!Number.isSafeInteger(continuation.existing_rounds)||Number(continuation.existing_rounds)<0
     ||!Number.isSafeInteger(continuation.max_new_rounds)||Number(continuation.max_new_rounds)<1||Number(continuation.max_new_rounds)>3
     ||typeof continuation.deadline!=='number'||!Number.isFinite(continuation.deadline))stop('problem_budget_invalid');
    if(Date.now()/1000>=Number(continuation.deadline))stop('problem_budget_expired');
    const added=Number(db.prepare('SELECT count(*) AS n FROM rounds').get()!.n)-Number(continuation.existing_rounds);
    if(added<0||added>Number(continuation.max_new_rounds))stop('problem_budget_rounds_exhausted');
   }else{
    if(Date.now()/1000>=Number(budget.deadline))stop('problem_budget_expired');
    if(Number(budget.streak)>=2)stop('problem_budget_no_improvement');
   }
   const active=db.prepare('SELECT id FROM rounds WHERE outcome IS NULL').all();
   if(active.length!==1||active[0]?.id!==boundRound)stop('problem_budget_round_unsettled');
 }
 return {reserve(){
  transaction(db=>{check(db,true);db.exec('UPDATE budget SET used=used+1');});
  // 存储授权或发送前校验可能等待；再次检查停止条件，不重复扣费，也不退回预留。
  return ()=>transaction(db=>check(db,false));
 }};
}
