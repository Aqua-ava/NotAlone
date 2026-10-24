import { useState } from 'react';
import { MemoryList } from './MemoryList';
import { memoryTimeText } from './memory-time-format';
import type {
  LayeredMemory,
  LayeredMemoryManagementOptions,
  LayeredMemoryProfile,
  LayeredMemoryReference,
  LayeredMemoryScenario,
  MemoryOverviewState,
} from '../shared/memory-bridge';

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

export type LayeredMemoryAction = 'summary-error' | 'withdraw-scenario' | 'withdraw-profile';

function operationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ReferenceList({ references, trace }: {
  references: LayeredMemoryReference[];
  trace?: (reference: LayeredMemoryReference) => void;
}) {
  return <div className="layered-memory-references">
    {references.map(reference => <div className="layered-memory-reference" key={`${reference.memoryId}:${reference.revision}`}>
      <span>资料 {reference.memoryId.slice(0, 8)} · 版本 {reference.revision}</span>
      {reference.level && trace && <button className="button" onClick={() => trace(reference)}>查看依据</button>}
    </div>)}
  </div>;
}

function ScenarioCard({ scenario, value, busy, manage, trace }: {
  scenario: LayeredMemoryScenario;
  value: LayeredMemory;
  busy: boolean;
  manage?: (action: LayeredMemoryAction, options: LayeredMemoryManagementOptions) => Promise<void>;
  trace?: (reference: LayeredMemoryReference) => void;
}) {
  const [correction, setCorrection] = useState<{ index: number; reason: string; operationId: string; removal: boolean } | null>(null);
  const [removingScenario, setRemovingScenario] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  function beginCorrection(index: number, removal = false) {
    setError('');
    setCorrection({
      index,
      removal,
      reason: removal ? '用户删除该段落；撤回整份派生主题，底层合法资料保持不变。' : '',
      operationId: operationId(),
    });
  }

  async function submitCorrection() {
    if (!manage || !correction || working) return;
    if (!correction.removal && !correction.reason.trim()) return;
    setWorking(true);
    setError('');
    try {
      await manage('summary-error', {
        targetKind: 'scenario',
        versionId: scenario.versionId,
        itemIndex: correction.index,
        reason: correction.reason.trim(),
        operationId: correction.operationId,
      });
      setCorrection(null);
    } catch {
      setError('这次修正尚未确认完成，请重新读取资料后再试。');
    } finally {
      setWorking(false);
    }
  }

  async function withdraw() {
    if (!manage || working) return;
    setWorking(true);
    setError('');
    try {
      await manage('withdraw-scenario', {
        organizationGeneration: value.organizationGeneration,
        scenarioVersionId: scenario.versionId,
      });
      setRemovingScenario(false);
    } catch {
      setError('主题资料撤回尚未确认完成，请重新读取后再试。');
    } finally {
      setWorking(false);
    }
  }

  return <div className="layered-scenario">
    <div className="layered-scenario-heading">
      <div><h3 className="layered-scenario-title">{scenario.title}</h3><p className="memory-section-note">{scenario.hint}</p></div>
      {manage && <button className="button" disabled={busy || working} onClick={() => setRemovingScenario(true)}>撤回主题</button>}
    </div>
    <MemoryList label="主题资料段落" items={scenario.paragraphs}>
      {(paragraph, index) => <article className="memory-card" key={`${scenario.versionId}:${index}`}>
        <p className="memory-text" style={{ whiteSpace: 'pre-wrap' }}>{paragraph.text}</p>
        <details className="memory-details">
          <summary>引用与修正</summary>
          <ReferenceList references={paragraph.references} trace={trace} />
          {manage && <div className="layered-memory-actions">
            <button className="button" disabled={busy || working} onClick={() => beginCorrection(index)}>修正这段</button>
            <button className="button" disabled={busy || working} onClick={() => beginCorrection(index, true)}>删除这段</button>
          </div>}
          {correction?.index === index && <form className="memory-edit-form" aria-label={correction.removal ? '确认删除主题段落' : '修正主题段落'}
            onSubmit={event => { event.preventDefault(); void submitCorrection(); }}>
            {correction.removal ? <p>这段会被撤回；由于主题是整份版本，整份主题也会撤回，底层合法资料保持不变。</p>
              : <label>哪里不正确或需要调整？<textarea aria-label="主题段落修正说明" value={correction.reason} disabled={busy || working}
                onChange={event => setCorrection({ ...correction, reason: event.target.value })} /></label>}
            <button className="button" type="submit" disabled={busy || working || !correction.reason.trim()}>
              {working ? '正在提交…' : correction.removal ? '确认删除这段' : '提交修正'}
            </button>
            <button className="button" type="button" disabled={busy || working} onClick={() => setCorrection(null)}>取消</button>
          </form>}
        </details>
      </article>}
    </MemoryList>
    {removingScenario && manage && <div className="memory-edit-form" role="group" aria-label="确认撤回主题资料">
      <p>确认撤回“{scenario.title}”？这一版不会自动恢复，底层合法记忆保持不变。</p>
      <button className="button" disabled={busy || working} onClick={() => void withdraw()}>{working ? '正在撤回…' : '确认撤回主题'}</button>
      <button className="button" disabled={busy || working} onClick={() => setRemovingScenario(false)}>取消</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

function ProfileCard({ profile, value, busy, manage, trace }: {
  profile: LayeredMemoryProfile;
  value: LayeredMemory;
  busy: boolean;
  manage?: (action: LayeredMemoryAction, options: LayeredMemoryManagementOptions) => Promise<void>;
  trace?: (reference: LayeredMemoryReference) => void;
}) {
  const [correction, setCorrection] = useState<{ index: number; reason: string; operationId: string; removal: boolean } | null>(null);
  const [removingProfile, setRemovingProfile] = useState(false);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);

  function beginCorrection(index: number, removal = false) {
    setError('');
    setCorrection({
      index,
      removal,
      reason: removal ? '用户删除该长期背景条目；撤回整份派生画像，底层合法资料保持不变。' : '',
      operationId: operationId(),
    });
  }

  async function submitCorrection() {
    if (!manage || !correction || working) return;
    if (!correction.removal && !correction.reason.trim()) return;
    setWorking(true);
    setError('');
    try {
      await manage('summary-error', {
        targetKind: 'profile',
        versionId: profile.versionId,
        itemIndex: correction.index,
        reason: correction.reason.trim(),
        operationId: correction.operationId,
      });
      setCorrection(null);
    } catch {
      setError('这次长期背景修正尚未确认完成，请重新读取资料后再试。');
    } finally {
      setWorking(false);
    }
  }

  async function withdraw() {
    if (!manage || working) return;
    setWorking(true);
    setError('');
    try {
      await manage('withdraw-profile', {
        organizationGeneration: value.organizationGeneration,
        profileVersionId: profile.versionId,
      });
      setRemovingProfile(false);
    } catch {
      setError('长期背景撤回尚未确认完成，请重新读取后再试。');
    } finally {
      setWorking(false);
    }
  }

  return <div className="layered-profile">
    <div className="layered-scenario-heading">
      <div><h3 className="layered-scenario-title">系统整理画像</h3><p className="memory-section-note">逐条核对来源；任一修正会撤回整份派生画像。</p></div>
      {manage && <button className="button" disabled={busy || working} onClick={() => setRemovingProfile(true)}>撤回长期背景</button>}
    </div>
    <MemoryList label="长期背景" items={profile.entries}>
      {(entry, index) => <article className="memory-card" key={`${profile.versionId}:${index}`}>
        <p className="memory-text">{entry.text}</p>
        <p className="memory-section-note">{temporalStatusNames[entry.temporalStatus]}{entry.uncertainty ? ` · ${entry.uncertainty}` : ''}</p>
        <details className="memory-details">
          <summary>引用与修正</summary>
          <ReferenceList references={entry.references} trace={trace} />
          {manage && <div className="layered-memory-actions">
            <button className="button" disabled={busy || working} onClick={() => beginCorrection(index)}>修正这条背景</button>
            <button className="button" disabled={busy || working} onClick={() => beginCorrection(index, true)}>删除这条背景</button>
          </div>}
          {correction?.index === index && <form className="memory-edit-form" aria-label={correction.removal ? '确认删除长期背景条目' : '修正长期背景'}
            onSubmit={event => { event.preventDefault(); void submitCorrection(); }}>
            {correction.removal ? <p>这条背景会被撤回；由于画像按整份版本发布，整份长期背景也会撤回，底层合法资料保持不变。</p>
              : <label>哪里不正确或需要调整？<textarea aria-label="长期背景修正说明" value={correction.reason} disabled={busy || working}
                onChange={event => setCorrection({ ...correction, reason: event.target.value })} /></label>}
            <button className="button" type="submit" disabled={busy || working || !correction.reason.trim()}>
              {working ? '正在提交…' : correction.removal ? '确认删除这条背景' : '提交修正'}
            </button>
            <button className="button" type="button" disabled={busy || working} onClick={() => setCorrection(null)}>取消</button>
          </form>}
        </details>
      </article>}
    </MemoryList>
    {removingProfile && manage && <div className="memory-edit-form" role="group" aria-label="确认撤回长期背景">
      <p>确认撤回整份长期背景？这一版不会自动恢复，底层合法记忆保持不变。</p>
      <button className="button" disabled={busy || working} onClick={() => void withdraw()}>{working ? '正在撤回…' : '确认撤回长期背景'}</button>
      <button className="button" disabled={busy || working} onClick={() => setRemovingProfile(false)}>取消</button>
    </div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function LayeredMemorySections({ state, manage, trace, busy = false }: {
  state: MemoryOverviewState<LayeredMemory>;
  manage?: (action: LayeredMemoryAction, options: LayeredMemoryManagementOptions) => Promise<void>;
  trace?: (reference: LayeredMemoryReference) => void;
  busy?: boolean;
}) {
  const value = state.value;
  // 未读到结果或该联系人还没有任何整理内容时不额外占位，避免与记忆列表混在一起。
  if (state.phase !== 'ready' || !value || (value.scenarios.length === 0 && value.profile === null)) return null;
  const note = organizationNote(value);
  return <>
    <section className="memory-section" aria-label="主题资料">
      <header><div><h2>主题资料</h2><p>{note}</p></div></header>
      {value.scenarios.length === 0 ? <p className="memory-section-note">还没有整理好的主题资料。</p>
        : value.scenarios.map(scenario => <ScenarioCard key={scenario.versionId} scenario={scenario} value={value}
          busy={busy} manage={manage} trace={trace} />)}
    </section>
    <section className="memory-section" aria-label="长期背景">
      <header><div><h2>长期背景</h2><p>{value.profile ? timeNote(value.profile.updatedAt) : ''}</p></div></header>
      {value.profile === null ? <p className="memory-section-note">还没有整理好的长期背景。</p>
        : <ProfileCard profile={value.profile} value={value} busy={busy} manage={manage} trace={trace} />}
    </section>
  </>;
}
