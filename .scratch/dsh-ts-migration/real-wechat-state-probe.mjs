// 只检查本轮测试库、认证状态和自有读进程；不输出身份、正文或凭据。
import {readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
const metadata=JSON.parse(await readFile('/tmp/notalone-dsh-real-acceptance-session.json','utf8'));
if(!/^notalone_ts_host_.*_test$/.test(metadata.database))throw Error('拒绝非本轮测试库');
const require=createRequire(join(metadata.project,'backend-ts/package.json'));
const pg=require('pg');
const permitted=JSON.parse(await readFile(metadata.scopeFile,'utf8'));
const info=Object.fromEntries((await readFile(metadata.infoPath,'utf8')).trim().split('\n').map(line=>{const at=line.indexOf('=');return [line.slice(0,at),line.slice(at+1)];}));
async function get(path){
  const response=await fetch(`http://${info.address}${path}`,{headers:{Authorization:`Bearer ${info.token}`},signal:AbortSignal.timeout(6000)});
  if(response.status!==200)throw Error('本轮状态查询失败');
  return response.json();
}
const status=await get('/api/sync/status'),runtime=await get('/api/runtime/status');
const keys=['sync_enabled','sync_scope','phase','cli_available','failure_code','cli_sync_phase','cli_sync_mode','cli_stream_active','cli_bound_count','cli_pending_count','cli_batch_message_count','cli_failure_code','cli_history_authorization_state'];
const publicState=Object.fromEntries(keys.filter(key=>Object.hasOwn(status,key)).map(key=>[key,status[key]]));
const {stdout}=await promisify(execFile)('/bin/ps',['-axo','pid=,ppid=,command='],{maxBuffer:4*1024*1024});
const parents=new Set([runtime.pid,runtime.legacyPid]);
const readers=[];
for(const line of stdout.split('\n')){
  const match=/^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
  if(!match||!parents.has(Number(match[2]))||!match[3].startsWith(permitted.cli+' '))continue;
  const command=match[3];
  readers.push({parent:match[2]===String(runtime.pid)?'typescript':'python',
    metadata_follow:command.includes('--mode sessions'),history:command.includes('--history'),
    since_time:command.includes('--since-time'),strict_read_only:command.includes('--strict-read-only'),
    target_matches:command.includes(permitted.locator)});
}
const client=new pg.Client({host:'/tmp',database:metadata.database});await client.connect();
let database;
try{
  database=(await client.query(`SELECT
    (SELECT count(*)::int FROM public.contact) contacts,
    (SELECT count(*)::int FROM public.conversation_binding WHERE status='active') active_bindings,
    (SELECT count(*)::int FROM public.wechat_binding_history_authorization) history_authorizations,
    (SELECT decision FROM public.wechat_history_sync_authorization WHERE owner_id=$1) history_decision,
    (SELECT count(*)::int FROM public.message) messages,
    (SELECT count(*)::int FROM public.message WHERE owner_id<>$1 OR contact_id<>$2) outside_scope_messages,
    (SELECT count(*)::int FROM public.reply_request) reply_requests,
    (SELECT count(*)::int FROM public.outbound_ledger_entry) outbound_calls,
    (SELECT count(*)::int FROM public.message m JOIN public.wechat_message_metadata wm ON wm.message_id=m.id AND wm.owner_id=m.owner_id AND wm.contact_id=m.contact_id JOIN public.wechat_observation_baseline b ON b.owner_id=m.owner_id AND b.contact_id=m.contact_id WHERE wm.source_create_time < extract(epoch FROM b.baseline_at)) before_baseline_messages,
    (SELECT baseline_at=$4::timestamptz FROM public.wechat_observation_baseline WHERE binding_id=$3) original_baseline_unchanged,
    (SELECT count(*)=1 FROM public.conversation_binding WHERE id=$3 AND owner_id=$1 AND contact_id=$2 AND status='active') original_binding_unchanged`,
    [metadata.owner,metadata.contact,metadata.binding,metadata.baseline])).rows[0];
}finally{await client.end();}
const report={checked_at:new Date().toISOString(),label:process.argv[2]||'state',public_state:publicState,
  runtime:{state:runtime.state,ownership:runtime.ownership},readers,database};
const output=resolve('.scratch/dsh-ts-migration/real-wechat-state-evidence.json');
let reports=[];
try{reports=JSON.parse(await readFile(output,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
reports.push(report);await writeFile(output,JSON.stringify(reports,null,2)+'\n');
console.log(JSON.stringify(report));
