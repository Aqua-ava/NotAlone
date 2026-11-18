/** L3 长期背景的内存工作区：只读冻结场景、只写 profile.md，暂存后即时编译校验；不调用模型、不发布版本。 */
import type {ToolDefinition} from '@deepseek-ai/dsh-tools';
import {applyExactTextEdits, createDocumentWorkspaceTools} from '../document-workspace-tools.ts';
import type {L2ScenarioBudget, L2ScenarioMemory, L2ScenarioVersion} from '../scenarios/index.ts';
import {
  UUID,
  object,
  exactKeys,
  count,
  clone,
  invalid,
  parseEntryBlocks,
  validateProfile,
  renderProfile,
  type L3ProfileDocument,
  type L3ProfileDraft,
} from './document.ts';
import {errorMessage} from './shared.ts';

const PATH = /^[a-zA-Z0-9_-]{1,96}\.md$/;

function renderScenario(scenario: L2ScenarioVersion): string {
  return `<!-- META ${JSON.stringify({scenario_id: scenario.scenario_id, version_id: scenario.version_id, title: scenario.title, hint: scenario.hint})} -->\n\n${scenario.paragraphs.map(paragraph =>
    `${paragraph.text}\n<!-- SOURCES ${JSON.stringify(paragraph.references.map(reference => ({
      memory_id: reference.memory_id,
      revision: reference.revision,
    })))} -->`).join('\n\n')}`;
}

type ProfileGenerationContext = {
  existing: L3ProfileDocument | null;
  scenarios: readonly L2ScenarioVersion[];
  memories: readonly L2ScenarioMemory[];
  budget: L2ScenarioBudget;
};

function freezeGenerationContext<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeGenerationContext(item);
    Object.freeze(value);
  }
  return value;
}

/** 只能读取本次场景并写 profile.md；不映射任何真实文件系统路径。 */
export class L3ProfileWorkspace {
  readonly budget: L2ScenarioBudget;
  readonly memories: readonly L2ScenarioMemory[];
  private readonly initial: ProfileGenerationContext;
  private readonly scenarios = new Map<string, {version: L2ScenarioVersion; content: string}>();
  private content: string;

  constructor(
    existing: L3ProfileDocument | null,
    scenarios: readonly L2ScenarioVersion[],
    memories: readonly L2ScenarioMemory[],
    budget: L2ScenarioBudget,
  ) {
    this.initial = freezeGenerationContext(clone({existing, scenarios, memories, budget}));
    this.budget = this.initial.budget;
    this.memories = this.initial.memories;
    this.content = renderProfile(this.initial.existing);
    for (const scenario of this.initial.scenarios) {
      if (!UUID.test(scenario.scenario_id) || !UUID.test(scenario.version_id)) invalid('l3_profile_scenario_invalid');
      const path = `${scenario.scenario_id}.md`;
      this.scenarios.set(path, {version: scenario, content: renderScenario(scenario)});
    }
  }

  /** 模型输入、文档读取与编译共用构造时的深冻结副本，不接收另一套资料。 */
  generationContext(): Readonly<ProfileGenerationContext> {
    return this.initial;
  }

  index(): Record<string, unknown>[] {
    return [...this.scenarios.entries()].map(([path, {version}]) => ({
      path,
      scenario_id: version.scenario_id,
      version_id: version.version_id,
      title: version.title,
      hint: version.hint,
      paragraph_count: version.paragraphs.length,
    }));
  }

  read(path: string): string {
    this.validatePath(path);
    if (path === 'profile.md') return this.content;
    const scenario = this.scenarios.get(path);
    if (!scenario) invalid('l3_profile_document_missing');
    return scenario.content;
  }

  write(path: string, content: string): string {
    this.validatePath(path);
    if (path !== 'profile.md') invalid('l3_profile_path_forbidden', '画像工具只能写profile.md');
    if (typeof content !== 'string' || !content.trim() || count(content) > this.budget.max_characters) {
      invalid('l3_profile_document_budget_invalid');
    }
    this.content = content;
    try {
      this.compile();
      return '已暂存长期背景，尚未发布。';
    } catch (error) {
      return `工具错误：${errorMessage(error)} 画像已暂存但格式无效，请修正后再结束；尚未发布。`;
    }
  }

  edit(edits: unknown): string {
    const content = applyExactTextEdits(this.content, edits, () => invalid('l3_profile_edit_invalid'));
    return this.write('profile.md', content);
  }

  execute(name: string, args: unknown): string {
    if (!object(args) || typeof args.path !== 'string') invalid('l3_profile_tool_arguments_invalid');
    if (name === 'read') {
      if (!exactKeys(args, ['path'])) invalid('l3_profile_tool_arguments_invalid');
      return this.read(args.path);
    }
    if (name === 'write') {
      if (!exactKeys(args, ['path', 'content']) || typeof args.content !== 'string') invalid('l3_profile_tool_arguments_invalid');
      return this.write(args.path, args.content);
    }
    if (name === 'edit') {
      if (!exactKeys(args, ['path', 'edits'])) invalid('l3_profile_tool_arguments_invalid');
      if (args.path !== 'profile.md') invalid('l3_profile_path_forbidden');
      return this.edit(args.edits);
    }
    invalid('l3_profile_tool_forbidden');
  }

  tools(): ToolDefinition[] {
    return createDocumentWorkspaceTools(this, {
      read: '读取profile.md或本次冻结目录内的单个场景Markdown。',
      write: '覆盖本次暂存profile.md；不能写场景或任何外部文件。',
      edit: '对profile.md执行唯一精确替换；仅暂存。',
    });
  }

  compile(): L3ProfileDraft {
    const parsed = parseEntryBlocks(this.content);
    if (parsed.errors.length) {
      invalid(parsed.errors[0]!.code, parsed.errors.map(error => error.detail).join('；'));
    }
    return validateProfile({entries: parsed.entries}, this.memories, this.budget);
  }

  private validatePath(path: string): void {
    if (!PATH.test(path)) invalid('l3_profile_path_forbidden');
  }
}

