export interface PageTransport {
  invoke(channel: string, ...args: unknown[]): Promise<any>;
  on(channel: string, listener: (event: unknown, state: any) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, state: any) => void): unknown;
}

/** 仅供具名桥内部订阅状态；页面回调不接触 IPC 事件或通道。 */
export function subscribePageState<State>(transport: PageTransport, channel: string,
  listener: (state: State) => void, invalidMessage: string): () => void {
  if (typeof listener !== 'function') throw new Error(invalidMessage);
  const receive = (_event: unknown, state: State) => listener(state);
  transport.on(channel, receive);
  return () => { transport.removeListener(channel, receive); };
}
