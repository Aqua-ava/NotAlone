# 03 桌面宿主与原库生命周期

状态：实现与验收完成。仅03，不提前迁移04；最终切换与退役仍属24—26。

## 固定官方依据与适配

DSH `0.2.1-rc.2`，官方提交 `687f282e8625c6b8d11ff58211a90524be2e4317`；消费锁沿02新增固定 `pg@8.16.3`、`@types/pg@8.15.5`，不改DSH核心。Node 24.19.0、pnpm 11.25.0；安装前输出卷及临时卷约148GiB可用，安装禁生命周期脚本和optional。

- [官方CLI文档及命名profile](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/README.md)：空bundles加明确patch，继续使用官方命令启动，不用直接Context替代。
- [profile启动与appReady](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/profile-boot.ts)：框架ready只在装配完成提交；产品先完成PG只读兼容及旧业务启动，再发布认证握手。
- [官方退出预算](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/src/process-shutdown.ts)：五秒后可终止整个后台。强制停止不是单任务强杀或优雅释放；桌面确认整个旧进程树退出后才重启，旧连接代际结果失效。
- [官方minimal示例](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/sdk-minimal/cordis.patch.yml)：示例含上报与持久化，未照搬。产品profile只装配02实测七个公开服务与产品薄插件；03无模型路由、无合成owner/source/model、无模型工具。05以后按功能接入模型，不提前实现。
- [node-postgres连接文档](https://node-postgres.com/features/connecting)：普通TS业务以显式原连接创建Client，事务与参数化查询留在业务层。库配置不交给DSH会话。

已消费02的锁、README、progress、interface-crosscheck、dependencies及独立runtime-audit；它们证明02发行组合与合成运行，不冒充03产品认证。原库合同另按[独立核验](database-contract-audit.md)核对。

## 责任分配

| 功能 | 03后的唯一执行方 |
| --- | --- |
| profile启动、临时HOME、认证握手、父子寿命、失败与重试 | Electron宿主＋同后台TS插件 |
| owner初始化／按受控ID恢复、模型配置与凭据保存 | 普通TS HostStorage；Python装配关闭旧setup写入口 |
| 数据库兼容只读检查 | TS在业务ready前及每次设置写前核验107完整前缀、checksum、035凭证和原必需表字段 |
| 原库结构升级／新受管库准备 | 原桌面启动门禁及Python迁移命令唯一执行；保留103 Skill文件校验钩子，不裸SQL重放、不伪造账本 |
| 联系人、回复、记忆、Skill、导入、删除、微信、任务、台账 | 本次DSH拥有的受控Python子进程，按具名HTTP路径固定转交，错误直接失败、不请求级fallback；后续票逐项移交 |

过渡Python子进程保留是spec批准的逐功能迁移，不是最终设计或第二套模型调用仲裁。03不启用TS模型请求，05才核验跨实现模型许可。产品默认开发入口启动产品host profile，02验证profile仍仅供测试。

## 数据与原首用边界

原env、数据库、业务HOME和资料目录保持；DSH每次独立临时HOME/cwd只保存profile、路径配置及寿命元数据。秘密仅在原配置与进程内，不写profile、握手之外日志或HTTP响应。退出清理仅针对本轮临时目录，不能删业务资料。

首次初始化仅空owner目录可创建；已有受控ID精确核验。缺配置且仅有一位owner时，设置页明确展示恢复操作，用户点击后只恢复原ID并重启；多位owner拒绝猜选。配置写入失败可修复后重试，不创建替代身份。响应丢失可重读配置后重启恢复。凭据0600原子保存且保留其他配置；关闭后不再接受配置写入。

承接 `local-app-first-use/02-database-lifecycle` 的既有原库合同，不把该票的所有受管建库阶段／重装／独立交付缺口算完成。微信准备继续由 `local-app-first-use/01`、`03` 和迁移18承接；本票仅保留现有微信首次连接HTTP，不重复实现准备或复活中止路线。模型本地检索准备属05，管理用途与诊断属23，独立安装验收属25及原首用09。

## 已运行验证

- TDD：取消启动、启动失败、HTTP认证／首用、旧写入口禁用、关闭后禁止写入、崩溃重试等先记录失败再实现。
- 原Python相关55例通过：startup_database、startup_diagnostics、database_migrations、skill_business_state_migration、setup_api。覆盖059原地升级保留资料、035基线、未知／分叉账本、事务中断、103损坏文件回滚及修复重试。103旧测试只预期单版，已修正为固定103—107尾部，原数据保真断言保持。
- TS HTTP／PG、配置与宿主26例通过：认证、首次／已有owner、凭据原地保留、重复账本、唯一旧执行方、未知版本停写、缺失Python启动有界失败后修复重试、035与结构漂移。
- 宿主用例包含坏profile／执行文件、重复启动、父／DSH SIGKILL、旧Python退出屏障、持内核互斥时强杀可恢复、PID复用不误杀。主会话另独立复跑“持有内核互斥／复用PID”2例通过。实际开发界面5/5通过；两轴审查发现的连接参数兼容问题已修复并复审关闭。

## 桌面状态与清理

开工只读核验已有一个真实配置开发实例及其监督器。确认其使用原配置后，向该已核验Electron发SIGTERM，沿App正常退出处理认证停读，宿主和监督器均退出；未修改原配置、未读env正文或业务库。

后续实际App验收只用 `npm run dev` 的独立合成配置与随机_test库。当前无Computer Use工具；已用明确opt-in、仅独立开发目录的loopback CDP操作实际renderer。5项均通过，见[结果](desktop/result.json)及同目录合成截图：首次初始化、合成凭据保存、后台强杀后手动重试、重新启动身份与凭据保留、唯一已有本人明确恢复。没有调用模型或读取微信，不称为Computer Use／真实微信或安装包验收。

合成库及独立用户目录已由夹具删除；`npm run dev:status` 返回 stopped、pids=[]。原配置未改动，原真实开发实例保持停止，避免验收后自动恢复真实同步或模型调用。输出卷和临时卷验收前后均约148GiB可用；本次生成的可重建开发缓存已确认无跟踪及Electron进程引用后清理，936KiB降为0。未打包、未发送聊天、未push。

## 最终验证命令

- `cd desktop && npm test`：类型检查通过；safe-node 945通过、1跳过、0失败（约52秒），不冒充原生验收。
- `cd desktop && node scripts/test-dsh-host.mjs`：实际 `npm run dev` 合成界面5/5通过，清理完成。
- `cd backend && NOTALONE_DISABLE_DOTENV=1 PYTHON_DOTENV_DISABLED=1 NOTALONE_TEST_DATABASE_URL="host=/tmp dbname=notalone_test" python -m unittest tests.integration.persistence.test_startup_database tests.integration.persistence.test_startup_diagnostics tests.integration.persistence.test_database_migrations tests.integration.persistence.test_skill_business_state_migration tests.integration.server.test_setup_api -v`：55/55通过。

## 双轴审查

固定基点 `fc8dcf50`，包含本票未提交／新增源码；独立核验报告由主会话另行提交，不归入本票修改。

### Standards

初审2项硬问题：P1受控配置PG参数未完整用于TS连接；P2原合法keyword DSN（如sslmode）被拒绝。均已修复；最终代码复审确认P1、P2关闭。另1项判断性“possible Duplicated Code”：TS与Python保留同一启动结构合同。过渡期保留显式固定合同，后续结构改动必须两处同步；不为本票引入跨语言运行依赖。

### Spec

初审同样2项问题：P1可能使TS与Python访问不同连接目标，P2阻断合法原连接。未发现额外越范围项。最终代码复审确认P1、P2关闭，无新阻断项。

- `cd backend-ts && pnpm install --offline --frozen-lockfile --ignore-scripts --no-optional`：通过，无新增依赖。
- `cd backend-ts && node node_modules/typescript/bin/tsc --noEmit && perl -e 'alarm 180; exec @ARGV' -- node --test test/*.test.mjs`：44/44通过，约25.5秒；桌面类型检查再次通过。
- 连接回归先RED再GREEN：受控PG环境贯穿官方宿主，TS初始化写原合成库，重新启动后由Python公开联系人接口读取同一库原ID；URI／keyword默认值与显式值优先级、密码文件、SSL协商均覆盖。

连接适配按[libpq连接规则](https://www.postgresql.org/docs/current/libpq-connect.html#LIBPQ-CONNECT-SSLMODE)、[密码文件规则](https://www.postgresql.org/docs/current/libpq-pgpass.html)及锁定pg/pgpass源码核对。保留受控PG参数、业务HOME密码文件及SSL模式；合成协议覆盖密码实际传入、首匹配／转义／权限与协商顺序，不代表真实证书TLS全部验收。服务文件、多主机及部分高级认证参数仍显式拒绝，未宣称通用libpq完全兼容；本票没有证据表明这些影响已确认原库场景。

两轴最终结果分别为：Standards无未关闭硬问题，保留1项非阻断重复合同建议；Spec无未关闭阻断项。未验证真实模型、微信、独立安装包或正式数据切换，继续由后续对应任务承接。

HTTP测试收尾顺序已修正为先停止宿主再删除夹具，针对性8/8复验通过；核验归属后清除了18个早期失败／旧测试收尾遗留的合成临时配置目录（约29KiB）。复验结束DSH临时目录、PG夹具目录及存活后台均为0。原业务资料不在清理范围。
