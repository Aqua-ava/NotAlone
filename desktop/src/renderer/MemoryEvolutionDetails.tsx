import type { MemoryEvolution } from '../shared/memory-bridge';

const kindNames: Record<MemoryEvolution['kind'], string> = {
  supplement: '补充', state_change: '状态变化', error_correction: '错误纠正',
  historical_supplement: '历史补充', unresolved_conflict: '未解决矛盾',
};

export function MemoryEvolutionDetails({ evolution }: { evolution?: MemoryEvolution | null }) {
  if (!evolution) return <p className="memory-evolution">变化依据：未知</p>;
  return <div className="memory-evolution" role="group" aria-label="记忆变化依据">
    <p>变化类型：{kindNames[evolution.kind]}</p>
    <p>{evolution.explanation}</p>
    <p>{evolution.sourceSupported ? '仅来源支持，不认证现实' : '变化依据未核实，不认证现实'}</p>
    {evolution.kind === 'unresolved_conflict' && <p>相关来源存在未解决矛盾，当前主张仍有不确定性，不能当作已确认现状。</p>}
    {evolution.kind === 'historical_supplement' && <p>补充的是历史信息，不因消息或导入较晚而覆盖当前状态。</p>}
    {evolution.conditionChanged && <p>{evolution.claimChanged
      ? '条件与原主张分别标记为改变，具体含义须核对各自依据。'
      : '条件发生变化；原主张未标记为改变，不代表撤销原偏好或禁忌。'}</p>}
    {!evolution.conditionChanged && evolution.claimChanged && <p>原主张标记为改变，适用条件未标记为改变。</p>}
    <details>
      <summary>查看关联版本与来源</summary>
      {evolution.relatedVersions.map(ref => <p key={`${ref.memoryId}:${ref.revision}`}>关联记忆：{ref.memoryId}；版本 {ref.revision}</p>)}
      {evolution.evidenceMessageIds.length ? evolution.evidenceMessageIds.map(messageId => <p key={messageId}>来源消息：{messageId}</p>) : <p>变化来源未知。</p>}
    </details>
  </div>;
}
