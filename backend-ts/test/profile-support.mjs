import {readFile} from 'node:fs/promises';
import {resolveHostReplyConfiguration} from '../src/host/host-reply-config.ts';

/** 共用正式插件装配；仅替换测试入口、环回模型服务与合成认证。 */
export async function createSyntheticProfile(pluginPath, providerURL) {
  const url = new URL(providerURL);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
    || url.username || url.password) throw new Error('合成模型服务必须使用本机环回地址');
  // 不读取用户环境或真实密钥；默认模型参数由正常宿主解析器提供。
  const configuration = resolveHostReplyConfiguration({NOTALONE_DEEPSEEK_API_KEY: 'synthetic-only'});
  if (configuration.status !== 'configured') throw new Error('正常宿主默认模型配置不可用');
  const {connection} = configuration.provider;
  const provider = {baseURL: providerURL, thinking: connection.defaults.thinking,
    maxTokens: configuration.model.maxTokens, retryPolicy: {mode: connection.retryPolicy.mode, maxRetries: connection.retryPolicy.maxRetries}};
  const patch = await readFile(new URL('../profile/host.patch.yml', import.meta.url), 'utf8');
  return patch.replace('PLUGIN_PATH', JSON.stringify(pluginPath)) + `    - id: provider
      name: '@deepseek-ai/dsh-llm-deepseek-api-key'
      config: ${JSON.stringify(provider)}
`;
}
