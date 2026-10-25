# Ticket 17 宿主集成候选

`backend-ts/src/host-plugin.ts` 当前含 Ticket 22 未提交改动，本票未修改该共享文件。以下接线应
由根集成在 Ticket 22 落定后应用；删除模块、迁移、测试和独立 HTTP 验证已在 Ticket 17 路径完成。

## 导入与装配

在 `host-plugin.ts` 增加：

```ts
import {
  CrossDomainDeletionService,
  crossDomainDeletionRoute,
  serveCrossDomainDeletion,
} from './cross-domain-deletion.ts';
```

在现有 `skills` 构造之后增加：

```ts
const deletionSkillsRoot=resolveSkillsRoot(runtimeEnvironment,config.businessHome,config.projectDirectory);
const deletions=storage.runtimeOwnerId
  ?new CrossDomainDeletionService({storage,skillsRoot:deletionSkillsRoot})
  :undefined;
```

现有 `skills` 也使用同一 `deletionSkillsRoot`，避免同一 owner 出现两个受管根。
删除服务按已持久化的 runtime owner 身份装配，不要求 owner 行此刻仍存在；这样账户主体已删、
仅受管文件清理失败的账号删除仍可在重启后按原 operation 读取并显式重试。

## 认证后的路由

在 `state==='running'` 检查之后、L2/L3 与 Legacy 路由之前增加：

```ts
if(crossDomainDeletionRoute(req.method??'',url.pathname)){
  await serveCrossDomainDeletion(req,res,deletions);
  return;
}
```

该 helper 只接受宿主持有公开 token 后的请求：来源删除保留既有空正文确认；账户、联系人和
讨论删除要求明确的 `confirmed:true` 及目标确认字段。不得放到认证检查之前。

## 重启恢复与可见所有权

在 `server.listen` 成功后、模型/Python 启动前调用：

```ts
if(deletions)await deletions.recover();
```

`recover()` 只接管当前 owner 的排队或已过租约删除，并分批处理全部可接管操作，不扫描其他
owner。`runtime/status` 的
`ownership` 增加：

```ts
crossDomainDeletion:deletions?'typescript':'unavailable',
```

## 验证入口

- `cd backend-ts && ./node_modules/.bin/tsc --noEmit`
- `cd backend-ts && node --test test/cross-domain-deletion-http.test.mjs`
- `cd backend-ts && node --test test/host-model-integration-profile.test.mjs`
- `cd desktop && node --test tests/assistant-session-deletion-guards.test.mjs tests/background-task-polling.test.mjs`

根集成后还应通过真实宿主认证 HTTP 重跑来源、联系人、账户、讨论四条入口；本候选测试使用
真实 `_test` PostgreSQL 和相同 `serveCrossDomainDeletion` HTTP 适配器，但没有改动未提交的
Ticket 22 宿主装配。
