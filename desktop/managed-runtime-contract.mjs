// 构建与App载入共用的最小运行组件契约。
export const managedLayout = { project: 'project', postgres: 'postgres/bin' };
export const minimumRuntimeComponents = 1;
export const requiredRuntimeFiles = [
  ...['initdb', 'postgres', 'pg_isready', 'psql'].map(name => `${managedLayout.postgres}/${name}`),
  ...['launch.ts', 'managed-postgres.ts', 'platform/database/managed-database-lifetime.ts', 'schema-prepare-cli.ts'].map(name => `project/backend-ts/src/${name}`),
  'project/backend-ts/profile/host.patch.yml'];
