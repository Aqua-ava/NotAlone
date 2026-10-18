import type { AssistantInputBudget } from '../shared/assistant-input-budget';

export function AssistantInputBudgetNotice({ budget, historical = false }: {
  budget: AssistantInputBudget; historical?: boolean;
}) {
  const estimated = budget.measurementKind === 'approximate';
  if (budget.state === 'ready' && !estimated) return null;
  const warning = budget.state === 'warning';
  let message = budget.state === 'exceeded'
    ? estimated ? '当前讨论超过建议长度，本次生成已停止。已填写内容和已保存讨论仍可查看，请新开助手会话。'
      : '当前讨论超出模型输入预算，超限调用已停止。已填写内容和已保存讨论仍可查看，可新开助手会话。'
    : estimated ? '当前模型的输入长度暂无法估算，本次生成已停止。已填写内容和已保存讨论仍会保留。'
      : '当前模型的完整输入计量配置不可用，暂不能生成。已填写内容和已保存讨论仍会保留。';
  if (budget.state === 'ready') {
    message = historical ? '这轮生成的输入长度为估算，已预留余量。' : '输入长度为估算，已预留余量。';
  } else if (warning) {
    message = estimated
      ? historical ? '这轮讨论当时快达到建议长度。' : '讨论快达到建议长度。继续前会重新检查，也可新开助手会话。'
      : historical ? '这轮生成当时已接近模型输入上限。' : '上次生成时，当前讨论已接近模型输入上限。继续前会重新核验预算，也可新开助手会话。';
  }
  return <aside aria-label={historical ? '当时的模型输入预算' : '模型输入预算'} role={warning || budget.state === 'ready' ? 'status' : 'alert'}>
    <p>{message}</p>
    {budget.totalTokens !== null && <details className="record-metadata"><summary>查看输入长度详情</summary><p>{estimated ? '估算总量' : budget.measurementKind === 'verified_upper_bound' ? '已核实的保守上界' : '本次输入计量'}：
      {budget.totalTokens} / {budget.contextWindowTokens} token（含输出预留 {budget.outputReserveTokens} token
      {budget.safetyMarginTokens > 0 && <>、安全余量 {budget.safetyMarginTokens} token</>}）。</p></details>}
  </aside>;
}
