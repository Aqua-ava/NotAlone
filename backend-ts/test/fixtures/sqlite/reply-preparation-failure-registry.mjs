import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// 在真实准备动作内模拟挂起，验证动作超时后的任务状态；不进入产品注册表。
let hangNext=false;
export const registry={...base,actions:[...base.actions.map(action=>action.name==='reply.freezeInput'
 ?{...action,execute(tx,i,lease){if(hangNext){hangNext=false;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);return [];}return action.execute(tx,i,lease);}}
 :action),{name:'preparationFailureTest.hangNextFreeze',mode:'write',retryBusy:false,execute(){hangNext=true;return true;}},
 {name:'preparationFailureTest.exit',mode:'read',retryBusy:false,execute(){process.exit(42);}}]};
