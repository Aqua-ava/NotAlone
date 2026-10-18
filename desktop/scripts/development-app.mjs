// 只管理本次启动的 Electron；停止失败时保留 App 的认证恢复入口。
export function superviseDevelopmentApp(launch, report = console.log) {
  let child, currentReady = false, stopping = false, restarting = false, settled = false, launched = false, timeout;
  let complete;
  const closed = new Promise(resolve => { complete = resolve; });
  const finish = code => {
    if (settled) return;
    settled = true; clearTimeout(timeout); complete(code);
  };
  const requestQuit = () => {
    if (!child || settled) return;
    if (currentReady && child.connected) child.send({ type: 'notalone-dev-quit' }, () => {});
    clearTimeout(timeout);
    timeout = setTimeout(() => report('仍在等待 App 确认停读和退出；请查看 App 的恢复提示。不会强制结束或启动第二份。'), 10_000);
  };
  const start = () => {
    let ready = false;
    currentReady = false;
    try { child = launch({ background: launched }); launched = true; } catch { report('开发 App 启动失败。'); finish(1); return; }
    child.on('message', message => {
      if (message?.type === 'notalone-dev-ready') {
        ready = true; currentReady = true; report('开发 App 已就绪；保存界面文件即可查看效果。');
        if (stopping || restarting) requestQuit();
      }
    });
    child.once('error', () => { report('开发 App 进程启动失败。'); });
    child.once('close', (code, signal) => {
      child = undefined; clearTimeout(timeout);
      if (stopping) { finish(code === 0 && !signal ? 0 : 1); return; }
      if (ready && restarting && code === 0 && !signal) {
        restarting = false; start(); return;
      }
      if (!ready && code === 0) report('开发宿主未就绪：请先从菜单退出已运行的 NotAlone，再运行 npm run dev。');
      else if (code !== 0 || signal) report('开发 App 异常退出，请查看终端错误后重新运行 npm run dev。');
      finish(ready && code === 0 && !signal ? 0 : 1);
    });
  };
  start();
  return {
    closed,
    restart() {
      if (stopping || settled || restarting) return;
      restarting = true; report('源码已更新，等待 App 安全退出后重启…'); requestQuit();
    },
    stop() { if (!stopping && !settled) { stopping = true; requestQuit(); } return closed; },
  };
}
