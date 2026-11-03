import { useEffect, useMemo, useRef, useState } from 'react';
import type { SkillLibraryBridge, SkillLibraryItem, SkillLibrarySnapshot, SqliteSkillLibrarySnapshot } from '../shared/skill-library-bridge';

const verificationLabels = { pending: '场景文件待核验', missing: '场景文件缺失，请恢复后刷新', conflict: '无法确认场景文件，请检查后刷新', invalid: '场景文件校验未通过，请检查后刷新' };

export function SqliteSkillLibraryPage({ initial, bridge, onModeChange, onUnavailable }: {
  initial: SqliteSkillLibrarySnapshot;
  bridge: SkillLibraryBridge;
  onModeChange: (value: SkillLibrarySnapshot) => void;
  onUnavailable: () => void;
}) {
  const [view, setView] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [stale, setStale] = useState(false);
  const [selectedTag, setSelectedTag] = useState('全部');
  const active = useRef(true);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  async function perform(operation: () => Promise<SkillLibrarySnapshot>) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const next = await operation();
      if (!active.current) return;
      if (next.mode !== 'sqlite') { onModeChange(next); return; }
      setView(next);
      setStale(false);
      if (selectedTag !== '全部' && !next.skills.some((item) => item.tags.includes(selectedTag))) setSelectedTag('全部');
    } catch (reason) {
      if (!active.current) return;
      setStale(true);
      setError(reason instanceof Error ? reason.message : 'Skill 状态暂不可用，请刷新后再操作。');
      onUnavailable();
    } finally {
      if (active.current) setBusy(false);
    }
  }

  const command = (item: SkillLibraryItem) => ({
    packageId: item.packageId,
    expectedHeadRevision: item.headRevision,
    connectionGeneration: view.connectionGeneration,
    confirmed: true as const,
  });
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of view.skills) for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return ['全部', ...Array.from(counts.keys()).sort((a, b) => a.localeCompare(b, 'zh-CN'))];
  }, [view.skills]);
  const visibleSkills = selectedTag === '全部' ? view.skills : view.skills.filter((item) => item.tags.includes(selectedTag));

  return <section className="sqlite-skill-library" aria-label="Skill 管理">
    <div className="sqlite-skill-heading">
      <div>
        <h2>回复场景</h2>
        <p>按场景查看回复方法。已启用的场景会在回复时按需加载。</p>
      </div>
      <button className="button" disabled={busy} onClick={() => void perform(() => bridge.readLibrary())}>
        {busy ? '正在核对…' : '刷新状态'}
      </button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!view.skills.length && <p role="status">暂无回复场景。</p>}
    {!!view.skills.length && <>
      <nav className="sqlite-skill-filters" aria-label="按场景筛选">
        {tags.map((tag) => {
          const count = tag === '全部' ? view.skills.length : view.skills.filter((item) => item.tags.includes(tag)).length;
          return <button key={tag} type="button" aria-pressed={selectedTag === tag} onClick={() => setSelectedTag(tag)}>
            {tag}<span>{count}</span>
          </button>;
        })}
      </nav>
      <div className="sqlite-skill-list" aria-live="polite">
        {visibleSkills.map((item) => {
          const enabled = item.enabledState === 'enabled';
          const enabling = !enabled;
          return <article className="sqlite-skill-card" key={item.packageId} aria-label={`回复场景：${item.title}`}>
            <div className="sqlite-skill-card-main">
              <div className="sqlite-skill-title-row">
                <h3>{item.title}</h3>
                <span className={`sqlite-skill-enabled-label${enabled && item.verificationState === 'verified' ? ' is-enabled' : ''}`}>
                  {enabled ? item.verificationState === 'verified' ? '已开启' : '暂不可用' : item.enabledState === 'unknown' ? '待核验' : '已关闭'}
                </span>
              </div>
              <p>{item.description}</p>
              <div className="sqlite-skill-card-meta">
                <div className="sqlite-skill-tags" aria-label="场景标签">
                  {item.tags.map((tag) => <span key={tag}>{tag}</span>)}
                </div>
                {item.verificationState !== 'verified' && <span className="sqlite-skill-verification" role="status">
                  {item.verificationReason === 'directory_content_changed' ? '场景文件与上次核验不一致，请恢复后刷新' : verificationLabels[item.verificationState]}
                </span>}
              </div>
              {item.verificationReason === 'source_qualification_changed' && <p className="sqlite-skill-note">来源资格待核验，不能仅凭相同文件恢复使用。</p>}
            </div>
            <button
              className={`sqlite-skill-switch${enabled ? ' is-on' : ''}`}
              type="button"
              role="switch"
              aria-checked={enabled}
              aria-label={`${enabling ? '启用' : '停用'}「${item.title}」`}
              disabled={busy || stale}
              onClick={() => void perform(() => bridge.changeLibraryEnabled({ ...command(item), enabled: enabling }))}
            >
              <span className="sqlite-skill-switch-thumb" aria-hidden="true" />
            </button>
          </article>;
        })}
      </div>
      {!visibleSkills.length && <p role="status">这个标签下暂时没有回复场景。</p>}
    </>}
  </section>;
}
