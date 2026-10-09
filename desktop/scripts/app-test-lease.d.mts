import type { ChildProcess } from 'node:child_process';

export const leaseRoot: string;
export function leasePath(probeId?: string, mode?: 'interactive' | 'probe' | 'headless'): string;
export function requestAppTestLease(action: 'check' | 'launch' | 'release' | 'probe', launchId?: string, probeId?: string): Promise<{ until: number; launchId?: string }>;
export function ownedGroupGone(child: ChildProcess): boolean;
