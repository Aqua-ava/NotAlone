# 当前v7上下文停止分类实测

日期：2026-10-16（台北时间）。本场确认独立辅助源在App内完成一轮55秒租期并续起；第二源以`instances_ambiguous`分类停止，`changed=0`。单A的正式定位及本场合成已确认绑定可用，但实际切群点击晚于自动完成点，不能认证A→群→A正式覆盖、事件提速或可见显示延迟。有限用例1／1、runner exit0约3.8分钟仅表示诊断生命周期正常收口，事件票仍有未验条件。

## 版本、范围与原件

runId为`0ab13e08-e813-4e9b-b69a-53d2dce1f9f2`，使用`desktop/artifacts/remaining-nine-final-20261016-v7/NotAlone-darwin-arm64/NotAlone.app`。本轮只读重新计算并核对：

- App ASAR SHA-256：`07839372c5af6e947ca34987de11653c3db8126a1741ea6139d536668ff72ace`。
- `libNotAloneSyncCore.dylib` SHA-256：`e6e6e03a2bc2a992ffea5d27e8e8777062abd5cd83329e5306424ff78ac89787`。
- 包内`manifest.buildSourceDigest`：`b031e177a857d4653036f5c614affa341a868fda60a2f442ef6a500d2ec40056`，`buildSources.length=18`；它是构建源集合摘要，不是manifest文件SHA。独立helper与正式短探针仍采用不同签名identifier。本次读取清单及字节不代替重新签名检查或TCC归属认证。

复用现有`continuous-contact-follow-acceptance.spec.ts`的单A／manual入口、隔离userData和随机测试PG；没有修改该初始dirty入口。CLI会话元数据与绑定为合成输入，消息为空，真实名称仅在端侧环境内使用；不认证真实CLI账号或locator归属。保留[诊断方案](context-stop-diagnostic-plan-20261016.md)的固定分类／六位匹配布尔及原门禁，未改为fresh proof重启。

忽略原件位于`desktop/artifacts/event-follow-v7-live-20261016-0ab13e08-e813-4e9b-b69a-53d2dce1f9f2/`：`run.log`、`runner-exit.json`、`owned-runner.json`、`host-lifecycle.jsonl`、`control/`和Playwright的`app-test-owned.json`／`continuous-follow-results.json`。报告不读取或复制真实姓名、正文、scope内容、凭据或截图。

## 实际启动与只读核验命令

原`run.log`头部记录的启动命令如下，从`desktop/`执行；日志将输出目录的随机后缀写为`***`，这里按本场实际产物目录展开。启动前已激活Conda NotAlone，`NOTALONE_CONTINUOUS_APP_ACCEPTANCE=1`与`NOTALONE_CONTINUOUS_MANUAL_ACCEPTANCE=1`已由本轮环境提供；当前包绝对路径、私有协调／诊断路径及已确认A的`NOTALONE_FOLLOW_TEST_NAME_A`值只由端侧提供，不抄录实际身份值。本次文档修订没有重跑该启动命令。

```sh
npm run test:app -- --interactive --coordinator root-v7-context \
  --from 2026-10-15T18:55:59.024Z --until 2026-10-15T18:59:59.024Z \
  --max-launches 1 \
  --output artifacts/event-follow-v7-live-20261016-0ab13e08-e813-4e9b-b69a-53d2dce1f9f2/playwright \
  -- tests/continuous-contact-follow-acceptance.spec.ts
```

以下为本轮实际执行的只读复核，从仓库根目录运行。第一条重新计算包内两文件SHA，读取`manifest.buildSourceDigest`，只按owned记录／清理回执定位4个PID和userData；ps结果仅输出归属集合的布尔值，不记录未知进程或路径。命令exit0，两个SHA与上文相同，18源，4 PID及以它们为PGID的组均gone、userData absent；runnerExitCode=0、normalQuit=true、formalProbes=27、changed=0。

```sh
node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const base = 'desktop/artifacts/event-follow-v7-live-20261016-0ab13e08-e813-4e9b-b69a-53d2dce1f9f2';
const reportDirectory = path.join(base, 'playwright/continuous-contact-follow-acceptance-正式App持续单帧名称跟随及可视诊断生命周期');
const resources = 'desktop/artifacts/remaining-nine-final-20261016-v7/NotAlone-darwin-arm64/NotAlone.app/Contents/Resources';
for (const file of ['app.asar', 'notalone-probe/libNotAloneSyncCore.dylib']) {
  console.log(JSON.stringify({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(resources, file))).digest('hex') }));
}
const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'notalone-probe/manifest.json')));
console.log(JSON.stringify({ buildSourceDigest: manifest.buildSourceDigest, buildSourceCount: manifest.buildSources.length }));
const runner = JSON.parse(fs.readFileSync(path.join(base, 'owned-runner.json')));
const app = JSON.parse(fs.readFileSync(path.join(reportDirectory, 'app-test-owned.json')));
const log = fs.readFileSync(path.join(base, 'run.log'), 'utf8');
const cleanup = JSON.parse(/^binding_fixture_cleanup: (.+)$/m.exec(log)[1]);
const pids = [runner.wrapperPid, runner.childPid, app.pid, cleanup.childPid];
const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,comm='], { encoding: 'utf8' });
if (ps.status !== 0) throw new Error('ps_failed');
const rows = ps.stdout.trim().split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
console.log(JSON.stringify({ recordedPidCount: pids.length, recordedPidsGone: pids.every(pid => !rows.some(row => Number(row[1]) === pid)), recordedIdGroupsGone: pids.every(pid => !rows.some(row => Number(row[3]) === pid)), ownedUserDataAbsent: !fs.existsSync(app.userData), authenticatedStopped: cleanup.authenticatedStopped, databaseDropped: cleanup.databaseDropped }));
const result = JSON.parse(fs.readFileSync(path.join(reportDirectory, 'continuous-follow-results.json')));
const host = fs.readFileSync(path.join(base, 'host-lifecycle.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
console.log(JSON.stringify({ runnerExitCode: JSON.parse(fs.readFileSync(path.join(base, 'runner-exit.json'))).code, normalQuit: result.normalQuit, formalProbes: result.measurements.filter(row => row.kind === 'probe').length, changed: host.filter(row => row.kind === 'host' && row.event === 'changed').length }));
NODE
```

精确测试库查询命令如下，exit0、`exact_owned_database_exists=false`。实际先执行了本机Conda初始化脚本，以下省略其本机绝对路径，从已初始化shell开始；没有读取`.env`或连接凭据。库名只取原清理回执并验证随机测试库格式，仅查询该名称存在性。

```sh
conda activate NotAlone
python - <<'PY'
import json
from pathlib import Path
import re
import psycopg

base = Path('desktop/artifacts/event-follow-v7-live-20261016-0ab13e08-e813-4e9b-b69a-53d2dce1f9f2')
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

## 实际操作与覆盖边界

主Agent打开并置顶助手；WXRaise没有使微信成为实际前台，随后通过微信原生菜单“隐藏其他”建立微信前台。A得到`verified-binding`，最终匿名状态共429条，其中129条同时为微信前台、A被选择、A被确认及已验证绑定；首次与末次分别为18:58:39.120Z和18:59:43.820Z。其余300条为unavailable，294条标记助手获焦；没有把这些准备阶段样本算作定位成功。主Agent此前看到的39是中途累计值，最终文件为129。

“隐藏其他”也隐藏了助手，故这些状态不认证助手屏幕可见、实际绘制或体感延迟。主Agent端侧确认后续实际进入既有测试群并返回原私聊A，但相关点击已超出自动观察期限：

| 动作／边界 | UTC时刻 | 相对自动完成点 |
| --- | --- | ---: |
| 打开“下一个会话”所在菜单 | 18:59:30.918Z | −13106ms |
| 夹具自动请求完成 | 18:59:44.024Z | 0 |
| 点击“显示下一个会话” | 18:59:44.889Z | +865ms |
| 打开“上一个会话”所在菜单 | 19:00:06.032Z | +22008ms |
| 点击“显示上一个会话” | 19:00:31.372Z | +47348ms |

所有时刻均为2026-10-15 UTC。自动完成点来自本轮租约截止前15秒的既有定时器；最后状态样本在它前204ms，runner最终18:59:46.264Z记录exit0。菜单打开不等于会话已切换，不能以其较早时间补签切群覆盖。没有群阶段或返回A阶段的正式状态样本，因此本场不提供切换到状态／显示的延迟，也不复用此前v6的结果冒充v7已测。

## 正式观察与辅助源

27条probe-start与27条probe结束一一对应。全部`single_frame_requested=true`、returned、recognized、complete、valid；每轮capture request／completion／frame／header OCR均恰好1。所有正式start均早于自动完成点。`recognized`说明原生返回成功，不单独认证真实身份；本场A绑定通过依赖上述正式状态与合成唯一会话元数据。

正式probe外层耗时中位475.077ms、P95 582.172ms、最大802.691ms；native中位452.321ms，OCR中位213.057ms。P95按27个值升序的第26项取值。辅助源初始化整窗帧和局部流另计，不能把27当作整场总采图数；本场没有局部流帧数记录。

私有宿主诊断共210行、60886字节，未到512行／256KiB上限，记录2次launch、2次paused／close、0次changed：

| 源 | native证据 | 宿主close及后续 |
| --- | --- | --- |
| 1 | 首帧297.263ms；55026.883ms以`lease_expired`结束 | 55034.382ms、code0、signal none、paused=true、stopping=false、epochCurrent=true、renewalEligible=true；24.032ms后启动源2 |
| 2 | 首帧341.135ms；5440.711ms记录`instances_ambiguous`、六项匹配均null；随后`context_changed`，5443.600ms结束 | 5450.726ms、code1、signal none、paused=true、stopping=false、epochCurrent=true、renewalEligible=false、blocked=true |

源2close后至退出前，记录4次`permit_present`更新带freshProof=true和5条`scope_blocked`；最后一条blocked距close为4543.983ms。这是更新次数，不是4份独立proof。freshProof表示与该源启动时observation不同，日志没有保存精确观察年龄，不能据布尔值补出毫秒时效。code1不满完整租期，连续许可内保留失败锁，符合[ADR-057](../../architecture/adr/057-header-change-triggered-foreground-observation.md)；没有因后续正式观察而重复初始化。

## 分类能证明什么

`RegionCalibration.swift:161–163`调用既有`NSRunningApplication.runningApplications(withBundleIdentifier:)`，仅在`instances.count == 1`且能取到首项时继续；否则抛原`CalibrationContextFailure.instances`。`HeaderChangeDiagnostics.swift:65–67`将其映射为固定`instances_ambiguous`。因此本场只证明某次原有查询没有满足“恰好一个微信实例”的门：0个或多个都可能，未记录计数，不能断言多开微信、进程重启或某个OS原因。

该拒绝发生在前台、版本、窗口查询及上下文六字段比较之前；六null表示未进行可用上下文比较，不是六项均不等，也不是已确定PID／窗口／frame变化。`HeaderChangeSource.swift:143–163`将该次读取失败返回nil，再按原不等门停止；本场可排除“本次已记录原因是六字段identity_mismatch”的解释，但不能推断查询为何不满足唯一实例。宿主`native-change-source.ts:169–175`据非正常租期close锁住原scope，`75–80`先查scope_blocked，只有`46–55`的scope变化才清锁。

日志只记相对耗时，未提供该次OS查询的墙钟锚点或原实例数。菜单打开、切换准备和上下文失败的相关性不构成菜单因果证据；未追加OS轮询、采图或查询实例原值。本场保持负结果，不放宽唯一实例、前台或连续许可门。

## 资源与精确收尾

本场没有额外ps资源采样器或完整后代进程追踪。结果仅有1条App主进程资源点：RSS 150634496字节（约143.656MiB），累计CPU 573835微秒；不足以计算整场平均CPU、峰值、辅助流开销或资源上界。不能沿用此前v6的资源表作为v7指标。

夹具通过公开“退出 NotAlone”菜单正常退出，`normalQuit=true`。原run.log的清理回执为backend exit0、signal null、authenticatedStopped=true、stopSource=`app-http-response`、databaseDropped=true、unconfirmedResources为空；它与runner exit0保留在原件。

本轮只读复核范围如下，没有终止进程、删除目录或操作未知资源：

- `owned-runner.json`两PID、`app-test-owned.json`的App PID、清理回执的backend PID，共4个有记录PID均已不存在；ps同时确认没有以这些PID为PGID的存活组。没有额外原生helper PID记录，不宣称全部未记录后代均独立核验gone。
- 对精确本轮随机测试库，沿夹具的本地管理连接、只读事务查询`pg_database`的该名称存在性，结果false；没有列其他库或连接业务库。
- `app-test-owned.json`明确的临时userData不存在；本场首次只读收尾时共享interactive租约不存在，此历史观察不表示后续其他场次没有取得新租约。协调`control/`仍作为验收证据保留，状态为closing；它不是活App证明或待删除用户目录。owned文件没有记录绑定fixture临时目录的绝对路径，因此未猜测或遍历临时目录；该目录回收只由原夹具正常收尾路径支持，未另称独立存在性核验。

`privateBodyRead=false`、sentMessages=0、modelCalls=0；未运行真实CLI、复制或发送消息、创建生成、授权录屏、修改TCC、输入密码或保存画面。本轮仅新增本报告，不修改初始dirty、生产门禁或其他评测资料，不提交。后续仍需在观察期限内完成实际切换并保留正式覆盖，事件来源覆盖、可见显示延迟、双真实联系人／来信、总资源峰值和当前App独立TCC责任身份均未由本场认证。
