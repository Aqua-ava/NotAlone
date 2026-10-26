// 仅诊断当前OID定位与判定下推，所有OID/结构来自本轮SQL，无DB成功缓存。
import { readFile,writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createStorageFixture } from '../../../../backend-ts/test/host-storage-fixture.mjs';
process.umask(0o077);
const source=await readFile(new URL('../../../../backend-ts/src/host-storage.ts',import.meta.url),'utf8');
const full=source.match(/const metadataPending = client\.query\(`([\s\S]*?)`/)[1];
const selectors=JSON.parse(await readFile(new URL('catalog-projection.json',import.meta.url),'utf8')).params;
const prior=JSON.parse(await readFile(new URL('sql-flags.json',import.meta.url),'utf8'));
const names=[...new Set(selectors[0])],rules=prior.rules;
const rewrite=(query,index)=>query.replace('WITH catalog_rows AS (',`WITH object_oids AS (SELECT name,pg_catalog.to_regclass('public.'||pg_catalog.quote_ident(name)) AS oid FROM unnest($${index}::text[]) AS wanted(name)), catalog_rows AS (`)
 .replace('JOIN pg_catalog.pg_class c ON c.relname=required.relname\n        JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace','JOIN object_oids o ON o.name=required.relname JOIN pg_catalog.pg_class c ON c.oid=o.oid')
 .replace("WHERE n.nspname='public' AND c.relkind IN ('r','p') AND EXISTS", "WHERE c.relkind IN ('r','p') AND EXISTS")
 .replace("SELECT c.oid,c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace\n        WHERE n.nspname='public' AND c.relkind IN ('r','p')", "SELECT c.oid,c.relname FROM object_oids o JOIN pg_catalog.pg_class c ON c.oid=o.oid WHERE c.relkind IN ('r','p')");
const oidFull=rewrite(full,3),oidFlags=rewrite(prior.flags_sql,4);
if(oidFull===full||oidFlags===prior.flags_sql)throw Error('OID诊断补丁未生效');
const queries={full:{text:full,values:selectors},oid_full:{text:oidFull,values:[...selectors,names]},flags:{text:prior.flags_sql,values:[...selectors,JSON.stringify(rules)]},oid_flags:{text:oidFlags,values:[...selectors,JSON.stringify(rules),names]}};
const oldFlags=s=>Object.fromEntries(Object.entries(rules).map(([table,r])=>{const cols=s.columns.filter(x=>x.table===table),all=s.constraints.filter(x=>x.table===table),selected=r.filter?all.filter(x=>r.constraints.includes(`${x.contype}:${x.definition}`)):all;const actual=selected.map(x=>`${x.contype}:${x.definition}`).sort();return[table,(!r.not_null||!cols.some(x=>x.attnotnull!==r.not_null.includes(x.attname)))&&!selected.some(x=>!x.convalidated||x.condeferrable||x.condeferred||(['p','u'].includes(x.contype)&&(!x.indisvalid||!x.indisready)))&&actual.length===r.constraints.length&&actual.every((x,i)=>x===r.constraints[i])];}));
const canonical=s=>JSON.stringify(['catalog','columns','constraints'].map(k=>s[k].map(x=>JSON.stringify(x)).sort()));
const fixture=await createStorageFixture(),rows=[],cases=[];
try{
 for(const [name,ddl] of [['baseline',null],['nullable_extra','ALTER TABLE public.model_call_receipt ADD COLUMN synthetic_extra text'],['notnull_extra',"ALTER TABLE public.model_call_receipt ADD COLUMN synthetic_extra text NOT NULL DEFAULT ''"],['required_notnull_removed','ALTER TABLE public.model_call_receipt ALTER COLUMN provider DROP NOT NULL'],['required_check_removed','ALTER TABLE public.model_call_receipt DROP CONSTRAINT model_call_receipt_cache_read_tokens_check'],['ignored_background_check','ALTER TABLE public.background_task_step ADD CONSTRAINT synthetic_ignored CHECK(true) NOT VALID'],['claim_check_removed','ALTER TABLE public.model_call_learning_claim DROP CONSTRAINT model_call_learning_claim_step_name_check'],['ledger_view','ALTER TABLE public.notalone_schema_migration RENAME TO synthetic_original; CREATE VIEW public.notalone_schema_migration AS SELECT name,checksum FROM public.synthetic_original'],['required_zero_column','DROP TABLE public.channel_identity CASCADE; CREATE TABLE public.channel_identity()']]){
  await fixture.client.query('BEGIN');try{if(ddl)await fixture.client.query(ddl);const a=(await fixture.client.query(queries.full)).rows[0],b=(await fixture.client.query(queries.oid_full)).rows[0],c=(await fixture.client.query(queries.oid_flags)).rows[0];const expected=oldFlags(a);const same=canonical(a)===canonical(b)&&Object.keys(expected).every(k=>expected[k]===c.ready_flags[k]);cases.push({name,equivalent:same,expected,actual:c.ready_flags});if(!same)throw Error('OID/flag判定不等价');}finally{await fixture.client.query('ROLLBACK');}
 }
 for(let index=-10;index<30;index++)for(const [mode,query] of Object.entries(queries)){const start=performance.now();const data=(await fixture.client.query(query)).rows[0];const result=mode.includes('flags')?data.ready_flags:oldFlags(data);if(Object.values(result).some(v=>v!==true))throw Error('基线判定错误');rows.push({index,mode,milliseconds:performance.now()-start});}
}finally{await fixture.close();}
const summary=Object.fromEntries(Object.keys(queries).map(mode=>{const a=rows.filter(x=>x.mode===mode&&x.index>=0).map(x=>x.milliseconds).sort((a,b)=>a-b);return[mode,{p50_ms:(a[14]+a[15])/2}]}));
await writeFile(new URL('catalog-oids.json',import.meta.url),JSON.stringify({diagnostic_only:true,source_sha256:createHash('sha256').update(source).digest('hex'),summary,cases,rows,queries},null,2)+'\n',{mode:0o600});console.log(JSON.stringify({summary,cases:cases.length,all_equivalent:cases.every(x=>x.equivalent)}));
