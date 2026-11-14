import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// 只在隔离数据库里控制真实 Worker 队列，正文仍由正式讨论与候选动作读取。
export const registry={migrations:base.migrations,actions:[...base.actions.map(action=>action.name!=='reply.view'?action:{...action,execute(tx,input,lease){
 if(input.barrier){
  const barrier=new Int32Array(input.barrier);Atomics.store(barrier,0,1);Atomics.notify(barrier,0);
  if(Atomics.wait(barrier,1,0,5000)==='timed-out')throw new Error('合成候选读取闸门超时');
 }
 return action.execute(tx,input,lease);
}}),{
 name:'assistantTest.holdWriter',mode:'read',retryBusy:false,execute(tx,input){
  tx.get('SELECT database_id FROM database_instance WHERE slot=1');
  const barrier=new Int32Array(input.barrier);Atomics.store(barrier,0,1);Atomics.notify(barrier,0);
  Atomics.wait(barrier,1,0,5000);return true;
 }},
]};
