import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// 文件只允许非秘密的快捷键；不会接收草稿、联系人或任意配置对象。
export class DesktopSettingsFile {
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = path.join(directory, 'desktop-settings.json');
  }

  readShortcut(): string | undefined {
    try {
      const stat = lstatSync(this.file);
      if (!stat.isFile() || stat.size > 2048) return;
      const value: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (value && typeof value === 'object' && 'helperShortcut' in value
        && typeof value.helperShortcut === 'string') return value.helperShortcut;
    } catch { /* 缺失或损坏的非秘密设置采用默认值，不回显原始文件。 */ }
  }

  saveShortcut(helperShortcut: string): void {
    mkdirSync(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `.desktop-settings-${randomUUID()}.tmp`);
    try {
      writeFileSync(temporary, JSON.stringify({ helperShortcut }), { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.file);
    } finally { rmSync(temporary, { force: true }); }
  }
}
