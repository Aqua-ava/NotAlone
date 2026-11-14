import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {adjudicationPages} from '../src/memory/adoption/pages.ts';

const text=()=>({message_id:randomUUID(),text:'合成原始文字',occurred_at:null});
function image(fileId=randomUUID()){
 return {message_id:randomUUID(),text:null,occurred_at:null,content_kind:'image',
  content_ref:{file_id:fileId,sha256:'a'.repeat(64),mime_type:'image/png',media_generation:'1'}};
}
function memory(index,sources=[text()]){
 return {memory_id:randomUUID(),revision:1,text:`合成旧记忆${index}`,category:'common_fact',topic:'other',subject:'contact',adoption_method:'auto',
  source_message_ids:sources.map(source=>source.message_id),source_texts:sources,statement_time:null,valid_at:null,invalid_at:null,
  event:null,conditions:null,source_receipt:`synthetic-prior-${index}`,source_dependency_mode:'all',requires_all_sources:true};
}
function item(similar,candidateSources=[text()]){
 return {candidate_index:0,candidate:{text:'合成候选',category:'common_fact',subject:'contact',topic:'other',
  source_message_ids:candidateSources.map(source=>source.message_id),confidence:1,risk_flags:[],valid_at:null,invalid_at:null,
  speech_act:'assertion',assertion_status:'asserted',figurative_type:'literal',alternatives:[],interpretation_reason:'合成测试',
  requires_all_sources:true,source_dependency_mode:'all',_scene_name:'合成',event:null,conditions:null,
  timing:{source_started_at:null,source_ended_at:null,source_time_complete:false},dimension_evidence:null,verified_source_receipt:null},
  candidate_source_receipt:'synthetic-candidate',candidate_source_texts:candidateSources,relation_source_receipt:'synthetic-relation',similar};
}

test('纯文字比较每页最多八条旧记忆并保持完整顺序和候选依据',()=>{
 const original=item(Array.from({length:17},(_,index)=>memory(index))),before=structuredClone(original),pages=adjudicationPages(original);
 assert.deepEqual(pages.map(page=>page.similar.length),[8,8,1]);
 assert.deepEqual(pages.flatMap(page=>page.similar),original.similar);
 for(const page of pages)assert.deepEqual({...page,similar:[]},{...original,similar:[]});
 assert.deepEqual(original,before,'分页不会改写冻结依据');
 assert.deepEqual(adjudicationPages(item([])),[],'没有比较池时保留直接采纳路径');
});

test('候选的一张图片与八条旧图片记忆按七加一分页，全部来源保留',()=>{
 const original=item(Array.from({length:8},(_,index)=>memory(index,[image()])),[image()]),pages=adjudicationPages(original);
 assert.deepEqual(pages.map(page=>page.similar.length),[7,1]);
 assert.deepEqual(pages.flatMap(page=>page.similar),original.similar);
 for(const page of pages)assert.deepEqual(page.candidate_source_texts,original.candidate_source_texts);
});

test('相同实际视觉引用跨消息及适配器复用时只计一次图片容量',()=>{
 const candidateSources=Array.from({length:8},()=>image()),shared=candidateSources[0].content_ref;
 const custom={...image(),content_kind:'synthetic-sticker',content_ref:{version:1,
  frozen:{pluginId:'synthetic.sticker',pluginVersion:'1',kind:'synthetic-sticker',identity:{fileId:shared.file_id}},
  ownerId:randomUUID(),contactId:randomUUID(),messageId:randomUUID(),representation:'image',reference:shared}};
 const original=item(Array.from({length:8},(_,index)=>memory(index,[index%2?{...image(),content_ref:shared}:custom])),candidateSources);
 const pages=adjudicationPages(original);
 assert.deepEqual(pages.map(page=>page.similar.length),[8]);
 assert.deepEqual(pages[0].similar,original.similar);
});

test('单条旧记忆与固定候选无法共同容纳时明确拒绝，不丢弃任何来源',()=>{
 const fixed=Array.from({length:8},()=>image()),original=item([memory(0,[image()])],fixed),before=structuredClone(original);
 assert.throws(()=>adjudicationPages(original),{name:'AdjudicationInputError',code:'memory_adjudication_input_too_large'});
 assert.deepEqual(original,before);
 assert.throws(()=>adjudicationPages(item([memory(0)],Array.from({length:9},()=>image()))),{code:'memory_adjudication_input_too_large'});
 assert.throws(()=>adjudicationPages(item([memory(0),memory(1,Array.from({length:9},()=>image()))])),{code:'memory_adjudication_input_too_large'});
});
