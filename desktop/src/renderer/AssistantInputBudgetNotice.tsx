import type { AssistantInputBudget } from '../shared/assistant-input-budget';

export function AssistantInputBudgetNotice({ budget, historical = false }: {
  budget: AssistantInputBudget; historical?: boolean;
}) {
  if (budget.state === 'ready') return null;
  const warning = budget.state === 'warning';
  return <aside aria-label={historical ? '当时的模型输入预算' : '模型输入预算'} role={warning ? 'status' : 'alert'}>
    <p>{warning ? historical ? '这轮生成当时已接近模型输入上限。' : '上次生成时，当前讨论已接近模型输入上限。继续前会重新核验预算，也可新开助手会话。'
      : budget.state === 'exceeded' ? '当前讨论超出模型输入预算，超限调用已停止。已填写内容和已保存讨论仍可查看，可新开助手会话。'
      : '当前模型的完整输入计量配置不可用，暂不能生成。已填写内容和已保存讨论仍会保留。'}</p>
    {budget.totalTokens !== null && <p>{budget.measurementKind === 'verified_upper_bound' ? '已核实的保守上界' : '本次输入计量'}：
      {budget.totalTokens} / {budget.contextWindowTokens} token（含输出预留 {budget.outputReserveTokens} token）。</p>}
  </aside>;
}
