# Ticket 17 宿主集成

Ticket 22 落定后，删除服务已接入共享 `backend-ts/src/host-plugin.ts`。以下记录实际接线与验证边界。

## 导入与装配

在 `host-plugin.ts` 增加：

```ts
import {
  CrossDomainDeletionService,
  crossDomainDeletionRoute,
  serveCrossDomainDeletion,
} from './cross-domain-deletion.ts';
```

现有 `skills` 与删除服务共用同一个受管根：

```ts
const deletionSkillsRoot=resolveSkillsRoot(runtimeEnvironment,config.businessHome,config.projectDirectory);
const skills=new SkillHost(storage,deletionSkillsRoot);
const deletions=storage.runtimeOwnerId
  ?new CrossDomainDeletionService({storage,skillsRoot:deletionSkillsRoot})
  :undefined;
```

删除服务按已持久化的 runtime owner 身份装配，不要求 owner 行此刻仍存在；这样账户主体已删、
仅受管文件清理失败的账号删除仍可在重启后按原 operation 读取并显式重试。

## 认证后的路由

删除路由位于认证检查及 `state==='running'` 检查之后、L2/L3 与 Legacy 路由之前：

```ts
if(crossDomainDeletionRoute(req.method??'',url.pathname)){
  await serveCrossDomainDeletion(req,res,deletions);
  return;
}
```

该 helper 只接受宿主持有公开 token 后的请求：来源删除保留既有空正文确认；账户、联系人和
讨论删除要求明确的 `confirmed:true` 及目标确认字段。不得放到认证检查之前。

## 重启恢复与可见所有权

服务在 `server.listen` 成功后、模型/Python 启动前恢复：

```ts
if(deletions)await deletions.recover();
```

`recover()` 只接管当前 owner 的排队或已过租约删除，并分批处理全部可接管操作，不扫描其他
owner。`runtime/status` 的 `ownership` 包含：

```ts
crossDomainDeletion:deletions?'typescript':'unavailable',
```

## 验证入口

- `cd backend-ts && ./node_modules/.bin/tsc --noEmit`
- `cd backend-ts && node --test test/cross-domain-deletion-http.test.mjs`
- `cd backend-ts && node --test test/host-http.test.mjs`
- `cd backend-ts && node --test test/host-model-integration-profile.test.mjs`
- `cd desktop && node --test tests/assistant-session-deletion-guards.test.mjs tests/background-task-polling.test.mjs`

宿主回归使用真实官方 DSH profile、认证信息和 `_test` PostgreSQL，经来源、讨论、联系人和账户
四条公开 HTTP 入口完成删除并持久回读；错误 token 在业务处理器之前返回 401。该证据仍不等于
实际 App／微信用户操作或 Ticket 24 的全组合切换／回退验收。
