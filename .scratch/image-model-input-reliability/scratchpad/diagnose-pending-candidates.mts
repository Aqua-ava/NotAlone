/** 候选隐藏原因取证：复制数据库后只读调用现行资格函数，输出只含状态与固定原因码。 */
import {copyFile,mkdtemp,chmod,rm,readFile,writeFile,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {requireCandidate,citations,requireSources} from '../../../backend-ts/src/memory/sqlite/management/qualification.ts';
import {qualificationSources,qualificationSourceRows,frozenContributingContactIds} from '../../../backend-ts/src/memory/sqlite/management/dependencies.ts';
import {managementRead} from '../../../backend-ts/src/memory/sqlite/management/read.ts';
import {assertTaskContributions,assertInputs} from '../../../backend-ts/src/memory/sqlite/qualification.ts';
import {verifiedExtractionOutput} from '../../../backend-ts/src/memory/sqlite/outputs.ts';
import {StorageFailure} from '../../../backend-ts/src/storage/sqlite/contracts.ts';
const privateRoot='/tmp/notalone-image-reliability-hw9x92j_';
const source=join(homedir(),'Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite');
const scope=JSON.parse(await readFile(join(privateRoot,'stage6-scope.json'),'utf8'));
const root=await mkdtemp(join(privateRoot,'candidate-readonly-'));await chmod(root,0o700);
let db:DatabaseSync|undefined;
const safeCode=(e:unknown)=>e instanceof StorageFailure&&/^[a-z][a-z0-9_]{0,95}$/.test(e.code)?e.code:'diagnosis_unavailable';
const attempt=(fn:()=>any)=>{try{return {ok:true,value:fn()};}catch(e){return {ok:false,code:safeCode(e)};}};
try{
 for(const suffix of ['','-wal','-shm'])try{const entry=await lstat(source+suffix);if(!entry.isFile()||entry.isSymbolicLink())throw Error();await copyFile(source+suffix,join(root,'snapshot.sqlite')+suffix,constants.COPYFILE_EXCL);await chmod(join(root,'snapshot.sqlite')+suffix,0o600);}catch(e){if(suffix&&(e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
 db=new DatabaseSync(join(root,'snapshot.sqlite'),{readOnly:true});
 const statement=(sql:string)=>{const s=db!.prepare(sql);s.setReadBigInts(true);return s;};
 const tx={get:(sql:string,values:any[]=[])=>statement(sql).get(...values),all:(sql:string,values:any[]=[])=>statement(sql).all(...values),run(){throw Error('readonly_violation');},runtimeGet(){return undefined;},runtimeSet(){throw Error('readonly_violation');},runtimeDelete(){throw Error('readonly_violation');}} as any;
 if(tx.get('PRAGMA quick_check')?.quick_check!=='ok')throw Error('snapshot_invalid');
 const rows=tx.all(`SELECT DISTINCT c.* FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id
 JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN task_contribution tc ON tc.owner_id=s.owner_id AND tc.task_id=s.task_id
 WHERE c.owner_id=? AND tc.source_contact_id=? AND c.state='pending' ORDER BY c.scope_kind,c.id`,[scope.ownerId,scope.contactId]);
 const results=rows.map((c:any,index:number)=>{
  const parent={candidateId:String(c.id)};
  const q=attempt(()=>qualificationSources(tx,scope.ownerId,parent));
  const frozen=attempt(()=>frozenContributingContactIds(tx,scope.ownerId,parent));
  const cited=attempt(()=>citations(tx,scope.ownerId,parent));
  const required=attempt(()=>requireSources(tx,scope.ownerId,parent));
  const candidate=attempt(()=>requireCandidate(tx,scope.ownerId,c));
  const output=attempt(()=>verifiedExtractionOutput(tx,{ownerId:scope.ownerId,eventId:String(c.event_id)}));
  const task=tx.get(`SELECT t.id,t.run_id,t.state,r.state AS run_state FROM step_attempt a JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id JOIN processing_run r ON r.owner_id=t.owner_id AND r.id=t.run_id WHERE a.owner_id=? AND a.id=?`,[scope.ownerId,c.produced_attempt_id]);
  const contribution=attempt(()=>assertTaskContributions(tx,scope.ownerId,String(task.run_id),String(task.id)));
  const inputs=tx.all(`SELECT i.* FROM execution_input x JOIN step_input si ON si.owner_id=x.owner_id AND si.step_id=x.planned_step_id AND si.input_no=x.planned_input_no JOIN run_input i ON i.owner_id=si.owner_id AND i.run_id=si.run_id AND i.input_no=si.run_input_no WHERE x.owner_id=? AND x.event_id=? ORDER BY x.presentation_no`,[scope.ownerId,c.event_id]);
  const inputEligibility=attempt(()=>assertInputs(tx,scope.ownerId,String(task.run_id),inputs));
  const s={scopeKind:c.scope_kind,contactId:c.contact_id};
  const visible=attempt(()=>managementRead(tx,{ownerId:scope.ownerId,scope:s,displayContactId:scope.contactId,candidateId:String(c.id)}));
  const unfiltered=attempt(()=>managementRead(tx,{ownerId:scope.ownerId,scope:s,candidateId:String(c.id)}));
  const citationsOnlySample=cited.ok&&cited.value.every((r:any)=>r.source_contact_id===scope.contactId);
  const frozenOnlySample=frozen.ok&&frozen.value.length===1&&frozen.value[0]===scope.contactId;
  const ownedIfCandidateQualified=cited.ok&&frozen.ok&&(s.scopeKind==='contact'?citationsOnlySample&&frozen.value.every((id:string)=>id===scope.contactId):cited.value.length>0&&citationsOnlySample&&frozenOnlySample);
  return {candidateId:String(c.id),revision:String(c.state_revision),ordinal:index+1,scope:c.scope_kind,
   requireCandidate:candidate.ok?{ok:true,verification:candidate.value.state}:{ok:false,code:candidate.code},
   verifiedExtractionOutput:output.ok?{ok:true}:{ok:false,code:output.code},
   qualificationSources:q.ok?{ok:true,count:q.value.length,onlySample:q.value.length>0&&q.value.every((r:any)=>r.contactId===scope.contactId)}:{ok:false,code:q.code},
   frozenContributions:frozen.ok?{ok:true,count:frozen.value.length,onlySample:frozenOnlySample}:{ok:false,code:frozen.code},
   citationSources:cited.ok?{ok:true,count:cited.value.length,onlySample:citationsOnlySample}:{ok:false,code:cited.code},
   requireSources:required.ok?{ok:true,count:required.value.length}:{ok:false,code:required.code},
   taskContributionQualification:contribution.ok?{ok:true}:{ok:false,code:contribution.code},
   inputQualification:inputEligibility.ok?{ok:true}:{ok:false,code:inputEligibility.code},
   taskState:task.state,runState:task.run_state,inputCount:inputs.length,
   ownedIfCandidateQualified,
   visibleByExactRead:visible.ok?visible.value.candidates.some((r:any)=>r.id===c.id):false,
   visibleWithoutDisplayFilter:unfiltered.ok?unfiltered.value.candidates.some((r:any)=>r.id===c.id):false,
   readCode:visible.ok?null:visible.code};
 });
 const targetIds=new Set(results.map((r:any)=>r.candidateId));const pageResults:any[]=[];const found=new Map<string,number>();let cursor:undefined|string;
 for(let page=1;page<=100;page++){
  const result=managementRead(tx,{ownerId:scope.ownerId,scope:{scopeKind:'self',contactId:null},displayContactId:scope.contactId,...(cursor?{cursor}:{})});
  for(const candidate of result.candidates)if(targetIds.has(candidate.id))found.set(candidate.id,page);
  pageResults.push({page,candidateCount:result.candidates.length,memoryCount:result.memories.length,nextPage:!!result.page.nextCursor});
  if(!result.page.nextCursor)break;cursor=result.page.nextCursor;
 }
 for(const row of results)(row as any).visibleOnListPage=found.get(row.candidateId)??null;
 const detail={phase:'candidate_diagnosis',listPages:pageResults,pending:results.length,contact:results.filter((r:any)=>r.scope==='contact').length,self:results.filter((r:any)=>r.scope==='self').length,visible:results.filter((r:any)=>r.visibleByExactRead).length,results};
 await writeFile(join(privateRoot,'stage6-candidate-diagnosis.json'),JSON.stringify(detail,null,2),{mode:0o600});
 process.stdout.write(JSON.stringify({...detail,results:results.map(({candidateId,revision,...safe}:any)=>safe)})+'\n');
}catch(e){process.stdout.write(JSON.stringify({phase:'failed',code:safeCode(e),errorClass:e instanceof Error?e.constructor.name:'unknown'})+'\n');process.exitCode=1;}
finally{db?.close();await rm(root,{recursive:true,force:true});}
