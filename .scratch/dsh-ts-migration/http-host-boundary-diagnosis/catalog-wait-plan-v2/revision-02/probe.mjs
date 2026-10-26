/** 只在获准执行时运行：同一真实HostStorage事务的原catalog与EXPLAIN。 */
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
process.umask(0o077);
const here=import.meta.dirname,run=process.env.NOTALONE_CATALOG_RUN,project=process.env.NOTALONE_CATALOG_PROJECT;
const config=JSON.parse(readFileSync(path.join(here,'configuration.json'),'utf8'));
const params=JSON.parse(readFileSync(path.join(here,'params.json'),'utf8'));
const explainSql=readFileSync(path.join(here,'explain.sql'),'utf8');
const now=()=>Number(process.hrtime.bigint())/1e6;
const rows=Array.from({length:config.units},(_,i)=>({index:i-config.warmups,warmup:i<config.warmups,status:'not_attempted',points:[]}));
const output={diagnostic_only:true,formal_performance_qualified:false,transaction_method:config.transaction_method,transaction_differs_from_get:config.transaction_differs_from_observed_get_source,rows,setup_catalog_starts:0,setup_catalog_finishes:0,physical_target_catalog_starts:0,physical_target_catalog_finishes:0,physical_explain_starts:0,physical_explain_finishes:0,failures:[],cleanup:{},observer_limits:{point_overflow:false},unknowns:['独立HostStorage与完整DSH/HTTP环境不同','EXPLAIN不含parse/rewrite及正常输出传输','raw固定在EXPLAIN之前的顺序/缓存偏差','无ready/dataRow/GC观察']};
let current=null,stopping=false,storage;const aliases=new Map();
const alias=pid=>{if(!Number.isSafeInteger(pid)||pid<1)throw Error('backend_pid_unknown');if(!aliases.has(pid))aliases.set(pid,'connection-'+(aliases.size+1));return aliases.get(pid);};
const observer={point(label,value){
 if(!current){if(label==='catalog.dispatch')output.setup_catalog_starts++;if(label==='catalog.resume')output.setup_catalog_finishes++;return;}
 if(current.points.length>=32){output.observer_limits.point_overflow=true;return;}
 current.points.push({label,time_ms:now()});
 if(label==='catalog.dispatch'){current.raw_connection=alias(value);output.physical_target_catalog_starts++;}
 if(label==='catalog.resume'){current.raw_envelope=value;output.physical_target_catalog_finishes++;}
}};
globalThis[Symbol.for('notalone.catalogProbe.v2')]=observer;
process.once('SIGTERM',()=>{stopping=true;output.stop_requested=true;});
process.once('SIGINT',()=>{stopping=true;output.stop_requested=true;});
try{
 const {HostStorage}=await import(pathToFileURL(path.join(project,'backend-ts/src/host-storage.ts')));
 storage=await HostStorage.open({envFilePath:process.env.NOTALONE_ENV_FILE,migrationsDirectory:path.join(project,'backend/database/migrations'),environment:{...process.env}});
 if(!['businessTransaction','businessReadTransaction'].includes(config.transaction_method))throw Error('invalid_frozen_transaction_method');
 for(const row of rows){
  if(stopping)break;current=row;row.status='failed';row.started_ms=now();
  try{
   await storage[config.transaction_method](async client=>{
    row.explain_connection=alias(client.processID);
    if(row.index===-config.warmups){
     const settings=(await client.query("SELECT current_setting('server_version_num') AS server_version_num,current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS read_only,current_setting('search_path') AS search_path,current_setting('statement_timeout') AS statement_timeout,current_setting('lock_timeout') AS lock_timeout")).rows[0];
     output.actual_transaction_settings=settings;output.setup_control_queries=1;
     if(settings.isolation!==config.expected_isolation||settings.read_only!==config.expected_read_only)throw Error('transaction_settings_mismatch');
    }
    if(row.raw_connection!==row.explain_connection)throw Error('catalog_explain_connection_mismatch');
    row.explain_started_ms=now();output.physical_explain_starts++;
    const result=await client.query(explainSql,params);
    row.explain_finished_ms=now();output.physical_explain_finishes++;
    if(result.rowCount!==1||!Array.isArray(result.rows[0]?.['QUERY PLAN']))throw Error('unexpected_explain_shape');
    row.explain=result.rows[0]['QUERY PLAN'];
   });
   row.finished_ms=now();row.status='succeeded';
  }catch(error){row.error={name:error?.name??'Error',message:String(error?.message??error)};output.failures.push(row.error);break;}
  finally{current=null;}
 }
}catch(error){output.failures.push({name:error?.name??'Error',message:String(error?.message??error)});}
finally{
 current=null;
 if(storage){try{await storage.close();output.cleanup.storage_closed=true;}catch(error){output.cleanup.storage_closed=false;output.failures.push({name:error?.name??'Error',message:String(error?.message??error)});}}
 for(const row of rows)if(row.status==='not_attempted')row.unknown_reason='stopped_before_unit';
 output.connection_alias_count=aliases.size;
 writeFileSync(path.join(run,'probe-result.json'),JSON.stringify(output)+'\n',{mode:0o600});
}
console.log(JSON.stringify({succeeded:rows.filter(r=>r.status==='succeeded').length,failed:rows.filter(r=>r.status==='failed').length,not_attempted:rows.filter(r=>r.status==='not_attempted').length,storage_closed:output.cleanup.storage_closed}));
process.exitCode=rows.every(r=>r.status==='succeeded')&&!output.failures.length?0:2;
