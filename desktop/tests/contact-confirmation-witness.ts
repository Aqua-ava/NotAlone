import { createHash } from 'node:crypto';
import type { ElectronApplication, Page } from '@playwright/test';

export const C_MAIN_SHA256 = '2bc46df820508fbc193961061c412c6e27853b38939f5de0d45b653c6bd75be2';
const versions = { electron: '44.7.0', chrome: '152.0.7977.130', node: '24.21.0', v8: '15.2.124.28-electron.0' };
export const NODE_WRAPPER = ['(function (exports, require, module, __filename, __dirname) { ', '\n});'] as const;
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const failureCodes = new Set(['witness_source_rejected', 'witness_version_rejected', 'witness_location_rejected',
  'witness_paused', 'witness_protocol_rejected', 'witness_protocol_closed', 'witness_protocol_failed',
  'witness_protocol_timeout', 'witness_endpoint_rejected', 'witness_scope_rejected', 'witness_dom_rejected']);
export const witnessFailureCode = (error: unknown) => error instanceof Error && failureCodes.has(error.message)
  ? error.message : 'witness_protocol_rejected';
export class WitnessSetupFailure extends Error {
  constructor(code: string, readonly witnessReport: unknown) { super(code); }
}

export function verifyWitnessSource(disk: string, runtime: string, actual: Record<string, string>): 'unwrapped' | 'node-commonjs' {
  if (Object.entries(versions).some(([key, value]) => actual[key] !== value)) throw new Error('witness_version_rejected');
  if (sha256(disk) !== C_MAIN_SHA256) throw new Error('witness_source_rejected');
  if (runtime === disk) return 'unwrapped';
  if (runtime === NODE_WRAPPER[0] + disk + NODE_WRAPPER[1]) return 'node-commonjs';
  throw new Error('witness_source_rejected');
}

export type Location = { scriptId: string; lineNumber: number; columnNumber: number };
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const natural = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function chooseWitnessLocation(scriptId: string, lineNumber: number, locations: unknown): Location {
  if (!Array.isArray(locations) || locations.length === 0 || locations.some((item) => !record(item)
    || item.scriptId !== scriptId || item.lineNumber !== lineNumber || !natural(item.columnNumber))) {
    throw new Error('witness_location_rejected');
  }
  const first = [...locations].sort((a, b) => a.columnNumber - b.columnNumber)[0];
  if (locations.filter((item) => item.columnNumber === first.columnNumber).length !== 1) throw new Error('witness_location_rejected');
  return { scriptId, lineNumber, columnNumber: first.columnNumber };
}

export class ConfirmationWitnessLog {
  private paused = 0;
  private foreignIgnored = 0;
  private failure: string | null = null;
  private records: Record<string, unknown>[] = [];
  constructor(private readonly nonce: string) {}
  receive(method: string, params: unknown): void {
    if (method === 'Debugger.paused') this.paused += 1;
    if (method !== 'Runtime.consoleAPICalled' || !record(params) || !Array.isArray(params.args)) return;
    if (params.args[0]?.value !== this.nonce) { this.foreignIgnored += 1; return; }
    try {
      if (params.args.length !== 2 || typeof params.args[1]?.value !== 'string') throw new Error();
      const value: unknown = JSON.parse(params.args[1].value);
      const keys = ['phase', 'submittedScopeRevision', 'submittedForegroundRevision', 'currentScopeRevision',
        'currentForegroundRevision', 'currentContactRevision', 'currentForegroundStateRevision', 'generationValid'];
      if (record(value) && value.phase === 'returned') keys.push('selectedScopeRevision', 'selectedContactRevision');
      if (!record(value) || !['guard', 'rejected', 'returned'].includes(String(value.phase))
        || Object.keys(value).length !== keys.length || keys.some((key) => !(key in value))
        || keys.filter((key) => key !== 'phase' && key !== 'generationValid').some((key) => !natural(value[key]))
        || typeof value.generationValid !== 'boolean') throw new Error();
      if (this.records.length === 24) { this.failure = 'overflow'; return; }
      this.records.push(value);
    } catch { this.failure = 'record_rejected'; }
  }
  report(cleanupConfirmed: boolean) {
    const complete = this.records.length > 0 && this.records.length % 2 === 0 && this.records.every((value, index) => {
      const previous = this.records[index - 1];
      return index % 2 === 0 ? value.phase === 'guard' : value.phase !== 'guard'
        && value.submittedScopeRevision === previous.submittedScopeRevision
        && value.submittedForegroundRevision === previous.submittedForegroundRevision;
    });
    const failure = this.paused ? 'paused' : this.failure ?? (!cleanupConfirmed ? 'cleanup_unconfirmed' : !complete ? 'missing_verdict' : null);
    return { valid: failure === null, paused: this.paused, records: this.records,
      failure, foreignIgnored: this.foreignIgnored, cleanupConfirmed };
  }
}

export type InspectorProtocol = {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  onEvent(listener: (method: string, params: unknown) => void): () => void;
  close(): Promise<boolean>;
};

export function confirmationCondition(nonce: string, phase: 'guard' | 'rejected' | 'returned'): string {
  const selected = phase === 'returned' ? ',selectedScopeRevision:selected.scopeRevision,selectedContactRevision:selected.revision' : '';
  return `(console.log(${JSON.stringify(nonce)},JSON.stringify({phase:${JSON.stringify(phase)},`
    + 'submittedScopeRevision:selection4.contactScopeRevision,submittedForegroundRevision:selection4.foregroundRevision,'
    + 'currentScopeRevision:contact.scopeRevision,currentForegroundRevision:this.state.foregroundRevision,'
    + 'currentContactRevision:contact.revision,currentForegroundStateRevision:this.state.revision,'
    + `generationValid:generation!==undefined&&generation===this.generation${selected}})),false)`;
}

export async function installMainConfirmationWitness(protocol: InspectorProtocol, target: {
  disk: string; versions: Record<string, string>; scriptUrl: string; nonce: string;
}) {
  const log = new ConfirmationWitnessLog(target.nonce);
  const scripts = new Set<string>();
  const points: string[] = [], locations: Location[] = [];
  const stopEvents = protocol.onEvent((method, params) => {
    log.receive(method, params);
    if (method === 'Debugger.scriptParsed' && record(params) && params.url === target.scriptUrl && typeof params.scriptId === 'string') {
      scripts.add(params.scriptId);
    }
  });
  let sourceMode: 'unwrapped' | 'node-commonjs' | null = null;
  const stop = async () => {
    let cleanupConfirmed = true;
    for (const breakpointId of points) {
      try { await protocol.send('Debugger.removeBreakpoint', { breakpointId }); }
      catch { cleanupConfirmed = false; }
    }
    try { stopEvents(); } catch { cleanupConfirmed = false; }
    try { cleanupConfirmed = await protocol.close() && cleanupConfirmed; }
    catch { cleanupConfirmed = false; }
    return { ...log.report(cleanupConfirmed), sourceMode,
      locations: locations.map(({ lineNumber, columnNumber }) => ({ lineNumber, columnNumber })), exactReactCommittedRevisionCertified: false };
  };
  try {
    await protocol.send('Runtime.enable');
    await protocol.send('Debugger.enable');
    if (scripts.size !== 1) throw new Error('witness_source_rejected');
    const scriptId = [...scripts][0];
    const runtime = await protocol.send('Debugger.getScriptSource', { scriptId });
    if (typeof runtime.scriptSource !== 'string') throw new Error('witness_source_rejected');
    sourceMode = verifyWitnessSource(target.disk, runtime.scriptSource, target.versions);
    const phases = ['guard', 'rejected', 'returned'] as const;
    // C 已固定到此完整源码摘要；三个原语句位置使用 CDP 的零基坐标。
    for (const [index, lineNumber] of [126, 127, 134].entries()) {
      const possible = await protocol.send('Debugger.getPossibleBreakpoints', {
        start: { scriptId, lineNumber, columnNumber: 0 }, end: { scriptId, lineNumber: lineNumber + 1, columnNumber: 0 }, restrictToFunction: true,
      });
      const location = chooseWitnessLocation(scriptId, lineNumber, possible.locations);
      const installed = await protocol.send('Debugger.setBreakpoint', { location, condition: confirmationCondition(target.nonce, phases[index]) });
      if (typeof installed.breakpointId !== 'string') throw new Error('witness_location_rejected');
      points.push(installed.breakpointId);
      const actual = installed.actualLocation;
      if (!record(actual) || actual.scriptId !== location.scriptId || actual.lineNumber !== location.lineNumber
        || actual.columnNumber !== location.columnNumber) throw new Error('witness_location_rejected');
      locations.push(location);
    }
    if (log.report(true).paused > 0) throw new Error('witness_paused');
    return { stop };
  } catch (error) {
    const report = await stop();
    throw new WitnessSetupFailure(witnessFailureCode(error), report);
  }
}

export async function connectLocalInspector(address: string): Promise<InspectorProtocol> {
  let url: URL;
  try { url = new URL(address); } catch { throw new Error('witness_endpoint_rejected'); }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' || !/^\d+$/.test(url.port)
    || Number(url.port) < 1 || Number(url.port) > 65535 || url.username || url.password || url.search || url.hash
    || !/^\/[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(url.pathname)) throw new Error('witness_endpoint_rejected');
  const socket = new WebSocket(address);
  const listeners = new Set<(method: string, params: unknown) => void>();
  const pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const rejectPending = () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('witness_protocol_closed')); }
    pending.clear();
  };
  socket.addEventListener('close', rejectPending);
  socket.addEventListener('error', rejectPending);
  socket.addEventListener('message', (event) => {
    try {
      if (typeof event.data !== 'string') throw new Error();
      const message: unknown = JSON.parse(event.data);
      if (!record(message)) throw new Error();
      if (natural(message.id)) {
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id); clearTimeout(request.timer);
        if (message.error || !record(message.result)) request.reject(new Error('witness_protocol_failed'));
        else request.resolve(message.result);
      } else if (typeof message.method === 'string') {
        for (const listener of listeners) listener(message.method, message.params);
      }
    } catch { rejectPending(); }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error('witness_protocol_timeout')); }, 3000);
    socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('witness_protocol_failed')); }, { once: true });
  });
  let sequence = 0;
  return {
    send(method, params = {}) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('witness_protocol_closed'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('witness_protocol_timeout')); }, 3000);
        pending.set(id, { resolve, reject, timer });
        try { socket.send(JSON.stringify({ id, method, params })); }
        catch { pending.delete(id); clearTimeout(timer); reject(new Error('witness_protocol_failed')); }
      });
    },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    close() {
      listeners.clear(); rejectPending();
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 3000);
        socket.addEventListener('close', () => { clearTimeout(timer); resolve(true); }, { once: true });
        socket.close();
      });
    },
  };
}

export async function startContactConfirmationWitness(app: ElectronApplication, manager: Page, contactIds: string[]) {
  if (contactIds.length !== 2 || new Set(contactIds).size !== 2) throw new Error('witness_scope_rejected');
  const nonce = `notalone-confirm-${globalThis.crypto.randomUUID()}`;
  // 仅设置阶段读取官方版本、现有Inspector与本App编译文件，不修改Main或启动新端口。
  const metadata = await app.evaluate(({ app }) => {
    const nodePath = process.getBuiltinModule('path');
    const sourcePath = nodePath.join(app.getAppPath(), 'dist/main/index.cjs');
    return { address: process.getBuiltinModule('inspector').url(),
      disk: process.getBuiltinModule('fs').readFileSync(sourcePath, 'utf8'),
      scriptUrl: process.getBuiltinModule('url').pathToFileURL(sourcePath).href,
      versions: { electron: process.versions.electron ?? '', chrome: process.versions.chrome ?? '',
        node: process.versions.node ?? '', v8: process.versions.v8 ?? '' } };
  });
  if (!metadata.address) throw new Error('witness_endpoint_rejected');
  const protocol = await connectLocalInspector(metadata.address);
  const main = await installMainConfirmationWitness(protocol, { ...metadata, nonce });
  try {
    await manager.evaluate(({ nonce, contactIds }) => {
      const label = document.querySelector<HTMLElement>('[role="combobox"][aria-label="本次联系人"]');
      const directory = document.querySelector('[aria-label="联系人目录"]');
      const owned = window as Window & { contactConfirmationDOMWitness?: { nonce: string; finish: () => unknown } };
      if (!label || !directory || owned.contactConfirmationDOMWitness) throw new Error('witness_dom_rejected');
      const history: Array<Record<string, unknown>> = [];
      let overflow = false, previous = '';
      const capture = (value: Record<string, unknown>) => {
        if (history.length === 24) { overflow = true; return; }
        history.push({ at: performance.now(), ...value });
      };
      const sample = () => {
        const pressed = ['甲', '乙'].map((suffix) => Array.from(directory.querySelectorAll('.contact-row')).some(row => row.querySelector('b')?.textContent === `合成联系人${suffix}` && row.getAttribute('data-current') === 'true'));
        const selectedFixtureIndex = pressed.filter(Boolean).length > 1 ? -2 : pressed.indexOf(true);
        const headerFixtureIndex = contactIds.indexOf(label.getAttribute('data-contact-id') ?? '');
        const signature = `${selectedFixtureIndex}:${headerFixtureIndex}`;
        if (signature !== previous) { previous = signature; capture({ kind: 'dom', selectedFixtureIndex, headerFixtureIndex }); }
      };
      const observer = new MutationObserver(sample);
      let unsubscribe: (() => void) | undefined;
      try {
        observer.observe(label, { attributes: true, attributeFilter: ['data-contact-id'], childList: true, characterData: true, subtree: true });
        observer.observe(directory, { attributes: true, attributeFilter: ['data-current'], childList: true, subtree: true });
        unsubscribe = window.notalone.contacts.onStateChanged((state) => capture({ kind: 'delivered',
          revision: state.revision, scopeRevision: state.scopeRevision, selectedFixtureIndex: contactIds.indexOf(state.selectedContactId ?? '') }));
        sample();
      } catch { observer.disconnect(); unsubscribe?.(); throw new Error('witness_dom_rejected'); }
      owned.contactConfirmationDOMWitness = { nonce, finish: () => {
        observer.disconnect(); unsubscribe?.(); delete owned.contactConfirmationDOMWitness;
        return { records: history, overflow, cleanupConfirmed: true, exactReactCommittedRevisionCertified: false };
      } };
    }, { nonce, contactIds });
  } catch {
    const witnessReport = await main.stop();
    throw new WitnessSetupFailure('witness_dom_rejected', witnessReport);
  }
  return { stop: async () => {
    let dom: unknown = { cleanupConfirmed: false };
    try {
      dom = await manager.evaluate((nonce) => {
        const owned = (window as Window & { contactConfirmationDOMWitness?: { nonce: string; finish: () => unknown } }).contactConfirmationDOMWitness;
        return owned?.nonce === nonce ? owned.finish() : { cleanupConfirmed: false };
      }, nonce);
    } catch { /* 页面失效时只记录收尾未确认，仍清理自有Main会话。 */ }
    const report = await main.stop();
    const failure = report.failure ?? (!record(dom) || dom.cleanupConfirmed !== true ? 'dom_cleanup_unconfirmed'
      : dom.overflow !== false ? 'dom_overflow' : null);
    return { ...report, valid: failure === null, failure,
      dom, versions: metadata.versions, diskSourceSha256: sha256(metadata.disk) };
  } };
}
