import { MemoryList } from './MemoryList';
import { memoryTimeText } from './memory-time-format';
import type { LayeredMemory, MemoryOverviewState } from '../shared/memory-bridge';

const statusNotes: Partial<Record<LayeredMemory['status'], string>> = {
  disabled: '整理已停用，下方为现有结果。',
  stale: '依据已变化，下方结果待刷新。',
  updating: '正在整理，下方为上次结果。',
  failed: '上次整理未完成，下方为已有结果。',
  paused: '整理已暂停，下方为已有结果。',
  blocked: '整理质量资格未核验，下方结果仅供核对。',
};
const temporalStatusNames = { stable: '稳定背景', historical: '历史背景', uncertain: '尚不确定' } as const;

function organizationNote(value: LayeredMemory): string {
  const warnings = [statusNotes[value.status], value.maintenancePending ? '资料已变化，等待后台更新。' : ''].filter(Boolean);
  if (warnings.length) return warnings.join('');
  return timeNote(value.updatedAt);
}

function timeNote(updatedAt: string | null): string {
  return updatedAt ? `系统整理 · 更新于 ${memoryTimeText(updatedAt)}` : '系统整理';
}

// L2 主题资料与 L3 长期背景沿用当前记忆列表的只读行式展示；管理、纠错与删除仍从底层记忆处理。
export function LayeredMemorySections({ state }: { state: MemoryOverviewState<LayeredMemory> }) {
  const value = state.value;
  // 未读到结果或该联系人还没有任何整理内容时不额外占位，避免与记忆列表混在一起。
  if (state.phase !== 'ready' || !value || (value.scenarios.length === 0 && value.profile === null)) return null;
  const note = organizationNote(value);
  return <>
    <section className="memory-section" aria-label="主题资料">
      <header><div><h2>主题资料</h2><p>{note}</p></div></header>
      {value.scenarios.length === 0 ? <p className="memory-section-note">还没有整理好的主题资料。</p>
        : value.scenarios.map((scenario) => <div className="layered-scenario" key={scenario.versionId}>
          <h3 className="layered-scenario-title">{scenario.title}</h3>
          <p className="memory-section-note">{scenario.hint}</p>
          <MemoryList label="主题资料段落" items={scenario.paragraphs}>
            {(paragraph, index) => <article className="memory-card" key={index}>
              <p className="memory-text">{paragraph.text}</p>
            </article>}
          </MemoryList>
        </div>)}
    </section>
    <section className="memory-section" aria-label="长期背景">
      <header><div><h2>长期背景</h2><p>{value.profile ? timeNote(value.profile.updatedAt) : ''}</p></div></header>
      {value.profile === null ? <p className="memory-section-note">还没有整理好的长期背景。</p>
        : <MemoryList label="长期背景" items={value.profile.entries}>
          {(entry, index) => <article className="memory-card" key={index}>
            <p className="memory-text">{entry.text}</p>
            <p className="memory-section-note">{temporalStatusNames[entry.temporalStatus]}{entry.uncertainty ? ` · ${entry.uncertainty}` : ''}</p>
          </article>}
        </MemoryList>}
    </section>
  </>;
}
