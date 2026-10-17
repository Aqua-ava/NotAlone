import type { SkillHistoryState } from '../shared/skill-learning-bridge';

export function SkillHistoryPanel({ state, rollback, retry, close }: {
  state: SkillHistoryState; rollback(skillId: string, versionId: string): void; retry(): void; close(): void;
}) {
  return <section aria-label="Skill版本历史"><h2>已发布方法与历史版本</h2>
    <p>回滚只切换仍有合法来源的版本，保留 Skill 当前的启用或停用状态；范围和来源删除继续有效。</p>
    <button className="button" onClick={close}>返回草稿</button>
    {state.skills.map(skill => <article className="memory-card" key={skill.skill_id} aria-label={`版本历史 ${skill.name}`}>
      <h3>{skill.name} · {skill.status === 'active' ? '已启用' : '已停用'}</h3>
      {skill.versions.map(version => <section key={version.version_id} aria-label={`版本 ${version.version_number}`}>
        <h4>版本 {version.version_number}{version.is_current ? ' · 当前版本' : ''}</h4>
        <p>范围：{version.scope.kind === 'contact' ? '当前联系人' : version.scope.kind === 'owner' ? '本人通用方法' : `精确场景「${version.scope.scene}」`}</p>
        <p>已核验来源依赖 {version.source_dependency_count} 项</p>
        <details><summary>查看版本 {version.version_number} 的正文与映射</summary><pre>{version.document}</pre>
          {version.methods.map(method => <div key={method.method_id}><b>{method.title}</b><p>{method.instruction}</p>
            <p>方法身份：{method.method_id}</p><p>延续映射：{method.replaces_method_ids.join('、') || '新建方法'}</p></div>)}</details>
        {!version.is_current && <button className="button" disabled={state.phase !== 'ready' || !version.enabled}
          onClick={() => rollback(skill.skill_id, version.version_id)}>回滚到版本 {version.version_number}</button>}
      </section>)}
    </article>)}
    {state.phase === 'loading' && <p role="status">正在核验版本来源…</p>}
    {state.phase === 'writing' && <p role="status">正在核验并回滚…</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.retry && <button className="button" onClick={retry}>重试原回滚</button>}
    {state.phase === 'ready' && !state.skills.length && <p>当前没有可查看的有效发布版本。</p>}
  </section>;
}
