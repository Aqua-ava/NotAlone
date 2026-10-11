import { app } from 'electron';
import type { BackendHost } from './host';
import type { AppWindows } from '../windows';

export function installQuitLifecycle(backend: BackendHost, windows: AppWindows, beforeShutdown?: () => Promise<void>): void {
  let allowed = false;
  let pending = false;
  app.on('before-quit', (event) => {
    if (allowed) { windows.prepareToQuit(); return; }
    event.preventDefault();
    if (pending) return;
    pending = true;
    void backend.stop(beforeShutdown).then((confirmed) => {
      if (confirmed) { allowed = true; app.quit(); }
      else void windows.open('manager');
    }).finally(() => { pending = false; });
  });
}
