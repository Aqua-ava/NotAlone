// 仅核对已授权的新测试文字；私密UUID只留本轮临时元数据，不输出正文或渠道身份。
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
const metadataPath='/tmp/notalone-dsh-real-acceptance-session.json';
const metadata=JSON.parse(await readFile(metadataPath,'utf8'));
if(!/^notalone_ts_host_[a-f0-9]+_test$/.test(metadata.database))throw Error('拒绝非本轮合成库');
const label=process.argv[2]??'positive';
if(!/^[a-z0-9_-]{1,60}$/.test(label))throw Error('检查阶段无效');
const require=createRequire(join(metadata.project,'backend-ts/package.json'));
const pg=require('pg'),client=new pg.Client({host:'/tmp',database:metadata.database});
await client.connect();
let result;
try{
  const rows=(await client.query('SELECT id,speaker FROM public.message WHERE owner_id=$1 AND contact_id=$2 AND text_content=$3',
    [metadata.owner,metadata.contact,'NotAlone 本机同步验收 1024'])).rows;
  if(rows.length!==1||rows[0].speaker!=='user')throw Error('新测试文字或本人说话人不匹配');
  const id=rows[0].id;
  if(metadata.positiveMessageId!==undefined&&metadata.positiveMessageId!==id)throw Error('原消息UUID变化');
  metadata.positiveMessageId??=id;
  await writeFile(metadataPath,JSON.stringify(metadata),{mode:0o600});
  result=(await client.query(`SELECT
    (SELECT count(*)::int FROM public.message) AS messages,
    (SELECT count(*)::int FROM public.message WHERE owner_id<>$1 OR contact_id<>$2) AS outside_scope_messages,
    (SELECT count(*)::int FROM public.wechat_message_metadata WHERE message_id=$3 AND owner_id=$1 AND contact_id=$2) AS target_metadata,
    (SELECT count(*)::int FROM public.message_source_ref WHERE message_id=$3 AND owner_id=$1 AND contact_id=$2 AND source_kind='local_wechat_observation') AS target_source_refs,
    (SELECT count(*)::int FROM public.source_processing_record WHERE message_id=$3 AND owner_id=$1 AND contact_id=$2) AS target_processing_records,
    (SELECT count(*)::int FROM public.wechat_binding_history_authorization) AS history_authorizations,
    (SELECT decision FROM public.wechat_history_sync_authorization WHERE owner_id=$1) AS history_decision,
    (SELECT count(*)::int FROM public.reply_request) AS reply_requests,
    (SELECT count(*)::int FROM public.outbound_ledger_entry) AS model_outbound_calls,
    (SELECT count(*)::int FROM public.message m JOIN public.wechat_message_metadata wm ON wm.message_id=m.id AND wm.owner_id=m.owner_id AND wm.contact_id=m.contact_id JOIN public.wechat_observation_baseline b ON b.owner_id=m.owner_id AND b.contact_id=m.contact_id WHERE wm.source_create_time<extract(epoch FROM b.baseline_at)) AS before_baseline_messages,
    (SELECT baseline_at=$5::timestamptz FROM public.wechat_observation_baseline WHERE binding_id=$4) AS baseline_unchanged,
    (SELECT count(*)=1 FROM public.conversation_binding WHERE id=$4 AND owner_id=$1 AND contact_id=$2 AND status='active') AS binding_unchanged`,
    [metadata.owner,metadata.contact,id,metadata.binding,metadata.baseline])).rows[0];
  if(result.messages<1||result.outside_scope_messages!==0||result.target_metadata!==1||result.target_source_refs<1||result.target_processing_records<1
    ||result.history_authorizations!==0||result.history_decision!=='declined'||result.reply_requests!==0||result.model_outbound_calls!==0
    ||result.before_baseline_messages!==0||!result.baseline_unchanged||!result.binding_unchanged){console.log(JSON.stringify({boundary_check:result}));throw Error('本轮范围或来源不符合验收边界');}
}finally{await client.end();}
const report={checked_at:new Date().toISOString(),label,exact_test_text_match:true,test_message_count:1,speaker_is_owner:true,original_message_uuid_unchanged:true,
  developer_authorized_test_sends:1,...result};
const output=resolve('.scratch/dsh-ts-migration/real-wechat-positive-evidence.json');
let reports=[];
try{reports=JSON.parse(await readFile(output,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
reports.push(report);await writeFile(output,JSON.stringify(reports,null,2)+'\n');
console.log(JSON.stringify(report));
