import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// 在真实准备动作内模拟挂起，验证动作超时后的任务状态；不进入产品注册表。
export const registry={...base,actions:[...base.actions.map(action=>action.name==='reply.memoryPool'
 ?{...action,execute(){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,2000);return [];}}
 :action),{name:'preparationFailureTest.exit',mode:'read',retryBusy:false,execute(){process.exit(42);}}]};
