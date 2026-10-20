import type { MemoryConditions, MemoryConditionsProposal } from '../shared/memory-bridge';

export function MemoryConditionsDetails({ conditions }: { conditions?: MemoryConditions | null }) {
  if (!conditions) return <p className="memory-conditions">适用条件：未知</p>;
  return <div className="memory-conditions" role="group" aria-label="记忆适用条件">
    {conditions.items.map((item, index) => <div key={index}>
      <p>适用条件：{item.text}</p>
      <p>{item.sourceSupported ? '来源支持限定，当前是否满足未知' : '条件依据未核实，当前是否满足未知'}</p>
      {item.evidence.length ? <p>已关联 {new Set(item.evidence.map(ref => ref.messageId)).size} 条来源消息，可在本条资料的来源中核对原话。</p>
        : <p>条件来源未知。</p>}
    </div>)}
  </div>;
}

export function conditionEditorText(conditions?: MemoryConditions | null): string {
  return conditions?.items.map(item => item.text).join('\n') ?? '';
}
export function conditionEditProposal(text: string, previous?: MemoryConditions | null): MemoryConditionsProposal | null | undefined {
  if (text === conditionEditorText(previous)) return undefined;
  const items = text.split('\n').map(text => text.trim()).filter(Boolean).map(text => ({ text, evidence: [] }));
  return items.length ? { version: 1, items } : null;
}
export function conditionEditorValid(text: string): boolean {
  const items = text.split('\n').map(text => text.trim()).filter(Boolean);
  return items.length <= 8 && items.every(text => text.length <= 1000);
}
export function MemoryConditionsEditor({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled?: boolean }) {
  return <>
    <label>适用条件（每行一项）<textarea aria-label="适用条件" value={value} disabled={disabled}
      onChange={event => onChange(event.target.value)} /></label>
    <p>只填写适用的情形，不代表条件现在成立。改写后依据需重新核实；清空会移除条件。</p>
    {!conditionEditorValid(value) && <p role="alert">最多填写8项条件，每项不超过1000字。</p>}
  </>;
}
