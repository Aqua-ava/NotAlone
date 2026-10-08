import type { DesktopBridge } from './desktop-bridge';

export interface WindowBridge extends DesktopBridge {
  openManager(): Promise<void>;
  openHelper(): Promise<void>;
  hideWindow(): Promise<void>;
}
