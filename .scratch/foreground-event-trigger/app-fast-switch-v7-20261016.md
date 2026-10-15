# 当前v7快速菜单切换与实际助手显示

日期：2026-10-16（台北时间）。本场在观察期限内实际完成单A→既有测试群→A，主Agent通过Computer Use核对置顶助手的群暂停及A恢复画面／AX内容。正式状态首次采样上界为切群673ms、返A1088ms；这不是精准绘制延迟。辅助源在App中发出1条`changed`，但缺少事件到正式请求的关联时钟，仍不能认证该提示对应哪次操作或量化提速。第二源随后因唯一实例门拒绝而code1锁定，负结果保留。

## 范围、版本与实际命令

正式runId为`2044ad04-6fd3-4453-a87d-9193159b86a5`，使用[前一场](app-context-stop-v7-20261016.md)相同v7签名包；本次只读重新计算的ASAR SHA-256为`07839372c5af6e947ca34987de11653c3db8126a1741ea6139d536668ff72ace`，core dylib SHA-256为`e6e6e03a2bc2a992ffea5d27e8e8777062abd5cd83329e5306424ff78ac89787`。`manifest.buildSourceDigest=b031e177a857d4653036f5c614affa341a868fda60a2f442ef6a500d2ec40056`，`buildSources.length=18`；该字段不是manifest文件SHA。未重新构建、签名或执行原生CLI来作本次只读分析。

沿用已有`continuous-contact-follow-acceptance.spec.ts`的single-A／manual场；没有修改该初始dirty入口。独立userData、随机PG与合成CLI元数据只给A建立本场已确认绑定，消息为空，不认证真实CLI账号／locator。真实名称仅经端侧`NOTALONE_FOLLOW_TEST_NAME_A`提供，不抄入公开报告；已知群仅为未绑定、不支持的负对照，不算第二位真实联系人。

`scope.json`明确单A与既有测试群负对照、最多1次启动，19:13:41.328Z至19:25:41.328Z；`run.log`为1／1、约9.8分钟正常结束，runner code0、signal null。实际启动命令从`desktop/`执行如下；日志目录后缀原记为`***`，这里按本场产物还原。已激活Conda NotAlone，`NOTALONE_CONTINUOUS_APP_ACCEPTANCE=1`、`NOTALONE_CONTINUOUS_MANUAL_ACCEPTANCE=1`、当前包绝对路径、端侧A名称和私有协调目录由本轮环境提供。成功场正确使用`NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE`，私有宿主日志实际存在。本文没有重跑该命令。

```sh
npm run test:app -- --interactive --coordinator root-v7-fast-switch \
  --from 2026-10-15T19:13:41.328Z --until 2026-10-15T19:25:41.328Z \
  --max-launches 1 \
  --output artifacts/event-follow-v7-fast-switch-20261016-2044ad04-6fd3-4453-a87d-9193159b86a5/playwright \
  -- tests/continuous-contact-follow-acceptance.spec.ts
```

首次准备run`cb3d0cc6-07f8-4afd-9945-0588269b2ed1`用了绝对输出目录，被`app_test_arguments`受控目录门拒绝，exit2、App0，没有取得有效实机场。主Agent另记录该准备时诊断变量键未正确设置；不能用其缺少host日志推断源未运行。该场原scope／run.log／exit和owned记录保留，未合并为正式场成功或删去失败。

## 实际操作与状态上界

最初菜单定位regex不匹配，打开菜单至点击下一会话间隔14058ms；当时助手仍获焦，微信实际前台未建立。这段不计作正式切换响应。主Agent随后返回A，再用微信“隐藏其他”建立实际前台，并执行“显示全部”使置顶助手恢复可见，稳定A的真实名称／绑定在实际画面中核对。

本轮`actual-actions.json`记录了实际操作开始时刻及三处画面确认布尔；主Agent先实际看见稳定A，再以快速原生菜单切到群，实际核对助手群暂停画面与AX，随后返回A并核对恢复画面与AX。没有把菜单打开当成切换发生。以下均为2026-10-15 UTC：

| 动作 | 菜单打开→item点击间隔 | 首次对应正式状态样本 | item开始→首状态样本上界 |
| --- | ---: | --- | ---: |
| A→测试群，item开始19:20:39.431Z | 367ms | 19:20:40.104Z：paused、微信前台、A仍选择，但未确认且无verified-binding | 673ms |
| 测试群→A，item开始19:21:22.132Z | 348ms | 19:21:23.220Z：confirmed、微信前台、A被选择／确认、verified-binding | 1088ms |

若从菜单打开计，上界分别1040ms、1436ms。这些值来自同机动作时间与约500ms一次的匿名状态采样，含操作／调度及采样误差，不是精准转换或paint时间。返回画面的实际核对记录为19:22:27.813Z，距返回item开始65681ms；这是晚取画面的时间，不能将65.681秒写成真实显示延迟，也不能用673／1088ms宣称同刻已经绘制。

1143条manual-observation状态覆盖579237ms：671条unavailable、387条confirmed、85条paused；665条标记助手获焦。387条confirmed均为A选择／确认及verified-binding，首次为19:19:27.310Z。准备阶段没有计入成功，群阶段没有把群绑定为A；`actualHelperPaint.privateBefore/groupPause/privateReturned`均为true，`privateScreenshotPersisted=false`，不在仓库保存截图、真实名称或正文。

## 正式观察、变化事件与停止

96条probe-start与96条结束一一对应；全部single-frame、returned、recognized、complete、valid，每次capture request／completion／frame／header OCR均恰好1。原生recognized包含本场群阶段，不等于96次私聊身份验证。辅助源初始化整窗帧及局部流另计，局部帧数未记录，不能将96当整场总采图数。

正式probe外层中位483.294ms、P95 542.900ms、最大1534.677ms；native中位462.083ms、OCR中位216.003ms。偶数样本中位取中间两值平均，P95取96个升序值的第92项。相邻95个正式start间隔中，仅1个低于2000ms：19:20:38.574Z至19:20:39.541Z，间隔966.716ms；较短间隔与提前触发相容，但不能单凭相邻请求间隔证明触发来源。

宿主日志487行、149306字节，低于512行／256KiB双限；最终dispose及其后disposed记录存在，没有看到达到上限截断。两个源各记录15／17条native及native-context元数据，均低于单源32行，`native_diagnostic_rejected=0`。本场确实记录2次launch、2次paused／close，以及1次`changed`：

| 源 | native证据 | 宿主结果 |
| --- | --- | --- |
| 1 | 首帧363.387ms；55078.990ms以lease_expired结束 | 55092.114ms close、code0、signal none、renewalEligible=true；41.343ms后启动源2 |
| 2 | 首帧297.091ms；48083.600ms记录instances_ambiguous、六匹配字段均null；48090.771ms以context_changed结束 | 48100.816ms close、code1、signal none、paused=true、stopping=false、epochCurrent=true、renewalEligible=false、blocked=true |

唯一changed属于源2，宿主相对时间413947.558ms，距该源launch为17090.513ms；当时permitPresent=true、epochCurrent=true、paused=false、stopping=false。它证明辅助源stdout提示进入宿主监听，未被记录为迟到或停止事件。宿主相对时间没有绝对墙钟锚点，也没有event ID→正式HTTP请求的关联记录；因此不能精确归到本表任一菜单动作，不能证明短间隔请求一定由它引起，不能计算相对周期观察节省多少时间。一次changed也不代表两次切换都被事件覆盖。

源2close后记录107次freshProof=true的permit更新、108条scope_blocked；末次blocked距close135522.993ms。它们是更新次数，不是独立proof数，精确proof年龄未记录。停止分类仍只是[既定唯一实例查询门](app-context-stop-v7-20261016.md)：既有查询未满足恰好1个微信实例，0个／多个均可能；六null不是六项不等。不确定实际实例数、OS原因或菜单因果。按照[ADR-057](../../architecture/adr/057-header-change-triggered-foreground-observation.md)，不足完整租期的code1在同一连续许可中锁住；未松门、未改为fresh proof无限重启，正式周期观察仍继续并完成返A恢复。

## 资源与精确收尾

没有额外资源采样器或完整后代PID追踪；仅1条App主进程资源点：RSS 152125440字节（约145.078MiB）、累计CPU 478441微秒。该点位于准备阶段，不支持整场平均CPU、峰值、辅助流开销或资源上界。没有借用其他场的资源数据。

主Agent发finish后，夹具通过公开退出菜单正常退出，`normalQuit=true`；原回执backend exit0、signal null、authenticatedStopped=true、stopSource=`app-http-response`、databaseDropped=true、unconfirmedResources为空。独立只读复核以下对象：

- 正式场owned-runner的wrapper／child、App、backend共4个有记录PID，以及首失败准备的wrapper／child两PID，共6个均gone；两份owned-runner明确记录的2个processGroup均无存活成员。不宣称未记录的原生helper或全部后代PID独立核验gone。
- App owned userData不存在；本次收尾检查时shared interactive租约absent，该历史结果不代替后续场次协调。`control/`仍保留匿名证据、状态closing；fixture临时目录绝对路径未在owned文件中记录，没有遍历或猜测目录来删除。原夹具正常回收路径支持其收尾，未另称独立目录核验。
- 沿夹具既有本地管理连接，以只读事务参数查询本轮精确随机库，`exact_owned_database_exists=false`；没有列其他库或连接用户业务库。没有kill、删未知资源或抢占租约。

以下为实际执行的包字节／owned资源核验命令，从仓库根执行，exit0；输出只有摘要及布尔，不输出未知PID、真实路径或身份：

```sh
node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = 'desktop/artifacts/remaining-nine-final-20261016-v7/NotAlone-darwin-arm64/NotAlone.app/Contents/Resources';
for (const file of ['app.asar', 'notalone-probe/libNotAloneSyncCore.dylib']) console.log(JSON.stringify({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') }));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'notalone-probe/manifest.json')));
console.log(JSON.stringify({ buildSourceDigest: manifest.buildSourceDigest, sourceCount: manifest.buildSources.length }));
const prefix = 'desktop/artifacts/event-follow-v7-fast-switch-20261016-';
const main = prefix + '2044ad04-6fd3-4453-a87d-9193159b86a5';
const prep = prefix + 'cb3d0cc6-07f8-4afd-9945-0588269b2ed1';
const runner = JSON.parse(fs.readFileSync(path.join(main, 'owned-runner.json')));
const initial = JSON.parse(fs.readFileSync(path.join(prep, 'owned-runner.json')));
const resultDirectory = path.join(main, 'playwright/continuous-contact-follow-acceptance-正式App持续单帧名称跟随及可视诊断生命周期');
const app = JSON.parse(fs.readFileSync(path.join(resultDirectory, 'app-test-owned.json')));
const cleanup = JSON.parse(/^binding_fixture_cleanup: (.+)$/m.exec(fs.readFileSync(path.join(main, 'run.log'), 'utf8'))[1]);
const pids = [runner.wrapperPid, runner.childPid, app.pid, cleanup.childPid, initial.wrapperPid, initial.childPid];
const groups = [runner.processGroup, initial.processGroup];
const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,comm='], { encoding: 'utf8' });
if (ps.status !== 0) throw new Error('ps_failed');
const rows = ps.stdout.trim().split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
console.log(JSON.stringify({ recordedPidCount: pids.length, recordedPidsGone: pids.every(pid => !rows.some(row => Number(row[1]) === pid)), recordedProcessGroupCount: groups.length, recordedProcessGroupsGone: groups.every(group => !rows.some(row => Number(row[3]) === group)), ownedUserDataAbsent: !fs.existsSync(app.userData), sharedInteractiveLeaseAbsent: !fs.existsSync(path.join(os.homedir(), '.notalone-desktop-tests/interactive.lock')), authenticatedStopped: cleanup.authenticatedStopped, databaseDropped: cleanup.databaseDropped, unconfirmedResources: cleanup.unconfirmedResources.length }));
NODE
```

精确PG只读查询如下，exit0且exists=false；实际先初始化本机Conda，以下省略本机初始化脚本绝对路径，从已初始化shell开始。没有读取`.env`或凭据。

```sh
conda activate NotAlone
python - <<'PY'
import json
from pathlib import Path
import re
import psycopg

base = Path('desktop/artifacts/event-follow-v7-fast-switch-20261016-2044ad04-6fd3-4453-a87d-9193159b86a5')
log = (base / 'run.log').read_text()
cleanup = json.loads(re.search(r'^binding_fixture_cleanup: (.+)$', log, re.MULTILINE).group(1))
name = cleanup['databaseName']
assert re.fullmatch(r'notalone_binding_[0-9a-f]{32}_test', name)
with psycopg.connect('host=/tmp dbname=postgres', connect_timeout=3) as admin:
    admin.execute('SET TRANSACTION READ ONLY')
    exists = admin.execute('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)', (name,)).fetchone()[0]
print(json.dumps({'exact_owned_database_exists': exists}))
PY
```

原件保存在忽略目录`desktop/artifacts/event-follow-v7-fast-switch-20261016-2044ad04-6fd3-4453-a87d-9193159b86a5/`，包括actual-actions、scope、run／exit、owned、host日志和Playwright匿名状态／测量；首准备目录同前缀、runId为cb3d0cc6…。只新增本报告，不改源码、旧报告、任务或初始dirty，不提交。`privateBodyRead=false`、modelCalls=0、sentMessages=0、permissionChanged=false；没有真实CLI、生成、复制外发、权限申请／修改或持久截图。本场补齐单A与群负对照的实际可见恢复；双真实联系人／真实来信、事件完整切换覆盖及提速、精确paint延迟、总资源峰值与当前App独立TCC责任身份仍未认证，不能据1case通过关闭全部事件AC。
