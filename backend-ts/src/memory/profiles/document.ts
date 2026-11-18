/** L3 长期背景的文档合同、确定性核验与发布选择；不执行模型或访问存储。 */
import type {ContentBlock} from '@deepseek-ai/dsh-llm';
import {
  L2ScenarioError,
  UUID,
  canonicalScenarioJSON,
  clone,
  count,
  exactKeys,
  object,
  readToolCalls,
  scenarioDigest,
  type L2ScenarioBudget,
  type L2ScenarioMemory,
  type L2ScenarioReference,
  type L2ScenarioVersion,
} from '../scenarios/document.ts';

// profiles/workspace.ts 与测试沿用本模块导出的名字。
export {UUID, clone, count, exactKeys, object, readToolCalls};

export type ProfileTemporalStatus = 'stable' | 'historical' | 'uncertain';
export type ProfileKind = 'fact' | 'preference' | 'inference' | 'contradiction';
export type ProfileSection =
  | 'basic_information'
  | 'long_term_preferences'
  | 'life_context'
  | 'interests'
  | 'insights'
  | 'evolution'
  | 'contradictions';

export interface L3ProfileEntry {
  text: string;
  kind: ProfileKind;
  section: ProfileSection;
  basis: string;
  temporal_status: ProfileTemporalStatus;
  uncertainty: string;
  references: L2ScenarioReference[];
}

export interface L3ProfileDocument {
  version_id: string;
  entries: L3ProfileEntry[];
}

export interface L3ProfileDraft {
  entries: L3ProfileEntry[];
}

export interface RejectedProfileEntry {
  index: number;
  reason: string;
}

const KINDS = new Set<ProfileKind>(['fact', 'preference', 'inference', 'contradiction']);
const SECTIONS = new Set<ProfileSection>([
  'basic_information', 'long_term_preferences', 'life_context', 'interests', 'insights', 'evolution', 'contradictions',
]);
const TEMPORAL = new Set<ProfileTemporalStatus>(['stable', 'historical', 'uncertain']);
export const ENTRY_FIELDS = [
  'text', 'kind', 'section', 'basis', 'temporal_status', 'uncertainty', 'references',
] as const;
export const KIND_VALUES = [...KINDS];
export const SECTION_VALUES = [...SECTIONS];
export const TEMPORAL_VALUES = [...TEMPORAL];
export const MAX_PROFILE_ENTRIES = 16;
export const MAX_PROFILE_CHARACTERS = 2_000;
const ACTION_GUIDANCE = [
  // 排除“联系人”名词，同时保留“联系人事部门”中的联系动作。
  /(?:下次|以后|应该|建议|务必|记得)[^。！？\n]{0,40}(?:回复|安慰|沟通|联系(?!人(?!事))|道歉|表达|见面|拒绝|答应|邀请)/u,
  /(?:应该|建议|务必|记得)联系/u,
  /(?:回复|安慰|沟通|表达)(?:时|时先|时不要|时应当)[^。！？\n]{0,40}/u,
  /(?:替|帮)(?:对方|联系人|本人)(?:决定|做主)/u,
  /(?:先|再)(?:安慰|试探|冷处理)[^。！？\n]{0,30}(?:然后|再|并)[^。！？\n]{0,30}/u,
];

export function invalid(code = 'l3_profile_proposal_invalid', detail?: string): never {
  throw new L2ScenarioError(code, undefined, detail);
}

function requireText(
  value: unknown,
  label: string,
  limit: number,
  allowEmpty: boolean,
  code: string,
): string {
  if (typeof value !== 'string' || value !== value.trim() || count(value) > limit || !allowEmpty && !value) {
    invalid(
      code,
      `${label}必须是${allowEmpty ? '可为空的' : '非空的'}无首尾空白字符串且不超过${limit}字`,
    );
  }
  return value;
}

function assertNoActionGuidance(value: string): void {
  if (ACTION_GUIDANCE.some(pattern => pattern.test(value))) {
    invalid('l3_profile_action_guidance', '长期背景不保存回复或行动建议');
  }
}

function checkedReferences(
  value: unknown,
  memories: ReadonlyMap<string, L2ScenarioMemory>,
): L2ScenarioReference[] {
  if (!Array.isArray(value) || !value.length) {
    invalid('l3_profile_reference_invalid', 'references必须是非空数组，且每条至少引用一个真实底层版本');
  }
  const seen = new Set<string>();
  return value.map((reference, index) => {
    if (
      !object(reference)
      || typeof reference.memory_id !== 'string'
      || !UUID.test(reference.memory_id)
      || !Number.isSafeInteger(reference.revision)
      || Number(reference.revision) < 1
    ) {
      invalid(
        'l3_profile_reference_invalid',
        `references[${index}]必须只含有效memory_id和大于0的整数revision`,
      );
    }
    const key = `${reference.memory_id.toLowerCase()}:${Number(reference.revision)}`;
    const memory = memories.get(key);
    if (!memory) {
      invalid(
        'l3_profile_reference_invalid',
        `references[${index}]不是本次输入memories中的精确memory_id+revision`,
      );
    }
    if (seen.has(key)) {
      invalid('l3_profile_reference_invalid', `references[${index}]重复引用了同一底层版本`);
    }
    seen.add(key);
    return {
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
    };
  });
}

function checkedEntry(value: unknown, memories: ReadonlyMap<string, L2ScenarioMemory>): L3ProfileEntry {
  if (!object(value)) invalid('l3_profile_entry_invalid', 'ENTRY元数据必须是JSON对象');
  const unexpected = Object.keys(value).filter(key => !ENTRY_FIELDS.includes(key as typeof ENTRY_FIELDS[number]));
  if (unexpected.length) {
    const shown = unexpected.slice(0, 8).map(key => `“${[...key].slice(0, 40).join('')}”`).join('、');
    invalid(
      'l3_profile_unexpected_keys',
      `ENTRY包含不允许的字段${shown}；允许字段仅为${ENTRY_FIELDS.join('/')}`,
    );
  }
  const text = requireText(value.text, 'text', 1_500, false, 'l3_profile_text_invalid');
  const basis = requireText(value.basis, 'basis', 1_000, false, 'l3_profile_basis_invalid');
  const uncertainty = requireText(value.uncertainty, 'uncertainty', 240, true, 'l3_profile_uncertainty_invalid');
  if (!KINDS.has(value.kind as ProfileKind)) {
    invalid('l3_profile_kind_invalid', `kind必须为${KIND_VALUES.join('/')}`);
  }
  if (!SECTIONS.has(value.section as ProfileSection)) {
    invalid('l3_profile_section_invalid', `section必须为${SECTION_VALUES.join('/')}`);
  }
  if (!TEMPORAL.has(value.temporal_status as ProfileTemporalStatus)) {
    invalid('l3_profile_temporal_status_invalid', `temporal_status必须为${TEMPORAL_VALUES.join('/')}`);
  }
  const kind = value.kind as ProfileKind;
  const temporal = value.temporal_status as ProfileTemporalStatus;
  if ((kind === 'inference' || kind === 'contradiction') && (!uncertainty || temporal !== 'uncertain')) {
    invalid('l3_profile_uncertainty_required', '推断与矛盾必须保持不确定');
  }
  assertNoActionGuidance(text);
  assertNoActionGuidance(basis);
  const references = checkedReferences(value.references, memories);
  if (kind === 'contradiction' && (references.length !== 2 || new Set(references.map(reference => reference.memory_id)).size !== 2)) {
    invalid('l3_profile_reference_invalid', '矛盾条目必须恰好引用两个不同memory_id的底层记忆版本，分别对应冲突的两端');
  }
  return {
    text,
    kind,
    section: value.section as ProfileSection,
    basis,
    temporal_status: temporal,
    uncertainty,
    references,
  };
}

/**
 * 整份画像的直接版本、命题类别、时间状态和行动建议校验。
 * 个人资料字段全部必填，旧记录不由本函数回填。
 */
export function validateProfile(
  proposal: unknown,
  memories: readonly L2ScenarioMemory[],
  budget: L2ScenarioBudget,
): L3ProfileDraft {
  if (!object(proposal) || !exactKeys(proposal, ['entries']) || !Array.isArray(proposal.entries)) invalid();
  if (proposal.entries.length > Math.min(MAX_PROFILE_ENTRIES, budget.max_memories)) {
    invalid('l3_profile_budget_exceeded', '长期背景条目数量超限');
  }
  const byVersion = new Map(memories.map(memory => [`${memory.memory_id}:${memory.revision}`, memory]));
  const entries = proposal.entries.map((entry, index) => {
    try {
      return checkedEntry(entry, byVersion);
    } catch (error) {
      if (!(error instanceof L2ScenarioError)) throw error;
      const prefix = `${error.code}: `;
      const detail = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
      invalid(error.code, `第${index + 1}条：${detail}`);
    }
  });
  const characters = entries.reduce((total, item) =>
    total + count(item.text) + count(item.basis) + count(item.uncertainty), 0);
  if (characters > Math.min(MAX_PROFILE_CHARACTERS, budget.max_characters)) {
    invalid('l3_profile_budget_exceeded', '长期背景正文预算已耗尽');
  }
  return {entries};
}

/** 用户已撤回的画像正文只能作为错误对照，不能由后续整理换入当前版本。 */
export function validateProfileCorrections(
  entries: readonly L3ProfileEntry[],
  rejectedTexts: ReadonlySet<string>,
): void {
  if (entries.some(entry => rejectedTexts.has(entry.text))) {
    invalid('l3_profile_correction_reintroduced', '不能重现已撤回的长期背景正文');
  }
}

/** 单个坏条目不拖垮同批其他合法条目；每个结果仍用完整冻结版本重新校验。 */
export function filterProfileProposal(
  proposal: unknown,
  memories: readonly L2ScenarioMemory[],
  budget: L2ScenarioBudget,
  rejectedTexts: ReadonlySet<string> = new Set(),
): {entries: L3ProfileEntry[]; rejected: RejectedProfileEntry[]} {
  if (!object(proposal) || !exactKeys(proposal, ['entries']) || !Array.isArray(proposal.entries)) invalid();
  const entries: L3ProfileEntry[] = [];
  const rejected: RejectedProfileEntry[] = [];
  let characters = 0;
  for (const [index, raw] of proposal.entries.entries()) {
    try {
      const checked = validateProfile({entries: [raw]}, memories, budget).entries[0]!;
      validateProfileCorrections([checked], rejectedTexts);
      const next = characters + count(checked.text) + count(checked.basis) + count(checked.uncertainty);
      if (entries.length >= Math.min(MAX_PROFILE_ENTRIES, budget.max_memories) || next > Math.min(MAX_PROFILE_CHARACTERS, budget.max_characters)) {
        invalid('l3_profile_budget_exceeded', '长期背景预算已耗尽');
      }
      characters = next;
      entries.push(checked);
    } catch (error) {
      if (!(error instanceof L2ScenarioError)) throw error;
      rejected.push({index, reason: error.message || '长期背景条目无效'});
    }
  }
  return {entries, rejected};
}

export function renderProfile(profile: {entries: readonly L3ProfileEntry[]} | null | undefined): string {
  const contents = (profile?.entries ?? []).map(entry => {
    const metadata = {
      kind: entry.kind,
      section: entry.section,
      basis: entry.basis,
      temporal_status: entry.temporal_status,
      uncertainty: entry.uncertainty,
      references: entry.references.map(reference => ({memory_id: reference.memory_id, revision: reference.revision})),
    };
    return `<!-- ENTRY ${JSON.stringify(metadata)} -->\n${entry.text}`;
  });
  return `# 长期背景\n${contents.length ? `\n${contents.join('\n\n')}` : ''}`;
}

export function parseEntryBlocks(content: string): {
  entries: L3ProfileEntry[];
  errors: {code:string; detail:string}[];
} {
  const firstLineEnd = content.indexOf('\n');
  const header = (firstLineEnd < 0 ? content : content.slice(0, firstLineEnd)).trimEnd();
  if (header !== '# 长期背景') {
    invalid('l3_profile_document_header_invalid', '画像第一行必须恰好是“# 长期背景”');
  }
  const body = content.slice(firstLineEnd < 0 ? content.length : firstLineEnd + 1).trim();
  if (!body) return {entries: [], errors: []};
  if (!body.startsWith('<!-- ENTRY ')) {
    invalid(
      'l3_profile_document_format_invalid',
      '标题后必须直接开始“<!-- ENTRY JSON -->”，不得先写二级标题、说明或总结',
    );
  }
  const parts = body.split(/(?=^<!-- ENTRY )/m).filter(part => part.trim());
  const rawEntries: unknown[] = [];
  const errors: {code:string; detail:string}[] = [];
  for (const [index, part] of parts.entries()) {
    const match = /^<!-- ENTRY ([^\n]*?) -->\n([\s\S]+)$/.exec(part.trim());
    if (!match || !match[2]!.trim()) {
      errors.push({
        code:'l3_profile_entry_format_invalid',
        detail:`第${index + 1}条必须采用“<!-- ENTRY JSON -->\\n正文”的完整格式`,
      });
      continue;
    }
    try {
      rawEntries.push({...JSON.parse(match[1]!), text: match[2]!.trim()});
    } catch {
      errors.push({
        code:'l3_profile_entry_metadata_invalid',
        detail:`第${index + 1}条ENTRY元数据不是有效JSON对象`,
      });
    }
  }
  return {entries: rawEntries as L3ProfileEntry[], errors};
}

export interface ProfileVerification {
  results: {
    entry_index:number;
    supported:boolean;
    evidence:{memory_id:string; quote:string}[];
  }[];
}

export function parseProfileVerification(
  value: unknown,
  entries: readonly L3ProfileEntry[],
  memories: readonly L2ScenarioMemory[],
): void {
  if (!object(value) || !exactKeys(value, ['results']) || !Array.isArray(value.results)) invalid('l3_profile_verification_invalid');
  const memoryById = new Map(memories.map(memory => [memory.memory_id, memory.text]));
  const seen = new Set<number>();
  for (const result of value.results) {
    if (
      !object(result)
      || !exactKeys(result, ['entry_index', 'supported', 'evidence'])
      || !Number.isSafeInteger(result.entry_index)
      || typeof result.supported !== 'boolean'
      || !Array.isArray(result.evidence)
    ) invalid('l3_profile_verification_invalid');
    const index = Number(result.entry_index);
    const proposed = entries[index];
    if (!proposed || seen.has(index)) invalid('l3_profile_verification_invalid');
    seen.add(index);
    if (!result.supported) continue;
    if (!result.evidence.length) invalid('l3_profile_verification_rejected');
    const references = new Set(proposed.references.map(reference => reference.memory_id));
    for (const [evidenceIndex, evidence] of result.evidence.entries()) {
      if (
        !object(evidence)
        || !exactKeys(evidence, ['memory_id', 'quote'])
        || typeof evidence.memory_id !== 'string'
        || typeof evidence.quote !== 'string'
        || !evidence.quote
      ) {
        invalid(
          'l3_profile_verification_invalid',
          `第${index + 1}条evidence[${evidenceIndex}]必须只含memory_id和逐字quote`,
        );
      }
      if (!references.has(evidence.memory_id)) {
        invalid(
          'l3_profile_quote_memory_invalid',
          `第${index + 1}条evidence[${evidenceIndex}]的memory_id不是该条entry引用`,
        );
      }
      const source = memoryById.get(evidence.memory_id);
      if (!source) {
        invalid(
          'l3_profile_quote_memory_invalid',
          `第${index + 1}条evidence[${evidenceIndex}]的memory_id不属于冻结输入`,
        );
      }
      if (!source.includes(evidence.quote)) {
        if (evidence.quote === proposed.text) {
          invalid(
            'l3_profile_quote_proposal_invalid',
            `第${index + 1}条evidence[${evidenceIndex}]误把提案entry正文当作quote；必须引用verbatim_text`,
          );
        }
        if (source.includes(evidence.quote.trim())) {
          invalid(
            'l3_profile_quote_wrapper_invalid',
            `第${index + 1}条evidence[${evidenceIndex}]的quote含额外首尾空白或包裹字符`,
          );
        }
        invalid(
          'l3_profile_quote_invalid',
          `第${index + 1}条evidence[${evidenceIndex}]的quote不是verbatim_text中连续、大小写和标点完全一致的非空子串`,
        );
      }
    }
  }
  if (seen.size !== entries.length) invalid('l3_profile_verification_invalid');
}

export const PROFILE_VERIFICATION_TOOL_NAME = 'ProfileVerificationOutput';

/** 在线核验与已知回执重放共用相同的工具包络及逐字证据合同。 */
export function parseProfileVerificationOutput(blocks:readonly ContentBlock[],entries:readonly L3ProfileEntry[],memories:readonly L2ScenarioMemory[]):ProfileVerification {
  const calls=readToolCalls(blocks);
  if(calls.length!==1||calls[0]!.name!==PROFILE_VERIFICATION_TOOL_NAME)invalid('l3_profile_verification_invalid','必须只调用一次ProfileVerificationOutput');
  let value:unknown;
  try{value=JSON.parse(calls[0]!.arguments);}catch{invalid('l3_profile_verification_invalid','ProfileVerificationOutput参数不是有效JSON');}
  parseProfileVerification(value,entries,memories);return value as ProfileVerification;
}
export const MAX_PROFILE_VERIFICATION_ATTEMPTS=2;
export function isRetryableProfileVerificationError(error:unknown):error is L2ScenarioError {
  return error instanceof L2ScenarioError&&[
    'l3_profile_quote_invalid','l3_profile_quote_memory_invalid','l3_profile_quote_proposal_invalid',
    'l3_profile_quote_wrapper_invalid','l3_profile_verification_invalid',
  ].includes(error.code);
}

function entryIdentity(entry: L3ProfileEntry): string {
  return canonicalScenarioJSON({
    text:entry.text,
    kind:entry.kind,
    section:entry.section,
    basis:entry.basis,
    temporal_status:entry.temporal_status,
    uncertainty:entry.uncertainty,
    references:entry.references.map(reference => ({
      memory_id:reference.memory_id,
      revision:reference.revision,
    })).sort((left, right) => `${left.memory_id}:${left.revision}`.localeCompare(`${right.memory_id}:${right.revision}`)),
  });
}

/** 先核对完整回执，再按原条目位置选择发布；失败的新提案不撤销有效旧条目。 */
export function selectProfilePublication(
  proposal: L3ProfileDraft,
  verification: ProfileVerification,
  memories: readonly L2ScenarioMemory[],
  budget: L2ScenarioBudget,
  existing?: L3ProfileDocument | null,
  changedScenarios: readonly L2ScenarioVersion[] = [],
): {accepted:{index:number;entry:L3ProfileEntry}[]; rejected:number[]; retained:{index:number;entry:L3ProfileEntry}[]} {
  parseProfileVerification(verification, proposal.entries, memories);
  const supported=new Map(verification.results.map(result=>[result.entry_index,result.supported]));
  const accepted=proposal.entries.flatMap((entry,index)=>supported.get(index)?[{index,entry}]:[]);
  const rejected=proposal.entries.flatMap((_,index)=>supported.get(index)?[]:[index]);
  if(!accepted.length)return {accepted,rejected,retained:(existing?.entries??[]).map((entry,index)=>({index,entry}))};
  const changed=new Set(changedScenarios.flatMap(scene=>scene.paragraphs.flatMap(paragraph=>paragraph.references.map(ref=>`${ref.memory_id}:${ref.revision}`))));
  const acceptedRefs=new Set(accepted.flatMap(({entry})=>entry.references.map(ref=>`${ref.memory_id}:${ref.revision}`)));
  const acceptedIdentities=new Set(accepted.map(({entry})=>entryIdentity(entry)));
  const retained=(existing?.entries??[]).flatMap((entry,index)=>{
    const refs=entry.references.map(ref=>`${ref.memory_id}:${ref.revision}`);
    // 同一来源可以承载多个事实；部分拒绝时不能仅凭共用来源推定旧条目已被替换。
    const preserve=(rejected.length>0||!refs.some(ref=>changed.has(ref)))&&!acceptedIdentities.has(entryIdentity(entry))||!refs.every(ref=>acceptedRefs.has(ref));
    return preserve?[{index,entry}]:[];
  });
  const selected=validateProfile({entries:[...accepted.map(item=>item.entry),...retained.map(item=>item.entry)]},memories,budget);
  validateIncrementalProfile(selected,existing,changedScenarios);
  return {accepted,rejected,retained};
}

/** 变化场景之外的有效旧条目必须逐字保留；依据变化条目允许更新或合并。 */
export function validateIncrementalProfile(
  proposal: L3ProfileDraft,
  existing: L3ProfileDocument | null | undefined,
  changedScenarios: readonly L2ScenarioVersion[],
): void {
  if (!existing) return;
  const changed = new Set(changedScenarios.flatMap(scenario => scenario.paragraphs
    .flatMap(paragraph => paragraph.references)
    .map(reference => `${reference.memory_id}:${reference.revision}`)));
  const presentRefs = new Set(proposal.entries.flatMap(entry =>
    entry.references.map(reference => `${reference.memory_id}:${reference.revision}`)));
  let presentEntries: Set<string> | undefined;
  for (const old of existing.entries) {
    const refs = old.references.map(reference => `${reference.memory_id}:${reference.revision}`);
    if (!refs.some(reference => changed.has(reference))) {
      presentEntries ??= new Set(proposal.entries.map(entryIdentity));
      if (!presentEntries.has(entryIdentity(old))) {
        invalid('l3_profile_incremental_entry_missing', '增量画像遗漏未变化的有效旧条目');
      }
    }
    if (!refs.every(reference => presentRefs.has(reference))) {
      invalid('l3_profile_incremental_reference_missing', '增量画像不能丢弃仍有效旧条目的来源');
    }
  }
}

export function profileDigest(value: unknown): string {
  return scenarioDigest(value);
}
