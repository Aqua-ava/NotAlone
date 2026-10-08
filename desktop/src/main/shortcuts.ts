import { globalShortcut } from 'electron';
import type { ShortcutSettings, ShortcutChangeError } from '../shared/desktop-bridge';
import { DesktopSettingsFile } from './desktop-settings';

const DEFAULT_HELPER_SHORTCUT = 'Command+Shift+Space';
type ShortcutResult = { settings: ShortcutSettings; error: ShortcutChangeError | null };

export class HelperShortcut {
  private accelerator: string;
  private registered = false;

  constructor(private readonly file: DesktopSettingsFile,
    private readonly activate: () => Promise<void>, private readonly failed: () => void) {
    this.accelerator = normalizeShortcut(file.readShortcut()) ?? DEFAULT_HELPER_SHORTCUT;
    this.registered = this.register(this.accelerator);
  }

  getSettings(): ShortcutSettings {
    return {
      helperShortcut: this.accelerator,
      shortcutRegistered: this.registered && globalShortcut.isRegistered(this.accelerator),
    };
  }

  change(value: string): ShortcutResult {
    const next = normalizeShortcut(value);
    if (!next) return this.result('invalid');
    const unchanged = next === this.accelerator && this.getSettings().shortcutRegistered;
    if (!unchanged && !this.register(next)) return this.result('unavailable');
    try { this.file.saveShortcut(next); }
    catch {
      if (!unchanged) globalShortcut.unregister(next);
      return this.result('save-failed');
    }
    if (next !== this.accelerator && this.registered) globalShortcut.unregister(this.accelerator);
    this.accelerator = next;
    this.registered = true;
    return this.result(null);
  }

  dispose(): void {
    if (this.registered) globalShortcut.unregister(this.accelerator);
    this.registered = false;
  }

  private result(error: ShortcutChangeError | null): ShortcutResult {
    return { settings: this.getSettings(), error };
  }

  private register(accelerator: string): boolean {
    try { return globalShortcut.register(accelerator, () => { void this.activate().catch(this.failed); }); }
    catch { return false; }
  }
}

function normalizeShortcut(value: string | undefined): string | undefined {
  if (!value || value.length > 80) return;
  const parts = value.trim().split('+').map((part) => part.trim().toLowerCase());
  const key = parts.pop();
  const modifiers = ['command', 'control', 'alt', 'shift'];
  if (!key || !parts.length || parts.some((part) => !modifiers.includes(part))
    || new Set(parts).size !== parts.length || !parts.some((part) => part !== 'shift')) return;
  const namedKeys = ['Space', 'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Up', 'Down', 'Left', 'Right'];
  const normalizedKey = namedKeys.find((name) => name.toLowerCase() === key)
    ?? (/^[a-z0-9]$/.test(key) || /^f([1-9]|1[0-9]|2[0-4])$/.test(key) ? key.toUpperCase() : undefined);
  if (!normalizedKey) return;
  return [...modifiers.filter((modifier) => parts.includes(modifier))
    .map((modifier) => modifier[0].toUpperCase() + modifier.slice(1)), normalizedKey].join('+');
}
