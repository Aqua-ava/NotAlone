import { useState } from 'react';
import type { SkillPolicySelection, SkillPolicyState, SkillPublicationScope, SkillVersionHistory } from '../shared/skill-learning-bridge';

export function SkillPolicyPanel({ state, skills, contactId, change, undo, retry, close }: {
  state: SkillPolicyState; skills: SkillVersionHistory[]; contactId: string;
  change(target: Pick<SkillPolicySelection, 'skillId' | 'versionId' | 'methodId' | 'policyScope'>): void;
  undo(policyId: string): void; retry(): void; close(): void;
}) {
  const [target, setTarget] = useState('');
  const [scope, setScope] = useState('');
  const [scene, setScene] = useState('');
  const options = skills.flatMap(skill => skill.versions.filter(version => version.is_current).flatMap(version => [
    { value: `${skill.skill_id}/${version.version_id}/whole`, label: `${skill.name} · 整个Skill`, skillId: skill.skill_id, versionId: version.version_id, methodId: null },
    ...version.methods.map(method => ({ value: `${skill.skill_id}/${version.version_id}/${method.method_id}`,
      label: `${skill.name} · 方法「${method.title}」`, skillId: skill.skill_id, versionId: version.version_id, methodId: method.method_id })),
  ]));
  const chosen = options.find(item => item.value === target);
  const needsScene = scope.endsWith('_scene');
  const policyScope: SkillPublicationScope = { kind: needsScene ? 'scene' : scope === 'owner' ? 'owner' : 'contact',
    contact_id: scope.startsWith('contact') ? contactId : null, scene: needsScene ? scene : null };
  return <section aria-label="方法与Skill反馈"><h2>方法与Skill的明确停用</h2>
    <p>“这句太生硬”先在当前回复中修改。长期修改可由已授权的经验整理形成待审核草稿，不会直接改写已发布方法。</p>
    <p>明确停用立即按所选范围生效。无法可靠排除某条方法时，该范围使用通用回复；更新、合并与回滚继续遵守停用。</p>
    <label>明确停用目标<select aria-label="明确停用目标" value={target} onChange={event => setTarget(event.target.value)}>
      <option value="">请选择具体方法或整个Skill</option>{options.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
    <label>停用范围<select aria-label="停用范围" value={scope} onChange={event => setScope(event.target.value)}>
      <option value="">请选择停用范围</option>
      <option value="contact">当前联系人 · 所有场景</option><option value="contact_scene">当前联系人 · 精确场景</option>
      <option value="owner">本人所有联系人</option><option value="owner_scene">所有联系人 · 精确场景</option>
    </select></label>
    {needsScene && <label>反馈精确场景<input aria-label="反馈精确场景" value={scene} maxLength={256} onChange={event => setScene(event.target.value)} /></label>}
    <button className="button" disabled={state.phase !== 'ready' || !chosen || !scope || needsScene && (!scene.trim() || scene !== scene.trim())}
      onClick={() => { if (chosen && scope) change({ skillId: chosen.skillId, versionId: chosen.versionId, methodId: chosen.methodId, policyScope }); }}>按此范围停用</button>
    <button className="button" onClick={close}>关闭方法反馈</button>
    {state.policies.map(policy => <article key={policy.policy_id} aria-label={`已停用 ${policy.name}`}>
      <h3>{policy.name} · {policy.method_id ? '方法已停用' : '整个Skill已停用'}</h3>
      <p>{policy.scope.contact_id ? '当前联系人' : '本人所有联系人'}{policy.scope.scene ? ` · 精确场景「${policy.scope.scene}」` : ' · 所有场景'}</p>
      {policy.method_id && <p>{skills.flatMap(skill => skill.versions.flatMap(version => version.methods)).find(method => method.method_id === policy.method_id)?.title ?? '历史方法'}</p>}
      <button className="button" disabled={state.phase !== 'ready'} onClick={() => undo(policy.policy_id)}>撤销此停用</button>
    </article>)}
    {state.phase === 'ready' && !state.policies.length && <p>当前没有明确停用的范围决定。</p>}
    {state.phase === 'loading' && <p role="status">正在核验停用范围…</p>}
    {state.phase === 'writing' && <p role="status">正在保存范围决定…</p>}
    {state.error && <p role="alert">{state.error}</p>}
    {state.retry && <button className="button" onClick={retry}>重试原反馈动作</button>}
  </section>;
}
