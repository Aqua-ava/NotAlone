import { useEffect, useState } from 'react';
import type { DesktopSettings, ShortcutChangeError } from '../shared/desktop-bridge';
import './desktop-controls.css';

export function DesktopControls() {
  const { settings, setSettings, error: loadError } = useDesktopSettings();
  const [shortcut, setShortcut] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (settings) setShortcut(settings.helperShortcut); }, [settings?.helperShortcut]);

  async function saveShortcut() {
    if (saving) return;
    setSaving(true);
    try {
      const result = await window.notalone.setHelperShortcut(shortcut);
      setSettings(result.settings);
      if (!result.error) setShortcut(result.settings.helperShortcut);
      setError(result.error ? shortcutErrors[result.error] : '');
    } catch { setError('桌面设置暂时不可用，请重新打开管理后台。'); }
    finally { setSaving(false); }
  }

  return <section className="desktop-controls" aria-label="桌面操作">
    <h2>桌面操作</h2>
    {settings ? <>
      <label htmlFor="helper-shortcut">小窗快捷键</label>
      <div className="shortcut-edit"><input id="helper-shortcut" value={shortcut} maxLength={80}
        onChange={(event) => setShortcut(event.target.value)} disabled={saving} spellCheck={false} />
        <button className="button" disabled={saving} onClick={() => void saveShortcut()}>{saving ? '正在保存…' : '保存快捷键'}</button></div>
      <p>使用 Command、Control 或 Alt 加一个按键，例如 Command+Shift+K。</p>
      <p role="status">{settings.shortcutRegistered ? `已注册 ${settings.helperShortcut}`
        : '快捷键未启用，请在应用配置中换一个组合。'}</p>
    </> : <p role="status">正在读取桌面设置…</p>}
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
  </section>;
}

export function ShortcutWarning() {
  const { settings } = useDesktopSettings();
  return settings?.shortcutRegistered === false
    ? <p className="shortcut-warning" role="note">快捷键未启用，请在应用配置中换一个组合。</p> : null;
}

export function HelperPinControl() {
  const { settings, setSettings } = useDesktopSettings();
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState('');
  async function changePinned() {
    if (!settings || changing) return;
    setChanging(true);
    try {
      setSettings(await window.notalone.setHelperPinned(!settings.helperPinned));
      setError('');
    } catch { setError('置顶设置暂时无法修改，请重新打开小窗。'); }
    finally { setChanging(false); }
  }
  return <>
    <button className="icon-button helper-pin" aria-label="置顶输入小窗" title={settings?.helperPinned ? '取消置顶' : '置顶输入小窗'}
      aria-pressed={settings?.helperPinned ?? false} disabled={!settings || changing} onClick={() => void changePinned()}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <path d="M8 3h8l-1 7 4 4v2H5v-2l4-4-1-7ZM12 16v6" />
      </svg>
    </button>
    {error && <p className="helper-desktop-error" role="alert">{error}</p>}
  </>;
}

function useDesktopSettings() {
  const [settings, setSettings] = useState<DesktopSettings>();
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let revision = 0;
    const unsubscribe = window.notalone.onDesktopSettingsChanged((value) => {
      revision++;
      if (active) { setSettings(value); setError(''); }
    });
    const refresh = () => {
      const current = ++revision;
      void window.notalone.getDesktopSettings().then((value) => {
        if (active && current === revision) { setSettings(value); setError(''); }
      }).catch(() => { if (active && current === revision) setError('桌面设置暂时不可用，请重新打开管理后台。'); });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => { active = false; unsubscribe(); window.removeEventListener('focus', refresh); };
  }, []);
  return { settings, setSettings, error };
}

const shortcutErrors: Record<ShortcutChangeError, string> = {
  invalid: '快捷键格式无效。请使用 Command、Control 或 Alt 加一个按键。',
  unavailable: '该快捷键未能注册，可能已被占用。原快捷键与设置保持不变。',
  'save-failed': '快捷键设置未能保存，原快捷键与设置保持不变。',
};
