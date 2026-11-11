import { useEffect, useRef, useState } from 'react';
import type { ContactSummary } from '../shared/contact-session-bridge';
import type { SkillGroupItem, SkillGroupsSnapshot, SkillLibraryBridge, SkillLibraryItem } from '../shared/skill-library-bridge';

const UNGROUPED = '';

/**
 * 联系人分组：为不同联系人选用不同的回复场景。
 * 联系人至多属于一个分组，没有分组的联系人不使用任何回复场景；分组只决定可选范围，全局停用的场景仍不会生效。
 */
export function SkillGroupsPanel({ bridge, skills, contacts, visible = true, onUnavailable }: {
  bridge: SkillLibraryBridge;
  skills: SkillLibraryItem[];
  contacts: ContactSummary[];
  visible?: boolean;
  onUnavailable?: () => void;
}) {
  const [view, setView] = useState<SkillGroupsSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const active = useRef(true);
  const pending = useRef(false);

  useEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (visible && !view && !pending.current) void perform(() => bridge.readGroups());
  }, [visible]);

  async function perform(operation: () => Promise<SkillGroupsSnapshot>): Promise<boolean> {
    if (pending.current) return false;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await operation();
      if (!active.current) return false;
      setView(next);
      return true;
    } catch (reason) {
      if (!active.current) return false;
      setError(reason instanceof Error ? reason.message : '分组状态暂不可用，请刷新后再操作。');
      if (!view) onUnavailable?.();
      return false;
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  const generation = view?.connectionGeneration ?? 0;
  const groupOf = new Map<string, SkillGroupItem>();
  for (const group of view?.groups ?? []) for (const contactId of group.contactIds) groupOf.set(contactId, group);
  const unavailable = busy || !view;

  async function create() {
    const name = newName.trim();
    if (!name || !view) return;
    if (await perform(() => bridge.createGroup({ name, packageIds: [], connectionGeneration: generation, confirmed: true }))) setNewName('');
  }

  return <section className="skill-groups" aria-label="联系人分组">
    <div className="sqlite-skill-heading">
      <div>
        <h2>联系人分组</h2>
        <p>为不同的人选用不同的回复场景，例如恋人、同事。没有分组的联系人不使用任何回复场景。</p>
      </div>
      <button className="button" disabled={busy} onClick={() => void perform(() => bridge.readGroups())}>
        {busy ? '正在核对…' : '刷新分组'}
      </button>
    </div>
    {error && <p role="alert">{error}</p>}
    {!view && !error && <p role="status">正在读取分组…</p>}
    {view && <>
      <form className="skill-groups-create" aria-label="新建分组" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label>
          <span>分组名称</span>
          <input value={newName} maxLength={30} placeholder="例如：恋人" onChange={(event) => setNewName(event.target.value)} />
        </label>
        <button className="button" type="submit" disabled={unavailable || !newName.trim()}>新建分组</button>
      </form>
      {!view.groups.length && <p role="status">还没有分组。新建分组后，选择它可用的回复场景，再把联系人放进去。</p>}
      <div className="sqlite-skill-list">
        {view.groups.map((group) => <GroupCard key={`${group.groupId}:${group.revision}`}
          group={group} skills={skills} busy={unavailable} confirmingDelete={confirmingDelete === group.groupId}
          onRequestDelete={(on) => setConfirmingDelete(on ? group.groupId : null)}
          onSave={(name, packageIds) => perform(() => bridge.updateGroup({ groupId: group.groupId, expectedRevision: group.revision, name, packageIds, connectionGeneration: generation, confirmed: true }))}
          onDelete={async () => { if (await perform(() => bridge.deleteGroup({ groupId: group.groupId, expectedRevision: group.revision, connectionGeneration: generation, confirmed: true }))) setConfirmingDelete(null); }} />)}
      </div>
      <h3 className="skill-groups-contacts-title">联系人</h3>
      {!contacts.length && <p role="status">暂无联系人。</p>}
      <ul className="skill-groups-contacts" aria-label="联系人所属分组">
        {contacts.map((contact) => {
          const current = groupOf.get(contact.contactId);
          return <li key={contact.contactId}>
            <label>
              <span>{contact.displayName || '未命名联系人'}</span>
              <select value={current?.groupId ?? UNGROUPED} disabled={unavailable}
                aria-label={`「${contact.displayName || '未命名联系人'}」所属分组`}
                onChange={(event) => void perform(() => bridge.assignContactGroup({ contactId: contact.contactId, groupId: event.target.value || null,
                  expectedGroupId: current?.groupId ?? null, connectionGeneration: generation, confirmed: true }))}>
                <option value={UNGROUPED}>未分组（不使用回复场景）</option>
                {view.groups.map((group) => <option key={group.groupId} value={group.groupId}>{group.name}</option>)}
              </select>
            </label>
          </li>;
        })}
      </ul>
    </>}
  </section>;
}

function GroupCard({ group, skills, busy, confirmingDelete, onRequestDelete, onSave, onDelete }: {
  group: SkillGroupItem;
  skills: SkillLibraryItem[];
  busy: boolean;
  confirmingDelete: boolean;
  onRequestDelete: (on: boolean) => void;
  onSave: (name: string, packageIds: string[]) => Promise<boolean>;
  onDelete: () => Promise<void>;
}) {
  const [name, setName] = useState(group.name);
  const [selected, setSelected] = useState(() => new Set(group.packageIds));
  const dirty = name.trim() !== group.name || selected.size !== group.packageIds.length || group.packageIds.some((id) => !selected.has(id));
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <article className="sqlite-skill-card skill-group-card" aria-label={`分组：${group.name}`}>
    <div className="sqlite-skill-card-main">
      <div className="sqlite-skill-title-row">
        <h3>{group.name}</h3>
        <span className="sqlite-skill-enabled-label">{group.contactIds.length ? `${group.contactIds.length} 位联系人` : '暂无联系人'}</span>
      </div>
      <label className="skill-group-name">
        <span>分组名称</span>
        <input value={name} maxLength={30} onChange={(event) => setName(event.target.value)} />
      </label>
      <fieldset className="skill-group-scenes">
        <legend>可用的回复场景{selected.size ? `（已选 ${selected.size}）` : '（未选择，此分组不使用回复场景）'}</legend>
        {!skills.length && <p role="status">暂无回复场景。</p>}
        {skills.map((skill) => <label key={skill.packageId}>
          <input type="checkbox" checked={selected.has(skill.packageId)} disabled={busy} onChange={() => toggle(skill.packageId)} />
          <span>{skill.title}{skill.enabledState !== 'enabled' || skill.verificationState !== 'verified' ? '（当前未开启，不会生效）' : ''}</span>
        </label>)}
      </fieldset>
      <div className="skill-group-actions">
        <button className="button" disabled={busy || !dirty || !name.trim()} onClick={() => void onSave(name.trim(), Array.from(selected))}>
          保存分组
        </button>
        {!confirmingDelete && <button className="button" disabled={busy} onClick={() => onRequestDelete(true)}>删除分组</button>}
        {confirmingDelete && <>
          <span role="status">删除后，该分组的联系人将回到“未分组”，不再使用回复场景。</span>
          <button className="button" disabled={busy} onClick={() => void onDelete()}>确认删除</button>
          <button className="button" disabled={busy} onClick={() => onRequestDelete(false)}>取消</button>
        </>}
      </div>
    </div>
  </article>;
}
