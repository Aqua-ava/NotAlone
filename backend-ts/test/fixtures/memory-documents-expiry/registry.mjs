import {registry as base} from '../../../src/storage/sqlite/registry.ts';
import {combinedKnowledgeReader} from '../../../src/memory/sqlite/documents/knowledge.ts';
import {createMemoryKnowledgeReader} from '../../../src/memory/sqlite/management/knowledge.ts';

// 只改变隔离测试 Worker 的时钟；不修改任何业务行。
const RealDate=Date;
let time=RealDate.now();
class TestDate extends RealDate {
 constructor(...args){if(args.length)super(...args);else super(time);}
 static now(){return time;}
}
export const registry={...base,actions:[...base.actions,
 {name:'fixture.setTime',mode:'read',retryBusy:false,execute(_tx,input){
  if(!Number.isSafeInteger(input.time))throw new Error('invalid_synthetic_time');
  time=input.time;globalThis.Date=TestDate;return time;
 }},
 {name:'fixture.knowledge',mode:'read',retryBusy:false,execute:(tx,input)=>combinedKnowledgeReader.read(tx,input)},
 {name:'fixture.unconfirmedKnowledge',mode:'read',retryBusy:false,execute:(tx,input)=>createMemoryKnowledgeReader({includeUnconfirmed:true}).read(tx,input)},
]};
