export interface ShortcutSettings {
  helperShortcut: string;
  shortcutRegistered: boolean;
}

export interface DesktopSettings extends ShortcutSettings {
  helperPinned: boolean;
}

export interface DesktopBridge {
  getDesktopSettings(): Promise<DesktopSettings>;
  setHelperShortcut(accelerator: string): Promise<ShortcutChangeResult>;
  setHelperPinned(pinned: boolean): Promise<DesktopSettings>;
  onDesktopSettingsChanged(listener: (settings: DesktopSettings) => void): () => void;
}

export type ShortcutChangeError = 'invalid' | 'unavailable' | 'save-failed';
export interface ShortcutChangeResult {
  settings: DesktopSettings;
  error: ShortcutChangeError | null;
}
