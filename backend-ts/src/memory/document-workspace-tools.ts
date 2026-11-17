/** 场景与画像共用的内存文档编辑协议；路径权限和暂存校验仍由各工作区负责。 */
import {defineTool, type ToolDefinition} from '@deepseek-ai/dsh-tools';

type DocumentToolName = 'read' | 'write' | 'edit';
type EditFailure = 'arguments' | 'edit';

/** 全部替换先在局部文本完成，任一编辑无效都不提交部分结果。 */
export function applyExactTextEdits(
  content: string,
  edits: unknown,
  invalid: (reason: EditFailure) => never,
): string {
  if (!Array.isArray(edits) || !edits.length || edits.length > 32) invalid('edit');
  for (const edit of edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) invalid('arguments');
    if (
      Object.keys(edit).sort().join('|') !== 'newText|oldText'
      || typeof edit.oldText !== 'string'
      || !edit.oldText
      || typeof edit.newText !== 'string'
      || content.split(edit.oldText).length !== 2
    ) invalid('edit');
    content = content.replace(edit.oldText, edit.newText);
  }
  return content;
}

/** DSH 与手动工具轮次共用工作区分派入口，不另维护一套业务调用。 */
export function createDocumentWorkspaceTools(
  workspace: {execute(name: string, args: unknown): string},
  descriptions: Record<DocumentToolName, string>,
): ToolDefinition[] {
  const parameters = {
    read: {path: {type: 'string', required: true}},
    write: {
      path: {type: 'string', required: true},
      content: {type: 'string', required: true},
    },
    edit: {
      path: {type: 'string', required: true},
      edits: {
        type: 'array', required: true,
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            oldText: {type: 'string', required: true},
            newText: {type: 'string', required: true},
          },
        },
      },
    },
  } as const;
  return (['read', 'write', 'edit'] as const).map(name => defineTool({
    name,
    description: descriptions[name],
    parameters: parameters[name],
    output: {schema: {type: 'string'}, render: (_args, value) => [{type: 'text', text: value}]},
    async execute(args, execution) {
      execution.signal.throwIfAborted();
      return workspace.execute(name, args);
    },
  }));
}
