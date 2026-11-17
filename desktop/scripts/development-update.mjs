/** 源码变更串行核验；publish 必须同步提交且不返回值，提交期间不让新保存插入。 */
export function createDevelopmentUpdates({ check, build, publish, restart = () => {}, report = () => {}, debounceMs = 180 }) {
  let revision = 0, timer, working, pending, controller, closed = false;
  const settle = result => { clearTimeout(timer); timer = undefined; const current = pending; pending = undefined; current?.resolve(result); };
  const run = () => {
    if (working || closed) return;
    clearTimeout(timer); timer = undefined;
    working = (async () => {
      while (!closed) {
        const current = revision;
        const latest = () => !closed && revision === current;
        let stage = 'check';
        controller = new AbortController();
        try {
          await check(controller.signal);
          if (!latest()) continue;
          stage = 'build';
          const result = await build();
          if (!latest()) continue;
          stage = 'publish';
          const publication = publish(result);
          if (publication !== undefined) {
            void Promise.resolve(publication).catch(() => {});
            throw new TypeError('开发产物必须同步提交。');
          }
          if (!latest()) continue;
          stage = 'restart';
          restart();
          settle(true); return;
        } catch (error) {
          if (!latest()) continue;
          report(stage, error); settle(false); return;
        }
      }
      settle(false);
    })().finally(() => { working = undefined; controller = undefined; });
  };
  return {
    update() {
      if (closed) return Promise.resolve(false);
      revision++;
      pending ??= Promise.withResolvers();
      clearTimeout(timer);
      timer = setTimeout(run, debounceMs);
      return pending.promise;
    },
    async close() {
      closed = true; revision++;
      clearTimeout(timer); controller?.abort();
      await working; settle(false);
    },
  };
}
