import {registry as base} from '../../src/storage/sqlite/registry.ts';

const heldActions=new Set(['media.imageSyncTargets','memory.read']);

/** 仅合成回归：在不改生产动作语义的前提下，让指定后台读持有独立只读事务。 */
function holdWhenRequested(action){
 return {...action,execute(tx,input,lease){
  const barrier=input&&typeof input==='object'?input.holdBarrier:undefined;
  if(barrier){
   const state=new Int32Array(barrier);
   // 先实际开启一次读查询，再阻住该附属 Worker，模拟持续中的后台长读。
   tx.get('SELECT 1 AS held');
   Atomics.store(state,0,1);Atomics.notify(state,0);
   Atomics.wait(state,1,0,5000);
  }
  return action.execute(tx,input,lease);
 }};
}

export const registry={...base,actions:base.actions.map(action=>heldActions.has(action.name)?holdWhenRequested(action):action)};
