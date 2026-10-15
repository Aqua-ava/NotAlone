import { constants, closeSync, fstatSync, openSync, realpathSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';

const hostEvents = ['permit', 'reconcile', 'launch', 'changed', 'paused', 'stop', 'close', 'dispose'] as const;
const hostReasons = ['permit_present', 'permit_absent', 'disposed', 'no_permit', 'child_running',
  'resolving', 'scope_blocked', 'proof_reused', 'resolve', 'resolve_stale', 'executable_unavailable',
  'resolve_failed', 'started', 'stdout_changed', 'stdout_paused', 'scope_changed', 'watchdog',
  'invalid_stdout', 'child_error', 'shutdown', 'closed', 'native_diagnostic_rejected'] as const;
const signals = ['none', 'SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'other'] as const;
const nativeStages = ['run', 'permission', 'context', 'initial_capture', 'initial_layout',
  'shareable_content', 'window', 'display', 'source_rect', 'stream_setup', 'stream_start',
  'streaming', 'stream_stop', 'finished'] as const;
const nativeReasons = ['begin', 'permission_missing', 'context_unavailable', 'context_changed',
  'window_unavailable', 'display_unsupported', 'source_rect_invalid', 'first_frame',
  'output_dimensions', 'pixel_format', 'buffer_lock', 'missing_buffer', 'frame_limit',
  'detector_failed', 'stream_error', 'stream_connection_invalid', 'stream_connection_interrupted',
  'stream_context_missing', 'stream_system_stopped', 'stream_user_stopped',
  'stream_permission_declined', 'stream_missing_entitlements', 'stream_internal',
  'stream_invalid_parameter', 'stream_start_failed', 'operation_failed', 'lease_expired', 'stopped'] as const;
const contextReasons = ['instances_ambiguous', 'instances_zero', 'instances_multiple', 'foreground_unknown', 'not_wechat_foreground',
  'version_unsupported', 'window_list_unavailable', 'window_not_visible', 'windows_ambiguous',
  'window_geometry_invalid', 'context_unavailable', 'identity_mismatch'] as const;
const contextMatchKeys = ['processMatches', 'windowMatches', 'originMatches', 'sizeMatches',
  'versionMatches', 'buildMatches'] as const;
type NativeContextDiagnosticRecord = {
  kind: 'native-context'; ordinal: number; elapsedMs: number; nativeElapsedMs: number;
  reason: typeof contextReasons[number];
} & Record<typeof contextMatchKeys[number], boolean | null>;
type NativeCountsDiagnosticRecord = {
  kind: 'native-counts'; ordinal: number; elapsedMs: number; nativeElapsedMs: number;
  status: 'final' | 'saturated'; initialImages: number; screenCallbacks: number; processedFrames: number;
};

export type HeaderChangeHostReason = typeof hostReasons[number];
export type HeaderChangeDiagnosticSignal = typeof signals[number];
export type HeaderChangeDiagnosticRecord = {
  kind: 'clock-anchor'; elapsedMs: number; epochMs: number; sampleSpanMs: number;
} | {
  kind: 'host'; event: typeof hostEvents[number]; reason: HeaderChangeHostReason;
  ordinal: number; elapsedMs: number; leaseElapsedMs: number | null; permitPresent: boolean; childPresent: boolean;
  resolving: boolean; blocked: boolean; freshProof: boolean; epochCurrent: boolean;
  paused: boolean; stopping: boolean; renewalEligible: boolean; code: number | null; signal: HeaderChangeDiagnosticSignal;
} | { kind: 'native'; ordinal: number; elapsedMs: number; stage: typeof nativeStages[number];
  reason: typeof nativeReasons[number]; nativeElapsedMs: number } | NativeContextDiagnosticRecord | NativeCountsDiagnosticRecord;
export interface HeaderChangeDiagnosticSink {
  record(record: HeaderChangeDiagnosticRecord): void;
  close(): void;
}

const includes = (items: readonly string[], value: unknown): boolean => typeof value === 'string' && items.includes(value);
const elapsed = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const ordinal = (value: unknown): boolean => Number.isSafeInteger(value) && Number(value) >= 0;
const countsValid = (status: unknown, initial: number, callbacks: number, processed: number): boolean =>
  (status === 'final' || status === 'saturated') && Number.isInteger(initial) && initial >= 0 && initial <= 1
  && Number.isSafeInteger(callbacks) && callbacks >= 0 && callbacks <= 0xffff_ffff
  && Number.isInteger(processed) && processed >= 0 && processed <= 240 && processed <= callbacks
  && (status !== 'saturated' || callbacks === 0xffff_ffff);
const contextValuesValid = (reason: unknown, values: unknown[]): boolean => values.length === 6
  && includes(contextReasons, reason) && (reason === 'identity_mismatch'
    ? values.every(value => typeof value === 'boolean') && values.some(value => value === false)
    : values.every(value => value === null));

// 再核白名单，避免未来调用处意外把原始范围或错误塞入诊断对象。
function validRecord(record: HeaderChangeDiagnosticRecord): boolean {
  if (!record || !elapsed(record.elapsedMs)) return false;
  const keys = Object.keys(record).sort().join(',');
  if (record.kind === 'clock-anchor') return keys === 'elapsedMs,epochMs,kind,sampleSpanMs'
    && Number.isSafeInteger(record.epochMs) && record.epochMs >= 0 && elapsed(record.sampleSpanMs)
    && record.sampleSpanMs / 2 <= record.elapsedMs;
  if (!ordinal(record.ordinal)) return false;
  if (record.kind === 'native-counts') return keys === 'elapsedMs,initialImages,kind,nativeElapsedMs,ordinal,processedFrames,screenCallbacks,status'
    && elapsed(record.nativeElapsedMs) && countsValid(record.status, record.initialImages, record.screenCallbacks, record.processedFrames);
  if (record.kind === 'native') return keys === 'elapsedMs,kind,nativeElapsedMs,ordinal,reason,stage'
    && includes(nativeStages, record.stage) && includes(nativeReasons, record.reason) && elapsed(record.nativeElapsedMs);
  if (record.kind === 'native-context') return keys === 'buildMatches,elapsedMs,kind,nativeElapsedMs,ordinal,originMatches,processMatches,reason,sizeMatches,versionMatches,windowMatches'
    && elapsed(record.nativeElapsedMs) && contextValuesValid(record.reason, contextMatchKeys.map(key => record[key]));
  if (record.kind !== 'host' || keys !== 'blocked,childPresent,code,elapsedMs,epochCurrent,event,freshProof,kind,leaseElapsedMs,ordinal,paused,permitPresent,reason,renewalEligible,resolving,signal,stopping') return false;
  return includes(hostEvents, record.event) && includes(hostReasons, record.reason) && includes(signals, record.signal)
    && (record.code === null || Number.isSafeInteger(record.code))
    && (record.leaseElapsedMs === null || elapsed(record.leaseElapsedMs))
    && [record.permitPresent, record.childPresent, record.resolving, record.blocked, record.freshProof,
      record.epochCurrent, record.paused, record.stopping, record.renewalEligible].every((value) => typeof value === 'boolean');
}

// 只在明确指定私有新文件时打开；失败仅停诊断，不更改采集许可。
export function openHeaderChangeDiagnostics(environment: NodeJS.ProcessEnv): HeaderChangeDiagnosticSink | undefined {
  const destination = environment.NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE;
  if (!destination || !path.isAbsolute(destination) || destination !== path.resolve(destination)
    || destination.length > 4096 || /[\0\r\n]/.test(destination)) return;
  let descriptor: number | undefined;
  try {
    const parent = path.dirname(destination);
    const owner = process.getuid?.();
    const parentInfo = statSync(parent);
    if (owner === undefined || realpathSync(parent) !== parent || !parentInfo.isDirectory()
      || parentInfo.uid !== owner || (parentInfo.mode & 0o777) !== 0o700) return;
    descriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.uid !== owner || (info.mode & 0o777) !== 0o600) { closeSync(descriptor); return; }
  } catch { if (descriptor !== undefined) { try { closeSync(descriptor); } catch {} } return; }
  const ownedDescriptor = descriptor;
  let records = 0, bytes = 0, closed = false, anchored = false;
  const close = () => { if (closed) return; closed = true; try { closeSync(ownedDescriptor); } catch {} };
  return { close, record(record) {
    if (closed) return;
    try {
      if (!validRecord(record)) return;
      if (record.kind === 'clock-anchor' && anchored) return;
      const line = Buffer.from(`${JSON.stringify(record)}\n`);
      if (records >= 512 || bytes + line.length > 256 * 1024) { close(); return; }
      if (record.kind === 'clock-anchor') anchored = true;
      ++records; bytes += line.length;
      let written = 0;
      while (written < line.length) {
        const count = writeSync(ownedDescriptor, line, written, line.length - written);
        if (count <= 0) { close(); return; }
        written += count;
      }
    } catch { close(); }
  } };
}

export function diagnosticSignal(signal: string | null): HeaderChangeDiagnosticSignal {
  return signal === null ? 'none' : includes(signals, signal) ? signal as HeaderChangeDiagnosticSignal : 'other';
}

export type NativeHeaderChangeDiagnostic = Pick<Extract<HeaderChangeDiagnosticRecord, { kind: 'native' }>,
  'stage' | 'reason' | 'nativeElapsedMs'> | Omit<NativeContextDiagnosticRecord, 'ordinal' | 'elapsedMs'>
  | Omit<NativeCountsDiagnosticRecord, 'ordinal' | 'elapsedMs'>;

// 每个源最多32行／3840字节；未知原文不进入任何回调或文件。
export class NativeHeaderChangeDiagnosticDecoder {
  private bytes = 0;
  private lines = 0;
  private pending = '';
  private rejected = false;
  private countsSeen = false;
  constructor(private readonly accept: (record: NativeHeaderChangeDiagnostic) => void,
    private readonly invalid: () => void) {}
  push(chunk: Buffer): void {
    if (this.rejected) return;
    this.bytes += chunk.length;
    if (this.bytes > 3840 || chunk.some((byte) => byte !== 10 && (byte < 32 || byte > 126))) { this.reject(); return; }
    this.pending += chunk.toString('ascii');
    for (;;) {
      const end = this.pending.indexOf('\n');
      if (end < 0) break;
      if (++this.lines > 32 || end + 1 > 120) { this.reject(); return; }
      const line = this.pending.slice(0, end); this.pending = this.pending.slice(end + 1);
      const counts = /^notalone-header-counts-v1 (final|saturated) ([01]) (\d+) (\d+) (\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/.exec(line);
      if (counts) {
        const initialImages = Number(counts[2]), screenCallbacks = Number(counts[3]), processedFrames = Number(counts[4]);
        if (this.countsSeen || !countsValid(counts[1], initialImages, screenCallbacks, processedFrames)
          || !elapsed(Number(counts[5]))) { this.reject(); return; }
        this.countsSeen = true;
        this.accept({ kind: 'native-counts', status: counts[1] as 'final' | 'saturated', initialImages,
          screenCallbacks, processedFrames, nativeElapsedMs: Number(counts[5]) });
        continue;
      }
      const context = /^notalone-header-context-v1 ([a-z_]+) ([01]{6}|------) (\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/.exec(line);
      if (context) {
        const values = [...context[2]].map(value => value === '-' ? null : value === '1');
        if (!contextValuesValid(context[1], values) || !elapsed(Number(context[3]))) { this.reject(); return; }
        this.accept({ kind: 'native-context', reason: context[1] as typeof contextReasons[number],
          nativeElapsedMs: Number(context[3]), processMatches: values[0], windowMatches: values[1],
          originMatches: values[2], sizeMatches: values[3], versionMatches: values[4], buildMatches: values[5] });
        continue;
      }
      const match = /^notalone-header-change-v1 ([a-z_]+) ([a-z_]+) (\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/.exec(line);
      if (!match || !includes(nativeStages, match[1]) || !includes(nativeReasons, match[2]) || !elapsed(Number(match[3]))) { this.reject(); return; }
      this.accept({ stage: match[1] as typeof nativeStages[number],
        reason: match[2] as typeof nativeReasons[number], nativeElapsedMs: Number(match[3]) });
    }
    if (this.pending.length >= 120) this.reject();
  }
  finish(): void { if (this.pending) this.reject(); }
  private reject(): void { this.rejected = true; this.pending = ''; this.invalid(); }
}
