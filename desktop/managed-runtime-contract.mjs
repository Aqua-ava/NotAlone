// 构建与App载入共用的最小运行组件契约。
export const managedLayout = { python: 'python/bin/python3.12', project: 'project', postgres: 'postgres/bin' };
export const minimumRuntimeComponents = 2;
export const requiredRuntimeFiles = [managedLayout.python,
  ...['initdb', 'postgres', 'pg_isready', 'psql', 'pg_dump', 'pg_restore'].map(name => `${managedLayout.postgres}/${name}`),
  ...['server/command.py', 'startup_diagnostics.py', 'managed_postgres.py', 'parent_lifetime.py'].map(name => `project/backend/src/notalone/${name}`)];
