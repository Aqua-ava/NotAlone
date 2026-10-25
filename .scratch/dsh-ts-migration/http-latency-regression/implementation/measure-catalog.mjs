import { performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import { createStorageFixture } from '../../../../backend-ts/test/host-storage-fixture.mjs';
const fixture=await createStorageFixture();
const rows=[];
const from=`FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped`;
const text=`SELECT c.relname,a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod) AS kind ${from}`;
let reference;
try {
 for(let i=-10;i<30;i++) for(const mode of ['object','array','aggregate']) {
  const start=performance.now();
  const value=await fixture.client.query(mode==='aggregate' ? `SELECT c.relname,json_object_agg(a.attname,pg_catalog.format_type(a.atttypid,a.atttypmod)) AS columns ${from} GROUP BY c.relname` : {text,rowMode:mode==='array'?'array':undefined});
  const tables=new Map();
  if(mode==='aggregate') for(const row of value.rows) tables.set(row.relname,new Map(Object.entries(row.columns)));
  else for(const row of value.rows) {const [table,column,kind]=mode==='array'?row:[row.relname,row.attname,row.kind];if(!tables.has(table))tables.set(table,new Map());tables.get(table).set(column,kind);}
  const milliseconds=performance.now()-start;
  const normalized=JSON.stringify([...tables].sort().map(([k,v])=>[k,[...v].sort()]));
  reference??=normalized;
  if(normalized!==reference) throw Error('完整catalog不相等');
  rows.push({index:i,mode,milliseconds,table_count:tables.size,column_count:[...tables.values()].reduce((n,t)=>n+t.size,0),identical:true});
 }
} finally {await fixture.close();}
const summaries=Object.fromEntries(['object','array','aggregate'].map(mode=>{const values=rows.filter(x=>x.mode===mode&&x.index>=0).map(x=>x.milliseconds).sort((a,b)=>a-b);return[mode,{p50_ms:(values[14]+values[15])/2}]}));
await writeFile(new URL('catalog.json',import.meta.url),JSON.stringify({summaries,rows},null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(summaries));
