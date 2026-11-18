import { isDeepSeekConfiguration } from '../../shared/ai-service-configuration';
import { isModelParameters } from '../../shared/model-parameters';
import { noArguments, type PageCommands } from '../page-commands';
import type { SetupController } from './controller';

export function installSetupBridge(commands: PageCommands, setup: SetupController): void {
  commands.handle('setup:get-state', (...args) => { noArguments(args); return setup.getState(); });
  commands.handle('setup:refresh', (...args) => { noArguments(args); return setup.refresh(); });
  commands.handle('setup:retry-restart', (...args) => { noArguments(args); return setup.retryRestart(); }, 'manager');
  commands.handle('setup:save-deepseek-configuration', (...args) => {
    const value = args[0];
    if (args.length !== 1 || !isDeepSeekConfiguration(value)) throw new Error('AI 服务配置无效');
    return setup.saveDeepSeekConfiguration({ baseUrl: value.baseUrl, apiKey: value.apiKey });
  }, 'manager');
  commands.handle('setup:save-model-parameters', (...args) => {
    const value = args[0];
    if (args.length !== 1 || !isModelParameters(value)) throw new Error('模型参数无效');
    return setup.saveModelParameters(structuredClone(value));
  }, 'manager');
  setup.onStateChanged((state) => commands.publish('setup:state-changed', state));
}
