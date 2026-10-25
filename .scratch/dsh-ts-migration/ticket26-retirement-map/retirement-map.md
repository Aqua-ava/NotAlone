# Ticket26 退役盘点（只读准备）

固定候选：`dd97457bdd604fbda970c6eb0e5dc406ab1157bd`。日期：2026-10-26（Asia/Taipei）。Ticket26 仍为 `open`，依赖25；未收到主协调“25通过实施”前不得实施。25完整回归、独立源码复核及实际App/微信由主协调完成，本清单不作签收。

最新范围：真实记忆仅初步跑通，内容质量后续调整；旧两争议、完整记忆语义矩阵与120不阻塞本阶段。**不能将此写成质量passed。**

本轮仅新增本目录三个清单文件；未改生产源码、tests、锁、README、任务状态、index或提交。未读取.env、真实资料、密钥或原账本，未运行App/微信、模型、测试、依赖安装或打包，未委派；未清理任何既有scratch。下方命令是下一实施会话的计划，尚未运行。

## 实际调用链与切断点

`desktop/package.json:9 dev` → `scripts/dev.mjs:77`继承环境 → `src/main/index.ts:54`核验开发入口并设置project → `backend/config.ts:83`选择runtime → `startup/diagnostics.ts:185`读schema/准备 → `backend/host.ts:205`复用或冷启动 → `backend/process.ts:27` → `backend-ts/src/launch.ts:162`官方profile → `host-plugin.ts:90`环境选择 → 默认旧业务/Python旁车或显式纯TS → HTTP/事件、Worker、资料 → `host-plugin.ts:225`停止接收与资源排空 → `launch.ts:126`profile/锁/自有进程回收。

编号对应 `paths.json.findings`，证据行号全部针对固定候选；完整可复制文件分组在 `path_groups`，不是删除指令。

| 编号 | 入口、调用方与当前行为 | 退役动作及关键风险 |
| --- | --- | --- |
| D01 | `desktop/package.json:9`、`desktop/scripts/dev.mjs:77`、`desktop/scripts/dev.mjs:84`；npm dev继承HOST选择且监督Python目录，删目录会使watch失败。 | 开发入口默认唯一TS，移除Python watcher及帮助；保留SQL和TS watcher及认证重启。 |
| D02 | `desktop/src/main/backend/config.ts:11`、`desktop/src/main/backend/config.ts:40`、`desktop/src/main/backend/config.ts:83`；旧路径配置兼容与runtime选择绑在一起。 | 允许旧pythonExecutable字段存在且不再stat/执行；新配置无需该字段；保留原env/info/资料路径、业务身份及managed/external语义。 |
| D03 | `desktop/src/main/backend/host.ts:239`、`desktop/src/main/backend/process.ts:27`、`desktop/src/main/backend/process.ts:36`；BackendHost冷启动无条件要求Python字段；只验证config不足。 | 解除Python门禁并去掉Python分支，只经launchDsh；覆盖无字段/失效旧字段的真实冷启动。 |
| D04 | `desktop/src/main/startup/diagnostics.ts:154`、`desktop/src/main/startup/diagnostics.ts:186`、`desktop/src/main/startup/diagnostics.ts:200`；诊断读schema可用Node，但缺HOST选择时prepare回到Python。 | 统一Node诊断及schema-prepare-cli；去掉startup_database/startup_diagnostics模块执行和Python错误分支。 |
| D05 | `desktop/src/main/startup/managed-runtime.ts:112`、`desktop/src/main/startup/managed-runtime.ts:167`、`desktop/src/main/startup/managed-manifest.ts:8`；受管PG监督和schema仍有Python分支，清单强制要求旧后端。 | 统一managed-postgres.ts和Node schema；更新共用manifest与声明类型；不移动原PG cluster、state及runtime.env。 |
| D06 | `desktop/src/main/backend/host.ts:225`、`desktop/src/main/backend/runtime-client.ts:46`；连接复用只证明runtime=dsh，旧DSH壳内仍可有Python。 | 复用需验证唯一TS执行责任及hostRuntime；旧活实例先认证停读/退出，不能只因握手存在继续复用。 |
| D07 | `desktop/src/shared/startup-bridge.ts:1`、`desktop/src/main/startup/diagnostic-export.ts:8`、`desktop/src/renderer/StartupSettings.tsx:164`；UI与诊断合同继续要求用户准备Conda Python。 | 移除正常设置中的Python必填与Conda修复引导；旧字段和旧错误只作可解释兼容，不让旧文件被未知键校验拒绝。 |
| H01 | `backend-ts/src/pure-ts-runtime.ts:3`、`backend-ts/src/history-runtime.ts:9`、`backend-ts/src/host-model-runtime.ts:38`；HOST缺省legacy，其他运行选择缺省python。 | 无选择时也唯一TS；移除legacy/python执行选项；显式退役selector给可操作错误且不改写用户资料，不能隐式回退。 |
| H02 | `backend-ts/src/host-plugin.ts:13`、`backend-ts/src/host-plugin.ts:596`、`backend-ts/src/legacy-backend.ts:29`；DSH正式插件导入并启动Python旁车。 | 先切走业务代理与所有导入，再删除LegacyBackend；保留官方profile、HTTP/事件合同与单一写者。 |
| H03 | `backend-ts/src/host-plugin.ts:167`、`backend-ts/src/host-plugin.ts:187`、`backend-ts/src/host-plugin.ts:207`；同步事件/撤销/状态、资料、记忆及通配路由仍可代理Python。 | 逐路由绑定既有TS实现；缺失时明确失败，禁止通配legacyRoute兜底；保留关闭停读与同联系人隔离。 |
| H04 | `backend-ts/src/host-plugin.ts:477`、`backend-ts/src/host-plugin.ts:484`、`backend-ts/src/contact-handoff.ts:8`；联系人/记忆handoff显式接受python，初始owner也是python。 | 取消转回旧写者接口与状态缺省；保留进入/排空/世代/关闭门禁并映射TS或unavailable。 |
| H05 | `backend-ts/src/task-control.ts:2`、`backend-ts/src/task-control.ts:41`、`backend-ts/src/task-control.ts:105`；TaskControl和Skill接管仍导入旧后台类型/运行错误类。 | 删除PythonTaskControlGateway与transfer旧桥，复用ExtractionWorkerTaskControl/activateStandalone；迁出稳定错误映射，避免删类导致正常TS导入断裂。 |
| H06 | `backend-ts/src/host-model-runtime.ts:98`、`backend-ts/src/host-model-runtime.ts:110`、`backend-ts/src/host-model-runtime.ts:133`；TS模型运行仍生成Python远程环境，但许可server/journal也被TS使用。 | 去掉仅跨Python的环境出口与stopPython回调；不要删除TS仍使用的permit/journal/记账/在途结算。 |
| H07 | `backend-ts/src/launch.ts:12`、`backend-ts/src/launch.ts:85`、`backend-ts/src/launch.ts:114`；launch/退出清理仍带Python配置与legacy.pid回收。 | 先核验旧旁车已退场再收敛清理；保留DSH PID身份/nonce/profile所有权、寿命锁、SIGTERM/SIGKILL收尾与PG排空顺序。 |
| H08 | `backend/src/notalone/server/command.py:391/393/405`、`server/model_control.py:16`、`server/reply_wiring.py:134`；Python侧还选择EXTRACTION_B/TASK_WORKER及回复的python默认。 | 连同旧生产树/桥退役；字段级完整位置见`paths.json.runtime_selector_inventory`，旧业务NULL/v1政策与执行器选择分别保留/退役。 |
| P01 | `backend/pyproject.toml:10`、`backend/pyproject.toml:13`、`backend/pyproject.toml:15`；Python生产树含475个py及2个旧服务HTML，CLI全部在pyproject注册。 | 移除生产实现、CLI安装和旧框架依赖；backend/database/migrations原字节保留；历史对照从固定git树及独立venv取得，不能从退役后HEAD import。 |
| P02 | `scripts/install.sh:34`、`scripts/install.sh:66`、`scripts/install.sh:70`；机器安装脚本强制Conda/pip/旧迁移模块。 | 安装改成固定Node依赖与Node schema seam；沿用已有数据库与配置，不能因退役重建默认库。 |
| P03 | `desktop/scripts/prepare-runtime.mjs:18`、`desktop/scripts/prepare-runtime.mjs:59`、`desktop/scripts/prepare-runtime.mjs:79`；运行时准备仍下载CPython/wheel，拷贝backend/src并安装wheel。 | 同步更新runtime契约、prepare/verify/替换工具及Python锁/归因；保留PG和原生依赖。只改静态入口，不执行打包、不解除release gate。 |
| P04 | `.github/workflows/ci.yml:36`、`.github/workflows/ci.yml:41`、`backend-ts/package.json:24`；CI仍安装Python并只compileall旧生产树。 | 改为匹配锁定Node/pnpm的TS检查；不要将删除compileall当业务测试通过，Node测试需说明PG/平台条件。 |
| P05 | `scripts/prepare_memory_embedding.py:20/25`、`backend-ts/src/retrieval-embedding.ts:15`、`scripts/replay_grounded_extraction.py:9`；本地embedding运行已Node，准备脚本仍用Python依赖。 | 原模型/缓存位置保留；当前准备入口需迁Node或明确历史隔离，旧评测绑定固定git树/独立venv；已有缓存不能证明准备链无Python。 |
| T01 | `backend-ts/test/host-storage-fixture.mjs:12`、`backend-ts/test/host-storage-fixture.mjs:14`、`backend-ts/test/host-storage-fixture.mjs:15`；正常Node夹具用HEAD Python migrate及Python DROP DATABASE。 | 先改为Node pg创建/清理自有随机_test库并调用prepareDatabaseSchema；逐项保留来源、隔离、删除及错误断言。 |
| T02 | `backend-ts/test/schema-prepare.test.mjs:76`、`backend-ts/test/schema-prepare.test.mjs:80`；schema test正常套件内仍含直接从HEAD导入Python迁移的比较器。 | 纯Node兼容断言继续默认运行；旧schema比较器改显式历史入口，从固定git树+独立venv执行，不能因失去backend/src而被动失败或隐藏skip。 |
| T03 | `backend-ts/src/schema-prepare-cli.ts:6`、`backend-ts/src/schema-prepare.ts:63`、`backend-ts/test/pure-ts-runtime-fixture.mjs:14`；已有纯Node schema/夹具/宿主测试可作为迁移seam。 | 复用现有seam；增加无HOST选择的正常入口、旧配置兼容和0Python观测，不能只重复显式typescript测试。 |
| T04 | `desktop/tests/assistant-candidate-carry-contract.test.mjs:14`、`desktop/tests/assistant-candidate-carry-contract.test.mjs:21`、`desktop/tests/dead-code-removal.test.mjs:63`；桌面部分安全测试仍执行或读HEAD Python合同，页面CLI强制Conda。 | 迁移到同一TS合同/合成HTTP；历史专用夹具显式隔离并保留登记；不把环境skip或只登记未执行写成通过。 |
| T05 | `backend-ts/test/reply-comparison-runner-integration.test.mjs:4`、`.scratch/dsh-ts-migration/ticket25-final-run/runner.mjs:23`、`.scratch/dsh-ts-migration/ticket25-final-run/runner.mjs:169`；历史runner存在固定git旧树，但默认硬编码Conda且默认Node测试会导入。 | 将旧执行器固定commit/源哈希/依赖锁与显式独立venv；与默认TS生产及测试启动隔离。保留纯JS材料/报告断言，旧实际执行单独报告。 |
| N01 | `desktop/scripts/wechat-components.mjs:10`、`desktop/scripts/wechat-components.mjs:12`、`desktop/scripts/wechat-components.mjs:54`；微信LLDB组件自身含CPython；它与后端runtime的CPython来自两套锁。 | 单独核验微信工具需求与加载/子进程。0Python后端进程不证明无嵌入CPython；不能为清字符串破坏微信原生链路，也不能将保留的依赖隐去。 |

## 配置、资料与契约必须保留

- 旧`backend-launch.json`里的`pythonExecutable`是**可读的废弃字段**，不能因未知键、字段数、绝对路径/X_OK或文件不存在而拒绝原用户；它不再参与runtime选择或子进程启动。新配置不必填写。保留`projectDirectory/envFilePath/backendInfoPath/wechatCliPath/syncProbePath`原值及原数据归属；隐藏旧UI字段时不得静默重写或清空原配置。
- 沿用原`.env`、PostgreSQL、owner/contact/channel身份、Skill目录、资料目录及迁移/删除决定；不连接实际库进行本轮盘点。`backend/database/migrations`原116份SQL及历史checksum不可改，**不能删除整个backend目录**。Node更新失败或结构不明时停写，不新建替代空库。
- `model-host`、permit/journal、来源证明中的Python JSON/Unicode/时间合同、旧NULL/v1政策与来源字段并不等于Python子进程。`host-model-runtime.ts:98`仍通过Node许可端点执行TS提取，不能按名称删掉许可和结算。历史文档、测试名称与兼容函数中的Python文字不要求清零。
- `N01`是独立的真实依赖边界：微信工具锁要求`debugger/bin/python3.12`与`libpython3.12.dylib`，LLDB合成探针执行内嵌Python。此盘点未证明微信运行期是否创建Python子进程；后端退役验收必须分别报告“0Python子进程”和“工具内嵌CPython仍保留/已另行验证移除”，不能含混宣称全产品无Python依赖。不要借26擅改原生工具或取消微信能力。

## 最小实施顺序（仅在25通过后）

1. 核对25新证据和候选变更，收到主协调实施指令后再认领26；重新检查dev实例与文件归属。固定DSH仍为`0.2.1-rc.2`，pnpm `11.25.0`；源码commit `687f282e8625c6b8d11ff58211a90524be2e4317`。本轮只核manifest/既有来源指针，不宣称重验DSH API；实施前读该commit的启动/profile及相关生命周期源码（见[01基线](../baseline/behavior-matrix.md#L15)及[ADR-102](../../../architecture/adr/102-dsh-typescript-backend-migration.md#L18)），保留官方profile装配，不改核心。
2. 先把正常Node夹具迁到`pg`+`prepareDatabaseSchema`：至少`host-storage-fixture.mjs:12–27`、`usage-summary-fixture.mjs:12–27`、`host-model-unconfigured-fixture.mjs:14–16`及其调用方；`paths.json.test_dependency_inventory`列出更广候选。现有`pure-ts-runtime-fixture.mjs:14`可复用。只对本轮自有随机`_test`库创建/删除，不共享真实库。
3. 将HOST/reply/extraction/history默认值及正常启动固定为TS，同时改桌面冷启动门禁、旧配置兼容、Node schema/受管PG分支、runtime复用证明与watcher。必须测试**不设置HOST flag**、旧`pythonExecutable`存在但不可执行、没有该字段三种情况；原纯TS测试显式设置flag，不能单独证明新默认。
4. 逐个切除`host-plugin`的Python代理、handoff转回接口、Gateway、Skill transfer、Python远程模型环境；先迁移仍共用的错误映射/门禁/许可生命周期，再删`legacy-backend.ts`。保留在途取消、来源删除、迟到结果、同步停读、异常父进程退出与资源归属核验。
5. 默认测试中的Python对照要迁移或显式隔离：`schema-prepare.test.mjs:76`虽称“隔离”，仍从HEAD import；回复runner旧臂已有固定`git archive`，但硬编码Conda且其Node准备仍依赖HEAD夹具。历史臂使用固定git树/锁/独立venv，独立命令显式开启，不能作为正常启动兜底，也不能删除断言或隐藏skip来取得绿色。三个用户已有desktop测试文件不修改、不归属；实施若受其阻塞交主协调处理。
`scripts/prepare_memory_embedding.py`的固定本地模型准备单列处理，不能仅因已有缓存跳过；旧Python测试/开发评测的完整资产组见JSON。

6. 在所有生产/正常测试消费者切断后，删除`backend/src`生产实现与`backend/pyproject.toml`安装入口，收敛runtime准备/校验/锁/归因/替换工具、`scripts/install.sh`、CI及现行实现文档。SQL、PG、原生工具及仍适用许可保留；发行脚本只静态修正，无发布授权不运行package/运行打包版、不解除release gate。最后回归后按主协调授权处理本地提交，任何远端另需用户同意；本准备会话不操作Git index/commit。

## 下一会话最小验收命令

先设置Node工具目录变量（取当前已经核验的Node/npm位置，不写入本机路径到公开证据），确认Node主版本>=24。以下均在仓库根目录起步；测试流水线用`set -o pipefail`保留失败退出码。合成PG及本机原生测试条件必须按工程流程核验，失败先回到单例。

```bash
set -o pipefail
# 单例：先保留纯Node迁移/空库验证，旧Python比较器已隔离后才跑整个文件。
(cd backend-ts && node --test --test-name-pattern='无 Python 和 Conda 的首次 schema' test/schema-prepare.test.mjs) 2>&1 | tail -60
(cd backend-ts && npm run typecheck) 2>&1 | tail -60
(cd desktop && npm run typecheck) 2>&1 | tail -60
# 模块：schema、原NULL/v1快照、CLI诊断、纯TS启动与生命周期。
(cd backend-ts && node --test --test-concurrency=4 test/schema-prepare.test.mjs test/extraction-policy-version-migration.test.mjs test/extraction-policy-version-task.test.mjs test/pure-ts-runtime.test.mjs test/pure-ts-lifetime.test.mjs test/pure-ts-shutdown.test.mjs) 2>&1 | tail -60
(cd desktop && node --test tests/pure-ts-startup.test.mjs tests/pure-ts-managed-runtime.test.mjs tests/startup-schema-guard.test.mjs tests/development-policy.test.mjs) 2>&1 | tail -60
# 默认套件必须不再依赖Conda，也不能通过扩大skip取得结果；Node/npm目录必须是真实Node工具链。
export NOTALONE_NODE_BIN="$(dirname "$(command -v node)")"
(cd backend-ts && env -u CONDA_PREFIX -u CONDA_DEFAULT_ENV -u PYTHONPATH -u PYTHONHOME -u NOTALONE_HOST_RUNTIME -u NOTALONE_REPLY_RUNTIME -u NOTALONE_EXTRACTION_RUNTIME -u NOTALONE_HISTORY_RUNTIME PATH="$NOTALONE_NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" perl -e 'alarm 600; exec @ARGV' -- npm test) 2>&1 | tail -60
(cd desktop && env -u CONDA_PREFIX -u CONDA_DEFAULT_ENV -u PYTHONPATH -u PYTHONHOME -u NOTALONE_HOST_RUNTIME -u NOTALONE_REPLY_RUNTIME -u NOTALONE_EXTRACTION_RUNTIME -u NOTALONE_HISTORY_RUNTIME PATH="$NOTALONE_NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" perl -e 'alarm 600; exec @ARGV' -- npm test) 2>&1 | tail -60
(cd desktop && npm run test:inventory) 2>&1 | tail -60
# 实际dev由主协调独占；先看状态。已有实例复用，但须正常退出旧环境后再验证清洁PATH冷启动。
(cd desktop && npm run dev:status)
```

上面是**现有命令**的建议组合；具体文件是否存在由本清单校验，下次候选改变后先复核。新退役测试按实际新增文件补入，不臆造不存在的测试名。`backend-ts/package.json:32`默认只取顶层`*.test.mjs`，显式历史入口隔离不得丢失原业务覆盖；`desktop/scripts/test-safe.mjs:10`只取safe-node，不能代替App验收。

实际dev冷启动模板（由主协调先正常退出旧实例并核验归属后再执行；保留既有资料，不传新用户目录）：

```bash
NOTALONE_T26_PRIVATE_DIR="$(mktemp -d /tmp/notalone-ticket26.XXXXXX)"
chmod 700 "$NOTALONE_T26_PRIVATE_DIR"
(
  cd desktop
  umask 077
  nohup env -u CONDA_PREFIX -u CONDA_DEFAULT_ENV -u PYTHONPATH -u PYTHONHOME -u NOTALONE_HOST_RUNTIME -u NOTALONE_REPLY_RUNTIME -u NOTALONE_EXTRACTION_RUNTIME -u NOTALONE_HISTORY_RUNTIME PATH="$NOTALONE_NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" npm run dev > "$NOTALONE_T26_PRIVATE_DIR/dev.log" 2>&1 &
  disown
)
(for i in $(seq 1 60); do /usr/bin/grep -q '开发模式：React/CSS 保存即更新' "$NOTALONE_T26_PRIVATE_DIR/dev.log" && exit 0; sleep 1; done; exit 1)
(cd desktop && npm run dev:status)
```

实际dev验收：主协调沿工程规范把日志写到仓库外0700目录/0600文件，先核验并复用实例；冷启动时在原配置与同一原资料上去掉Conda PATH并不设置HOST选择，按`nohup npm run dev`监督方式后台启动，单条有界等待及`dev:status`核对监督器/实际宿主。不要从本清单直接启动第二份，不运行打包版。

| 必验项 | 可复核最小结果 |
| --- | --- |
| 无Conda正常dev | 旧字段存在/缺失两类配置都打开同原资料；失效Python路径不阻断；正常默认不需runtime flag；原owner/联系人/模型配置仍在。 |
| 真宿主0Python | 仅采样本轮自有dev/DSH/PG进程树，覆盖schema准备、启动、导入、生成、后台任务及退出；记录进程名/所有权及结果，不能只看status中legacyPid为空或某一瞬间ps。未知进程不杀；原始命令行不公开。 |
| Node迁移与旧快照 | 原116份SQL/审计基线/checksum、原NULL/v1政策不升级、102 Skill与114→116原地更新、未知/改变账本停写及同原身份；合成库执行，真实原库验收由主协调核对。 |
| 生成/停止/切换 | 同联系人候选依据可见、可编辑；取消/切换后迟到结果不提交，讨论重开可恢复且无额外DSH长期日志；外部发送仍只由用户操作。 |
| 授权同步/历史导入 | 既有授权范围、默认所选与明确全部私聊、撤销不复活、历史覆盖/增量去重、关闭即停读、导入预览/单联系人确认/重复不重复写。 |
| 记忆审阅/删除 | 显示、修改、审核及来源删除/联系人删除后不可检索、不被在途或重启恢复；实记忆只标初步跑通，质量后续。 |
| 退出/故障 | 正常菜单退出、取消/任务结算、原生观察/CLI/模型连接关闭、PG共享寿命锁释放、DSH profile/握手清理；父进程退出/异常重启不得另起旧Python。 |

## 本轮核验与剩余风险

盘点中另见`backend-ts/test/exploration-store.test.mjs`与`backend-ts/test/wechat-setup.test.mjs`出现其他工作树变动，未归属、修改或读取其变更正文；后续实施须先与主协调核对候选更新。

仅完成静态候选路径/行号/调用关系盘点、机器列表结构及保护范围核验；没有执行上述业务验收。普通工具shell的PATH未提供node，查询了应用只读运行时元数据并仅使用其Node核验清单（版本v24.19.0）；这不证明项目锁定运行组合已跑通。未产生原始产品日志；无新增私有资料副本。未变更既有三份desktop改动或其他scratch。25未签收、26未实施、App/微信/模型未运行，所有未运行项目均保持未验证。
