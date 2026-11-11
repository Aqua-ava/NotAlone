// 在受控临时副本上比较正式管理读取；只输出计数、耗时和结果摘要。
import {DatabaseSync,backup} from 'node:sqlite';
import {chmod,mkdtemp,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {join,isAbsolute,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const {managementRead}=await import(process.env.NOTALONE_MANAGEMENT_READ_MODULE?pathToFileURL(process.env.NOTALONE_MANAGEMENT_READ_MODULE).href:new URL('../src/memory/sqlite/management/read.ts',import.meta.url).href);
import {statementCache} from '../src/storage/sqlite/statement-cache.ts';
process.umask(0o077);
const [phase,location,contactPrefix]=process.argv.slice(2);
if(!['before','baseline','after','cleanup'].includes(phase)||!location||!isAbsolute(location))throw new Error('benchmark_arguments_invalid');
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
let root,state;
if(phase==='before'){
 if(!/^[a-f0-9]{8}$/.test(contactPrefix??''))throw new Error('benchmark_contact_prefix_invalid');
 root=await realpath(await mkdtemp(join(tmpdir(),'notalone-management-batch-')));await chmod(root,0o700);
 const source=new DatabaseSync(await realpath(location),{readOnly:true});
 try{await backup(source,join(root,'snapshot.sqlite'));}finally{source.close();}
 await chmod(join(root,'snapshot.sqlite'),0o600);
 state={schemaVersion:1,contactPrefix};
}else{
 root=await realpath(location);
 if(dirname(root)!==await realpath(tmpdir())||!basename(root).startsWith('notalone-management-batch-'))throw new Error('benchmark_temporary_root_invalid');
 state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));
 if(state.schemaVersion!==1||!/^[a-f0-9]{8}$/.test(state.contactPrefix??''))throw new Error('benchmark_state_invalid');
}
if(phase==='cleanup'){await rm(root,{recursive:true,force:true});console.log(JSON.stringify({cleaned:true}));process.exit(0);}
const db=new DatabaseSync(join(root,'snapshot.sqlite'));db.exec('PRAGMA query_only=OFF');
const statement=statementCache(db);let totalQueries=0,eligibilityQueries=0;
const tx={get(sql,args=[]){totalQueries++;if(sql.includes('wanted AS ('))eligibilityQueries++;return statement(sql).get(...args);},all(sql,args=[]){totalQueries++;if(sql.includes('wanted AS ('))eligibilityQueries++;return statement(sql).all(...args);},run(sql,args=[]){statement(sql).run(...args);},runtimeGet(){return undefined;},runtimeSet(){},runtimeDelete(){}};
const contact=statement('SELECT owner_id,id FROM contact WHERE substr(id,1,8)=?').all(state.contactPrefix);
if(contact.length!==1)throw new Error('benchmark_contact_not_unique');
const input={ownerId:contact[0].owner_id,scope:{scopeKind:'contact',contactId:contact[0].id}};
function inspect(value){return {hash:digest(value),candidates:value.candidates.map(c=>({idHash:digest(c.id),hash:digest(c)})),memories:value.memories.map(m=>({idHash:digest(m.id),hash:digest(m),visible:m.current!==null,redacted:m.versions.every(v=>v.body===null)})),bytes:Buffer.byteLength(JSON.stringify(value))};}
const results={};
try{
 for(const scenario of ['saved','revision_changed','proof_invalid']){
  db.exec('BEGIN');
  try{
   if(scenario==='revision_changed')statement(`UPDATE message SET interpretation_revision=interpretation_revision+1 WHERE owner_id=? AND contact_id=? AND id=(SELECT message_id FROM memory_citation WHERE owner_id=? AND source_contact_id=? LIMIT 1)`).run(input.ownerId,input.scope.contactId,input.ownerId,input.scope.contactId);
   if(scenario==='proof_invalid')statement(`UPDATE source_proof SET state='needs_confirmation' WHERE owner_id=? AND contact_id=?`).run(input.ownerId,input.scope.contactId);
   const samples=[];let result;
   for(let i=0;i<3;i++){totalQueries=0;eligibilityQueries=0;const started=performance.now();result=managementRead(tx,input);samples.push({durationMs:performance.now()-started,totalQueries,eligibilityQueries});}
   results[scenario]={samples,...inspect(result)};
  }finally{db.exec('ROLLBACK');}
 }
}finally{db.close();}
if(phase==='before'||phase==='baseline'){state.before=results;await writeFile(join(root,'state.json'),JSON.stringify(state),{mode:0o600});console.log(JSON.stringify({phase,root,results}));}
else{
 const equal=Object.keys(results).map(scenario=>({scenario,equal:results[scenario].hash===state.before[scenario].hash,itemsEqual:JSON.stringify(results[scenario].candidates)===JSON.stringify(state.before[scenario].candidates)&&JSON.stringify(results[scenario].memories)===JSON.stringify(state.before[scenario].memories)}));
 console.log(JSON.stringify({phase,results,equal}));
 if(equal.some(e=>!e.equal||!e.itemsEqual))process.exitCode=1;
}
