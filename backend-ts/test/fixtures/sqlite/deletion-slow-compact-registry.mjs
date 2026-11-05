import {registry as base} from './deletion-registry.mjs';

// 压缩在真实数据上耗时随库体积增长；这里在真实压缩前加一段无法打断的同步等待来模拟大库，
// 其余删除动作与 deletion-registry.mjs 完全一致。延迟由测试经环境变量设置，不进入正式注册表。
export const registry={migrations:base.migrations,actions:base.actions.map(action=>action.name!=='deletion.compact'?action:{...action,
 execute(maintenance,input,lease){
  const milliseconds=Number(process.env.NOTALONE_TEST_COMPACT_DELAY_MS??0);
  if(!Number.isSafeInteger(milliseconds)||milliseconds<0||milliseconds>20_000)throw new Error('invalid_synthetic_duration');
  if(milliseconds)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,milliseconds);
  return action.execute(maintenance,input,lease);
 }})};
