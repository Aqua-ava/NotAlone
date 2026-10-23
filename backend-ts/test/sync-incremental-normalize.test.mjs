import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeCliEvents} from '../src/sync-incremental-normalize.ts';
const event = (changes={}) => ({message_id:{local_id:101,talker:'wxid_synthetic_contact',server_id_str:'9223372036854775807'},text:'合成文字 👨‍👩‍👧‍👦\n[微笑]',kind:'text',sender:'合成',sender_wxid:'wxid_synthetic_contact',is_from_me:false,create_time:1770000000,time:null,time_iso:null,...changes});
test('文字保留正文、稳定身份和原始epoch时间', () => {
 const [message] = normalizeCliEvents([event()]);
 assert.equal(message.source_locator,'cli:101');
 assert.equal(message.text_content,'合成文字 👨‍👩‍👧‍👦\n[微笑]');
 assert.equal(message.speaker,'contact');
 assert.equal(message.occurred_at,'2026-02-02T02:40:00+00:00');
 assert.equal(message.wechat_metadata.external_server_id,'9223372036854775807');
});
test('文字和媒体页保留排序末尾游标、大整数及最小媒体收据', async () => {
 const {parseIncrementalTail} = await import('../src/sync-incremental-normalize.ts');
 const line=(id,kind,text)=>({type:'message',cursor:`opaque:${id}`,message:{id:{local_id:id,talker:'wxid_synthetic_contact'},kind,text,is_from_me:false}});
 const page=parseIncrementalTail(JSON.stringify({ok:true,data:{events:[line(105,'text','合成'),line(103,'image','不得保留')],cursor:'opaque:103',freshness:{message_source:'live_message_db'},query:{chat:'wxid_synthetic_contact',has_more:true}}}),'wxid_synthetic_contact');
 assert.equal(page.last_local_id,'103');assert.equal(page.cursor,'opaque:103');assert.equal(page.events.length,1);assert.equal(page.has_more,true);
 assert.equal(JSON.stringify(page.filtered_records).includes('不得保留'),false);
 const large=parseIncrementalTail('{"type":"message","cursor":"opaque:large","message":{"id":{"local_id":9223372036854775807,"talker":"wxid_synthetic_contact"},"kind":"text","text":"合成","is_from_me":false}}','wxid_synthetic_contact');
 assert.equal(large.last_local_id,'9223372036854775807');assert.equal(normalizeCliEvents(large.events)[0].wechat_metadata.external_local_id,'9223372036854775807');
});
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {parseIncrementalTail,parseIncrementalSessionLine} from '../src/sync-incremental-normalize.ts';
const root=fileURLToPath(new URL('../../',import.meta.url));
function frozenPython(inputs){
 const script=`import sys,json,subprocess\nfrom dataclasses import asdict\nfrom notalone.wechat_cli.models import CliMessageEvent,MessageIdentifier\npath='backend/src/notalone/wechat_cli/normalizer.py'\nsrc=subprocess.check_output(['git','show','3c168296e9e8edaa43b8b323ff693e790e709069:'+path],text=True)\nns={'__file__':path,'__name__':'frozen_normalizer'}\nexec(compile(src,path,'exec'),ns)\nresult=[]\nfor e in json.load(sys.stdin):\n e['message_id']=MessageIdentifier(**e['message_id'])\n try:\n  messages=ns['normalize_cli_events']([CliMessageEvent(**e)])\n  out=[]\n  for msg in messages:\n   value=asdict(msg);value.pop('processing_record');value['occurred_at']=msg.occurred_at.isoformat() if msg.occurred_at else None;value['wechat_metadata']['external_local_id']=str(value['wechat_metadata']['external_local_id']);value['wechat_metadata']['raw_payload_json']=json.loads(value['wechat_metadata']['raw_payload_json']);out.append(value)\n  result.append(out)\n except Exception as error: result.append({'code':getattr(error,'code',type(error).__name__)})\nprint(json.dumps(result,ensure_ascii=False))`;
 const p=spawnSync(`${process.env.HOME}/miniconda3/envs/NotAlone/bin/python`,['-c',script],{cwd:root,input:JSON.stringify(inputs),encoding:'utf8',env:{...process.env,PYTHONPATH:`${root}/backend/src`}});
 assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);
}
test('冻结Python对照：时间精度、方向、空白、媒体、引用和损坏输入一致',()=>{
 const cases=[event(),event({is_from_me:true}),event({text:'  原样空格\n🙂  '}),event({text:'\t\n'}),event({kind:'image',text:'不保存媒体'}),event({kind:'reply',text:'不伪造引用'}),event({create_time:null,time_iso:null}),event({create_time:null,time_iso:'2026-02-02T08:00:00+08:00'}),event({create_time:null,time_iso:'2026-02-02T08:00:00.123456'}),event({create_time:null,time_iso:'20260202T080000Z'}),event({create_time:null,time_iso:'2026-02-30T00:00:00'}),event({create_time:10**20}),event({is_from_me:null})];
 const actual=cases.map(e=>{try{return normalizeCliEvents([e]).map(({processing_record,...m})=>({...m,wechat_metadata:{...m.wechat_metadata,raw_payload_json:JSON.parse(m.wechat_metadata.raw_payload_json)}}));}catch(error){return {code:error.code};}});
 assert.deepEqual(actual,frozenPython(cases));
});
test('空页保留未知水位，媒体和坏来源不得冒充追平',()=>{
 assert.deepEqual(parseIncrementalTail('','x'),{events:[],cursor:null,last_local_id:null,event_count:0,non_text_count:0,freshness_confirmed:false,filtered_records:[],has_more:false,local_history_state:null});
 const wrap=(changes={})=>JSON.stringify({ok:true,data:{events:[],cursor:'stale',freshness:{message_source:'live_message_db'},query:{chat:'x',has_more:false},...changes}});
 assert.equal(parseIncrementalTail(wrap(),'x').cursor,null);assert.equal(parseIncrementalTail(wrap(),'x').freshness_confirmed,true);
 assert.throws(()=>parseIncrementalTail(wrap({query:{chat:'x',has_more:true}}),'x'),{code:'cli_output_invalid'});
 assert.throws(()=>parseIncrementalTail(wrap({freshness:{message_source:'cache'}}),'x'),{code:'cli_freshness_unknown'});
 assert.throws(()=>parseIncrementalTail(wrap(),'x',{history:true}),{code:'cli_freshness_unknown'});
});
test('混联系人和坏字段失败关闭，失败收据不带原始正文',()=>{
 assert.throws(()=>normalizeCliEvents([event(),event({message_id:{local_id:102,talker:'other',server_id_str:null}})]),{code:'cli_normalization_failed'});
 const line=(patch)=>JSON.stringify({type:'message',cursor:'opaque',message:{id:{local_id:101,talker:'x'},kind:'text',text:'敏感合成占位',is_from_me:false,...patch}});
 for(const patch of [{id:{local_id:true,talker:'x'}},{id:{local_id:1,talker:'other'}},{is_from_me:1},{create_time:'123'},{text:' '},{sender:1}]){
 assert.throws(()=>parseIncrementalTail(line(patch),'x'),error=>error.code==='cli_output_invalid'&&!error.failure_record.payload_json.includes('敏感合成占位'));
 }
});
test('规范化保留重复事件给唯一写入者去重，收据UUID不替代消息UUID',()=>{
 const receipts=[];const messages=normalizeCliEvents([event(),event(),event({kind:'image'})],{processingReceipts:receipts});
 assert.equal(messages.length,2);assert.equal(receipts.length,3);assert.notEqual(receipts[0].record_id,receipts[1].record_id);
 assert.match(receipts[0].record_id,/^[a-f0-9-]{36}$/);assert.equal('message_id' in messages[0],false);
});
test('session通知仅返回游标和定位，拒绝失败envelope',()=>{
 assert.deepEqual(parseIncrementalSessionLine(JSON.stringify({type:'unread',cursor:'s1',session:{username:'wxid_synthetic',display_name:'不得返回',summary:'不读取'}})),{cursor:'s1',conversation_locator:'wxid_synthetic'});
 assert.equal(parseIncrementalSessionLine('{"type":"heartbeat"}'),null);
 assert.throws(()=>parseIncrementalSessionLine('{"ok":false,"error":{"code":"failed"}}'),{code:'cli_command_failed'});
});
test('冻结Python对照：周日期及秒级偏移不能被迁移丢弃',()=>{
 const inputs=['2026-W05','2026W051T10','2026-02-02T12.5','2026-02-02T12:00+01:70','2026-02-02T12:00+00:00:00.5','2026-02-02T12:00+01:02:03.123456','2026-W53-7','2020-W53-7','2026-02-30T12','20260202T080000Z','2026-02-02😀12:03:04,1234567'];
 for(const date of ['0001-01-01','2020-W53-7','2021-W53-1','2026-02-29','2024-02-29','9999-12-31','20261024'])for(const time of ['', 'T12','T12:30','T123045.1234567','T24:00','T12:60','T12:30:60','T12:30+010203.123','T12:30-00:00:30','T12:30+23:59:59.9','T12:30+24:00'])inputs.push(date+time);
 const cases=inputs.map(time_iso=>event({create_time:null,time_iso}));
 const actual=cases.map(e=>{try{return normalizeCliEvents([e]).map(({processing_record,...m})=>({...m,wechat_metadata:{...m.wechat_metadata,raw_payload_json:JSON.parse(m.wechat_metadata.raw_payload_json)}}));}catch(error){return {code:error.code};}});
 assert.deepEqual(actual,frozenPython(cases));
});
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
test('来源收据可核验当时解析规范化规则摘要，并保留解析收据UUID',()=>{
 const raw=JSON.stringify({type:'message',cursor:'cursor',message:{id:{local_id:1,talker:'x'},kind:'text',text:'合成',is_from_me:false}});
 const page=parseIncrementalTail(raw,'x'),before=page.events[0].processing_record;
 const [message]=normalizeCliEvents(page.events),receipt=JSON.parse(message.processing_record.payload_json);
 const digest=createHash('sha256').update(readFileSync(new URL('../src/sync-incremental-normalize.ts',import.meta.url))).digest('hex');
 assert.equal(message.processing_record.record_id,before.record_id);
 assert.equal(receipt.record_text,raw);
 assert.equal(receipt.parse.rule_version,digest);assert.equal(receipt.normalize.rule_version,digest);
 assert.equal(receipt.outcome,'normalized');
});
test('已加载规则的收据版本不随磁盘文件后续改动变化',async t=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');
 const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {pathToFileURL}=await import('node:url');
 const directory=await mkdtemp(join(tmpdir(),'notalone-rule-version-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const file=join(directory,'normalize.ts');
 const source=readFileSync(new URL('../src/sync-incremental-normalize.ts',import.meta.url),'utf8').replace("'./host-json.ts'",JSON.stringify(new URL('../src/host-json.ts',import.meta.url).href));
 await writeFile(file,source);const loaded=await import(pathToFileURL(file).href);
 const expected=createHash('sha256').update(source).digest('hex');
 await writeFile(file,source+'\n// 合成磁盘修改，不重新加载模块。\n');
 const page=loaded.parseIncrementalTail(JSON.stringify({type:'message',cursor:'c',message:{id:{local_id:1,talker:'synthetic'},kind:'text',text:'合成',is_from_me:false}}),'synthetic');
 const [message]=loaded.normalizeCliEvents(page.events);const receipt=JSON.parse(message.processing_record.payload_json);
 assert.equal(receipt.parse.rule_version,expected);assert.equal(receipt.normalize.rule_version,expected);
});
