/** 只传结构化 stdin；失败或 ACK 不确定都拒绝发送，不退款或自动重试。 */
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';

export function problemBudgetBridge(configuration, action = 'reserve') {
  if (!configuration || !['check', 'reserve', 'ack'].includes(action)) return Promise.reject(new Error('budget_bridge_rejected'));
  const {python, moduleRoot, repositoryRoot, budget} = configuration;
  if (![python, moduleRoot, repositoryRoot].every(value => typeof value === 'string' && value.startsWith('/'))) return Promise.reject(new Error('budget_bridge_rejected'));
  return new Promise((resolve, reject) => {
    const child = execFile(python, [fileURLToPath(new URL('./bridge.py', import.meta.url))], {
      env: {PYTHONPATH: moduleRoot, PYTHONDONTWRITEBYTECODE: '1', NOTALONE_DISABLE_DOTENV: '1', NOTALONE_BUDGET_REPOSITORY: repositoryRoot},
      timeout: 5000, maxBuffer: 8192,
    }, (error, stdout) => {
      if (error) { reject(new Error('budget_bridge_rejected')); return; }
      try {
        const receipt = JSON.parse(stdout);
        if (receipt.schema_version !== 'reply-budget-bridge-v1' || receipt.action !== action || receipt.reserved !== (action === 'reserve') || !Number.isSafeInteger(receipt.used_reservations) || !Number.isSafeInteger(receipt.max_reservations) || receipt.max_reservations < 1 || receipt.used_reservations < 0 || receipt.used_reservations > receipt.max_reservations || !Number.isFinite(receipt.deadline) || receipt.deadline <= 0) throw new Error();
        resolve(receipt);
      } catch { reject(new Error('budget_bridge_rejected')); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({schema_version: 'reply-budget-bridge-v1', action, budget}));
  });
}

/** 满足 ReplyServiceOptions.provider 的现有 Interface，保留其原本 PG/范围守卫。 */
export function withProblemBudgetProvider(provider, configuration) {
  return {
    beginCall(call) {
      return provider.beginCall({...call, beforeDispatch: async value => {
        await problemBudgetBridge(configuration);
        await call.beforeDispatch(value);
      }});
    },
  };
}
