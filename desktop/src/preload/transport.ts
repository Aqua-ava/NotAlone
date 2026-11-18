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

/**
 * 具名桥的参数形状校验：零参数或单参数的调用才会转发到固定通道，
 * 其余一律以同一提示拒绝，页面不能借此附带额外负载。
 */
export function pageInvokers(transport: PageTransport, message: string) {
  const reject = (): Promise<never> => Promise.reject(new Error(message));
  return {
    reject,
    empty: (channel: string, args: unknown[]): Promise<any> => args.length === 0 ? transport.invoke(channel) : reject(),
    single: (channel: string, args: unknown[]): Promise<any> => args.length === 1 ? transport.invoke(channel, args[0]) : reject(),
  };
}
