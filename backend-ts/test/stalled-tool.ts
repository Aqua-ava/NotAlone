import type { Context } from '@deepseek-ai/cordis';
import { defineTool } from '@deepseek-ai/dsh-tools';
export const inject = ['agents', 'tools'];
/** 仅由专门的对抗测试 profile 装配，不属于默认业务工具。 */
export function apply(ctx: Context) {
  ctx.on('agent/created', ({ agent }) => {
    agent.ctx.tools.register(defineTool({
      name: 'uncooperative_fixture', description: '合成不合作执行边界', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { process.stdout.write('VALIDATION_STALLED\n'); return await new Promise<string>(() => {}); },
    }));
  });
}
