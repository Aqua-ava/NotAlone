import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';

const compiled=await build({entryPoints:['src/renderer/memory-source-time.ts'],bundle:true,platform:'node',format:'esm',write:false,logLevel:'silent'});
const {memorySourceTime,memoriesBySourceTime,memorySourceDateLabel}=await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString('base64')}`);
const source=date=>({sentAt:String(Date.parse(date)),timePrecision:'millisecond'});

test('时间线只取直接聊天日期，缺失或非法时间保持未知',()=>{
 assert.equal(memorySourceTime([]),null);
 assert.equal(memorySourceTime([{sentAt:null},{createdAt:'2026-11-03'}]),null);
 assert.equal(memorySourceTime([{sentAt:'not-a-date'},{sentAt:'9007199254740992'},{sentAt:''}]),null);
 const first=source('2026-10-01T12:00:00Z'),last=source('2026-10-03T12:00:00Z');
 assert.deepEqual(memorySourceTime([last,first]),{start:Number(first.sentAt),end:Number(last.sentAt),complete:true});
 assert.deepEqual(memorySourceTime([first,{sentAt:null}]),{start:Number(first.sentAt),end:Number(first.sentAt),complete:false});
});

test('记忆按最新直接来源倒序，未知置后且不借旧版本和决定日期补序',()=>{
 const make=(id,date)=>({id,current:date?{sources:[source(date)]}:null});
 const old=make('old','2026-10-01T00:00:00Z'),recent=make('recent','2026-10-03T00:00:00Z');
 const withdrawn={...make('withdrawn'),versions:[recent.current],decisions:[{createdAt:'2026-11-03'}]};
 const unknown=make('unknown');
 const original=[old,withdrawn,recent,unknown];
 assert.deepEqual(memoriesBySourceTime(original).map(item=>item.id),['recent','old','withdrawn','unknown']);
 assert.deepEqual(original.map(item=>item.id),['old','withdrawn','recent','unknown']);
});

test('聊天日期按显示时区归日，同日合并、跨日保留范围',()=>{
 const time=memorySourceTime([source('2026-10-01T18:00:00Z'),source('2026-10-02T01:00:00Z')]);
 assert.equal(memorySourceDateLabel(time,'Asia/Taipei'),'2026年10月2日');
 assert.equal(memorySourceDateLabel(time,'UTC'),'2026年10月1日 — 2026年10月2日');
});
