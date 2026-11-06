import test from 'node:test';
import assert from 'node:assert/strict';
import {memorySourceTimeLabel,messageTimePrefix} from '../src/reply/sqlite/candidates/input.ts';

const DAY=86_400_000;
const format=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit'});
const base=Date.UTC(2022,10,2,12,0,0);
/** 合成事务：按消息 id 返回 sent_at；未登记的消息视为不存在。 */
const tx=times=>({get:(_sql,params)=>times.has(params[2])?{sent_at:times.get(params[2])}:undefined});
const source=id=>({contactId:'c1',messageId:id,recordId:'r-'+id,acceptedRevision:1n});

test('单条来源附聊天发送日期与相对现在的距离，不使用保存或提取时间',()=>{
 const label=memorySourceTimeLabel(tx(new Map([['m1',BigInt(base)]])),'o1',[source('m1')],base+4*365*DAY);
 assert.equal(label,`（聊天时间：${format.format(base)}，约4年前）`);
});

test('多条来源取最早到最晚的日期范围，距离按最晚来源计算',()=>{
 const late=base+40*DAY;
 const label=memorySourceTimeLabel(tx(new Map([['m1',BigInt(base)],['m2',BigInt(late)]])),'o1',[source('m1'),source('m2')],late+100*DAY);
 assert.equal(label,`（聊天时间：${format.format(base)} 至 ${format.format(late)}，约3个月前）`);
});

test('同一天的多条来源只显示一天',()=>{
 const label=memorySourceTimeLabel(tx(new Map([['m1',BigInt(base)],['m2',BigInt(base+1000)]])),'o1',[source('m1'),source('m2')],base+DAY);
 assert.equal(label,`（聊天时间：${format.format(base)}，近30天内）`);
});

test('部分来源时间未知时只用已知时间并如实标注，不补造',()=>{
 const label=memorySourceTimeLabel(tx(new Map([['m1',BigInt(base)],['m2',null]])),'o1',[source('m1'),source('m2')],base+DAY);
 assert.equal(label,`（聊天时间：${format.format(base)}，近30天内，部分来源时间未知）`);
});

test('全部来源时间未知或来源消息不存在时标为未知',()=>{
 assert.equal(memorySourceTimeLabel(tx(new Map([['m1',null]])),'o1',[source('m1')],base),'（聊天时间未知）');
 assert.equal(memorySourceTimeLabel(tx(new Map()),'o1',[source('missing')],base),'（聊天时间未知）');
 assert.equal(memorySourceTimeLabel(tx(new Map()),'o1',[],base),'（聊天时间未知）');
});

test('距离档位：30天内、按月、按年；来源晚于冻结时刻时不给距离',()=>{
 const at=base+10*DAY,one=new Map([['m1',BigInt(base)]]);
 assert.match(memorySourceTimeLabel(tx(one),'o1',[source('m1')],at),/，近30天内）$/);
 assert.match(memorySourceTimeLabel(tx(one),'o1',[source('m1')],base+95*DAY),/，约3个月前）$/);
 assert.match(memorySourceTimeLabel(tx(one),'o1',[source('m1')],base+800*DAY),/，约2年前）$/);
 assert.equal(memorySourceTimeLabel(tx(one),'o1',[source('m1')],base-DAY),`（聊天时间：${format.format(base)}）`);
});

test('聊天消息按发送时间标注到分钟，时间未知或异常时不补造',()=>{
 const minute=new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
 assert.equal(messageTimePrefix(BigInt(base)),`（${minute.format(base)}）`);
 assert.match(messageTimePrefix(BigInt(base)),/^（\d{4}-\d{2}-\d{2} \d{2}:\d{2}）$/);
 assert.equal(messageTimePrefix(null),'');
 assert.equal(messageTimePrefix(undefined),'');
 assert.equal(messageTimePrefix(-1n),'');
 assert.equal(messageTimePrefix(BigInt(Number.MAX_SAFE_INTEGER)),'');
 assert.equal(messageTimePrefix(Number(base)),'','非整数库值类型不当作时间');
});
