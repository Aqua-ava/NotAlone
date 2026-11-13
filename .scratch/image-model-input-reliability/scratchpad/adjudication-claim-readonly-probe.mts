/** 正式claim在私有副本只读执行，首次写入前以固定哨兵退出；输出不含SQL、参数、正文或身份。 */
import {readFile,writeFile,lstat} from 'node:fs/promises';
import {appendFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {statementCache} from '../../../backend-ts/src/storage/sqlite/statement-cache.ts';
import {SqlDiagnosticSummary} from '../../../backend-ts/src/diagnostics/sql-summary.ts';
const privateRoot='/tmp/notalone-image-reliability-hw9x92j_',args=process.argv.slice(2),command=args.shift(),copy=args.shift()!;
const stat=await lstat(copy);if(!stat.isDirectory()||stat.uid!==process.getuid?.()||(stat.mode&0o077)!==0||!copy.startsWith(privateRoot+'/schedule-probe-'))throw Error('probe_copy_invalid');
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
if(command==='run'){
 const label=args.shift()!,module=args.shift()??'current',index=Number(args.shift()??0);if(!/^[a-z0-9-]{1,32}$/.test(label)||!Number.isSafeInteger(index)||index<0||index>50)throw Error('probe_label_invalid');
 const log=join(copy,label+'.jsonl');await writeFile(log,'',{mode:0o600,flag:'wx'});
 const start=performance.now(),child=spawnSync(process.execPath,[import.meta.filename,'child',copy,log,module==='current'?module:resolve(module),String(index)],{timeout:35_000,encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
 const entries=(await readFile(log,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse),reads=entries.filter(row=>row.phase==='done'),groups=new Map<string,any>();
 for(const row of reads){const value=groups.get(row.hash)??{hash:row.hash,queries:0,elapsedMs:0,rows:0};value.queries++;value.elapsedMs+=row.elapsedMs;value.rows+=row.rows;groups.set(row.hash,value);}
 const summary={label,exitCode:child.status,timeout:child.error?.code==='ETIMEDOUT',elapsedMs:Math.round(performance.now()-start),queries:reads.length,last:entries.at(-1),slow:[...groups.values()].sort((a,b)=>b.elapsedMs-a.elapsedMs).slice(0,10),errorType:child.stderr.includes('TypeError')?'TypeError':child.stderr.includes('Error')?'Error':'none'};
 await writeFile(join(copy,label+'-summary.json'),JSON.stringify(summary),{mode:0o600});console.log(JSON.stringify(summary));
}else if(command==='child'){
 const log=args.shift()!,module=args.shift()??'current',index=Number(args.shift()??0),db=new DatabaseSync(join(copy,'snapshot.sqlite'),{readOnly:true});
 db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;');
 const prepared=statementCache(db),summary=new SqlDiagnosticSummary('memory.processing','sqlite_worker'),seen=new Set<string>(),templates=log+'.templates';writeFileSync(templates,'',{flag:'wx',mode:0o600});let seq=0;
 const emit=(value:any)=>appendFileSync(log,JSON.stringify(value)+'\n');
 const read=(kind:'get'|'all',sql:string,p:any[]=[])=>{const hash=sha(sql),no=++seq,start=performance.now();if(!seen.has(hash)){seen.add(hash);appendFileSync(templates,JSON.stringify({hash,sql,origins:(new Error().stack??'').split('\n').filter(line=>line.includes('/backend-ts/src/')).map(line=>line.slice(line.indexOf('/backend-ts/src/')+1))})+'\n');}emit({phase:'start',seq:no,hash});const rows=summary.measure(sql,()=>prepared(sql).all(...p));emit({phase:'done',seq:no,hash,elapsedMs:Math.round((performance.now()-start)*100)/100,rows:rows.length});return kind==='get'?rows[0]:rows;};
 const tx={get:(sql:string,p:any[]=[])=>read('get',sql,p),all:(sql:string,p:any[]=[])=>read('all',sql,p),runtimeGet(){},run(){throw Object.assign(Error('probe_first_write'),{code:'probe_first_write'});}} as any;
 try{
 const scope=JSON.parse(await readFile(join(privateRoot,'stage6-scope.json'),'utf8'));
 const run=db.prepare(`SELECT r.id FROM processing_run r WHERE r.owner_id=? AND EXISTS(SELECT 1 FROM run_contact c WHERE c.owner_id=r.owner_id AND c.run_id=r.id AND c.contact_id=?) AND EXISTS(SELECT 1 FROM run_input i WHERE i.owner_id=r.owner_id AND i.run_id=r.id AND i.role='target') ORDER BY r.started_at DESC,r.rowid DESC LIMIT 1`).get(scope.ownerId,scope.contactId)!;
 const candidates=db.prepare(`SELECT c.id,c.scope_kind FROM memory_candidate c JOIN step_attempt a ON a.owner_id=c.owner_id AND a.id=c.produced_attempt_id JOIN processing_step s ON s.owner_id=a.owner_id AND s.id=a.step_id JOIN processing_task t ON t.owner_id=s.owner_id AND t.id=s.task_id JOIN execution_event e ON e.owner_id=c.owner_id AND e.id=c.event_id WHERE c.owner_id=? AND t.run_id=? AND c.state='pending' ORDER BY e.id`).all(scope.ownerId,run.id);
 emit({phase:'candidate_metadata',pending:candidates.length,scopes:candidates.map(row=>row.scope_kind),selectedIndex:index});const candidate=candidates[index];
 if(!candidate)throw Object.assign(Error('probe_no_pending_candidate'),{code:'probe_no_pending_candidate'});
 await writeFile(log+'.identity',JSON.stringify({runId:run.id,candidateId:candidate.id}),{mode:0o600});
 const {memoryAdjudicationActions}=await import(module==='current'?'../../../backend-ts/src/memory/sqlite/management/adjudication-actions.ts':module),action=memoryAdjudicationActions.find((row:any)=>row.name==='memoryAdjudication.claim')!;
 const start=performance.now();try{const value=action.execute(tx,{ownerId:scope.ownerId,candidateId:candidate.id},{});emit({phase:'result',elapsedMs:Math.round(performance.now()-start),returnedNull:value===null,scopeKind:candidate.scope_kind});}catch(error){if((error as any).code!=='probe_first_write')throw error;emit({phase:'result',elapsedMs:Math.round(performance.now()-start),firstWriteBlocked:true,scopeKind:candidate.scope_kind});}
 }finally{db.close();}
}else throw Error('probe_command_invalid');
