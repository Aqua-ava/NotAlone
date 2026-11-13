# 手动输入首版验证

状态：任务06内部实现与组合验收已完成。2026-10-17普通统一包、独立审查、Computer Use及相同产品代码合成模型的最终证据见[组合验收](release-validation.md)；真实模型、真正无开发环境及正式分发仍未完成，不据本记录宣称正式发行。

## 接缝与范围

最高接缝为实际独立 App 的公开控件、菜单和用户输入。联系人只经公开创建／选择建立，模型密钥只输入固定合成字符串；补充接缝为真实回环 HTTP、正式迁移与随机临时 PostgreSQL。全部资料为合成，不读取用户 `.env`、凭据或默认资料库，不操作微信，不发送外部消息。

首版保留内部 `owner_id + contact_id` 范围；新建联系人没有渠道身份或桌面绑定。独立手动确认记录只给具名助手请求使用，不供 CLI／前台绑定查找。每次请求显式手动来源，准备、执行、续写、回执和退出中断继续复验原输入与执行标识；旧连接停止句柄冻结接纳时的来源，只能读取／中断原会话，不能重新生成。中断恢复仍需本次显式手动范围，并保留对方文字、方向及来源；被拒的旧操作键不可复用。

## 公开 red → green 过程

| 实际场次 | 结果及边界 |
| --- | --- |
| 冻结基线首启首次尝试 | 本人初始化正常重连等待不足，未到目标断言；不是产品 RED。 |
| 冻结基线 `manual06-red-create` | 完成首启和本人设置后，确实缺少公开“创建联系人”，保留为 RED。 |
| 初版 `green-create-red-paste` | 实际创建暴露 `ON CONFLICT (id)` 与组合主键不符；改为 `(owner_id,id)`。 |
| `green-create-red-paste-v2/v3` | helper 等待与测试源码错误分别修正，不当作产品结果。 |
| `green-create-red-paste-v4` | 创建、明确选择已通过，确实缺少“回应粘贴文字”，保留为 RED。 |
| `manual06-green` | 空目录场1/1通过；完整场缺模型时错误展示为联系人拒绝，保留 RED并修为503。 |
| `manual06-green-v2/v3` | 粘贴、方向门与设置已到达；首个候选失败。旧 fixture 未覆盖 SDK 实际 HTTPX2，不能宣称 mock-only 或零出站。 |
| `manual06-green-v4` | 发现护栏缺口后主动停止在本人初始化阶段；不是产品失败或通过。 |
| `manual06-green-v5` | OS profile 拒绝了本地租约 Unix socket，App未启动。 |
| `manual06-green-v6` | OS profile 作用整个 Electron，Chrome helper 内部sandbox冲突SIGABRT，未到首窗；未关闭Chromium安全沙箱。 |
| `manual06-green-v7` | 双层网络限制下真实模型Mock、方向门、依据、编辑、甲乙切换通过；测试误要求切回恢复编辑输入，改按既有清空合同核对候选原输入快照。 |
| `manual06-green-v8` | 删除讨论、合成503及同请求重试通过；退出因缺模型时遗留未知作业被阻止，保留真实RED。 |
| `manual06-green-v9` | 首次正常退出与搬动重开通过；旧模型预算失败已领取输入，模型设置重载前未排空，最终退出阻塞并240秒超时，保留RED。 |
| `manual06-green-v10` | 公开旧模型恢复后生成已通过；退出后测试再次访问已释放的Playwright进程对象，fixture报错，改为预先缓存ChildProcess。 |
| `manual06-green-v11` | 同包公开完整场1/1通过，44.8秒；初始App与搬动重开后均正常菜单退出、PG退场及握手消失。 |

早期一次独立 SDK 诊断使用固定合成 key／合成文字收到官方401，前述 App 候选失败也不能排除同类出站。没有使用真实凭据或私人资料，失败证据保留。后续测试包显式覆盖 HTTPX0.28.1及HTTPX2 2.13.1，并独立拒绝外部socket；Python测试入口再套OS网络profile，外部nc返回Operation not permitted、回环动态端口成功。正式包完全排除这些测试替换。整个Electron的失败profile后改为仅包装测试Python入口，按自身目录解析原PBS与profile，监督器及后台继承OS限制，搬动重开仍验证哨兵。

## 补充公开 HTTP

`tests.integration.server.test_manual_input` 与 `test_manual_model_recovery` 共7项通过：创建幂等、初始未选择／未确认拒绝；手动模式仅限本联系人助手端点；跨owner拒绝；外部／手动已准备作业不能相互接管；粘贴文字须方向并保留独立依据，准备→执行→续写与历史来源保持；没有新增规范消息或长期记忆。纯新内部联系人可预览／确认单联系人文件，预览不写资料，混杂／损坏422，导入不建立外部绑定；公开来源删除请求及任务执行后消息不可检索、来源deleted，跨owner删除404。

旧 `deepseek-chat` 配置在0模型调用时被预算门阻止；不带明确确认的新官方配置请求400；用户明确目标和新合成key后保存200，重装配后真实SDK通过MockTransport生成，响应不含密钥。

缺模型 prepare 现在通过同owner锁的既有未领取证明提交无正文失效键，返回精确503／reply_unavailable。恢复模型后旧键仍拒绝；同键已准备／排队、实际运行或完成时503均不带证明。Main仅对同联系人、会话、请求的精确证明解除本次待核对，未知作业门禁保持。

模型配置重载与资料更新统一经`BackendHost.prepareRuntime`的内部排空门，门内暂停接纳／派发，持原认证目标核对并中断已接纳作业；失败不停止、不换代际。配置重载用独立`configuration_reload`来历，退出仍`app_quit`；已有终态来历不被重写，历史显示准确并可由用户显式恢复。

独立真实Main＋认证HTTP／PG负例1/1通过（不启动App）：公开创建／确认联系人、预算失败后，对原会话读取与中断临时返回503，重载被拒且原generation／connected保持、联系人认证读取仍成功、shutdown为0；解除故障后可读原失败输入，`generation_active`仍未知，经原身份ACK才停止成功。执行`cd desktop && node --test tests/manual-connection-change-http.test.mjs`，须已激活Conda。该场不加入默认不启动PG的safe测试。

后端unit最近一次1506项通过。桌面 `npm test` 类型及安全调度93项通过，该命令未运行真实App。相关61项HTTP回归首次有1项续写超时、1项因缺显式隔离库被跳过；该超时项独立重跑通过，不能据重跑宣称唯一根因。启动诊断／旧库接管35项首次有2项`adoption_writers_present`，独立重跑2/2通过；新增旧59只读pending／最新账本缺手动表schema_incomplete及改动的迁移列表3项通过。04已定位相同autovacuum条件的修复待组合；未放宽生产门禁或通过sleep掩盖。最终组合回归另记。

## 当前仅测试包

本机产物位于任务工作树 `desktop/artifacts/manual06-package-green/NotAlone-darwin-arm64/NotAlone.app`；不是正式发行包。冻结底座原字节未修改；只保留一份自有runtime克隆与当前测试包，旧包仅保留ASAR／清单摘要。

v11验收对应测试包v8的 ASAR SHA256：`4d4c652efc0f955efbb8a44c709b599c5a9474c6e91a7ce522f23b2fcfd01cc1`。
测试 runtime manifest：`ac772262e6f2cd1b60dc30e05a58fce59818e8b75028c8110c604c397b4ad6e2`。
后端 wheel：`fc0f19e2fd6b70c41d6a2bb3ba3dc0e42a6e8c7ba4cad9a97afcb1abf32e9c88`。
测试Python wrapper：`9a7cd67454ba2e660c639e2825591a84d9bb4ffd1a50ab4b2ea7fd10d192ba6a`。
同目录原PBS binary：`efa4aeb5a88a656d28f5da5317d5b990f56ef0acd5cdbfe300f8fc435f31c49b`。
OS profile：`8a12cfd33ed92142fc1935f4abbb65cda39ebfec1741da61489bac7a52100290`。
传输fixture：`cc084ac9938e50b85286c680afc36d074690fc1e6cbb3c44d6fe49d98f70c2ff`。

此包包含完整手动闭环、未领取证明和配置重载排空修复；后续仅启动诊断必要表／构建验证集合适配在源码回归，统一最终包需重新构建，不补签旧包。

v11首runtime实际Mock调用6次（其中合成503失败3次），最后runtime1次；实际输入模式分别为`reply_to_pasted_text / user_current_chat`和`rewrite_draft / user_draft`。每次启动前SDK哨兵独立进程计量，不混入模型调用数。没有真实模型质量或供应商可用性结论。

wrapper按自身目录找到profile和原PBS，搬动不依赖源码路径。每次启动前用同包解释器执行 `sitecustomize.assert_sdk_canary()`，确认实际SDK命中Mock且socket护栏拒绝外部目标；App连接后先检查固定护栏分类，才进行公开模型操作。

第三方核对：Context7工具不可用。HTTPX官方[MockTransport说明](https://www.python-httpx.org/advanced/transports/#mock-transports)、LangChain官方[`_compat.py`](https://github.com/langchain-ai/langchain/blob/master/libs/partners/openai/langchain_openai/_compat.py)与运行时已安装源码／版本共同核对；HTTPX2公开MockTransport代码从包内对应源码复核。文档不代替实际包接线验证。

## 实际验证命令

Python均先激活`NotAlone`，使用本工作树`PYTHONPATH`及`NOTALONE_DISABLE_DOTENV=1`，没有改共享editable安装。

```bash
PYTHONPATH=backend/src:backend NOTALONE_DISABLE_DOTENV=1 python -m unittest tests.integration.server.test_manual_input tests.integration.server.test_manual_model_recovery -q
PYTHONPATH=backend/src NOTALONE_DISABLE_DOTENV=1 python -m unittest discover -s backend/tests/unit -t backend -q
npm --prefix desktop test
npm --prefix desktop run build
```

仅测试包：后端用`pip wheel --no-deps --no-build-isolation`产生普通wheel，安装到自有克隆runtime并重新生成组件清单；测试fixture、wrapper和profile仅复制到该克隆。使用`package.mjs --runtime-directory ... --electron-zip-directory ... --output-directory ...`正常打包并严格ad-hoc签名核验。实际App由`test-app.mjs --interactive --coordinator manual06 --from ... --until ... --max-launches 2 --grep 公开手动输入 --output artifacts/manual06-green-v11 tests/manual-first-release.spec.ts`调度，显式指定本例测试包与`NOTALONE_TEST_MANUAL_MODEL_FIXTURE=1`。不把测试runner时间／次数参数解释为用户授权缺口。

清理按每场`app-test-owned.json`精确PID、userData和包路径核验；正常退出必须确认App、后台、PG和握手退场，失败强制回收不算正常退出通过。只有主Agent复核归属后才释放曾保留的未知租约，未操作用户已有App或资料。

## 与已有资料更新及修改运行时的组合

本任务生产提交`617936fe`随后合并统一基线`4e8a09c3`；只在旧库迁移期望列表保留060，并同时保留两边真实验收记录。普通模型设置重载与04资料更新都沿`BackendHost.prepareRuntime`同一原连接排空门。组合后公开startup／adoption／manual／model HTTP共42/42通过，真实Main连接门1/1与04两轮资料更新cycle1/1通过，类型和safe101项通过。先前35项中的writers_present失败记录保留；本轮带入04对autovacuum边界的修复后完整相关组通过，没有降低真实写连接的阻断门。

上述组合测试仍未构建普通最终App；v11测试包摘要不会改写成新组合包摘要。新增手动确认表的启动检查已通过公开只读命令验证：旧59仅pending且不建表；账本完整但手动表缺失时schema_incomplete，不到业务选择时才报错。运行时工具验证脚本将本包正式SQL文件名集合与实际applied逐项比对并输出实际数量，最终60项工具实跑由统一标准builder完成。

## 官方配置恢复的解析一致性修复

在`eb844b46`审查基线上补充离线回归：旧`export KEY=...`、等号空格与重复赋值会在官方恢复后残留；清空环境的新进程执行正式`load_project_env`仍采用旧地址、模型或密钥。设置服务的普通密钥／本人写入和导入命令的本人持久化存在同类问题，普通写入也未采用原子替换。新增回归首次14项中5处失败，保留此RED事实。

现在全部持久化复用正式`_parse_line`识别本次键的所有旧赋值，写入0600临时文件、flush／fsync后一次原子替换。官方恢复同时保存接收方、模型与新合成密钥；普通密钥更新保留已有接收方和模型。混用重复行、注释、其它配置与末尾无换行均覆盖；三个App配置场通过真实新子进程重载验证。替换故障保留旧文件及进程配置且清理临时文件。定向命令`PYTHONPATH=backend/src:backend NOTALONE_DISABLE_DOTENV=1 python -m unittest tests.unit.application.test_setup_service tests.unit.test_runtime_config tests.unit.ingest.test_import_command -q`共19/19通过（先激活`NotAlone`）。全部文件为临时合成配置，未启动App／数据库、未联网或重建包；旧v11产物不包含此后续修复。
