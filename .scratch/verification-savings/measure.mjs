// 只在内存中生成合成核验请求与回复；不启动 App、不访问业务资料、不调用模型。
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {dirname,relative,resolve} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {digest} from '../../backend-ts/src/memory/evidence/canonical-json.ts';
import {prepareSourceVerification,replayCompleteClaimVerification} from '../../backend-ts/src/memory/extraction/verification/complete-claim.ts';
import {prepareMultimodalVerification,replayMultimodalVerification} from '../../backend-ts/src/memory/extraction/multimodal.ts';
import {completeClaimRow} from '../../backend-ts/test/fixtures/complete-claim-response.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const legacyRevision='962ed44b965afbe4e7ca15b9eea46a4ae4e9f612'; // 7769fe4ae 的父提交
const extraction='backend-ts/src/memory/extraction/';
const archives=JSON.parse(readFileSync(resolve(root,'backend-ts/test/fixtures/verification-hash-archives.json'),'utf8'));
const archive=kind=>archives.find(item=>item.kind===kind);
const id=n=>`${String(n).padStart(8,'0')}-1111-4111-8111-111111111111`;
const blocks=value=>[{type:'tool-call',name:'SourceVerificationOutput',arguments:JSON.stringify(value)}];
const historicalSource=path=>execFileSync('git',['show',`${legacyRevision}:${path}`],{cwd:root,encoding:'utf8'});

// 旧 complete-claim 的 contract/prompts 必须使用同一版本，其余基础校验复用当前代码。
// import 的重定向只发生在内存中，既不落盘旧源码，也不编辑任何 src 文件。
const historicalModules=new Map();
async function historicalModule(path){
 if(historicalModules.has(path))return historicalModules.get(path);
 let source=stripTypeScriptTypes(historicalSource(path));
 const imports=[...source.matchAll(/from\s*['"](\.[^'"]+)['"]/gu)];
 for(const match of imports){
  const dependency=relative(root,resolve(root,dirname(path),match[1]));
  const specifier=dependency===`${extraction}contract.ts`||dependency===`${extraction}prompts.ts`
   ?await historicalModule(dependency):pathToFileURL(resolve(root,dirname(path),match[1])).href;
  source=source.replace(match[0],`from ${JSON.stringify(specifier)}`);
 }
 const url=`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
 historicalModules.set(path,url);return url;
}
const oldComplete=await import(await historicalModule(`${extraction}verification/complete-claim.ts`));
// 图文只读取常量及纯 payload 函数；真实历史 flat 合同不经手工逆变换。
const multimodalSource=historicalSource(`${extraction}multimodal.ts`);
const constants=multimodalSource.slice(multimodalSource.indexOf('const policyId='),multimodalSource.indexOf('function fail('));
const payloadSource=multimodalSource.slice(multimodalSource.indexOf('function payload('),multimodalSource.indexOf('function facetStatus('));
const oldMultimodal=new Function(stripTypeScriptTypes(`${constants}\n${payloadSource}`)+
 ';return {schema,prompt,payload,fields,facet,attributionFacet};')();

function scenario(count,imageCount){
 const base=archive(imageCount?'flat-fields-v2':'complete-claim-v1');
 const window=structuredClone(base.window),textCount=Math.min(count,20);
 window.messages=Array.from({length:textCount},(_,i)=>({...base.window.messages[0],message_id:id(100+i)}));
 window.target_message_ids=window.messages.map(message=>message.message_id);
 const imageMessages=Array.from({length:imageCount},(_,i)=>{
  const message=structuredClone(base.window.messages[1]);
  message.message_id=id(1000+i);message.image.id=id(2000+i);message.image.file_id=message.image.id;
  return message;
 });
 window.messages.push(...imageMessages);
 const facts=Array.from({length:count},(_,i)=>({...structuredClone(base.facts[0]),
  source_message_ids:[window.messages[i%textCount].message_id,...imageMessages.map(message=>message.message_id)]}));
 const bytes=Buffer.from('synthetic-image-local-ids');
 return {window,facts,images:imageMessages.map(message=>({id:message.image.id,mimeType:'image/png',dataBase64:bytes.toString('base64')})),
  policy:{id:'complete-claim-v1',rule_version:'a'.repeat(64)},requireCurrent:async()=>{}};
}

function multimodalResponse(s,format,fingerprint){
 const template=JSON.parse(archive(format==='nested-v1'?'nested-v1':'flat-fields-v2').blocks[0].arguments).results[0];
 const results=s.facts.map((fact,candidate_index)=>{
  const row=structuredClone(template);row.candidate_index=candidate_index;
  row.evidence=fact.source_message_ids.map(message_id=>{
   const message=s.window.messages.find(item=>item.message_id===message_id);
   return message.image?{...structuredClone(template.evidence[1]),message_id,file_id:message.image.file_id,sha256:message.image.sha256}
    :{...structuredClone(template.evidence[0]),message_id};
  });
  const indices=row.evidence.map((_,index)=>index);
  // 仅保留必填字段；说明文字沿用存档，所有格式使用相同措辞和依据。
  if(format==='nested-v1'){
   for(const facet of [row.claim_check.attribution,row.claim_check.body,row.claim_check.temporal_and_modality,
    ...Object.values(row.claim_check.field_checks)])facet.evidence_indices=[...indices];
  }else{
   for(const check of row.checks)check.evidence_indices=[...indices];
   if(format==='local-ids-v3')for(const ref of row.evidence){delete ref.file_id;delete ref.sha256;}
  }
  return row;
 });
 return format==='local-ids-v3'?{results}:{request_fingerprint:fingerprint,results};
}
function completeResponse(s,fingerprint){
 const results=s.facts.map((fact,candidate_index)=>completeClaimRow(fact,{candidate_index,verdict:'supported',issues:[],
  evidence:fact.source_message_ids.map(message_id=>({message_id,quote:s.window.messages.find(m=>m.message_id===message_id).text}))},s.window));
 return fingerprint?{request_fingerprint:fingerprint,results}:{results};
}

// nested 存档没有 system/schema；以下合同按归档/decoder 重建，不能冒称历史原文。
function nestedContract(){
 const {fields,facet,attributionFacet}=oldMultimodal,schema=structuredClone(oldMultimodal.schema);
 const row=schema.properties.results.items;
 for(const field of ['scope_subject','actor_kind','resolution','checks'])delete row.properties[field];
 row.properties.claim_check={type:'object',additionalProperties:false,properties:{version:{type:'integer',enum:[1]},
  attribution:attributionFacet,body:facet,temporal_and_modality:facet,
  field_checks:{type:'object',additionalProperties:false,properties:Object.fromEntries(fields.map(field=>[field,facet])),required:[...fields]}},
  required:['version','attribution','body','temporal_and_modality','field_checks']};
 row.required=['candidate_index','verdict','issues','evidence','claim_check'];
 const prompt=oldMultimodal.prompt
  .replace(/^输出采用flat-fields-v2：.*$/mu,'输出采用nested-v1：每条results记录填写claim_check，version固定为1；attribution含scope_subject、actor_kind、resolution与verdict、evidence_indices、explanation；body及temporal_and_modality分别填写verdict、evidence_indices、explanation；field_checks独立包含category、topic、scene_name、alternatives、interpretation_reason、valid_at、invalid_at、speech_act、assertion_status、figurative_type、event、conditions，各项填写相同三个核验键。')
  .replaceAll('每个check','每个核验项').replace('完整闭合每个核验项对象、checks数组、结果对象、results数组及最外层对象。','完整闭合每个核验项、field_checks、claim_check、结果对象、results数组及最外层对象。');
 assert.doesNotMatch(prompt,/flat-fields-v2|checks数组/u);
 return {schema,prompt};
}

// 对量化涉及的内联 JSON Schema 约束逐项校验，再走正式解码器；不调用供应商 SDK。
function assertSchema(value,schema,path='$'){
 if(schema.type){const types=[schema.type].flat(),type=value===null?'null':Array.isArray(value)?'array':typeof value;
  assert.ok(types.includes(type)||(type==='number'&&Number.isInteger(value)&&types.includes('integer')),`${path}: type`);}
 if(schema.enum)assert.ok(schema.enum.some(item=>JSON.stringify(item)===JSON.stringify(value)),`${path}: enum`);
 if(typeof value==='string'){
  const length=[...value].length;
  if(schema.minLength!==undefined)assert.ok(length>=schema.minLength,`${path}: minLength`);
  if(schema.maxLength!==undefined)assert.ok(length<=schema.maxLength,`${path}: maxLength`);
  if(schema.pattern)assert.match(value,new RegExp(schema.pattern),`${path}: pattern`);
  if(schema.format==='uuid')assert.match(value,/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/iu,`${path}: uuid`);
 }
 if(typeof value==='number'){
  if(schema.minimum!==undefined)assert.ok(value>=schema.minimum,`${path}: minimum`);
  if(schema.maximum!==undefined)assert.ok(value<=schema.maximum,`${path}: maximum`);
 }
 if(Array.isArray(value)){
  if(schema.minItems!==undefined)assert.ok(value.length>=schema.minItems,`${path}: minItems`);
  if(schema.maxItems!==undefined)assert.ok(value.length<=schema.maxItems,`${path}: maxItems`);
  value.forEach((item,index)=>assertSchema(item,schema.items,`${path}[${index}]`));
 }else if(value&&typeof value==='object'){
  for(const key of schema.required??[])assert.ok(Object.hasOwn(value,key),`${path}.${key}: required`);
  for(const [key,item] of Object.entries(value)){
   if(schema.additionalProperties===false)assert.ok(Object.hasOwn(schema.properties,key),`${path}.${key}: additionalProperties`);
   if(schema.properties?.[key])assertSchema(item,schema.properties[key],`${path}.${key}`);
  }
 }
}
const size=text=>({bytes:Buffer.byteLength(text,'utf8'),chars:[...text].length});
const measurements=[];
async function measure(count,imageCount,format,request,response,decode){
 assertSchema(response,request.tool.parameters);
 const decoded=await decode(blocks(response)),items=decoded.items??decoded;
 assert.equal(items.length,count);assert.ok(items.every(item=>item.admitted),'所有最小字段响应都必须合法准入');
 const parts={system:size(request.system),user:size(request.user),schema:size(JSON.stringify(request.tool.parameters))};
 if(format==='local-ids-v3')for(const text of [request.system,request.user,JSON.stringify(request.tool.parameters)]){
  assert.doesNotMatch(text,/[a-f0-9]{64}/iu);assert.doesNotMatch(text,/request_fingerprint|sha256/iu);
 }
 const responseSize=size(JSON.stringify(response));
 measurements.push({candidates:count,images:imageCount,format,contract:format==='nested-v1'?'重建':'源码',...Object.fromEntries(
  Object.entries(parts).flatMap(([part,value])=>Object.entries(value).map(([unit,n])=>[`${part}_${unit}`,n]))),
  request_bytes:Object.values(parts).reduce((n,p)=>n+p.bytes,0),request_chars:Object.values(parts).reduce((n,p)=>n+p.chars,0),
  response_bytes:responseSize.bytes,response_chars:responseSize.chars});
}
for(const count of [5,20,60])for(const imageCount of [0,1,3]){
 const s=scenario(count,imageCount),current=imageCount?prepareMultimodalVerification(s):prepareSourceVerification(s);
 if(!imageCount){
  const old=oldComplete.prepareSourceVerification(s);
  await measure(count,0,'complete-claim-v1',old.request,completeResponse(s,old.fingerprint),old.decode);
  // 同时确认旧响应与旧请求能在现行重放入口原样通过。
  replayCompleteClaimVerification(s.window,s.facts,blocks(completeResponse(s,old.fingerprint)),old.fingerprint,JSON.parse(old.request.user));
 }else for(const format of ['nested-v1','flat-fields-v2']){
  const contract=format==='nested-v1'?nestedContract():oldMultimodal;
  const fingerprint=digest({window:s.window,facts:s.facts,system:contract.prompt,schema:contract.schema});
  const body={...oldMultimodal.payload(s.window,s.facts,format),request_fingerprint:fingerprint};
  const request={system:contract.prompt,user:JSON.stringify(body),tool:{parameters:contract.schema}};
  await measure(count,imageCount,format,request,multimodalResponse(s,format,fingerprint),
   response=>replayMultimodalVerification(s.window,s.facts,response,fingerprint,body));
 }
 await measure(count,imageCount,'local-ids-v3',current.request,
  imageCount?multimodalResponse(s,'local-ids-v3'):completeResponse(s),current.decode);
}
for(const row of measurements){
 const local=measurements.find(item=>item.candidates===row.candidates&&item.images===row.images&&item.format==='local-ids-v3');
 row.total_bytes=row.request_bytes+row.response_bytes;row.total_chars=row.request_chars+row.response_chars;
 row.request_tokens_est=row.request_chars/4;row.response_tokens_est=row.response_chars/4;
 row.request_saved_bytes=row.request_bytes-local.request_bytes;row.request_saved_chars=row.request_chars-local.request_chars;
 row.response_saved_bytes=row.response_bytes-local.response_bytes;row.response_saved_chars=row.response_chars-local.response_chars;
 row.request_saved_percent=Number((100*row.request_saved_bytes/row.request_bytes).toFixed(2));
 row.response_saved_percent=Number((100*row.response_saved_bytes/row.response_bytes).toFixed(2));
 row.total_saved_bytes=row.total_bytes-(local.request_bytes+local.response_bytes);
 row.total_saved_chars=row.total_chars-(local.request_chars+local.response_chars);
 row.total_saved_tokens_est=row.total_saved_chars/4;
 row.total_saved_percent=Number((100*row.total_saved_bytes/row.total_bytes).toFixed(2));
 if(row.format==='complete-claim-v1')assert.equal(row.response_saved_chars,89);
 if(row.format==='flat-fields-v2')assert.equal(row.response_saved_chars,89+row.candidates*(29+125*row.images));
}
if(process.argv.includes('--table')){
 console.log('| 候选/图 | 格式 | 请求B | 响应B | 转v3合计减少B/% |');
 console.log('|---|---|---:|---:|---:|');
 for(const row of measurements)console.log(`| ${row.candidates}/${row.images} | ${row.format}${row.contract==='重建'?'*':''} | ${row.request_bytes} | ${row.response_bytes} | ${row.total_saved_bytes}/${row.total_saved_percent}% |`);
}else{
 const columns=Object.keys(measurements[0]);console.log(columns.join(','));
 for(const row of measurements)console.log(columns.map(key=>row[key]).join(','));
}
