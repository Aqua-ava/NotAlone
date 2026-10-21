// 首帧状态读取失败时的统一可见提示与重试入口。
export function FirstFrameError({ message, retry }: { message: string; retry: () => void }) {
  if (!message) return null;
  return <p className="first-frame-error" role="alert">{message}
    <button className="button" onClick={() => retry()}>重试读取</button></p>;
}
