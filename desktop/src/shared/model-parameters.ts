import { isRecord } from './record';
export type ModelThinkingEffort = 'off' | 'low' | 'high' | 'max';
export interface ModelSamplingParameters { thinkingEffort: ModelThinkingEffort; temperature: number }
export interface ModelParameters { reply: ModelSamplingParameters; memory: ModelSamplingParameters }

export const DEFAULT_MODEL_PARAMETERS: ModelParameters = {
  reply: { thinkingEffort: 'off', temperature: 0 },
  memory: { thinkingEffort: 'off', temperature: 0 },
};

const effort = (value: unknown): value is ModelThinkingEffort => ['off', 'low', 'high', 'max'].includes(value as string);
const temperature = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2;
const group = (value: unknown): value is ModelSamplingParameters => isRecord(value) && Object.keys(value).length === 2
  && effort(value.thinkingEffort) && temperature(value.temperature);

/** 设置、预加载和主进程共用同一有界合同，不接受额外配置字段。 */
export function isModelParameters(value: unknown): value is ModelParameters {
  return isRecord(value) && Object.keys(value).length === 2 && group(value.reply) && group(value.memory);
}

/** 只比较参数值，合法对象的字段排列不影响生效核对或编辑状态。 */
export function equalModelParameters(left: ModelParameters | undefined, right: ModelParameters | undefined): boolean {
  return left === right || Boolean(left && right
    && left.reply.thinkingEffort === right.reply.thinkingEffort && left.reply.temperature === right.reply.temperature
    && left.memory.thinkingEffort === right.memory.thinkingEffort && left.memory.temperature === right.memory.temperature);
}

export function modelParametersFromApi(value: unknown): ModelParameters | undefined {
  if (!isRecord(value) || Object.keys(value).length !== 2) return;
  const parse = (input: unknown): ModelSamplingParameters | undefined => isRecord(input) && Object.keys(input).length === 2
    && effort(input.thinking_effort) && temperature(input.temperature)
    ? { thinkingEffort: input.thinking_effort, temperature: input.temperature } : undefined;
  const reply = parse(value.reply), memory = parse(value.memory);
  return reply && memory ? { reply, memory } : undefined;
}

export function modelParametersToApi(value: ModelParameters) {
  const convert = (input: ModelSamplingParameters) => ({ thinking_effort: input.thinkingEffort, temperature: input.temperature });
  return { reply: convert(value.reply), memory: convert(value.memory) };
}
