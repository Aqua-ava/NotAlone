# 18 最终接线与提交交付

## 固定 DSH 依据

锁定 @deepseek-ai/dsh 0.2.1-rc.2，官方commit 687f282e8625c6b8d11ff58211a90524be2e4317。源码核对 /tmp/notalone-dsh-official-687f282/packages/boot/cmdline/src/index.ts:38-62、88、125-136：公开 appReady.onReady 与 appExit 生命周期；复用既有官方 profile/host-plugin apply，不新增替代宿主、不修改DSH核心。业务服务自身不调用模型或框架私有接口。真实官方profile测试验证监听先于旧进程启动、独立内部认证及有序退出。

## 最终接线

createWechatScopeApi 由 HostStorage、受控CLI/environment、readSyncStatus及revokeWithDrain构造。公开撤销走legacy内部排空端点，再用独立scope token回调TS revoke；内部state/discover/history-state/history-bindings/revoke绝不回调legacy，避免循环等待。所有旧setup/scope/binding写入口在Python迁移模式拒绝503。close取消CLI及事务后再停止legacy、关闭storage。

认证与路由共用一次规范化pathname；严格JSON拒绝重复键、坏UTF8；正文1MiB，10秒总截止，原始socket验证413/408/400。远程端口只允许127.0.0.1独立token，不重定向、不代理、不fallback。

## 实际验证命令

Node使用本机缓存Node24；Python使用NotAlone环境。命令从对应目录运行，输出保存仓库外再裁剪。

- backend-ts：node --test test/wechat-setup.test.mjs test/wechat-sessions.test.mjs test/binding-service.test.mjs test/sync-scope.test.mjs test/sync-scope-migration.test.mjs test/wechat-scope-api.test.mjs test/wechat-scope-host.test.mjs → 58/58。
- backend：python -m unittest tests.unit.front_sync.test_wechat_scope_remote tests.unit.front_sync.test_wechat_history_scope tests.unit.server.test_wechat_scope_drain tests.integration.server.test_wechat_scope_handoff → 22/22。
- desktop：NOTALONE_TEST_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node --test tests/wechat-setup.test.mjs tests/wechat-setup-view.test.mjs tests/binding-startup.test.mjs → 32/32。
- npm run typecheck --prefix backend-ts；npm run typecheck --prefix desktop → 均通过。
- npm run dev -- --user-data-dir <本轮合成临时目录>；Computer Use实操两轮，结果与清理见progress.md。

## 精确待提交清单（等待Git分配）

- backend-ts/src/{binding-service,sync-scope,sync-scope-history,wechat-history-enrollment,wechat-http-body,wechat-scope-api,wechat-scope-json,wechat-sessions,wechat-setup-probe,wechat-setup}.ts
- backend-ts/src/{host-plugin,legacy-backend}.ts（主协调授予18的最终共享接线，提交前复核未混入其他票）
- backend-ts/test/{binding-service,sync-scope,wechat-scope-api,wechat-scope-host,wechat-sessions,wechat-setup}.test.mjs
- backend/src/notalone/front_sync/{cli_sync,factory,full_sync_engine,wechat_scope_remote}.py
- backend/src/notalone/server/{app,command,sync_host}.py
- backend/tests/unit/front_sync/{test_wechat_history_scope,test_wechat_scope_remote}.py
- backend/tests/unit/server/test_wechat_scope_drain.py；backend/tests/integration/server/test_wechat_scope_handoff.py
- desktop/src/main/bindings/{bridge,controller}.ts；desktop/src/main/setup/{wechat-bridge,wechat-controller}.ts
- desktop/src/preload/{binding-consent,wechat-setup}.ts
- desktop/src/renderer/{BindingConsentPage,ContactsPage,WechatSetupPanel}.tsx；desktop/src/renderer/use-binding-consent.ts
- desktop/src/shared/{binding-consent-bridge,wechat-setup-bridge}.ts
- desktop/tests/{binding-page-scenarios.ts,binding-startup.test.mjs,wechat-setup-view.test.mjs,wechat-setup.test.mjs}
- .scratch/dsh-ts-migration/issues/18-wechat-scope-binding.md；本目录progress.md、integration-request.md

108及专属升级测试已提交，不捎带package/lock、json-client及05/06/09改动。主协调的root-host-verification.md不重复修改。
