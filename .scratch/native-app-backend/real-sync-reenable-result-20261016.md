# v7单联系人同App总开关重开实测

日期：2026-10-16（台北时间）。当前v7包在同一App、同一后端内完成公开总开关开启→关闭→重新开启、自然周期复验及正常菜单退出，单case实际`1 passed (2.2m)`、runner exit0、`passed=true`、`stage=complete`。关闭确认后的65.926秒内真实CLI新启动0，重开后真实有界tail完成并被范围guard接受、补齐状态complete，消息／来源引用／重复身份实际均为0。

这是空窗口的关闭边界、有界补读尝试、状态及零计数验证；不认证关闭期间新增消息的正向恢复、无丢失、来信、双联系人、App／后端重启或整张04票完成。本场没有独立Computer Use观察，不把同goal其他v7场次的CUA证据移入本case。

## 版本、范围与原件

runId：`0523c9bc-d2a6-4fdc-9787-3edac2079fb2`。正式包为`desktop/artifacts/remaining-nine-final-20261016-v7/NotAlone-darwin-arm64/NotAlone.app`；ASAR运行前后及本次只读重算均为`07839372c5af6e947ca34987de11653c3db8126a1741ea6139d536668ff72ace`。这不是本场重新执行签名或TCC认证的证明。

沿[准备计划](real-sync-reenable-plan-20261016.md)复用原真实CLI夹具、只读sandbox、已确认的唯一联系人和随机隔离PG；不改真实cursor白名单。scope从既有单联系人模板复制，只更新本轮时间与两份独立审计路径，`long_running=false`、`allow_incoming_test_text=false`。scope为2026-10-15 UTC 19:27:22–19:35:22，480秒；runner为同日19:27:22.504–19:35:22.504，最多且实际启动1次App。没有新增外部发送、模型生成或正式OCR，测试结果分别为`sentMessages=0`、`modelCalls=0`、`ocrRun=false`。

原件保留于忽略目录`desktop/artifacts/real-sync-reenable-v7-20261016-0523c9bc-d2a6-4fdc-9787-3edac2079fb2/`：`run.log`、`runner-exit.json`、`execution-scope.json`、双审计、`root-cleanup-check.json`，以及Playwright单case目录中的`real-sync-reenable-results.json`、owned和cleanup回执。私人scope、姓名、locator、正文、路径内容或凭据不复制进报告。

## 实际命令与操作

启动前激活Conda NotAlone，从`desktop/`运行。下式保留实际参数，输出目录将日志中的`***`按本场目录展开；两个环境变量只代表本轮私有scope路径和上述冻结包可执行路径，不记录私有值。本报告编写没有重跑命令。

```sh
conda activate NotAlone
NOTALONE_REAL_SYNC_REENABLE_ACCEPTANCE=1 \
NOTALONE_TEST_REAL_SYNC_SCOPE="$REENABLE_SCOPE_FILE" \
NOTALONE_TEST_APP_EXECUTABLE="$REENABLE_APP_EXECUTABLE" \
npm run test:app -- --interactive --coordinator root-single-contact-reenable \
  --from 2026-10-15T19:27:22.504Z --until 2026-10-15T19:35:22.504Z \
  --max-launches 1 \
  --output artifacts/real-sync-reenable-v7-20261016-0523c9bc-d2a6-4fdc-9787-3edac2079fb2/playwright \
  -- tests/real-sync-reenable-acceptance.spec.ts
```

[用例](../../desktop/tests/real-sync-reenable-acceptance.spec.ts)沿公开管理页点击总开关，认证HTTP状态和无正文同步摘要，不调用立即检查或手动重试。初始开启、重新开启及随后自然周期分别要求阶段行边界后的tail实际启动、同PID成功结束，再出现`accepted`；另等正式cycle发布补齐complete、1个会话、0失败／0无法确认／0待处理和活跃流。

| 检查点 | 实际结果 |
| --- | --- |
| 初始开启 | 单一已确认绑定，真实tail接受，消息／来源引用／重复身份0／0／0 |
| 关闭UI确认 | 真实启动累计4；在途tail0、在途全局流0，旧自有进程已退场 |
| 关闭窗口 | 65926ms，累计4→4、新启动0，流未重开，消息／来源／水位不变 |
| 同App重新开启 | 新tail接受、新全局流PID，补齐complete，消息／来源／重复身份仍0／0／0 |
| 自然周期复验 | 再次真实tail成功结束并接受，未手动触发；水位与计数不变，同App及原后端仍存活 |
| 正常菜单退出 | App exit0，原token认证停读，自有后端与CLI退出；实际启动8→8，5秒新增0 |

## 审计计数为何不是双倍请求

直接按`event=started`统计会同时计入`status=reserved,pid=null`及`status=running,pid>0`。[原夹具](../../desktop/tests/fixtures/real-sync-python.py)的`AuditedProcesses._spawn`先双账本预写reserved，再真正启动，最后记running；[本用例的starts](../../desktop/tests/real-sync-reenable-acceptance.spec.ts)只计正整数PID。因此应使用下列口径：

| kind | 原始started行 | reserved／无PID | running／有PID | 不同实际PID |
| --- | ---: | ---: | ---: | ---: |
| tail | 6 | 3 | 3 | 3 |
| sessions_follow | 4 | 2 | 2 | 2 |
| version | 6 | 3 | 3 | 3 |
| 合计 | 16 | 8 | 8 | 8 |

这与结果`actualTailStarts=3`及退出前后真实启动累计8严格一致，不是测试故障或双倍业务请求。8个running PID各恰好对应1条finished；3次tail及3次version均returncode0，2次全局流在关闭／退出时为−15。tail有3条accepted。唯一scope拒绝是管理页会话列表的预期`acceptance_session_listing_blocked`，实际sessions查询没有执行。

本次只读核对两份审计的realpath不同、设备号＋inode不同，均nlink1、0600，各28行。剔除pid审计附加的`wrapper_pid`／`child_pid`后，规范化逐行完全一致，wrapper仅1个，所有`child_pid===pid`。规范化行SHA有7个重复，恰为重复的固定无PID事件：version reserved多2、流reserved多1、tail reserved多2、tail accepted多2；不对应重复的running PID。未发现同inode双写或双guard证据，也未把两份账本相加为请求量。

本轮文档核验只使用Node的`readFileSync`、`statSync`、`realpathSync`和SHA-256读取上述产物、scope的时间／开关／审计路径元数据及固定枚举；没有重跑CLI或查询消息库。ASAR只读重算的实际命令为：

```sh
node --input-type=module <<'NODE'
import fs from 'node:fs'; import crypto from 'node:crypto';
const file = 'desktop/artifacts/remaining-nine-final-20261016-v7/NotAlone-darwin-arm64/NotAlone.app/Contents/Resources/app.asar';
console.log(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
NODE
```

## 精确收尾与证据限制

原夹具回执`authenticatedStopped=true`、`stopSource=app-http-response`、backend exit0／signal null、`databaseDropped=true`、未确认资源0。主Agent另作只读复核，`root-cleanup-check.json`记录12个已归属PID全部gone、独立userData与fixture目录均absent、精确随机测试库absent。12个PID包括8个实际CLI PID及4个runner／App／后端PID，不是12次CLI请求；没有额外完整后代／进程组认证。

主Agent实际清理核验命令使用Conda NotAlone和`NOTALONE_DISABLE_DOTENV=1`。以下为其等价简化表达，非逐字shell日志，本次报告没有再次执行PG：owned取唯一结果文件同目录的`real-sync-reenable-owned.json`；PID集合来自该owned、`app-test-owned.json`、`real-sync-cleanup.json`、`owned-runner.json`的pid／`*Pid`字段，以及审计中的正整数PID。逐一`os.kill(pid, 0)`均得到`ProcessLookupError`，两个自有目录用`Path.exists()`得到false，回执以0600写入。

```python
with psycopg.connect(dbname='postgres', host='/tmp',
                     options='-c default_transaction_read_only=on') as connection:
    exists = connection.execute(
        'SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=%s)',
        (owned['databaseName'],),
    ).fetchone()[0]
# 本场exists为False；只查询上述owned记录的精确测试库名。
```

本场只有空窗口，水位保持与零重复计数不能证明有消息时无丢失或正向补齐；没有切联系人、来信、重新启动、持续前台／显示延迟、视觉资源或TCC验收。真实微信正文仍限既有确认范围，原始scope与审计留端侧，未改旧结果或抹除历史失败。原04票其余AC和未验证项保留，不因本场1pass而补签整票。
