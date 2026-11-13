# 实际 App 前的夹具归属保护

本增量基于集成候选 `5c254dd04fe4575a80d50112a7f790b2a1dd7a4f`，只修改选用测试夹具及资源核验，不更改产品能力、正式票状态、S 分叉库或 main。后续根分支记录同步保留在合并历史中。

## 行为

直接 `rewrite-backend.py` 和 `import_backend.py` 在导入产品／测试装配前生成受控随机 `_test` 库名并绑定两个数据库环境变量。Core 新增默认 `None` 的可选库名 hook，仍由 Core 唯一创建和清理数据库；受控名称按完整正则、63 字节上限和 SQL Identifier 检查。Core 既有 `database-ownership.json` hook 在 CREATE 前以 0600、O_EXCL、O_NOFOLLOW 写入并 flush/fsync；创建后、迁移前精确断言 `current_database()`。默认未设置 hook 的其他 Core 调用不据此宣称已受事前 marker 保护。

两个直接入口核验 `synthetic.env` 与握手处于同一自有私有目录，接通现有 hook。runpy 包装器不预生成第二个库、不预创建重复 marker，也不夺取已有包装器的建库权。正常收尾除子进程退出外，还读取本轮私有 marker、匹配 PID／准备库名并独立确认精确库不存在，才移除目录。失败保留非秘密 marker 与 0600 的未确认记录。

`withSyntheticBackendFixture` 将私有 ownership path 显式传给 contact、memory、empty-owner-memory 和 memory-correction 入口。contact 原 hook 增加 O_NOFOLLOW、私有目录核验、双 URL 迁移环境及精确当前库断言；CREATE 前写 planned，CREATE 成功后持久化 created。自动恢复清理只接受 created，不能把仅计划建库的记录当成成功创建。memory 两个包装器透传同一路径，保留原无参／原模式调用兼容。准备解析失败仍能沿事前 marker 精确清库；进程状态、marker、后端退出或数据库不存在未确认时保留目录。

共享 `withRewriteFixture` 增加显式 marker 文件名参数，接通现有 message-events 调用使用的不同文件名，不猜测未知 marker。该旧场景的迁移 guard 仍停在 058，本轮未执行，留待最终严格前缀与组合回归核验。

## 真实验证

仅使用本任务合成数据、自有随机数据库和回环 HTTP；未运行 App、Chrome、微信、探针、租约调度、真实模型或外部发送。未读取业务配置、S 库或历史未知资源。

- 安全 red：建库前明确退出的受控 Python 脚本不导入数据库代码；旧 runner 删除目录，新增“失败应保留”检查失败。原失败为目录 ENOENT，不能记为通过。
- 首次 HTTP 轮：2 测试中 1 通过、1 失败。六条正常入口已通过精确身份／清理核验；末尾损坏 JSON 反例误选了只支持 create 的旧脚本，drop 被拒，新保护正确保留目录及 marker。它是测试驱动选择错误，与所修的无条件删目录问题分开记录。
- 上述唯一失败库由保留的私有 marker 精确恢复：准备 PID 已不存在，CREATE 路径已执行当前库身份断言；使用同一库名的 DROP IF EXISTS 后，精确 `pg_database` 查询确认不存在，才删除该自有目录。没有模糊前缀清理或未知 PID 操作。
- 将损坏回执测试改用同时支持 create/drop 的专用脚本后，原 2 测试单轮 2/2 通过；新增后端收尾失败反例单轮 1/1 通过。
- 最终同一版本单轮：`node --test tests/fixture-database-ownership.test.mjs`，3/3 通过、0 跳过，21.922 秒。覆盖 generic rewrite、generic import、contact、memory、empty-owner-memory、memory-correction 六条真实 HTTP，以及真实建库后损坏 JSON 的精确恢复，共七条正常／准备路径。另一个收尾失败场景先确认目录／0600 marker 保留、真实库仍能按双 URL 精确连接，再显式恢复 DROP、查询不存在并移除目录。该轮八个库均已销账，所有场景模型调用为 0。
- `npm run typecheck`、七个改动 Python 文件的 `python -m py_compile`、`git diff --check` 均通过。Python 与 Node 验证均在 Conda `NotAlone`，禁默认 dotenv；未运行默认 npm 调度组。

分轮结果不累加为独立用例数。新保护不能结清早期失败夹具的未知库身份或残留；历史证据以[资源证据记录](fixture-ownership-evidence-gap.md)为准。实际 App 仍由根任务后续执行，当前 HTTP 结果不认证原生权限、微信渠道或模型语义质量。

## 独立审查修复

候选 `4a06c6ead65e810ad97f7fbbba50aec36b6d42e2` 的 Standards 审查为 0 项硬性违反、1 项重复代码判断项；Spec 审查发现 1 项 P2：共享 runner 新增的尾部 ownership path 没有同步到既有 trace 入口，四种追踪页面准备都会被旧 CLI 拒绝。原七条验证未覆盖 trace，不能代替该调用者的兼容证据。

重新枚举 `withSyntheticBackendFixture` 的全部真实调用：contact App、memory App、headless memory、headless memory-correction、headless trace，分别使用 contact、memory、memory-correction、trace 四个脚本。原 contact、memory（含 empty-owner-memory）、correction 参数已兼容；本次仅补 trace 的可选末尾绝对路径和 `create_database` 向 memory 的同一路径透传，保留原无路径和三种删除模式的参数形式。改写／导入的相同安全收尾收拢为一个非泛型 Core 函数，调用者保留自己的 stop 协议、准备回执 matcher、标签及显式 marker 文件名。

新增有限 CLI 回归首先在 CREATE 前形成 red：full 模式携带新参数时命中旧参数分派的固定 `ValueError`，1 项测试失败、0 库；准备进程退出和 marker 不存在均已确认，才移除该自有空目录。接通参数后的首轮真实准备另有 1 项失败：trace 的旧人工确认调用缺少纠错审核标识，触发 `MemoryCorrectionConflictError`。该轮唯一已登记库经夹具异常清理与独立精确不存在查询销账；其余三种模式当轮尚未运行。随后只在 trace 合成确认中显式传入当前候选真实 `correction_review` 的 decision IDs，与 memory 夹具既有做法一致，不改变产品确认合同。

修复后 `node --test tests/trace-fixture-ownership.test.mjs` 单轮 1/1 通过、0 跳过，12.606 秒，覆盖 full、deletion-contact、deletion-owner、deletion-candidate 四种准备。每种均有建库前 marker、双 URL／精确当前库断言、真实准备结果和独立精确库不存在查询，四个库及目录均已销账。它只验证四种场景准备，不认证追踪页面或来源删除交互。

共用收尾改动后，原 `fixture-database-ownership.test.mjs` 单轮仍为 3/3、0 跳过，21.373 秒；另运行既有 `headless/rewrite-lifecycle-check.mjs`，受控未知命令导致子进程 exit 1，未撤销入口资源登记，诊断先保留且精确库查询为 0 后清理自有目录。类型检查、trace Python 编译与差异检查通过。上述新增验证只有合成本地 runtime，无外部模型请求、App、浏览器、微信、探针或租约调度；原失败分母继续保留。

## 同步正式 06 后的静态边界

两轴增量审查确认 `d56f94f7517cbaff8a663fd9da1c997fe254448d` 没有未解决项。随后在本安全工作树合入正式 06 根提交 `90e7daf4d762070b9b62ec4f41dd438123a13b71`，合并提交为 `851475f857cd60036d47232c6c2599246517e2fa`，无冲突。Core 安全 hook、trace 归属透传及共用收尾继续保留，同时完整保留 06 本人概览与来源／修订合同。

本次只执行静态检查：TypeScript 通过；M2 至候选差异检查通过；SQL 文件恰为连续 001–062，逐文件与正式 06 根提交一致，062 的 Git blob 为冻结源 `206cf12cc754ed7a1ec23facbb9fd9db02ba405c`。预算、历史依据、generation、本人概览夹具与生命周期测试的严格尾部均为 062。未连接数据库、未重跑 HTTP；上文 21.373 秒、12.606 秒及故障验证仍是迁移 061 下的真实执行证据，不能改记为 062 运行通过。

既有 21.922 秒日志和新增 21.373 秒日志为两轮不同结果。后两条当时仅保存在本 Agent 原始工具输出，已于本轮转录为私有 0600 文件，并在仓库外索引标注转录来源、缺少独立原始日志的失败轮及各自证明范围；没有以转录伪装当时原生文件，也没有为补日志重复执行。

## 根集成合并与静态复验

独立 Standards／Spec 增量复审均已关闭原发现：`d56f94f7` 为 0 项未解决硬性违反、0 项未解决可能异味及 Spec 0 项未解决。Spec 后续只读核对了本任务原始工具记录的指定单条输出，确认 21.373 秒 Core 轮与 lifecycle 转录逐字来源；lifecycle 原输出仍没有库 UUID，只由脚本进程内断言核验精确身份，不追认历史未知库，不认证 062。

独立 merger 在 clean 根 `ef17d598` 上，将最终候选 `2ad3fd63` 无冲突 no-ff 合入为 `45aa7e3a4cfce48b2f150dcecd264512c3078229`。16 个安全代码／测试文件与已审查 `d56f94f7` 的 Git blob 完全相同；其余 1465 个非任务文档文件与原根逐字节相同，全部产品／测试及架构文件与最终候选一致。原根三项资源／main 报告和正式 06 签收、07／08 领取元数据保留；全局仍为 7 resolved、2 claimed（07、08）、6 open，AC41 已勾／50 未勾，本增量不签正式票。

merger 实际只运行 `npm run typecheck`、工作树／暂存及 M2 至合并候选的 `git diff --check`，并用 Node 标准库核对固定 Git blob 与现有静态合同：正式迁移连续 001–062、全部与正式 06 根一致、001–058 与 M2 一致，062 与固定 S061 blob `206cf12cc754ed7a1ec23facbb9fd9db02ba405c` 一致；两预算、归属、历史依据、联系人／本人概览共六组已知夹具及生命周期尾序保持严格 062，codec 仍 version2/schema2，三处生产 Grounded 默认不变。临时检查脚本曾误要求预算夹具也含 `range(1, 63)` 而失败；按其真实的完整账本相等、精确 62 和 062 尾部门禁核对后通过，未改产品或夹具。

本次没有连接数据库、运行 HTTP／页面／App／微信／探针／模型或占用租约，没有新增动态成绩。061 的真实运行与本轮 062 静态复验分列；旧 35 个失败库的精确 UUID 仍未知，不能认证残留已清。合并提交后的公开检查 `--ref main`（只读 `df885565`）及 `--ref HEAD`（`45aa7e3a`）均 issues0；文档记录提交后再复验。未合入 main 或执行远端操作。
