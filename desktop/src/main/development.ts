import path from 'node:path';

export type DevelopmentServer = { origin: string; token: string };

export function validateDevelopmentServer(value: unknown): DevelopmentServer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('开发服务配置无效');
  const { origin, token } = value as Record<string, unknown>;
  if (typeof origin !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(origin)
    || typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('开发服务配置无效');
  const url = new URL(origin);
  if (url.origin !== origin) throw new Error('开发服务配置无效');
  return { origin, token };
}

export function readDevelopmentServer(packaged: boolean, argv: string[], raw: string | undefined): (DevelopmentServer & { projectDirectory: string }) | undefined {
  // 环境变量本身不能把正式包或普通启动变为开发宿主。
  if (packaged || !argv.includes('--notalone-dev')) return undefined;
  if (!raw || raw.length > 1024) throw new Error('开发服务配置无效');
  const value = JSON.parse(raw);
  const server = validateDevelopmentServer(value);
  if (typeof value.projectDirectory !== 'string' || !path.isAbsolute(value.projectDirectory)
    || value.projectDirectory.length > 1024 || /[\0\r\n]/.test(value.projectDirectory)) throw new Error('开发源码目录无效');
  return { ...server, projectDirectory: value.projectDirectory };
}
