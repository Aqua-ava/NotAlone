import { noArguments, type PageCommands } from '../page-commands';
import type { BackendHost } from './host';

export function installBackendBridge(commands: PageCommands, backend: BackendHost, quit: () => void): void {
  commands.handle('backend:get-state', (...args) => { noArguments(args); return backend.getState(); });
  commands.handle('backend:retry-connection', (...args) => { noArguments(args); return backend.connect(); });
  commands.handle('backend:quit', (...args) => { noArguments(args); quit(); });
  backend.onStateChanged((state) => commands.publish('backend:state-changed', state));
}
