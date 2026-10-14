export interface AcceptanceCoordinator {
  readonly runId: string;
  close(): Promise<void>;
  waitFor(stage: string): Promise<void>;
  waitForForeground(stage: string, read: (since: number) => Promise<{
    helperBlurred: boolean; wechatInFront: boolean; freshObservation: boolean;
  }>, timeoutMs?: number): Promise<void>;
  holdFailure(): Promise<'finished' | 'exited' | 'lease-ended' | 'closing'>;
}
export function createAcceptanceCoordinator(options: {
  directory: string; pid: number;
  checkLease: () => Promise<unknown>; isAlive: () => boolean;
  now?: () => number; wait?: () => Promise<void>;
}): Promise<AcceptanceCoordinator>;
