import path from 'node:path';

export function isolatedAppEnvironment(userData: string, overrides: NodeJS.ProcessEnv = {}): Record<string, string> {
  const environment = {
    ...process.env, ELECTRON_RUN_AS_NODE: '',
    NOTALONE_DISABLE_DOTENV: '1', NOTALONE_ENV_FILE: path.join(userData, 'synthetic.env'),
    NOTALONE_BACKEND_INFO: path.join(userData, 'backend.info'),
    NOTALONE_DATABASE_URL: '', NOTALONE_OWNER_ID: '', DEEPSEEK_API_KEY: '',
    NOTALONE_WECHAT_CLI: path.join(userData, 'unavailable-cli'),
    NOTALONE_SYNC_PROBE: path.join(userData, 'unavailable-probe'),
    ...overrides,
  };
  return Object.fromEntries(Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

