/** 调度故障只读取私有副本；日志仅保留查询摘要与计时，不输出SQL、参数或正文。 */
import {readFile,writeFile,appendFile,mkdtemp,copyFile,chmod,rm,lstat} from 'node:fs/promises';
import {constants} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {join,resolve} from 'node:path';
import {homedir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {appendFileSync,writeFileSync} from 'node:fs';
import {statementCache} from '../../../backend-ts/src/storage/sqlite/statement-cache.ts';
import {SqlDiagnosticSummary} from '../../../backend-ts/src/diagnostics/sql-summary.ts';
const privateRoot='/tmp/notalone-image-reliability-hw9x92j_';
const source=join(homedir(),'Library/Application Support/NotAloneDesktop/managed/sqlite/notalone.sqlite');
const args=process.argv.slice(2),command=args.shift(),directory=args.shift();
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
async function checkedDirectory(path:string){const s=await lstat(path);if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||(s.mode&0o077)!==0||!resolve(path).startsWith(privateRoot+'/schedule-probe-'))throw Error('probe_directory_invalid');}
if(command==='prepare'){
 const root=await mkdtemp(join(privateRoot,'schedule-probe-'));await chmod(root,0o700);
 try{for(const suffix of ['','-wal','-shm']){try{const s=await lstat(source+suffix);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid?.())throw Error('probe_source_invalid');await copyFile(source+suffix,join(root,'snapshot.sqlite')+suffix,constants.COPYFILE_EXCL);await chmod(join(root,'snapshot.sqlite')+suffix,0o600);}catch(e){if(suffix&&(e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}}
 const db=new DatabaseSync(join(root,'snapshot.sqlite'),{readOnly:true});try{if(db.prepare('PRAGMA quick_check').get()?.quick_check!=='ok')throw Error('probe_snapshot_inconsistent');}finally{db.close();}
 console.log(JSON.stringify({directory:root,prepared:true}));}catch(e){await rm(root,{recursive:true,force:true});throw e;}
}else if(command==='remove'){
 await checkedDirectory(directory!);await rm(directory!,{recursive:true,force:true});console.log(JSON.stringify({removed:true}));
}else if(command==='run'){
 await checkedDirectory(directory!);const label=args.shift();if(!label||!/^[a-z0-9-]{1,32}$/.test(label))throw Error('probe_label_invalid');
 const logfile=join(directory!,label+'.jsonl');await writeFile(logfile,'',{flag:'wx',mode:0o600});
 const module=args.shift()??'current',wrapper=args.shift()??'raw',action=args.shift()??'schedule';const began=performance.now(),child=spawnSync(process.execPath,[import.meta.filename,'child',directory!,logfile,module==='current'?module:resolve(module),wrapper,action],{timeout:25_000,encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME}});
 const records=(await readFile(logfile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 const finished=records.filter(row=>row.phase==='done'),timed=finished.filter(row=>row.kind==='get'||row.kind==='all'),groups=new Map<string,{hash:string;queries:number;elapsedMs:number;rows:number}>();
 for(const row of timed){const group=groups.get(row.hash)??{hash:row.hash,queries:0,elapsedMs:0,rows:0};group.queries++;group.elapsedMs+=row.elapsedMs;group.rows+=row.rows;groups.set(row.hash,group);}
 const result={label,wrapper,action,exitCode:child.status,signal:child.signal,timeout:child.error?.code==='ETIMEDOUT',elapsedMs:Math.round(performance.now()-began),queries:timed.length,last:records.at(-1),slow:[...groups.values()].sort((a,b)=>b.elapsedMs-a.elapsedMs).slice(0,10),stderrKind:child.stderr.includes('Error')?'error':'none'};
 await writeFile(join(directory!,label+'-summary.json'),JSON.stringify(result),{mode:0o600});console.log(JSON.stringify(result));
}else if(command==='child'){
 await checkedDirectory(directory!);const logfile=args.shift()!,module=args.shift()??'current',wrapper=args.shift()??'raw',target=args.shift()??'schedule';
 if(!['raw','worker-on','worker-off'].includes(wrapper)||!['schedule','contact','queue'].includes(target))throw Error('probe_options_invalid');
 const db=new DatabaseSync(join(directory!,'snapshot.sqlite'),{readOnly:true});let seq=0;const cached=statementCache(db),summary=wrapper==='worker-on'?new SqlDiagnosticSummary('memory.processing','sqlite_readonly_worker'):undefined;
 if(wrapper!=='raw')db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA temp_store=MEMORY;');
 const emit=(value:unknown)=>appendFileSync(logfile,JSON.stringify(value)+'\n'),templates=new Set<string>(),templateFile=logfile+'.templates';writeFileSync(templateFile,'',{flag:'wx',mode:0o600});
 const read=(kind:'get'|'all',sql:string,parameters:any[]=[])=>{const hash=sha(sql),no=++seq,began=performance.now();if(!templates.has(hash)){templates.add(hash);const origins=(new Error().stack??'').split('\n').filter(line=>line.includes('/backend-ts/src/')).map(line=>line.slice(line.indexOf('/backend-ts/src/')+1));appendFileSync(templateFile,JSON.stringify({hash,sql,origins})+'\n');if(sql.includes('t.id AS task_id,t.state AS task_state')){const plan=db.prepare('EXPLAIN QUERY PLAN '+sql).all(...parameters);writeFileSync(logfile+'.plan',JSON.stringify({hash,plan}),{mode:0o600});}}emit({phase:'start',kind,seq:no,hash});const work=()=>{const statement=wrapper==='raw'?db.prepare(sql):cached(sql);statement.setReadBigInts(true);return wrapper==='raw'&&kind==='get'?statement.get(...parameters):kind==='get'?statement.all(...parameters)[0]:statement.all(...parameters);};const value=summary?summary.measure(sql,work):work();emit({phase:'done',kind,seq:no,hash,elapsedMs:Math.round((performance.now()-began)*100)/100,rows:Array.isArray(value)?value.length:value?1:0});return value;};
 try{
 const scopePath=join(privateRoot,'stage6-scope.json'),scopeStat=await lstat(scopePath);if(!scopeStat.isFile()||scopeStat.uid!==process.getuid?.()||(scopeStat.mode&0o077)!==0)throw Error('probe_scope_invalid');
 const {ownerId,contactId}=JSON.parse(await readFile(scopePath,'utf8'));if(typeof ownerId!=='string'||!/^[a-f0-9-]{36}$/i.test(ownerId))throw Error('probe_scope_invalid');
 const tx={get:(sql:string,p?:any[])=>read('get',sql,p),all:(sql:string,p?:any[])=>read('all',sql,p),runtimeGet(){return undefined;},recordUnifiedDiagnostic(){},run(){throw Error('probe_readonly_violation');}} as any;
 const exported=await import(module==='current'?(target==='queue'?'../../../backend-ts/src/memory/sqlite/documents/later-schedule.ts':'../../../backend-ts/src/memory/sqlite/runs.ts'):module);
 const actions=target==='queue'?exported.memoryDocumentsLaterScheduleActions:exported.runActions;
 const action=actions.find((action:any)=>action.name===(target==='queue'?'memoryDocuments.queueSummary':target==='contact'?'memoryExtraction.readContact':'memoryExtraction.readSchedule'))!;
 if(wrapper!=='raw')db.exec('BEGIN');const began=performance.now(),result=action.execute(tx,{ownerId,contactId,now:Date.now()},{} as any);if(wrapper!=='raw')db.exec('COMMIT');
 const queue=target==='contact'?result.queue:result;
 emit({phase:'result',elapsedMs:Math.round(performance.now()-began),pending:queue.pending,blockedContacts:queue.blockedContacts,content:queue.content,...(target==='contact'?{runState:result.run?.state??null,runTotal:result.run?.total??0}:{}),diagnosticEvents:summary?.events().length??0});
 }finally{db.close();}
}else throw Error('probe_command_invalid');
