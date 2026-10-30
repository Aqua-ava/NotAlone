import {registry as base} from '../../../src/storage/sqlite/registry.ts';

// 合成慢动作仅供验证Worker串行排队与执行预算，不进入正式动作注册表。
export const registry={migrations:base.migrations,actions:[
 {name:'timing.block',mode:'read',retryBusy:false,execute(_tx,input){
  if(!Number.isSafeInteger(input.milliseconds)||input.milliseconds<0||input.milliseconds>20_000)throw new Error('invalid_synthetic_duration');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,input.milliseconds);
  return input.sequence;
 }},
 {name:'timing.exit',mode:'read',retryBusy:false,execute(){process.exit(42);}},
 {name:'timing.error',mode:'read',retryBusy:false,execute(){process.nextTick(()=>{throw new Error('合成私密错误，不得投影');});return null;}},
]};
