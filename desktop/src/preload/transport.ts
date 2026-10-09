export interface PageTransport {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, listener: (event: unknown, state: any) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, state: any) => void): unknown;
}
