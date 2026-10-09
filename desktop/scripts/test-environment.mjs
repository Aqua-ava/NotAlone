// 测试子进程不继承追踪供应商配置；调用方的覆盖值也不能重新开启外部追踪。
export function withoutExternalTracing(environment) {
  const clean = Object.fromEntries(Object.entries(environment).filter(([key, value]) =>
    typeof value === 'string' && !key.startsWith('LANGSMITH_') && !key.startsWith('LANGCHAIN_')));
  return { ...clean, LANGSMITH_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', LANGCHAIN_TRACING: 'false' };
}
