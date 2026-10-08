export interface WindowBridge {
  openManager(): Promise<void>;
  openHelper(): Promise<void>;
  hideWindow(): Promise<void>;
}
