/** L2 场景文档的确定性合同、编译与核验；不执行模型调用或发布业务版本。 */
import {createHash} from 'node:crypto';

export interface L2ScenarioScope {
  owner_id: string;
  contact_id: string | null;
}

export interface L2ScenarioBudget {
  max_memories: number;
  max_batch_memories: number;
  max_scenarios: number;
  max_paragraphs: number;
  max_characters: number;
  max_model_calls: number;
}

export const DEFAULT_L2_SCENARIO_BUDGET: Readonly<L2ScenarioBudget> = Object.freeze({
  max_memories: 120,
  max_batch_memories: 20,
  max_scenarios: 15,
  max_paragraphs: 40,
  max_characters: 128_000,
  max_model_calls: 16,
});

/** 只含模型整理所需的最小记忆正文、时间和版本身份。 */
export interface L2ScenarioMemory {
  memory_id: string;
  revision: number;
  level?: 'owner' | 'contact';
  text: string;
  category: string;
  provenance_kind: 'manual_entry' | 'source_supported';
  timing: Record<string, unknown>;
  event: Record<string, unknown> | null;
  conditions: Record<string, unknown> | null;
  evolution: Record<string, unknown> | null;
  valid_at: string | null;
  invalid_at: string | null;
  dependency_ids: string[];
  /** 只用于反馈 guard，不进入模型可见的记忆字段。 */
  message_ids: string[];
  dependency_manifest: Record<string, unknown>;
}

export interface L2ScenarioReference {
  memory_id: string;
  revision: number;
  level?: 'owner' | 'contact';
  provenance_kind: 'manual_entry' | 'source_supported';
  timing: Record<string, unknown>;
  event: Record<string, unknown> | null;
  conditions: Record<string, unknown> | null;
  evolution: Record<string, unknown> | null;
  valid_at: string | null;
  invalid_at: string | null;
}

export interface L2ScenarioParagraph {
  text: string;
  references: L2ScenarioReference[];
}

export interface L2ScenarioVersion {
  scenario_id: string;
  version_id: string;
  title: string;
  hint: string;
  paragraphs: L2ScenarioParagraph[];
  input_manifest: Record<string, unknown>[];
  dependency_ids: string[];
}

export interface L2ScenarioDraft {
  scenario_id?: string;
  topic_key: string;
  title: string;
  hint: string;
  replaces: string[];
  paragraphs: L2ScenarioParagraph[];
}

export class L2ScenarioError extends Error {
  readonly code: string;
  constructor(code: string, options?: ErrorOptions, detail?: string) {
    super(detail ? `${code}: ${detail}` : code, options);
    this.code = code;
    this.name = 'L2ScenarioError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOPIC_KEY = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CJK = /[\u3400-\u9fff]/u;

export function scenarioDigest(value: unknown): string {
  return createHash('sha256').update(canonicalScenarioJSON(value), 'utf8').digest('hex');
}

export function canonicalScenarioJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalScenarioJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalScenarioJSON(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 与 Python uuid.uuid5 的 v5 名称空间算法一致，稳定主题身份不依赖运行批次。 */
export function scenarioTopicId(namespace: string, name: string): string {
  if (!UUID.test(namespace)) throw new L2ScenarioError('l2_scenario_namespace_invalid');
  const namespaceBytes = Buffer.from(namespace.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function count(value: string): number {
  return [...value].length;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join('|') === [...keys].sort().join('|');
}

export function validateScenarioBudget(budget: L2ScenarioBudget): void {
  for (const value of Object.values(budget)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new L2ScenarioError('l2_scenario_budget_invalid');
  }
  if (budget.max_model_calls < 2 || budget.max_model_calls > 16) {
    throw new L2ScenarioError('l2_scenario_budget_invalid');
  }
}

export function validateScenarioDocument(
  proposal: unknown,
  memories: readonly L2ScenarioMemory[],
  current: readonly L2ScenarioVersion[],
  budget: L2ScenarioBudget,
): L2ScenarioDraft[] {
  validateScenarioBudget(budget);
  if (!object(proposal) || !exactKeys(proposal, ['scenarios']) || !Array.isArray(proposal.scenarios)) {
    throw new L2ScenarioError('l2_scenario_proposal_invalid');
  }
  const scenarios = proposal.scenarios;
  if (scenarios.length > budget.max_scenarios) throw new L2ScenarioError('l2_scenario_proposal_invalid');
  const inputs = new Map(memories.map(memory => [`${memory.memory_id}:${memory.revision}`, memory]));
  const previous = new Map(current.map(document => [document.version_id, document]));
  const topics = new Set<string>();
  let paragraphCount = 0;
  let characterCount = 0;
  const result: L2ScenarioDraft[] = [];
  for (const value of scenarios) {
    if (
      !object(value)
      || Object.keys(value).some(key => !['scenario_id', 'topic_key', 'title', 'hint', 'replaces', 'paragraphs'].includes(key))
      || !['topic_key', 'title', 'hint', 'replaces', 'paragraphs'].every(key => Object.hasOwn(value, key))
    ) {
      throw new L2ScenarioError('l2_scenario_proposal_invalid');
    }
    if (
      typeof value.topic_key !== 'string'
      || !TOPIC_KEY.test(value.topic_key)
      || topics.has(value.topic_key)
      || !Array.isArray(value.replaces)
      || value.replaces.some(version => typeof version !== 'string' || !previous.has(version))
      || new Set(value.replaces).size !== value.replaces.length
    ) {
      throw new L2ScenarioError('l2_scenario_proposal_invalid');
    }
    if (
      value.scenario_id !== undefined
      && (
        typeof value.scenario_id !== 'string'
        || !UUID.test(value.scenario_id)
        || !value.replaces.length
        || !value.replaces.some(version => previous.get(version)?.scenario_id === value.scenario_id)
      )
    ) {
      throw new L2ScenarioError('l2_scenario_proposal_invalid');
    }
    topics.add(value.topic_key);
    for (const [key, limit] of [['title', 60], ['hint', 160]] as const) {
      const text = value[key];
      if (typeof text !== 'string' || !text.trim() || text !== text.trim() || count(text) > limit || !CJK.test(text)) {
        throw new L2ScenarioError('l2_scenario_proposal_invalid');
      }
      characterCount += count(text);
    }
    if (!Array.isArray(value.paragraphs) || !value.paragraphs.length) {
      throw new L2ScenarioError('l2_scenario_proposal_invalid');
    }
    const paragraphs: L2ScenarioParagraph[] = [];
    for (const paragraph of value.paragraphs) {
      if (
        !object(paragraph)
        || !exactKeys(paragraph, ['text', 'references'])
        || typeof paragraph.text !== 'string'
        || !paragraph.text.trim()
        || paragraph.text !== paragraph.text.trim()
        || !Array.isArray(paragraph.references)
        || !paragraph.references.length
      ) {
        throw new L2ScenarioError('l2_scenario_proposal_invalid');
      }
      const references: L2ScenarioReference[] = [];
      const seen = new Set<string>();
      for (const reference of paragraph.references) {
        const memoryId = reference?.memory_id;
        const revision = reference?.revision;
        if (
          !object(reference)
          || Object.keys(reference).some(key => ![
            'memory_id', 'revision', 'level', 'provenance_kind', 'timing', 'event', 'conditions', 'evolution', 'valid_at', 'invalid_at',
          ].includes(key))
          || !['memory_id', 'revision'].every(key => Object.hasOwn(reference, key))
          || typeof memoryId !== 'string'
          || !UUID.test(memoryId)
          || !Number.isSafeInteger(revision)
          || Number(revision) < 1
        ) {
          throw new L2ScenarioError('l2_scenario_reference_invalid');
        }
        const key = `${memoryId.toLowerCase()}:${revision}`;
        const memory = inputs.get(key);
        if (!memory || seen.has(key)) throw new L2ScenarioError('l2_scenario_reference_invalid');
        seen.add(key);
        references.push({
          memory_id: memory.memory_id,
          revision: memory.revision,
          ...(memory.level ? {level: memory.level} : {}),
          provenance_kind: memory.provenance_kind,
          timing: clone(memory.timing),
          event: clone(memory.event),
          conditions: clone(memory.conditions),
          evolution: clone(memory.evolution),
          valid_at: memory.valid_at,
          invalid_at: memory.invalid_at,
        });
      }
      paragraphs.push({text: paragraph.text, references});
      paragraphCount++;
      characterCount += count(paragraph.text);
    }
    const title = value.title as string;
    const hint = value.hint as string;
    result.push({
      ...(value.scenario_id ? {scenario_id: value.scenario_id as string} : {}),
      topic_key: value.topic_key as string,
      title,
      hint,
      replaces: [...value.replaces],
      paragraphs,
    });
  }
  if (paragraphCount > budget.max_paragraphs || characterCount > budget.max_characters) {
    throw new L2ScenarioError('l2_scenario_budget_exceeded');
  }
  return result;
}

export function renderScenarioDocument(scenario: L2ScenarioVersion): string {
  const metadata = {
    topic_key: `scene-${scenario.scenario_id}`,
    title: scenario.title,
    hint: scenario.hint,
  };
  return `<!-- META ${JSON.stringify(metadata)} -->\n\n${scenario.paragraphs.map(paragraph =>
    `${paragraph.text}\n<!-- SOURCES ${JSON.stringify(paragraph.references.map(reference => ({
      memory_id: reference.memory_id,
      revision: reference.revision,
    })))} -->`).join('\n\n')}`;
}

function invalidDocument(detail: string): never {
  throw new L2ScenarioError('l2_scenario_document_invalid', undefined, detail);
}

export function compileScenarioMarkdown(
  path: string,
  content: string,
  originals: ReadonlyMap<string, L2ScenarioVersion>,
  readPaths: ReadonlySet<string>,
  memories: readonly L2ScenarioMemory[],
  budget: L2ScenarioBudget,
): L2ScenarioDraft | null {
  if (content.trim() === '[DELETED]') return null;
  const match = /^<!-- META (.*?) -->\s*([\s\S]+)$/.exec(content);
  if (!match) invalidDocument('场景必须以 <!-- META ... --> 开头，并在后接正文');
  let metadata: unknown;
  try {
    metadata = JSON.parse(match[1]!);
  } catch {
    invalidDocument('META 必须是有效 JSON');
  }
  if (
    !object(metadata)
    || Object.keys(metadata).some(key => !['topic_key', 'title', 'hint', 'replaces', 'scenario_id'].includes(key))
    || !['topic_key', 'title', 'hint'].every(key => Object.hasOwn(metadata, key))
    || typeof metadata.topic_key !== 'string'
    || typeof metadata.title !== 'string'
    || typeof metadata.hint !== 'string'
  ) {
    invalidDocument('META 必须包含 topic_key、title、hint，只能另带 replaces、scenario_id');
  }
  const original = originals.get(path);
  const replaceValue = metadata.replaces ?? [];
  if (
    !Array.isArray(replaceValue)
    || replaceValue.some(version => typeof version !== 'string')
    || new Set(replaceValue).size !== replaceValue.length
  ) invalidDocument('META.replaces 必须是无重复的版本 ID 数组');
  let replaces = replaceValue as string[];
  if (original) {
    replaces = [...new Set([original.version_id, ...replaces])];
  }
  if (replaces.some(version => ![...originals.values()].some(item => item.version_id === version && readPaths.has(`${item.scenario_id}.md`)))) {
    throw new L2ScenarioError('l2_scenario_read_required');
  }
  const replacedOriginals = [...originals.values()].filter(item => replaces.includes(item.version_id));
  const inheritedScenarioId = metadata.scenario_id
    ?? (original ? original.scenario_id : replaces.map(version => [...originals.values()].find(item => item.version_id === version)?.scenario_id).find(Boolean));
  if (
    inheritedScenarioId !== undefined
    && (
      typeof inheritedScenarioId !== 'string'
      || !UUID.test(inheritedScenarioId)
      || !replaces.some(version => [...originals.values()].some(item => item.version_id === version && item.scenario_id === inheritedScenarioId))
    )
  ) invalidDocument('scenario_id 必须属于本次显式替换的已读旧场景');
  const parsed: Record<string, unknown>[] = [];
  let body = match[2]!;
  while (body.trim()) {
    const paragraph = /^\s*([\s\S]*?)\n<!-- SOURCES (.*?) -->\s*/.exec(body);
    if (!paragraph || !paragraph[1]!.trim()) {
      invalidDocument(`第 ${parsed.length + 1} 段必须是非空正文，并紧跟 <!-- SOURCES ... -->`);
    }
    let references: unknown;
    try {
      references = JSON.parse(paragraph[2]!);
    } catch {
      invalidDocument(`第 ${parsed.length + 1} 段的 SOURCES 必须是有效 JSON`);
    }
    parsed.push({text: paragraph[1]!.trim(), references});
    body = body.slice(paragraph[0].length);
  }
  if (!parsed.length) invalidDocument('正文至少需要一个非空段落');
  const proposal = validateScenarioDocument({
    scenarios: [{
      ...(inheritedScenarioId ? {scenario_id: inheritedScenarioId} : {}),
      topic_key: original ? `continued-${metadata.topic_key}`.slice(0, 64) : metadata.topic_key,
      title: metadata.title,
      hint: metadata.hint,
      replaces,
      paragraphs: parsed,
    }],
  }, memories, replacedOriginals, budget);
  const result = proposal[0]!;
  if (original) {
    result.scenario_id = original.scenario_id;
    if (readPaths.has(path) !== true) throw new L2ScenarioError('l2_scenario_read_required');
  }
  return result;
}

export interface ScenarioVerification {
  results: {
    scenario_index: number;
    paragraph_index: number;
    supported: boolean;
    evidence: {memory_id: string; quote: string}[];
  }[];
}

export interface ScenarioVerificationFeedback {
  code: string;
  verification: ScenarioVerification;
  proposal: readonly L2ScenarioDraft[];
}

/** 仅转交核验合同内的索引、判断与引文；额外字段及未知来源不能进入修正提示。 */
export function scenarioVerificationFeedback(error: L2ScenarioVerificationError, proposal: readonly L2ScenarioDraft[], memories: readonly L2ScenarioMemory[]): ScenarioVerificationFeedback | null {
  const value = error.verification;
  if (!/^l2_scenario_(verification_(rejected|invalid)|quote_invalid)$/.test(error.code) || !object(value) || !exactKeys(value, ['results']) || !Array.isArray(value.results) || value.results.length > proposal.reduce((sum, item) => sum + item.paragraphs.length, 0)) return null;
  const ids = new Set(memories.map(memory => memory.memory_id)), seen = new Set<string>();
  for (const row of value.results) {
    if (!object(row) || !exactKeys(row, ['scenario_index', 'paragraph_index', 'supported', 'evidence']) || !Number.isSafeInteger(row.scenario_index) || !Number.isSafeInteger(row.paragraph_index) || !proposal[row.scenario_index as number]?.paragraphs[row.paragraph_index as number] || typeof row.supported !== 'boolean' || !Array.isArray(row.evidence) || row.evidence.length > 60) return null;
    const key = `${row.scenario_index}:${row.paragraph_index}`;
    if (seen.has(key)) return null;
    seen.add(key);
    for (const evidence of row.evidence) if (!object(evidence) || !exactKeys(evidence, ['memory_id', 'quote']) || typeof evidence.memory_id !== 'string' || !ids.has(evidence.memory_id) || typeof evidence.quote !== 'string' || !evidence.quote || evidence.quote.length > 128_000) return null;
  }
  return {code: error.code, verification: clone(value) as unknown as ScenarioVerification, proposal: clone(proposal)};
}

export class L2ScenarioVerificationError extends L2ScenarioError {
  readonly verification: unknown;
  constructor(code: string, verification: unknown) {
    super(code);
    this.verification = verification;
    this.name = 'L2ScenarioVerificationError';
  }
}

export function parseScenarioVerification(value: unknown, scenarios: readonly L2ScenarioDraft[], memories: readonly L2ScenarioMemory[]): void {
  if (!object(value) || !exactKeys(value, ['results']) || !Array.isArray(value.results)) {
    throw new L2ScenarioError('l2_scenario_verification_invalid');
  }
  const expected = scenarios.flatMap((scenario, scenarioIndex) =>
    scenario.paragraphs.map((_paragraph, paragraphIndex) => `${scenarioIndex}:${paragraphIndex}`));
  const seen = new Set<string>();
  const memoryText = new Map(memories.map(memory => [memory.memory_id, memory.text]));
  for (const result of value.results) {
    if (
      !object(result)
      || !exactKeys(result, ['scenario_index', 'paragraph_index', 'supported', 'evidence'])
      || !Number.isSafeInteger(result.scenario_index)
      || !Number.isSafeInteger(result.paragraph_index)
      || result.supported !== true
      || !Array.isArray(result.evidence)
      || !result.evidence.length
    ) throw new L2ScenarioError('l2_scenario_verification_rejected');
    const scenario = scenarios[result.scenario_index as number];
    const paragraph = scenario?.paragraphs[result.paragraph_index as number];
    const key = `${result.scenario_index}:${result.paragraph_index}`;
    if (!paragraph || seen.has(key)) throw new L2ScenarioError('l2_scenario_verification_invalid');
    seen.add(key);
    const references = new Set(paragraph.references.map(reference => reference.memory_id));
    for (const evidence of result.evidence) {
      if (
        !object(evidence)
        || !exactKeys(evidence, ['memory_id', 'quote'])
        || typeof evidence.memory_id !== 'string'
        || typeof evidence.quote !== 'string'
        || !evidence.quote
        || !references.has(evidence.memory_id)
        || !memoryText.get(evidence.memory_id)?.includes(evidence.quote)
      ) throw new L2ScenarioError('l2_scenario_quote_invalid');
    }
  }
  if (seen.size !== expected.length || expected.some(key => !seen.has(key))) {
    throw new L2ScenarioError('l2_scenario_verification_invalid');
  }
}
