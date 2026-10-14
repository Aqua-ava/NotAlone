import { readAssistantNoGenerationProof, type AssistantNoGenerationProof } from './assistant-no-generation';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
const exact = (value: Record<string, unknown>, fields: readonly string[]) => Object.keys(value).length === fields.length
  && fields.every((field) => Object.hasOwn(value, field));
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= 4096;

// B 的执行键由服务器生成，只有原具名命令的精确身份绑定才允许消费该实际键。
export function readExplorationNoGenerationProof(value: unknown, status: number,
  path: string, body: unknown): AssistantNoGenerationProof | undefined {
  const parts = path.split('/');
  if (parts.length !== 9 || parts[1] !== 'api' || parts[2] !== 'contacts' || !uuid(parts[3])
    || parts[4] !== 'assistant-sessions' || !uuid(parts[5]) || parts[6] !== 'explorations'
    || !uuid(parts[7]) || !['prepare-confirm', 'prepare-answer'].includes(parts[8])
    || !record(body) || !uuid(body.input_version_id) || !record(value)
    || !record(value.exploration_preparation) || !record(value.no_generation)) return undefined;
  if (body.generate !== true) return undefined;
  const { generate: _generate, ...command } = body;
  const action = parts[8];
  if (action === 'prepare-confirm' ? !(
    exact(command, ['input_version_id', 'suggestion_id']) && uuid(body.suggestion_id)
    || exact(command, ['input_version_id', 'direct_intent']) && text(body.direct_intent)
  ) : !(exact(command, ['input_version_id', 'question_id', 'answer', 'operation_key'])
    && uuid(body.question_id) && uuid(body.operation_key) && text(body.answer))) return undefined;
  const binding = value.exploration_preparation;
  if (!exact(binding, ['exploration_id', 'input_version_id', 'action', 'operation_key'])
    || binding.exploration_id !== parts[7] || binding.input_version_id !== body.input_version_id
    || binding.action !== action || binding.operation_key !== (action === 'prepare-confirm' ? null : body.operation_key)
    || !uuid(value.no_generation.request_key)) return undefined;
  const { exploration_preparation: _, ...rejected } = value;
  return readAssistantNoGenerationProof(rejected, status, { contactId: parts[3], sessionId: parts[5],
    requestKey: value.no_generation.request_key });
}
