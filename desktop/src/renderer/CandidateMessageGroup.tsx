import { useEffect, useRef, useState, type ReactNode } from 'react';

interface MessageView { messageId: string; text: string; }

export function CandidateMessageGroup({ identity, number, messages, requirements, controls, disabled, dirty, canCopy, restored,
  edit, editRequirements, save, copy, noteTextCopy }: {
  identity: string;
  number: number;
  messages: readonly MessageView[];
  requirements: string;
  controls: ReactNode;
  disabled: boolean;
  dirty: boolean;
  canCopy: boolean;
  restored: boolean;
  edit: (messageId: string, text: string) => void;
  editRequirements: (text: string) => void;
  save: () => Promise<void>;
  copy: (messageId: string) => Promise<void>;
  noteTextCopy: (text: string) => void;
}) {
  const signature = JSON.stringify([identity, messages, requirements]);
  const latest = useRef(signature);
  latest.current = signature;
  const active = useRef(true);
  const [copying, setCopying] = useState(false);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setNotice(''); setError(''); }, [signature]);
  async function copyMessage(messageId: string, index: number) {
    if (disabled || dirty || !canCopy || copying || saving) return;
    const operation = signature;
    setCopying(true); setNotice(''); setError('');
    try {
      await copy(messageId);
      if (active.current && latest.current === operation) setNotice(`已复制第${index + 1}条，请自行粘贴并发送。`);
    } catch {
      if (active.current && latest.current === operation) setError('复制未确认，编辑文字仍保留，请重试。');
    } finally { if (active.current) setCopying(false); }
  }
  async function saveGroup() {
    if (disabled || !dirty || saving || copying) return;
    const operation = signature;
    setSaving(true); setNotice(''); setError('');
    try { await save(); }
    catch { if (active.current && latest.current === operation) setError('修改尚未保存，编辑文字仍保留，请重试。'); }
    finally { if (active.current) setSaving(false); }
  }
  return <fieldset className="candidate-message-group" aria-label={`说法${number}消息组`} disabled={disabled || saving}>
    <legend>{messages.length > 1 ? `这组共${messages.length}条，按顺序表达` : '这组有1条消息'}</legend>
    {controls}
    {messages.map((message, index) => <div className="candidate-message" key={message.messageId}>
      <label>第{index + 1}条<textarea
        aria-label={messages.length === 1 && !restored ? `候选${number}编辑文本` : `说法${number}第${index + 1}条编辑文本`}
        value={message.text} maxLength={messages.length > 1 ? 8192 : 65_536}
        onChange={(event) => edit(message.messageId, event.target.value)}
        onCopy={(event) => { const input = event.currentTarget; noteTextCopy(input.value.slice(input.selectionStart, input.selectionEnd)); }}
        onCut={(event) => { const input = event.currentTarget; noteTextCopy(input.value.slice(input.selectionStart, input.selectionEnd)); }}
      /></label>
      <button disabled={copying || dirty || !canCopy || !message.text.trim()} onClick={() => void copyMessage(message.messageId, index)}>复制第{index + 1}条</button>
    </div>)}
    <label>本组修改要求<textarea aria-label={`说法${number}修改要求`} maxLength={4096} value={requirements}
      placeholder="可选，只作用于本组当前修改"
      onChange={(event) => editRequirements(event.target.value)} /></label>
    <button disabled={!dirty || copying || messages.some((message) => !message.text.trim())} onClick={() => void saveGroup()}>保存本组修改</button>
    {saving && <p role="status">正在保存本组修改…</p>}
    {!saving && dirty && <p>保存修改后，再选择当前版本并逐条复制。</p>}
    {!dirty && !canCopy && <p>选择当前版本后可逐条复制。</p>}
    {copying && <p role="status">正在复制…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
