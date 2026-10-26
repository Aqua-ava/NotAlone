# 26测试夹具退役交接（2026-10-26）
范围：只改分配的测试/夹具/登记和backend-ts脚本；无生产源码、App/微信、原库、真实模型、配置、Git index/提交、push/PR操作。
Node：node（本机已核验Node24，绝对路径保留在端侧执行记录）（下称N）；命令cwd按backend-ts或desktop。
核心：host-storage-fixture通过pg+prepareDatabaseSchema创建本轮32hex随机库，保留同库连接核对、排空/精确销毁与失败清理；不扫描/删除未知4库。原116SQL字节未改。
后端入口：backend-ts/package.json、pnpm-lock.yaml（engines>=24，移除darwin直接devdep与对应importer3行，版本不变）。
新增：backend-ts/test/{historical-inventory.json,run-current.mjs,run-historical.mjs,schema-fixture.mjs,HISTORICAL.md}。
共享夹具：backend-ts/test/{host-storage-fixture,extraction-fixture,usage-summary-fixture,contact-context-support,host-model-unconfigured-fixture}.mjs。
升级：backend-ts/test/{auto-read-suppression-migration,model-call-receipt-migration,model-call-learning-claim-migration,sync-scope-migration,schema-prepare}.test.mjs。
业务：backend-ts/test/{extraction-sources,extraction-task-store,source-processing-trace,exploration-skill-sources,history-runtime,memory-management-handoff,memory-management,model-host,skill-files,host-launch,usage-summary-http,extraction-model,diagnostic-model-budget,host-model-unconfigured,skill-host,task-api}.test.mjs。
桌面入口：desktop/scripts/{test-inventory,test-pages}.mjs；desktop/tests/{inventory.json,test-inventory.test.mjs,startup-fixture.ts,backend-fixture.ts,synthetic-backend-fixture.ts}。
桌面合同：desktop/tests/{assistant-candidate-carry-contract,dead-code-removal,reply-contract}.test.mjs；desktop/tests/packaging/{build-space,runtime-attribution}.test.mjs。
保护：三个用户文件完全未改；Python历史命令只用固定23a树，不包含其当前未提交修改，不能声称用户资产已运行。
DSH：锁定0.2.1-rc.2，本组无新DSH直接接口；只将ModelHost旧环境出口消费改为既有公开permit字段，未改框架/模型/预算。
最小验证（没有全量、盲评、性能采样、独立审查）：
N fixture smoke：116迁移与当前随机库核对/清理通过。
N --test --test-concurrency=1 test/{auto-read-suppression-migration,model-call-receipt-migration,model-call-learning-claim-migration,sync-scope-migration,extraction-sources}.test.mjs：初次27/29；2个超长库名守卫失败已修短。
N --test --test-concurrency=1 test/{auto-read-suppression-migration,model-call-learning-claim-migration}.test.mjs：11/11，修正后通过；已通过的其余模块未重复。
N --test --test-concurrency=1 test/{extraction-task-store,source-processing-trace,exploration-skill-sources}.test.mjs：20/20。
N --test --test-concurrency=1 test/{history-runtime,memory-management-handoff,model-host}.test.mjs：9/9。
N --test --test-concurrency=1 test/{skill-files,memory-management}.test.mjs：初次24/25；DTO单例按保留的状态历史修正后1/1；期间运行的1个旧103 Python oracle随后显式隔离，不计Node覆盖。
N --test --test-concurrency=1 test/schema-prepare.test.mjs：8/8（旧schema比较器原断言登记到固定旧树）。
N --test --test-name-pattern='官方profile/原adapter/真实ModelHost与PG.*record_ack' test/extraction-model.test.mjs：1/1。
N --test --test-name-pattern='真实DSH被SIGKILL' test/host-launch.test.mjs：1/1。
N --test --test-concurrency=1 test/{usage-summary-http,preference-management}.test.mjs：12/12，含偏好范围/CAS/幂等/删除/来源失效与旧大修订。
桌面N --test tests/{assistant-candidate-carry-contract,dead-code-removal,reply-contract}.test.mjs：初次10/11；TS原因枚举阈值修正后对应单例1/1。
桌面N --test tests/test-inventory.test.mjs tests/packaging/{build-space,runtime-attribution}.test.mjs：初次17/18；缺npm PATH的门禁单例用所给npm-cli私有临时symlink复验1/1，实际打包被门禁拒绝。
N test/run-current.mjs --list：164现行/72历史文件，只登记未执行；N test/run-historical.mjs --list：163文件/14历史case，固定23a767330e4af8a024629a00c8740344be564259。
桌面N scripts/test-inventory.mjs：126safe-node/18headless/28isolated-http-pg/9native/11app/91historical；79个Python资产仅历史登记，safe-node未缩减。
历史命令：NOTALONE_HISTORICAL_PYTHON=/独立venv/bin/python npm run test:historical -- backend <登记文件> [--test-name-pattern=...]；另支持desktop-node/pages/app原范围。
历史边界：无venv的显式历史命令已确认失败关闭（未建临时树）；固定旧树/独立venv实际历史命令未运行。早期旧fixture smoke曾执行旧Python合成建库，后续Node smoke已独立通过。
清理：本轮自有合成库、模型socket/进程与临时npm symlink均由夹具/命令收尾；未动既有4未知库、旧scratch/资源。未做全库清扫。
新增直接模块：N --test --test-concurrency=1 test/{host-model-unconfigured,skill-host,task-api}.test.mjs：9/9，核心业务默认保留，旧IPC/transfer/gateway精确case历史隔离。
待root：统一TSC和已授权最小真实开发闭环、本地提交；本组未运行全量或实际App，不能冒称这些通过。
