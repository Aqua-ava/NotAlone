import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {encodePreparedContext,decodePreparedContext} from '../src/reply-prepared-codec.ts';
import {stringifyJson} from '../src/host-json.ts';
const root=new URL('../../',import.meta.url).pathname,python=resolve(homedir(),'miniconda3/envs/NotAlone/bin/python');
const env={...process.env,PYTHONPATH:root+'/backend/src:'+root+'/backend',NOTALONE_DISABLE_DOTENV:'1'};
const original=JSON.parse(execFileSync(python,['-c',`import json
from tests.unit.reply.test_input_budget_runtime import prepared_context
from notalone.reply.prepared_context_codec import encode_context
print(json.dumps(encode_context(prepared_context()),ensure_ascii=False))`],{env,encoding:'utf8'}));
const scope={owner_id:'00000000-0000-0000-0000-000000000001',contact_id:'00000000-0000-0000-0000-000000000002'},binding='00000000-0000-0000-0000-000000000003';
const command={contact_id:scope.contact_id,idempotency_key:'00000000-0000-0000-0000-000000000006',content:{type:'rewrite_draft',include_relationship_context:false},continued_from_candidate_id:null};
test('旧Python v2/r15精确往返，C重绑定只改request UUID不改冻结证据',()=>{
 const decoded=decodePreparedContext(original,command,scope,binding);assert.deepEqual(encodePreparedContext(decoded),original);
 const request='00000000-0000-0000-0000-000000000099',rebound=decodePreparedContext(original,command,scope,binding,request);assert.equal(rebound.reply_request_id,request);assert.deepEqual(rebound.evidence,decoded.evidence);
 const output=execFileSync(python,['-c',`import json,sys
from tests.unit.reply.test_input_budget_runtime import prepared_context
from notalone.reply.prepared_context_codec import encode_context,decode_context
p=json.load(sys.stdin);print(json.dumps(encode_context(decode_context(p,prepared_context().command)),ensure_ascii=False))`],{env,input:stringifyJson(encodePreparedContext(rebound)),encoding:'utf8'});assert.deepEqual(JSON.parse(output),encodePreparedContext(rebound));
});
test('未知格式、缺字段、错误类型、跨scope及无冻结历史明确拒绝',()=>{
 for(const mutate of [p=>p.schema_revision=14,p=>p.extra=1,p=>delete p.context.overview_read_failed,p=>p.context.evidence[0].fields.model_visible='true',p=>p.context.scope.fields.owner_id.uuid=binding]){const p=structuredClone(original);mutate(p);assert.throws(()=>decodePreparedContext(p,command,scope,binding),/重新准备/);}
 assert.throws(()=>decodePreparedContext(original,{...command,content:{...command.content,include_relationship_context:true}},scope,binding),/重新准备/);
});
