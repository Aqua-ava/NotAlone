export type ModelThinkingEffort='off'|'low'|'high'|'max';
export interface ModelPurposeParameters {thinking_effort:ModelThinkingEffort;temperature:number}
export interface ModelParameters {reply:ModelPurposeParameters;memory:ModelPurposeParameters}
export const MODEL_PARAMETER_ENV_KEYS=['NOTALONE_REPLY_THINKING_EFFORT','NOTALONE_REPLY_TEMPERATURE','NOTALONE_MEMORY_THINKING_EFFORT','NOTALONE_MEMORY_TEMPERATURE'] as const;
const efforts=new Set(['off','low','high','max']);
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function isPurposeParameters(value:unknown):value is ModelPurposeParameters {
 return record(value)&&Object.keys(value).length===2&&Object.keys(value).every(key=>key==='thinking_effort'||key==='temperature')
  &&typeof value.thinking_effort==='string'&&efforts.has(value.thinking_effort)
  &&typeof value.temperature==='number'&&Number.isFinite(value.temperature)&&value.temperature>=0&&value.temperature<=2;
}
export function isModelParameters(value:unknown):value is ModelParameters {
 return record(value)&&Object.keys(value).length===2&&Object.keys(value).every(key=>key==='reply'||key==='memory')
  &&isPurposeParameters(value.reply)&&isPurposeParameters(value.memory);
}
/** 未设置时沿用原值；非法环境配置不伪装成已生效默认值。 */
export function readPurposeParameters(environment:Readonly<Record<string,string|undefined>>,purpose:'reply'|'memory'):ModelPurposeParameters|null {
 const prefix=purpose==='memory'?'NOTALONE_MEMORY':'NOTALONE_REPLY';
 const effort=environment[`${prefix}_THINKING_EFFORT`]??'off',raw=environment[`${prefix}_TEMPERATURE`];
 if(!efforts.has(effort)||raw!==undefined&&!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(raw))return null;
 const value={thinking_effort:effort,temperature:raw===undefined?0:Number(raw)};
 return isPurposeParameters(value)?value:null;
}
export function readModelParameters(environment:Readonly<Record<string,string|undefined>>):ModelParameters|null {
 const reply=readPurposeParameters(environment,'reply'),memory=readPurposeParameters(environment,'memory');
 return reply&&memory?{reply,memory}:null;
}
