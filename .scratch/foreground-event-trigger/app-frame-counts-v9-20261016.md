# 当前v9辅助帧分账与可见切换实测

日期：2026-10-16（台北时间）。同版正式App中，主Agent通过微信原生菜单实际完成单A→既有测试群→A，核对基线A及返A名称正确、100%置信度和本场合成绑定。群暂停画面在item点击开始后1078ms内被核对，返A画面为2782ms内；它们是包含CUA轮询／AX／取图耗时的可见上界，不是精确paint耗时或亚秒SLA。

本场首次取得辅助源的完整最终实际分账：成功返回初始化整窗CGImage **1张**、收到screen sample回调 **154次**、进入顶部处理 **84帧**，未饱和。84包含detector初始基线，是154回调中的处理子集，不能相加；screen回调也不等于OS内部全部物理采帧。正式观察另外36轮，每轮单帧／单OCR。结合资源及精确收尾证据，建议原事件票AC4在明确单A与测试群负对照范围勾选；本报告不修改票据。独立只读Spec／Standards复核各0项，主Agent据此更新原票，范围和以下限制保持。

## 范围、版本与实际入口

runId为`787727c8-a35e-438b-b42a-2e3095215277`。`scope.json`限定单A与既有测试群负对照、最多1次启动，2026-10-15T20:27:54.057Z至20:35:54.057Z，元数据采样目标间隔500ms。使用现有manual／single-A验收入口、独立userData和随机PG；CLI元数据、空消息及A测试绑定为合成输入，不认证真实CLI账号、双真实联系人或真实来信。名称仅经端侧环境提供，不抄录或提交身份。

包为`desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app`。本轮只读独立复算如下，与主Agent记录一致：

| 对象 | SHA-256／字段 |
| --- | --- |
| `Contents/Resources/app.asar` | `e8ed699a551d8db5dfab5e4e1d652ae68bafe6e7d87a616876c739bb9a475021` |
| `notalone-probe/libNotAloneSyncCore.dylib` | `c17f9028c8a90fd8c8e44d26953b5d9b4ce18d72715ed7ff1308262b030724c2` |
| `manifest.buildSourceDigest`，18源 | `8b3df06a118fb851bb06e509cece191c92b5d100eb7a5e8598db115948cf79bf` |

buildSourceDigest是manifest内的源摘要，不是manifest文件SHA。独立`codesign --verify --deep --strict`为exit0。主Agent首次hash检查在`desktop/`工作目录却再次使用`desktop/artifacts/...`，原ENOENT保留；这是App0准备检查失败，后从仓库根正确复算成功，不能写成首次检查即通过。

`run.log`为1／1、约2.3分钟通过；runner-exit记录code0、signal null，20:30:13.788Z结束，由主Agent实际finish收口。下列为日志头的实际npm命令，从`desktop/`执行；输出目录原记录的`***`按本场产物还原。已激活Conda NotAlone；manual／真实App opt-in、签名包绝对路径、私有协调目录、正确`NOTALONE_HEADER_CHANGE_HOST_DIAGNOSTICS_FILE`及已确认A的`NOTALONE_FOLLOW_TEST_NAME_A`均由端侧环境提供，真实值省略。分析阶段没有重跑入口。

```sh
npm run test:app -- --interactive --coordinator root-v9-frame-counts \
  --from 2026-10-15T20:27:54.057Z --until 2026-10-15T20:35:54.057Z \
  --max-launches 1 \
  --output artifacts/event-follow-v9-counts-20261016-787727c8-a35e-438b-b42a-2e3095215277/playwright \
  -- tests/continuous-contact-follow-acceptance.spec.ts
```

## 实际操作、名称与显示上界

主Agent确认助手置顶并执行微信“隐藏其他”；本场没有执行“显示全部”，不沿用旧场操作结论。基线A画面于20:29:07.579Z核对，之后原生显示菜单切到既有测试群、再返回A，逐次核对实际助手AX及画面。没有保存截图、输入新消息、生成、发送、模型调用或权限修改。

以下均为2026-10-15 UTC。正式状态轮询约500ms，画面轮询与状态采样独立，不能把某次状态时刻替代paint：

| 操作 | 菜单／item开始 | 可见画面核对 | 首正式状态样本 |
| --- | --- | --- | --- |
| A→测试群 | 20:29:07.778Z／08.138Z，间隔360ms | 第5次尝试于09.216Z核对群暂停；item后1078ms上界 | 09.309Z，item后1171ms；paused、微信前台、A仅被选择且未确认，无verified-binding |
| 测试群→A | 20:29:26.018Z／26.360Z，间隔342ms | 第21次尝试于29.142Z核对A恢复、名称正确及100%置信度；item后2782ms上界 | 29.452Z，item后3092ms；A被选择／确认、verified-binding |

260条manual-observation覆盖20:28:01.091Z至20:30:11.949Z，共130858ms：88 unavailable、132 confirmed、40 paused；82条助手获焦。132条confirmed均匹配本场A选择／确认及verified-binding；群阶段未被错误确认成A。准备期unavailable不算成功，群不算第二位真实联系人。该场证明实际暂停和恢复正确、记录了有限切换到可见显示上界，不代表所有会话、连续切换或所有窗口布局均具备相同延迟。

## 正式观察、事件时序与实际辅助分账

36条probe-start、36条probe结束、36条后端观察HTTP测量一一对应。每轮均single-frame、returned、recognized、complete、valid，capture request／completion／frame／header OCR各1。recognized包含群阶段，不等于36次私聊身份认证。外层耗时中位465.575ms、P95 644.987ms、最大765.804ms；native中位446.119ms、OCR中位211.977ms。P95取36个升序值第35项。

一次clock-anchor为epochMs=1792096080214、elapsedMs=0.0055835ms、sampleSpanMs=0.001583ms；按既定中点投影近似对齐宿主事件与HTTP，不认证微秒精度、唯一因果或以wallclock参与调度。可见1次有效changed，ordinal1、elapsed=68192.148125ms，约20:29:08.406143Z，即next item后268.143ms。实际HTTP于08.407991Z进入，约在changed后1.848ms；前一HTTP于07.714701Z结束，新请求距其结束693.290ms，比正常2000ms空等的保守最早边界早1306.710ms。群画面核对约在changed后809.857ms。它补充[此前v8](app-instance-clock-v8-20261016.md)的接入时序，仍无唯一trigger-id或反事实实验，不把时序关联当作全部显示改善的唯一定因。

宿主只记录1次源launch，最终分账如下。原生`finished`为38727.938ms、reason=context_changed，紧接最终计数投影nativeElapsed=38727.960ms；宿主close租期38735.548ms、code1、signal none、paused=true、blocked=true、renewalEligible=false。

| 分账 | 实际值 | 计量边界 |
| --- | ---: | --- |
| 初始化整窗CGImage成功返回 | 1 | 仅既有captureWindow成功返回时0→1；不是调用尝试数 |
| screen sample回调收到 | 154 | 既有screen回调入口计数，包括未通过后续门或未进入处理的回调；不是OS内部全部物理帧 |
| 顶部处理帧 | 84 | 原frames计数，合法buffer进入顶部处理时递增，包含detector基线；不是仅changed帧或两帧比较次数 |

计数状态为final，未饱和，三项均在原上界内。没有将84与154相加，没有将154称全部额外物理采图或将两项差额归于某个未经记录的原因。辅助源不做OCR；正式36轮与辅助初始化／局部流分开记录，不能把36当整场总帧数。该元数据来自[已双轴审查的最小计量](header-frame-counts-plan-20261016.md)，没有增加OS查询、采图或改变调度／安全门。

本场原生同次上下文查询返回`instances_zero`、六匹配字段全null，nativeElapsed=38720.409ms，约20:29:24.027381Z，比prev item早2332.619ms。源码只将既有runningApplications数组count=0细分，随后仍抛原.instances错误；null表示上下文未取得，不是六字段不等。源以code1保守锁住连续许可，返A沿正式周期观察恢复；这不是正常55秒到期或本场续租通过，也不能归因于随后才发生的prev点击。

280个独立ps样本均见微信count=1、同初始PID。紧邻诊断的前一查询为20:29:23.797Z至23.825Z，仍采到源；后一查询24.298Z至24.331Z未采到源。两查询间473ms未观测，ps也不是同次Cocoa数组读取；不能据此断言系统微信真的退出、API根因或OS／菜单因果。该分类不作为放宽唯一实例门或自动解锁的依据。

宿主日志229行、69429字节，未达到512行／256KiB上限；有最终counts、close及shutdown／disposed尾部，没有v8那样因cap丢失末段的证据缺口。完整租期／续租已有v8两次55秒证据，本场无需为了补实际计数再强求正常续租或增加SLA。

## 资源与精确自有清理

wrapper内元数据采样共280条，跨度139728ms，start间隔366–528ms、查询耗时24–77ms；仅覆盖被实际采到的进程，不是资源平均值、完整峰值或总开销上界。

| 对象 | 样本命中／不同PID | RSS范围（KiB） | ps CPU字段范围 |
| --- | --- | ---: | ---: |
| 正式短探针 | 33／33 | 240–120704 | 0–19.2% |
| 独立辅助源 | 77／1 | 21104–59616 | 0.7–13.7% |

正式36轮中33个PID被采样捕获，不补造其余3个。App主进程仅1个准备期资源点，RSS 156549120字节（约149.297MiB）、累计CPU 512707微秒；测量中后端max RSS为159481856字节（约152.094MiB）。没有汇总renderer等所有子进程或据局部样本宣称整体低耗。

夹具normalQuit=true，通过公开菜单退出；清理回执backend exit0、signal null、authenticatedStopped=true、stopSource=app-http-response、databaseDropped=true、unconfirmedResources为空。独立只读ps核对34个已采native PID加owned wrapper／child／App／backend，共38个不同PID均gone，owned-runner记录的唯一processGroup无存活成员。采样是wrapper内定时器，没有额外sampler PID／进程组。

owned userData不存在；按项目实际leasePath核对共享interactive租约absent。control目录保留证据；fixture临时根没有在owned中记录，不猜测、遍历或清理未知目录。精确本轮测试库以READ ONLY查询确认不存在，不列其他库、kill进程或改用户业务库。此为空闲／清理历史快照，不替代后续桌面协调。

下面是本轮从仓库根实际执行只读核验的脱敏合并命令，未读.env／凭据；两SHA、18源、38 PID与唯一组gone、userData absent均exit0。共享租约使用实际模块路径，未创建或领取gate。

```sh
node --input-type=module <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { leasePath } from './desktop/scripts/app-test-lease.mjs';
const base = 'desktop/artifacts/event-follow-v9-counts-20261016-787727c8-a35e-438b-b42a-2e3095215277';
const resources = 'desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app/Contents/Resources';
for (const file of ['app.asar', 'notalone-probe/libNotAloneSyncCore.dylib']) console.log(JSON.stringify({ file, sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(resources, file))).digest('hex') }));
const manifest = JSON.parse(fs.readFileSync(path.join(resources, 'notalone-probe/manifest.json')));
console.log(JSON.stringify({ buildSourceDigest: manifest.buildSourceDigest, sourceCount: manifest.buildSources.length }));
const runner = JSON.parse(fs.readFileSync(base + '/owned-runner.json'));
const app = JSON.parse(fs.readFileSync(base + '/playwright/continuous-contact-follow-acceptance-正式App持续单帧名称跟随及可视诊断生命周期/app-test-owned.json'));
const cleanup = JSON.parse(/^binding_fixture_cleanup: (.+)$/m.exec(fs.readFileSync(base + '/run.log', 'utf8'))[1]);
const samples = fs.readFileSync(base + '/process-samples.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
const native = [...new Set(samples.flatMap(row => row.native.map(item => item.pid)))];
const pids = [...new Set([runner.wrapperPid, runner.childPid, app.pid, cleanup.childPid, ...native])];
const ps = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,comm='], { encoding: 'utf8' });
if (ps.status !== 0) throw new Error('ps_failed');
const rows = ps.stdout.trim().split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/)).filter(Boolean);
console.log(JSON.stringify({ recordedPidCount: pids.length, recordedPidsGone: pids.every(pid => !rows.some(row => Number(row[1]) === pid)), recordedProcessGroupGone: !rows.some(row => Number(row[3]) === runner.processGroup), ownedUserDataAbsent: !fs.existsSync(app.userData), sharedInteractiveLeaseAbsent: !fs.existsSync(leasePath(undefined, 'interactive')) }));
JS
codesign --verify --deep --strict desktop/artifacts/remaining-nine-final-20261016-v9/NotAlone-darwin-arm64/NotAlone.app
```

实际精确库查询如下，exit0、exact_owned_database_exists=false；省略本机Conda初始化脚本绝对路径，从已初始化shell开始：

```sh
conda activate NotAlone
python - <<'PY'
import json
from pathlib import Path
import re
import psycopg
base = Path('desktop/artifacts/event-follow-v9-counts-20261016-787727c8-a35e-438b-b42a-2e3095215277')
cleanup = json.loads(re.search(r'^binding_fixture_cleanup: (.+)$', (base / 'run.log').read_text(), re.MULTILINE).group(1))
name = cleanup['databaseName']
assert re.fullmatch(r'notalone_binding_[0-9a-f]{32}_test', name)
with psycopg.connect('host=/tmp dbname=postgres', connect_timeout=3) as admin:
    admin.execute('SET TRANSACTION READ ONLY')
    exists = admin.execute('SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = %s)', (name,)).fetchone()[0]
print(json.dumps({'exact_owned_database_exists': exists}))
PY
```

## 原事件AC4建议与未认证范围

建议[原01票](issues/01-event-capability-and-integration.md)AC4在用户明确的单联系人范围勾选：同版正式包实际A名称／绑定正确、测试群暂停后返A恢复、两方向可见显示上界、36轮正式单帧及独立辅助实际分账、有限资源和精确自有清理均有原件。原规格没有亚秒SLA或本场必须再次正常续租要求；1078／2782ms不改写成精确paint。辅源本场context_changed仍保留为安全失败事实，不因fixture通过写成源正常到期，也不撤回v8已有接入及续租证据。

这不认证双真实联系人、真实来信、所有切换事件覆盖、所有切换亚秒、整体资源峰值或独立Finder启动的当前App TCC责任身份。名称和截图不提交；本场无正文读取、生成、复制外发、发送、真实CLI、模型或权限改变。独立Finder／TCC缺口继续由相应任务处理，不在本报告补签。

忽略原件位于`desktop/artifacts/event-follow-v9-counts-20261016-787727c8-a35e-438b-b42a-2e3095215277/`，包括scope、actual-actions、run／exit、owned、process-samples、host日志、control及Playwright匿名状态／测量。本次仅新增此报告，不修改源码、票据、进度、旧报告或模型冻结／闭账文件；分析没有启动桌面、App、真实探针／CLI或模型，不提交。报告冻结后交主Agent协调独立双轴审查。
