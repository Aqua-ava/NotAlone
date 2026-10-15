# 当前v8实例分类、时钟对齐与可见群暂停

日期：2026-10-16（台北时间）。本场实际单A→已知测试群时，助手群暂停画面在item点击开始后810ms内被核对；返A首次正式状态样本为2703ms，短轮询没有看到即时画面恢复，随后晚取图确认A名称／100%置信度及绑定正确。新增时钟锚点使一条真实changed与实际观察HTTP入口对齐：提示后约1.666ms进入HTTP，早于纯正常2秒空等的最早边界约230.628ms。此为接入时序实证，不认证唯一因果、所有切换事件覆盖或所有切换亚秒。

第三源随后记录`instances_zero`并安全停止。其前后独立ps快照均为同一微信PID、count=1；两个查询间仍有未观测窗口，不能把原生同次查询返回0解释为全系统微信真的退出，也不能反向据ps否定该诊断或判定OS／API根因。宿主日志达到512行上限，后段截断保留。

## 本场范围、版本与实际命令

runId为`f1f548e3-1abf-410c-8640-be341b5d1594`。`scope.json`规定单A与既有测试群负对照、最多1次启动，19:58:23.732Z至20:06:23.732Z；进程元数据采样目标间隔500ms。使用现有single-A／manual入口、独立userData及随机PG，CLI元数据和A绑定仅为合成输入，消息为空，不认证真实CLI账号／locator。真实名称只经端侧环境提供，群不算第二位真实联系人。

正式包为`desktop/artifacts/remaining-nine-final-20261016-v8/NotAlone-darwin-arm64/NotAlone.app`。本轮只读复算ASAR SHA-256为`f928fba601b419ff9f3dd21611019d57319acb588a1b2e409185233338eb9d7b`，`libNotAloneSyncCore.dylib`为`866a26ebca28938a03d577c0a486817d0a9f5b79c3d881b6bf873bcd83657a36`；`manifest.buildSourceDigest=d6117ee54f9cc114034563dcd047e1a2cd58885a80991a830130092d6fa78c04`、18源。该字段不是manifest文件SHA。`codesign --verify --deep --strict`本轮独立复核exit0。主Agent首次hash命令误写core文件名，原失败记录保留；其后正确文件复算一致，未以该准备错误重跑App或覆盖实际字节。

`run.log`为1／1、约5.5分钟通过；runner code0、signal null，由主Agent实际finish收口。下列为实际npm启动命令，从`desktop/`执行；原日志随机目录后缀记作`***`，这里按产物还原。已激活Conda NotAlone，manual／真实App opt-in、当前包绝对路径、私有协调目录、`NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE`及已确认A的`NOTALONE_FOLLOW_TEST_NAME_A`由端侧环境提供，不抄录真实身份值；分析阶段没有重跑启动命令。

```sh
npm run test:app -- --interactive --coordinator root-v8-instance-clock \
  --from 2026-10-15T19:58:23.732Z --until 2026-10-15T20:06:23.732Z \
  --max-launches 1 \
  --output artifacts/event-follow-v8-live-20261016-f1f548e3-1abf-410c-8640-be341b5d1594/playwright \
  -- tests/continuous-contact-follow-acceptance.spec.ts
```

## 实际操作与状态／画面边界

主Agent先核对基线A画面正确。本场准备时“显示全部”菜单项禁用、没有点击；经AXCancel退菜单后核对微信实际前台、helper未获焦且置顶助手实际可见，没有沿用上一场“隐藏其他／显示全部”成功的操作结论。随后通过原生显示菜单连续切群、返A，并做即时AX与画面短轮询。`actual-actions.json`记录无截图持久化、无权限修改、无模型或发送。

以下时刻均为2026-10-15 UTC；采样上界含约500ms轮询，画面上界还包括CUA取AX／截图及返回耗时：

| 动作 | 菜单打开／item开始 | 首正式状态样本 | 画面核对 |
| --- | --- | --- | --- |
| A→测试群 | 20:01:05.294Z／05.658Z，间隔364ms | 20:01:06.432Z，paused、微信前台、A仍被选择但未确认，无verified-binding；item后774ms | 第3次短轮询于06.468Z核对群暂停AX＋画面；item后810ms为可见暂停上界 |
| 测试群→A | 20:01:53.375Z／53.708Z，间隔333ms | 20:01:56.411Z，A被选择／确认、verified-binding；item后2703ms | 8次早期短轮询未观察到匹配恢复；20:02:59.695Z晚图确认A名称／100%置信度和绑定正确 |

早期循环实际为8次；曾打印attempts9是循环计数加1错误，actual-actions已明确记载，不计作第9次观测。没有逐次早期poll的时间记录，不能把次数换算成持续秒数。晚图距返Aitem开始65987ms，只是晚取图的宽松上界，不能写成实际绘制花了65.987秒；正式状态2703ms也不能替代同刻屏幕paint。

633条manual-observation样本覆盖19:58:30.795Z至20:03:50.090Z、319295ms：94条unavailable、440条confirmed、99条paused；88条标记助手获焦。440条confirmed均匹配本场A的选择／确认及verified-binding。准备阶段未计入成功，群未被错误绑定成A。

## changed、HTTP与正常周期的对齐

唯一`clock-anchor`为`epochMs=1792094309636`、`elapsedMs=0.003104ms`、`sampleSpanMs=0.001208ms`。按[本轮诊断设计](instance-count-clock-diagnostic-plan-20261016.md)，以`anchor.epochMs + (event.elapsedMs - anchor.elapsedMs)`近似投影宿主事件；跨度仅表示锚点取样窗口，不涵盖毫秒量化、可能墙钟调整、原生stdout交付或CUA耗时，不能宣称微秒级OS时刻。

测量夹具除了probe-start／probe，还在既有`BackendApp.handle`处理`POST /api/sync/foreground/observe`前后记录epoch开始及monotonic耗时，没有增加请求或记录正文。这一既有HTTP锚点使本场不同于[此前v7只有宿主elapsed](app-fast-switch-v7-20261016.md)：

| 记录 | UTC／投影UTC | 与changed接收的时序 |
| --- | --- | ---: |
| 前一正式HTTP结束 | 20:01:04.041209Z | 早1767.707ms |
| 源2有效changed，host elapsed=156172.918542ms | 约20:01:05.808915Z | item后约150.915ms |
| 新正式HTTP进入后端 | 20:01:05.810581Z | 约后1.666ms |
| 该HTTP内probe开始／结束 | 20:01:05.827640Z／06.334553Z | 约后18.725ms开始 |
| HTTP处理结束 | 20:01:06.335246Z | 约后526.330ms |
| 首群暂停画面核对上界 | 20:01:06.468Z | 约后659.085ms |

前一HTTP结束至新HTTP进入为1769.372ms。现有控制器在正常结算后至少等待2000ms再发周期请求；若只依正常空等，服务端前一处理结束加2000ms已是保守最早边界20:01:06.041209Z，实际新请求早230.628ms。期间changed记录permitPresent=true、epochCurrent=true、paused=false、stopping=false，现有controller把有效changed交给取消正常等待的路径；相关控制器／认证HTTP合成回归已覆盖这一行为。

这足以记录“当前正式包收到变化提示后紧邻出现早于纯周期等待边界的真实HTTP”，支持事件来源已接入。没有trigger-id或完整唯一触发归属日志，不能排除同窗口其他合法触发，也没有反事实基线来将230.628ms认作画面收益；不把时序关联升格为唯一定因或所有会话切换覆盖。

## 正式轮次、租期与日志截断

109条probe-start、109条probe结束和109条HTTP测量一一对应。全部single-frame、returned、recognized、complete、valid；每次capture request／completion／frame／header OCR均恰好1。recognized包含群阶段，不是109次私聊身份验证。正式probe外层中位466.642ms、P95 536.307ms、最大1033.792ms；native中位448.081ms、OCR中位210.703ms。P95取109个升序值第104项。

辅助源另外有初始化整窗采集和局部流，不得把109说成整场总帧数。三个源均有initial_capture／首帧合规阶段记录，但本轮没有实际初始化整窗／局部帧数量，不能用阶段数、4Hz或240上限替代实际计量。

| 源 | native完成 | host close／续期 |
| --- | --- | --- |
| 1 | 55067.646ms，lease_expired | 55074.757ms、code0、renewalEligible=true；23.466ms后续起源2 |
| 2 | 55071.059ms，lease_expired；可见日志内1条changed | 55078.440ms、code0、renewalEligible=true；28.351ms后续起源3 |
| 3 | 30193.127ms记录instances_zero及六null，30195.667ms以context_changed结束 | 30204.674ms、code1、signal none、paused=true、stopping=false、epochCurrent=true、renewalEligible=false、blocked=true |

宿主JSONL恰512行、154190字节，达到行数上限；末记录是20:03:26.340Z投影的scope_blocked，没有shutdown／dispose尾部。最后正式状态还在约23.750秒后继续，故明确存在后段截断，不能用缺记录证明后段零事件、零重启或退出后的零读取。截断前close后可见85次freshProof=true的permit更新、86条scope_blocked，末次距close107660.454ms；只是可见更新次数，非独立proof数或整个余程总数。code1的连续许可失败锁符合ADR-057，返A正式观察继续走周期路径，没有该次返A事件收益证据。

## instances_zero与独立进程采样

源码`RegionCalibration.swift`仅将既有`runningApplications`返回数组count=0投影为instances_zero，再抛原.instances错误；它发生在前台／窗口查询和六字段比较前，六null表示没有可用上下文，非六项不等。此处没有增加一次OS读取或更改唯一实例门。

以宿主接收该诊断的锚点投影为参考，分类发生在约20:01:38.676299Z，比返Aitem早15031.701ms，不应归因于那次尚未发生的返A点击。原生同次查询实际时刻可能略早于诊断接收，未保存原值或精确查询耗时。

wrapper内setInterval的ps采样共654条，跨度327291ms；每条均wechatCount=1且wechatSameInitialPid=true。实际采样start间隔499–574ms，查询耗时27–152ms。紧邻该诊断的窗口为：

| ps查询窗口 | 结果 | 与诊断接收投影的距离 |
| --- | --- | --- |
| 20:01:38.271Z至38.310Z | 微信count=1、同初始PID；源3仍被采到 | 查询结束早约366.299ms |
| 20:01:38.772Z至38.800Z | 微信count=1、同初始PID；已未采到源 | 查询开始晚约95.701ms |

两查询之间462ms没有ps观测，查询本身也不是原子快照。ps与原生Cocoa数组不是同一次查询或同一接口；本场不能证明两次快照之间始终恰好1个实例，也不能判断API返回0的OS根因。采样结果只排除了“已记录ps窗口中微信持续缺失／换PID”的解释，不能据此改为忽略zero或自动解锁。

## 资源与精确收尾

本场只采有归属的原生进程元数据，不记录微信PID原值、名称、画面或正文。654个ps样本中的观测范围如下，非全场平均CPU、完整峰值或资源硬上界：

| 对象 | 命中条数／不同PID | RSS样本范围（KiB） | ps CPU字段范围 |
| --- | --- | ---: | ---: |
| 正式短探针 | 86／84 | 208–144512 | 0–51.3% |
| 独立辅助源 | 280／3 | 19488–87424 | 0.4–6.7% |

正式109轮中只有84个PID被500ms采样捕获，没有补造其余PID。App主进程另只有准备阶段1个资源点，RSS 150372352字节（约143.406MiB）、累计CPU 576707微秒；未汇总renderer等子进程。辅助流实际帧数缺失，不能据这些样本宣称整体低耗。

主Agent发finish，夹具通过公开菜单正常退出，normalQuit=true。原清理回执为backend exit0、signal null、authenticatedStopped=true、stopSource=app-http-response、databaseDropped=true、unconfirmedResources为空。只读独立核验87个已采原生PID加owned wrapper／child／App／backend，共91个不同PID均gone；owned-runner明确的唯一processGroup也无存活成员。采样器就是wrapper内定时器，没有独立sampler PID或第二自有组，不造额外清理对象。

App owned userData不存在，本次收尾共享interactive租约absent；后续场次仍需各自协调，不把此历史状态当永久空闲。control目录保留证据；fixture临时目录没有在owned记录中保存绝对路径，不遍历或猜测删除。精确本轮测试库以READ ONLY参数查询确认不存在，没有列其他库、kill未知进程或改动用户业务资源。以下为实际执行的只读hash／owned核验命令，从仓库根执行，exit0；输出两SHA一致、18源、91 PID全gone、记录组gone、userData absent：

```sh
node - <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const base = 'desktop/artifacts/event-follow-v8-live-20261016-f1f548e3-1abf-410c-8640-be341b5d1594';
const resources = 'desktop/artifacts/remaining-nine-final-20261016-v8/NotAlone-darwin-arm64/NotAlone.app/Contents/Resources';
for (const file of ['app.asar', 'notalone-probe/libNotAloneSyncCore.dylib']) console.log(JSON.stringify({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(resources, file))).digest('hex') }));
const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'notalone-probe/manifest.json')));
console.log(JSON.stringify({ buildSourceDigest: manifest.buildSourceDigest, sourceCount: manifest.buildSources.length }));
const runner = JSON.parse(fs.readFileSync(path.join(base, 'owned-runner.json')));
const app = JSON.parse(fs.readFileSync(path.join(base, 'playwright/continuous-contact-follow-acceptance-正式App持续单帧名称跟随及可视诊断生命周期/app-test-owned.json')));
const cleanup = JSON.parse(/^binding_fixture_cleanup: (.+)$/m.exec(fs.readFileSync(path.join(base, 'run.log'), 'utf8'))[1]);
const samples = fs.readFileSync(path.join(base, 'process-samples.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
const native = [...new Set(samples.flatMap(row => row.native.map(item => item.pid)))];
const pids = [...new Set([runner.wrapperPid, runner.childPid, app.pid, cleanup.childPid, ...native])];
const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,comm='], { encoding: 'utf8' });
if (ps.status !== 0) throw new Error('ps_failed');
const rows = ps.stdout.trim().split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
console.log(JSON.stringify({ sampledNativePidCount: native.length, recordedPidCount: pids.length, recordedPidsGone: pids.every(pid => !rows.some(row => Number(row[1]) === pid)), recordedProcessGroupGone: !rows.some(row => Number(row[3]) === runner.processGroup), ownedUserDataAbsent: !fs.existsSync(app.userData), authenticatedStopped: cleanup.authenticatedStopped, databaseDropped: cleanup.databaseDropped, unconfirmedResourceCount: cleanup.unconfirmedResources.length }));
NODE
codesign --verify --deep --strict desktop/artifacts/remaining-nine-final-20261016-v8/NotAlone-darwin-arm64/NotAlone.app
```

实际精确库核验命令如下，exit0、exists=false；本机Conda初始化脚本绝对路径省略，以下从已初始化shell开始，没有读取.env或凭据：

```sh
conda activate NotAlone
python - <<'PY'
import json
from pathlib import Path
import re
import psycopg

base = Path('desktop/artifacts/event-follow-v8-live-20261016-f1f548e3-1abf-410c-8640-be341b5d1594')
cleanup = json.loads(re.search(r'^binding_fixture_cleanup: (.+)$', (base / 'run.log').read_text(), re.MULTILINE).group(1))
name = cleanup['databaseName']
assert re.fullmatch(r'notalone_binding_[0-9a-f]{32}_test', name)
with psycopg.connect('host=/tmp dbname=postgres', connect_timeout=3) as admin:
    admin.execute('SET TRANSACTION READ ONLY')
    exists = admin.execute('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)', (name,)).fetchone()[0]
print(json.dumps({'exact_owned_database_exists': exists}))
PY
```

独立只读复核：Spec与Standards各0项；均核对匿名原件与边界，未启动桌面、真实组件或模型。主Agent据此仅落实下述AC2，其余缺口保持。

## 原事件票验收建议

建议[原01票](issues/01-event-capability-and-integration.md)AC2勾选，限定为当前包顶部变化来源已接入、变化提示不再只等待正常固定间隔：同控制器／鉴权HTTP合成覆盖取消正常等待，本场有效changed与提前HTTP的对齐补足实机接入时序。无需将这一条件扩成“唯一定因”“每次切换都发事件”或亚秒SLA。

AC4已有正式包A名称／绑定正确、可见群暂停810ms上界、返A最终正确画面、有限资源和清理子证据；建议仍不整体勾选。[规格](spec.md)第50行要求同版实机记录实际额外帧数，ADR-057也要求初始化整窗与局部流分开计量，本场仍未得到这些实际计数。返A画面只有短轮询负结果及晚图，不能将2703ms正式状态或65.987秒晚取图改写成精准paint延迟。这里只保留原规格真实缺口，不添加所有切换亚秒等新门槛；事件票保持claimed，不因1case通过关闭全部AC。

忽略原件在`desktop/artifacts/event-follow-v8-live-20261016-f1f548e3-1abf-410c-8640-be341b5d1594/`：scope、actual-actions、run／exit、owned、process-samples、host日志、control及Playwright匿名状态／测量。仅新增本报告，不改源码、旧报告、任务、模型输入或闭账代码，不提交。本分析未启动App、执行真实探针／CLI或操作GUI；实际场modelCalls=0、sentMessages=0、privateBodyRead=false、permissionChanged=false、privateScreenshotPersisted=false，无生成／复制外发／权限修改。双真实联系人、真实来信、总资源峰值和当前App独立TCC责任身份不由本场认证。
