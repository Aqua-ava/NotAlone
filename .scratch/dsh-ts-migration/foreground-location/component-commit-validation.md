# 票21基础组件：完整暂存树验证

范围为根批准的7个文件：原生probe及其测试/fixture、legacy-backend代理完成回执及测试、sync_host前台移交及测试。没有host/app入口接线，没有locator/name-matching/api/sessions及05 casefold，不启用半套前台功能。

- 基础HEAD：ccc7dbd1。
- 验证产品暂存树：eeea18a440e5a923296a46ec79cfb8e108167c0f。
- git archive该完整tree到独立临时目录，仅链接现有backend-ts/node_modules；没有复制任何未提交产品代码。明确核验casefold及完整定位模块均不存在于隔离树。
- Node24：`node --test --test-concurrency=1 test/foreground-location-probe.test.mjs test/foreground-location-proxy.test.mjs`，26/26（23+3）、0skip。
- 独立类型检查：`tsc --ignoreConfig --noEmit --target es2024 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --types node --allowImportingTsExtensions src/foreground-location-probe.ts src/legacy-backend.ts`，退出0。
- 隔离PYTHONPATH仅指向暂存树backend/src及backend，`python -m unittest -q tests.unit.server.test_foreground_location_handoff tests.unit.server.test_foreground_independence tests.unit.server.test_foreground_worker_cleanup`，8/8，3.940秒。
- 最初尝试pytest因本地环境未安装该模块而未执行用例；未安装依赖，改用测试原有unittest入口，以上8项真实运行通过。
- `git diff --cached --check`通过。验证后只增加本证据文档，产品字节不变；最终提交树与验证树只多本证据。

测试只用匿名合成探针、本机HTTP和FakeEngine，不使用App/业务数据库/模型/真实微信资料。完整工作树实际App证据不用于替代本次独立组件闭包验证。

此提交不关闭21整票；完整定位模块、共享host/app接线及05依赖归档仍待完成。
