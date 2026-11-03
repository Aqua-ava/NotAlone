import { useEffect, useRef, useState } from 'react';
import { useSettingsDraft } from './use-settings-draft';
import { readInitialState } from './initial-read';
import type { BackendState } from '../shared/backend-bridge';
import type { DiagnosticPreview, StartupCode, StartupPaths, StartupState } from '../shared/startup-bridge';
import './startup-settings.css';

export function useStartupState(): { state: StartupState; error: string; retry: () => void } {
  const [state, setState] = useState<StartupState>({ phase: 'idle', revision: -1, helperWarnings: [] });
  const [error, setError] = useState('');
  const [readAttempt, setReadAttempt] = useState(0);
  const reading = useRef(false);
  useEffect(() => {
    let active = true;
    const receive = (next: StartupState) => {
      if (active) setState((previous) => next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = window.notalone.startup.onStateChanged(receive);
    void readInitialState({ read: () => window.notalone.startup.getState(), receive, reportError: setError,
      isActive: () => active, busy: reading });
    return () => { active = false; unsubscribe(); };
  }, [readAttempt]);
  return { state, error, retry: () => setReadAttempt((value) => value + 1) };
}

export function StartupReadiness({ state, backend, onConfigure, showStorageDiagnostics = false }: {
  state: StartupState; backend?: BackendState; onConfigure?: () => void; showStorageDiagnostics?: boolean;
}) {
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState('');
  async function retry() {
    if (retrying || !backend?.canRetryConnection) return;
    setRetrying(true); setError('');
    try { await window.notalone.startup.retry(); }
    catch { setError('暂时无法重新连接，请稍后重试或查看诊断。'); }
    finally { setRetrying(false); }
  }
  if (state.sqlite && showStorageDiagnostics) return <section className="startup-readiness" aria-label="SQLite 存储诊断">
    <h2>SQLite 存储诊断</h2>
    <p role={state.sqlite.phase === 'ready' ? 'status' : 'alert'}>{state.sqlite.phase === 'ready'
      ? state.sqlite.capabilities?.includes('history') ? 'SQLite 联系人与历史消息存储已就绪。' : state.sqlite.capabilities?.includes('skills') ? 'SQLite 联系人与 Skill 管理已就绪。' : state.sqlite.capabilities?.includes('contacts') ? 'SQLite 联系人存储已就绪。' : 'SQLite 底座已就绪，业务功能尚未切换。' : 'SQLite 底座检查未通过，已有资料现场已保留。'}</p>
    {state.sqlite.phase === 'ready' && <p>结构版本 {state.sqlite.schemaVersion} · SQLite {state.sqlite.sqliteVersion}</p>}
    {state.sqlite.phase === 'blocked' && <p>诊断代码：{state.sqlite.code}</p>}
    <p>{state.sqlite.capabilities?.includes('history') ? '已开放联系人与历史消息查看；微信读取需先通过版本、状态与来源核验。' : state.sqlite.capabilities?.includes('skills') ? '当前开放联系人身份、逐人授权与 Skill 目录管理；正文同步、记忆和回复尚未开放。' : state.sqlite.capabilities?.includes('contacts') ? '当前仅开放联系人身份与逐人授权；正文同步、记忆和回复尚未开放。' : '此模式仅核验隔离存储，不开放联系人、同步、记忆或回复。'}</p>
    <button className="button" disabled={!backend?.canRetryConnection || retrying} onClick={() => void retry()}>
      {retrying ? '正在检查…' : '重新检查存储'}
    </button>
    {error && <p role="alert">{error}</p>}
  </section>;
  if (state.phase === 'ready') return null;
  const blocked = state.phase === 'blocked' || (backend?.phase === 'disconnected' && !!backend.errorCode);
  return <section className="startup-readiness" aria-label="启动状态">
    <h2>{blocked ? '启动遇到问题' : '正在启动 NotAlone'}</h2>
    <p role={blocked ? 'alert' : 'status'}>{blocked
      ? (state.code ? startupMessages[state.code][0] : '本机服务暂时无法启动。')
      : state.phase === 'preparing' ? '正在准备本机资料…' : '正在连接本机服务…'}</p>
    {blocked && <div className="startup-actions">
      <button className="button" disabled={!backend?.canRetryConnection || retrying} onClick={() => void retry()}>
        {retrying ? '正在重试…' : '重试连接'}
      </button>
      {onConfigure && <button className="button" onClick={onConfigure}>查看诊断</button>}
    </div>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

function StartupDiagnostics({ state }: { state: StartupState }) {
  return <section className="startup-readiness" aria-label="机器环境诊断">
    <h2>机器环境</h2>
    <p role={state.phase === 'blocked' ? 'alert' : undefined}>{state.phase === 'preparing' && state.step === 'updating-schema' ? '正在补齐本机数据库结构…'
      : state.phase === 'checking' ? '正在只读检查机器环境…'
      : state.code ? startupMessages[state.code][0] : '正在检查本机服务…'}</p>
    {state.code && <p className="startup-guidance">{startupMessages[state.code][1]}</p>}
    {state.helperWarnings.includes('cli_unavailable') && <p className="startup-guidance">微信 CLI 未就绪。确认绝对路径后，才可使用已确认范围的文字同步。</p>}
    {state.helperWarnings.includes('probe_unavailable') && <p className="startup-guidance">前台定位探针未就绪。配置完整 helper 后，才可检查前台定位。</p>}
  </section>;
}

export function StartupSettings({ state, backend, open = false, onOpenChange }: {
  state: StartupState; backend: BackendState; open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  return <details className="startup-troubleshooting" open={open} onToggle={(event) => onOpenChange?.(event.currentTarget.open)}>
    <summary>故障排查</summary>
    {open && <>{state.sqlite ? <><StartupReadiness state={state} backend={backend} showStorageDiagnostics /><StartupDiagnostics state={state} /></> : <StartupPathSettings state={state} backend={backend} />}<DiagnosticExport /></>}
  </details>;
}

function DiagnosticExport() {
  const [preview, setPreview] = useState<DiagnosticPreview>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  async function inspect() {
    if (busy) return;
    setBusy(true); setError(''); setMessage(''); setPreview(undefined);
    try { setPreview(await window.notalone.startup.previewDiagnostics()); }
    catch { setError('诊断暂时无法预览，请重试。'); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!preview || busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await window.notalone.startup.exportDiagnostics(preview.previewId);
      setMessage(result.status === 'saved' ? '已将本次预览保存到你选择的本机位置。' : '已取消保存。');
    } catch { setError('诊断未能导出，请检查本机保存位置后重试；也可重新预览。'); }
    finally { setBusy(false); }
  }
  return <section className="startup-settings" aria-label="诊断预览与本机导出">
    <h2>脱敏诊断</h2>
    <p>只包含固定启动状态和恢复入口是否可用。请先查看下面的完整预览，再选择本机位置保存；不会自动上传。</p>
    <button className="button" disabled={busy} onClick={() => void inspect()}>{busy ? '正在处理…' : '预览诊断'}</button>
    {preview && <><pre aria-label="诊断完整预览" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{preview.json}</pre>
      <button className="button" disabled={busy} onClick={() => void save()}>将此预览导出到本机…</button></>}
    {message && <p role="status">{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}

function StartupPathSettings({ state, backend }: { state: StartupState; backend: BackendState }) {
  const [savedPaths, setSavedPaths] = useState<StartupPaths>();
  const [paths, setPaths, discardPaths, saving, saveDraft] = useSettingsDraft('startup-paths', savedPaths);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pathReadPhase, setPathReadPhase] = useState<'reading' | 'ready' | 'failed'>('reading');
  const [pathReadAttempt, setPathReadAttempt] = useState(0);
  useEffect(() => {
    setPathReadPhase('reading');
    if (saving && savedPaths) return;
    let active = true;
    void window.notalone.startup.getPaths().then((value) => { if (active) { setSavedPaths(value); if (!saving) setPathReadPhase('ready'); } })
      .catch(() => { if (active) { setPathReadPhase('failed'); setError('启动路径暂时无法读取，请重新打开设置。'); } });
    return () => { active = false; };
  }, [saving, pathReadAttempt]);
  const checking = state.phase === 'checking' || backend.phase === 'connecting';
  const editable = backend.canSaveStartupPaths && !checking && !saving && !preparing && pathReadPhase === 'ready';
  async function save() {
    if (!paths || !editable) return;
    setPathReadPhase('reading');
    try { await saveDraft(() => window.notalone.startup.savePaths(paths)); setSavedPaths(paths); discardPaths(); setMessage('启动路径已保存。请重新检查并连接。'); setError(''); }
    catch { setError('启动路径未能保存。请核对绝对路径，并先确认原服务已停止。'); }
    finally { setPathReadAttempt(attempt => attempt + 1); }
  }
  async function retry() {
    try { setMessage(''); setError(''); await window.notalone.startup.retry(); }
    catch { setError('诊断暂时不可用，请稍后重试。'); }
  }
  return <section className="startup-settings" aria-label="本机启动配置">
    <StartupDiagnostics state={state} />
    <h2>本机启动路径</h2>
    <p>这里只保存非秘密绝对路径。数据库连接与模型凭据保存在你选定的配置文件中，不在本页显示。</p>
    {!saving && pathReadPhase === 'reading' && <p role="status">正在读取启动路径…</p>}
    {paths && <div className="startup-paths">
      {pathFields.map(([key, label]) => <label key={key} htmlFor={`startup-${key}`}>{label}
        <input id={`startup-${key}`} value={paths[key]} disabled={!editable} maxLength={1024} spellCheck={false}
          onChange={(event) => setPaths({ ...paths, [key]: event.target.value })} />
      </label>)}
    </div>}
    <div className="startup-actions">
      <button className="button" disabled={!paths || !editable} onClick={() => void save()}>{saving ? '正在保存…' : '保存启动路径'}</button>
      <button className="button" disabled={!backend.canRetryConnection || checking || saving} onClick={() => void retry()}>重新检查并连接</button>
    </div>
    {message && <p>{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}

const pathFields: Array<[keyof StartupPaths, string]> = [
  ['projectDirectory', '项目目录'],
  ['envFilePath', '本机配置文件'], ['backendInfoPath', '后端握手文件'],
  ['wechatCliPath', '微信 CLI（可稍后配置）'], ['syncProbePath', '前台定位探针（可稍后配置）'],
];
const startupMessages: Record<StartupCode, [string, string]> = {
  sqlite_business_unavailable: ['SQLite 底座已就绪，业务功能尚未切换。', '当前只核验隔离存储；业务能力须在对应实现及验收完成后开放。'],
  sqlite_storage_failed: ['SQLite 底座检查未通过，已有资料现场已保留。', '核对固定诊断代码和受控配置后重试；不要删除或替换数据库。'],
  local_setup_required: ['准备你的本机空间。', '联系人、聊天和关系资料保存在这台 Mac。点击开始即可准备，无需安装开发工具。'],
  runtime_components_unavailable: ['App 运行组件缺失或校验未通过。', '请重新取得完整的 NotAlone App 后打开；已有本机资料会保留。'],
  runtime_configuration_invalid: ['本机资料环境需要恢复。', '已有目录或配置无法安全核验。请保留本机资料，使用支持恢复的版本继续，勿删除资料目录。'],
  runtime_cancelled: ['本次设置已取消。', '已保存的准备和资料会保留。可以继续设置，或从菜单退出 App。'],
  runtime_stop_unconfirmed: ['本机服务停止尚未获确认。', '请使用连接状态中的停读入口重试。已有资料会保留。'],
  database_prepare_failed: ['本机资料空间未能准备完成。', '请确认磁盘空间充足，然后重试设置。已经保存的准备会保留。'],
  database_start_failed: ['本机资料服务未能启动。', '请稍后重试；已有资料会保留。仍失败时关闭 App 后重新打开。'],
  database_already_running: ['已有资料服务尚未退出。', '请先正常退出旧版 NotAlone，再重新打开；不要删除资料或锁文件。'],
  ready: ['机器环境已就绪。', '机器检查通过后，继续核对本人身份和模型配置。'],
  launch_unconfigured: ['尚未配置本机启动路径。', '填写已安装的 NotAlone 项目目录，然后保存并重试。'],
  configuration_invalid: ['本机启动路径配置无效。', '重新填写非秘密绝对路径并保存；已有业务资料不会被改动。'],
  python_unavailable: ['旧版运行组件不可用。', '请更新完整运行组件后重新检查；现版本无需配置 Python。'],
  python_version_unsupported: ['旧版运行组件不兼容。', '请更新完整运行组件后重新检查。'],
  backend_package_missing: ['后端包或必要依赖缺失。', '核对所选项目源码和 NotAlone 环境中的依赖，安装后重新检查。'],
  project_unavailable: ['项目目录不可用。', '选择包含 backend-ts 的 NotAlone 项目绝对目录。'],
  env_path_unavailable: ['本机配置文件路径不可用。', '核对配置文件及其目录；本页不读取或回显配置内容。'],
  info_path_unavailable: ['后端握手文件路径不可用。', '核对握手文件及其目录，然后重试。'],
  baseline_missing: ['既有数据库缺少受管基线或迁移账本。', '先独立核验结构、备份与接管方案。App 不会自动接管或升级业务库。'],
  baseline_invalid: ['数据库审计基线无效。', '核对基线与恢复验证凭证，完成受控恢复后重新检查。'],
  migration_history_mismatch: ['数据库迁移账本或基线发生漂移。', '核对原始迁移文件及实际记录，不通过补写历史成功记录绕过检查。'],
  migration_pending: ['数据库结构尚待补齐。', '启动时会在当前数据库补齐已核验的表结构。若未完成，请检查数据库权限后重试。'],
  database_writers_present: ['还有其他程序正在连接这份数据库。', '请先正常退出使用同一数据库的旧版 App 或开发工具，再重新检查连接。'],
  migration_busy: ['另一个数据库结构更新仍在进行。', '请等待它完成，再重新检查连接。'],
  migration_failed: ['本机数据库结构尚未补齐。', '请核对数据库权限与迁移文件后重试。已完成的版本记录会保留。'],
  schema_incomplete: ['数据库必要结构不完整。', '账本不能替代结构就绪。请核验结构与恢复方案，然后重新检查。'],
  migration_files_invalid: ['项目迁移文件不可核验。', '核对所选项目的连续迁移文件，恢复原始文件后重新检查。'],
  diagnostic_timeout: ['机器环境检查超时。', '检查本机服务和路径后重试；重新核验结构就绪后才会启动后台读取。'],
  diagnostic_failed: ['机器环境暂时无法核验。', '核对配置文件、数据库权限及必要结构后重新检查。'],
  database_cutover_required: ['旧数据库需要切换，当前处于维护态。', '请保留现有资料，按维护态提示核验旧目标归属与停写状态后重试；App 不会自动清理、重建或回退旧数据库。'],
  database_maintenance: ['本机数据库处于维护态。', '维护期间不启动业务写入；请按诊断提示确认旧目标清理或切换进度后重试。'],
  cutover_manifest_invalid: ['切换控制面记录无法核验。', '保留数据库与控制面文件现场，不要删除；按恢复说明核对后重试。'],
  cutover_authorization_required: ['旧数据库切换需要明确授权。', '只有精确归属并获确认的旧业务对象可清理；未获授权时保持维护态，不创建新空库。'],
  cutover_authorization_invalid: ['旧数据库清理授权不完整或不匹配。', '重新核对授权对象与范围；未覆盖的对象不会被清理。'],
  cutover_legacy_target_unclassified: ['存在无法证明归属的旧对象。', '切换已停止且不会删除未知对象；请核验归属并保留现场后重试。'],
  cutover_legacy_writer_running: ['旧数据库仍有写入者或无法确认已停写。', '先正常退出旧版 App 与相关服务；不要强杀或接管未知进程。'],
  cutover_cleanup_failed: ['旧对象清理未完成。', '保留现场并按同一操作重试；清理完成前不会切换配置或启动新旧双写。'],
  cutover_checks_failed: ['切换目标核验未通过。', '按诊断代码核对结构、媒体闭包与 Skill 空库状态；目标不完整时不切换。'],
  cutover_target_unrecorded: ['已存在未登记身份的数据库文件。', '保留文件与现场等待核验；不会删除它，也不会再创建另一个空库。'],
  cutover_configuration_conflict: ['启动配置与已记录数据库身份不一致。', '保留现场并核对切换控制面记录后重试，不要手工覆盖数据库。'],
  cutover_storage_failed: ['SQLite 目标数据库不可用或身份不符。', '保留文件现场并核对诊断代码；缺失或损坏时不会自动换空库。'],
  sqlite_cancelled: ['本次存储检查已取消。', '可重新检查；已保存的受管文件与现场会保留。'],
};
