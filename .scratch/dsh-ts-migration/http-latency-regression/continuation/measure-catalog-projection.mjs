// 仅诊断：证明被检查投影相同，量化去掉未使用catalog字段的收益。
import { readFile,writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createStorageFixture } from '../../../../backend-ts/test/host-storage-fixture.mjs';
process.umask(0o077);
const source=await readFile(new URL('../../../../backend-ts/src/host-storage.ts',import.meta.url),'utf8');
const clean=s=>JSON.parse(s.replace(/,\s*([}\]])/g,'$1'));
const tables=clean(source.match(/const REQUIRED_TABLES = (\[[\s\S]*?\n\]);/)[1]);
const columns=clean(source.match(/const REQUIRED_COLUMNS[^=]*= ({[\s\S]*?\n});/)[1]);
const wanted={...Object.fromEntries(tables.map(t=>[t,[]])),...Object.fromEntries(Object.entries(columns).map(([t,c])=>[t,Object.keys(c)])),notalone_schema_migration:['name','checksum'],notalone_schema_baseline:['format_version','through_version','manifest','backup_sha256','restore_verified_at']};
const selectors=Object.entries(wanted).flatMap(([table,columns])=>(columns.length?columns:[null]).map(column=>({table,column})));
const full=`SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS kind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`;
const projected=`SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS kind
 FROM unnest($1::text[],$2::text[]) AS required(relname,attname)
 JOIN pg_catalog.pg_class c ON c.relname=required.relname JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=required.attname AND a.attnum>0 AND NOT a.attisdropped
 WHERE n.nspname='public' AND c.relkind IN ('r','p') AND EXISTS(SELECT 1 FROM pg_catalog.pg_attribute visible WHERE visible.attrelid=c.oid AND visible.attnum>0 AND NOT visible.attisdropped)`;
const params=[selectors.map(r=>r.table),selectors.map(r=>r.column)];
const canonical=rows=>{
 const maps=new Map();for(const row of rows){if(!maps.has(row.relname))maps.set(row.relname,new Map());if(row.attname!==null)maps.get(row.relname).set(row.attname,row.kind);}
 return JSON.stringify(Object.entries(wanted).map(([table,cols])=>({table,present:maps.has(table),columns:cols.map(c=>[c,maps.get(table)?.get(c)??null])})));
};
const fixture=await createStorageFixture(),rows=[],mutations=[];
try {
 for(let index=-10;index<30;index++)for(const mode of ['full','projected']){
  const start=performance.now();const data=await fixture.client.query(mode==='full'?full:projected,mode==='full'?[]:params);
  rows.push({index,mode,milliseconds:performance.now()-start,rows:data.rows.length,projection:canonical(data.rows)});
 }
 for(const [name,ddl] of [['unknown_table','CREATE TABLE public.synthetic_unknown(value integer)'],['required_column_renamed','ALTER TABLE public.owner RENAME COLUMN display_name TO synthetic_missing'],['required_table_empty','CREATE TABLE public.synthetic_empty()'],['unknown_ledger_view',"ALTER TABLE public.notalone_schema_migration RENAME TO synthetic_original_ledger; CREATE VIEW public.notalone_schema_migration AS SELECT name,checksum FROM public.synthetic_original_ledger"]]){
  await fixture.client.query('BEGIN');try{await fixture.client.query(ddl);const a=canonical((await fixture.client.query(full)).rows),b=canonical((await fixture.client.query(projected,params)).rows);mutations.push({name,equivalent:a===b});if(a!==b)throw Error('catalog验证投影不等价');}finally{await fixture.client.query('ROLLBACK');}
 }
 if(!rows.every(r=>r.projection===rows[0].projection))throw Error('catalog验证投影不等价');
} finally {await fixture.close();}
const summary=Object.fromEntries(['full','projected'].map(mode=>{const values=rows.filter(r=>r.index>=0&&r.mode===mode).map(r=>r.milliseconds).sort((a,b)=>a-b);return[mode,{p50_ms:(values[14]+values[15])/2,rows:rows.find(r=>r.mode===mode).rows}]}));
await writeFile(new URL('catalog-projection.json',import.meta.url),JSON.stringify({diagnostic_only:true,source_sha256:createHash('sha256').update(source).digest('hex'),summary,mutations,rows,params,projected_sql:projected},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify({summary,mutations}));
