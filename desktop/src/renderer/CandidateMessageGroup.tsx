import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';

interface MessageView { messageId: string; text: string; }

export function CandidateMessageGroup({ identity, number, messages, controls, disabled, dirty, restored,
  edit, save, copy, noteTextCopy, validatePaste }: {
  identity: string;
  number: number;
  messages: readonly MessageView[];
  controls: ReactNode;
  disabled: boolean;
  dirty: boolean;
  restored: boolean;
  edit: (messageId: string, text: string) => void;
  save: () => Promise<void>;
  copy: (messageId: string) => Promise<void>;
  noteTextCopy: (text: string) => void;
  validatePaste: (text: string) => Promise<void>;
}) {
  const signature = JSON.stringify([identity, messages]);
  const latest = useRef(signature);
  latest.current = signature;
  const active = useRef(true);
  const [copying, setCopying] = useState(false);
  const [saving, setSaving] = useState(false);
  const pendingSave = useRef(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [pasting, setPasting] = useState(false);
  const pendingPaste = useRef(false);
  const saveAfterPaste = useRef(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setNotice(''); setError(''); }, [signature]);
  useEffect(() => {
    if (!pasting && saveAfterPaste.current) { saveAfterPaste.current = false; void saveGroup(); }
  }, [pasting, signature]);
  async function copyMessage(messageId: string, index: number) {
    if (disabled || dirty || copying || saving) return;
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
    if (disabled || !dirty || pendingSave.current || copying || pendingPaste.current || messages.some((message) => !message.text.trim())) return;
    const operation = signature;
    pendingSave.current = true; setSaving(true); setSaveFailed(false); setNotice(''); setError('');
    try { await save(); }
    catch { if (active.current && latest.current === operation) { setSaveFailed(true); setError('修改尚未保存，编辑文字仍保留，请重试。'); } }
    finally { pendingSave.current = false; if (active.current) setSaving(false); }
  }
  async function paste(event: ClipboardEvent<HTMLTextAreaElement>, apply: (text: string) => void) {
    event.preventDefault();
    if (disabled || saving || copying || pendingPaste.current) return;
    const input = event.currentTarget;
    const text = event.clipboardData.getData('text/plain');
    const start = input.selectionStart, end = input.selectionEnd;
    const inserted = text.slice(0, Math.max(0, input.maxLength - input.value.length + end - start));
    const next = input.value.slice(0, start) + inserted + input.value.slice(end);
    const operation = signature;
    pendingPaste.current = true; setPasting(true); setNotice(''); setError('');
    try {
      await validatePaste(text);
      if (active.current && latest.current === operation) apply(next);
    } catch {
      if (active.current && latest.current === operation) setError('这段粘贴文字的来源尚未确认，原编辑文字仍保留。请在原来源入口保存。');
    } finally { pendingPaste.current = false; if (active.current) setPasting(false); }
  }
  return <fieldset className="candidate-message-group" aria-label={`说法${number}消息组`} disabled={disabled || saving || pasting || copying}>
    <legend>{messages.length > 1 ? `这组共${messages.length}条，按顺序表达` : '这组有1条消息'}</legend>
    {controls}
    {messages.map((message, index) => <div className="candidate-message" key={message.messageId}>
      <label>第{index + 1}条<textarea
        aria-label={messages.length === 1 && !restored ? `候选${number}编辑文本` : `说法${number}第${index + 1}条编辑文本`}
        value={message.text} maxLength={messages.length > 1 ? 8192 : 65_536}
        onChange={(event) => edit(message.messageId, event.target.value)}
        onBlur={() => { if (pendingPaste.current) saveAfterPaste.current = true; else void saveGroup(); }}
        onPaste={(event) => void paste(event, (text) => edit(message.messageId, text))}
        onCopy={(event) => { const input = event.currentTarget; noteTextCopy(input.value.slice(input.selectionStart, input.selectionEnd)); }}
        onCut={(event) => { const input = event.currentTarget; noteTextCopy(input.value.slice(input.selectionStart, input.selectionEnd)); }}
      /></label>
      <button disabled={copying || dirty || !message.text.trim()} onClick={() => void copyMessage(message.messageId, index)}>复制第{index + 1}条</button>
    </div>)}
    {saveFailed && dirty && <button onClick={() => void saveGroup()}>重试保存修改</button>}
    {saving && <p role="status">正在自动保存修改…</p>}
    {!saving && dirty && <p>结束编辑后自动保存，保存完成即可复制。</p>}
    {copying && <p role="status">正在复制…</p>}
    {pasting && <p role="status">正在核对粘贴来源…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}
