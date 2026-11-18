/** profiles 内部共用的小工具；不属于对外入口。 */
import type {GenerateOptions} from '@deepseek-ai/dsh-llm';
import type {L2ScenarioBudget} from '../scenarios/document.ts';
import {invalid} from './document.ts';

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '长期背景格式无效';
}


export function bounded(messages: GenerateOptions['messages'], budget: L2ScenarioBudget): void {
  if (JSON.stringify(messages).length > budget.max_characters) invalid('l3_profile_context_budget_exceeded');
}

