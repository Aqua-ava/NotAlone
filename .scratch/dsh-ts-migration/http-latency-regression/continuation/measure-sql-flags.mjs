// 仅诊断：同一实际catalog上比较原JS逐项判定与SQL判定，不缓存DB结果。
import { readFile,writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createStorageFixture } from '../../../../backend-ts/test/host-storage-fixture.mjs';
process.umask(0o077);
const source=await readFile(new URL('../../../../backend-ts/src/host-storage.ts',import.meta.url),'utf8');
const full=source.match(/const metadataPending = client\.query\(`([\s\S]*?)`/)[1];
const literal=name=>vm.runInNewContext(source.match(new RegExp('const '+name+'\\s*=\\s*(\\[[\\s\\S]*?\\n\\]);'))[1]);
const receipt=literal('RECEIPT_CONSTRAINTS'),claim=literal('LEARNING_CLAIM_CONSTRAINTS');
const notNull=vm.runInNewContext(source.match(/const RECEIPT_NOT_NULL = new Set\((\[[\s\S]*?\])\);/)[1]);
const rules={model_call_receipt:{constraints:receipt,not_null:notNull,filter:false},model_call_learning_claim:{constraints:claim,not_null:['attempt_id','owner_id','contact_id','request_id','task_id','step_id','step_name','worker_id','lease_generation'],filter:false},background_task_step:{constraints:['u:UNIQUE (id, task_id)'],filter:true}};
const params=JSON.parse(await readFile(new URL('catalog-projection.json',import.meta.url),'utf8')).params;
const prefix=full.slice(0,full.indexOf(') SELECT\n        COALESCE')+1);
const flags=prefix+`, expected AS (SELECT key AS table_name,value AS rules FROM jsonb_each($3::jsonb)), actual_columns AS (
 SELECT t.relname AS table_name,a.attname,a.attnotnull FROM checked_tables t JOIN pg_catalog.pg_attribute a ON a.attrelid=t.oid WHERE a.attnum>0 AND NOT a.attisdropped
), actual_constraints AS (
 SELECT t.relname AS table_name,c.contype::text||':'||pg_catalog.pg_get_constraintdef(c.oid) AS descriptor,
 (COALESCE(c.convalidated,false) AND NOT COALESCE(c.condeferrable,true) AND NOT COALESCE(c.condeferred,true) AND
 (c.contype NOT IN ('p','u') OR COALESCE(i.indisvalid,false) AND COALESCE(i.indisready,false))) AS valid
 FROM checked_tables t JOIN pg_catalog.pg_constraint c ON c.conrelid=t.oid LEFT JOIN pg_catalog.pg_index i ON i.indexrelid=c.conindid
), selected AS (
 SELECT a.* FROM actual_constraints a JOIN expected e ON e.table_name=a.table_name
 WHERE NOT (e.rules->>'filter')::boolean OR (e.rules->'constraints') ? a.descriptor
) SELECT COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM catalog_rows r),'[]'::jsonb) AS catalog,
 (SELECT jsonb_object_agg(e.table_name,
 (NOT (e.rules ? 'not_null') OR NOT EXISTS(SELECT 1 FROM actual_columns a WHERE a.table_name=e.table_name AND a.attnotnull IS DISTINCT FROM ((e.rules->'not_null') ? a.attname))) AND
 COALESCE((SELECT bool_and(s.valid) FROM selected s WHERE s.table_name=e.table_name),true) AND
 COALESCE((SELECT array_agg(s.descriptor COLLATE "C" ORDER BY s.descriptor COLLATE "C") FROM selected s WHERE s.table_name=e.table_name),ARRAY[]::text[]) = ARRAY(SELECT jsonb_array_elements_text(e.rules->'constraints')) COLLATE "C") FROM expected e) AS ready_flags`;
const oldFlags=snapshot=>Object.fromEntries(Object.entries(rules).map(([table,rule])=>{
 const columns=snapshot.columns.filter(r=>r.table===table),all=snapshot.constraints.filter(r=>r.table===table);
 const selected=rule.filter?all.filter(r=>rule.constraints.includes(`${r.contype}:${r.definition}`)):all;
 const actual=selected.map(r=>`${r.contype}:${r.definition}`).sort();
 return[table,(!rule.not_null||!columns.some(r=>r.attnotnull!==rule.not_null.includes(r.attname)))&&!selected.some(r=>!r.convalidated||r.condeferrable||r.condeferred||(['p','u'].includes(r.contype)&&(!r.indisvalid||!r.indisready)))&&actual.length===rule.constraints.length&&actual.every((r,i)=>r===rule.constraints[i])];
}));
const fixture=await createStorageFixture(),rows=[],cases=[];
const compare=async(name,ddl)=>{
 await fixture.client.query('BEGIN');try{
  if(ddl)await fixture.client.query(ddl);
  const a=(await fixture.client.query(full,params)).rows[0];
  const b=(await fixture.client.query(flags,[...params,JSON.stringify(rules)])).rows[0];
  const expected=oldFlags(a),same=Object.keys(expected).every(k=>expected[k]===b.ready_flags[k]);
  cases.push({name,equivalent:same,expected,actual:b.ready_flags});if(!same)throw Error('SQL判定不等价');
 }finally{await fixture.client.query('ROLLBACK');}
};
try{
 for(const [name,ddl] of [['baseline',null],['nullable_extra','ALTER TABLE public.model_call_receipt ADD COLUMN synthetic_extra text'],['notnull_extra',"ALTER TABLE public.model_call_receipt ADD COLUMN synthetic_extra text NOT NULL DEFAULT ''"],['required_notnull_removed','ALTER TABLE public.model_call_receipt ALTER COLUMN provider DROP NOT NULL'],['required_check_removed','ALTER TABLE public.model_call_receipt DROP CONSTRAINT model_call_receipt_cache_read_tokens_check'],['unknown_receipt_check','ALTER TABLE public.model_call_receipt ADD CONSTRAINT synthetic_unknown CHECK(true) NOT VALID'],['duplicate_receipt_check','ALTER TABLE public.model_call_receipt ADD CONSTRAINT synthetic_duplicate CHECK(cache_read_tokens>=0)'],['ignored_background_check','ALTER TABLE public.background_task_step ADD CONSTRAINT synthetic_ignored CHECK(true) NOT VALID'],['claim_check_removed','ALTER TABLE public.model_call_learning_claim DROP CONSTRAINT model_call_learning_claim_step_name_check']])await compare(name,ddl);
 for(let index=-10;index<30;index++)for(const mode of ['full','flags']){const start=performance.now();const data=(await fixture.client.query(mode==='full'?full:flags,mode==='full'?params:[...params,JSON.stringify(rules)])).rows[0];const valid=mode==='full'?oldFlags(data):data.ready_flags;if(Object.values(valid).some(v=>v!==true))throw Error('基线判定异常');rows.push({index,mode,milliseconds:performance.now()-start});}
}finally{await fixture.close();}
const summary=Object.fromEntries(['full','flags'].map(mode=>{const a=rows.filter(r=>r.mode===mode&&r.index>=0).map(r=>r.milliseconds).sort((a,b)=>a-b);return[mode,{p50_ms:(a[14]+a[15])/2}]}));
await writeFile(new URL('sql-flags.json',import.meta.url),JSON.stringify({diagnostic_only:true,source_sha256:createHash('sha256').update(source).digest('hex'),summary,cases,rows,rules,flags_sql:flags},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({summary,cases:cases.length,all_equivalent:cases.every(r=>r.equivalent)}));
