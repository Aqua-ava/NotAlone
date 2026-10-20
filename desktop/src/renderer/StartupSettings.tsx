import { useEffect, useState } from 'react';
import type { BackendState } from '../shared/backend-bridge';
import type { StartupCode, StartupPaths, StartupState } from '../shared/startup-bridge';
import './startup-settings.css';

export function useStartupState(): StartupState {
  const [state, setState] = useState<StartupState>({ phase: 'idle', revision: -1, helperWarnings: [] });
  useEffect(() => {
    let active = true;
    const receive = (next: StartupState) => {
      if (active) setState((previous) => next.revision >= previous.revision ? next : previous);
    };
    const unsubscribe = window.notalone.startup.onStateChanged(receive);
    void window.notalone.startup.getState().then(receive).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);
  return state;
}

export function StartupReadiness({ state, onConfigure }: { state: StartupState; onConfigure?: () => void }) {
  if (state.mode === 'managed') return <ManagedSetup state={state} />;
  return <section className="startup-readiness" aria-label="机器环境诊断">
    <h2>机器环境</h2>
    <p role={state.phase === 'blocked' ? 'alert' : undefined}>{state.phase === 'preparing' && state.step === 'updating-schema' ? '正在补齐本机数据库结构…'
      : state.phase === 'checking' ? '正在只读检查机器环境…'
      : state.code ? startupMessages[state.code][0] : '正在检查本机服务…'}</p>
    {state.code && <p className="startup-guidance">{startupMessages[state.code][1]}</p>}
    {state.helperWarnings.includes('cli_unavailable') && <p className="startup-guidance">微信 CLI 未就绪。确认绝对路径后，才可使用已确认范围的文字同步。</p>}
    {state.helperWarnings.includes('probe_unavailable') && <p className="startup-guidance">前台定位探针未就绪。配置完整 helper 后，才可检查前台定位。</p>}
    {onConfigure && state.phase === 'blocked' && <button className="button" onClick={onConfigure}>核对启动路径</button>}
  </section>;
}

export function StartupSettings({ state, backend }: { state: StartupState; backend: BackendState }) {
  const [paths, setPaths] = useState<StartupPaths>();
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void window.notalone.startup.getPaths().then((value) => { if (active) setPaths(value); })
      .catch(() => { if (active) setError('启动路径暂时无法读取，请重新打开设置。'); });
    return () => { active = false; };
  }, []);
  const checking = state.phase === 'checking' || backend.phase === 'connecting';
  const editable = backend.canSaveStartupPaths && !checking && !saving && !preparing;
  async function prepare() {
    if (preparing || !backend.canPrepareConfiguration) return;
    setPreparing(true);
    try {
      if (await window.notalone.startup.prepareConfiguration()) {
        setMessage('本次服务已停止。修改并保存路径后，由你重新检查连接。'); setError('');
      } else setError('服务停读未获确认，暂时不能修改路径。请按连接状态中的入口恢复。');
    } catch { setError('服务停读未获确认，暂时不能修改路径。请按连接状态中的入口恢复。'); }
    finally { setPreparing(false); }
  }
  async function save() {
    if (!paths || !editable) return;
    setSaving(true);
    try { await window.notalone.startup.savePaths(paths); setMessage('启动路径已保存。请重新检查并连接。'); setError(''); }
    catch { setError('启动路径未能保存。请核对绝对路径，并先确认原服务已停止。'); }
    finally { setSaving(false); }
  }
  async function retry() {
    try { setMessage(''); setError(''); await window.notalone.startup.retry(); }
    catch { setError('诊断暂时不可用，请稍后重试。'); }
  }
  if (state.mode === 'managed') return <ManagedSetup state={state} />;
  return <section className="startup-settings" aria-label="本机启动配置">
    <StartupReadiness state={state} />
    <h2>本机启动路径</h2>
    <p>这里只保存非秘密绝对路径。数据库连接与模型凭据保存在你选定的配置文件中，不在本页显示。</p>
    {paths && <div className="startup-paths">
      {pathFields.map(([key, label]) => <label key={key} htmlFor={`startup-${key}`}>{label}
        <input id={`startup-${key}`} value={paths[key]} disabled={!editable} maxLength={1024} spellCheck={false}
          onChange={(event) => setPaths({ ...paths, [key]: event.target.value })} />
      </label>)}
    </div>}
    <div className="startup-actions">
      {(backend.canPrepareConfiguration || preparing) && <button className="button" disabled={preparing} onClick={() => void prepare()}>{preparing ? '正在确认停读…' : '停止服务以修改路径'}</button>}
      <button className="button" disabled={!paths || !editable} onClick={() => void save()}>{saving ? '正在保存…' : '保存启动路径'}</button>
      <button className="button" disabled={!backend.canRetryConnection || checking || saving} onClick={() => void retry()}>重新检查并连接</button>
    </div>
    {!editable && (backend.canPrepareConfiguration || preparing) && <p>先明确停止本次服务，再修改启动路径。失联不能证明服务已停读，未获确认时保留原运行时与恢复入口。</p>}
    {message && <p>{message}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}

const pathFields: Array<[keyof StartupPaths, string]> = [
  ['pythonExecutable', 'Python 可执行文件'], ['projectDirectory', '项目目录'],
  ['envFilePath', '本机配置文件'], ['backendInfoPath', '后端握手文件'],
  ['wechatCliPath', '微信 CLI（可稍后配置）'], ['syncProbePath', '前台定位探针（可稍后配置）'],
];
const startupMessages: Record<StartupCode, [string, string]> = {
  local_setup_required: ['准备你的本机空间。', '联系人、聊天和关系资料保存在这台 Mac。点击开始即可准备，无需安装开发工具。'],
  runtime_components_unavailable: ['App 运行组件缺失或校验未通过。', '请重新取得完整的 NotAlone App 后打开；已有本机资料会保留。'],
  runtime_configuration_invalid: ['本机资料环境需要恢复。', '已有目录或配置无法安全核验。请保留本机资料，使用支持恢复的版本继续，勿删除资料目录。'],
  runtime_cancelled: ['本次设置已取消。', '已保存的准备和资料会保留。可以继续设置，或从菜单退出 App。'],
  runtime_stop_unconfirmed: ['本机服务停止尚未获确认。', '请使用连接状态中的停读入口重试。已有资料会保留。'],
  database_prepare_failed: ['本机资料空间未能准备完成。', '请确认磁盘空间充足，然后重试设置。已经保存的准备会保留。'],
  database_start_failed: ['本机资料服务未能启动。', '请稍后重试；已有资料会保留。仍失败时关闭 App 后重新打开。'],
  database_already_running: ['已有资料服务尚未退出。', '请先正常退出旧版 NotAlone，再重新打开；不要删除资料或锁文件。'],
  ready: ['机器环境已就绪。', '机器检查通过后，继续核对本人身份和模型配置。'],
  launch_unconfigured: ['尚未配置本机启动路径。', '填写已安装的 NotAlone Python 与项目目录，然后保存并重试。'],
  configuration_invalid: ['本机启动路径配置无效。', '重新填写非秘密绝对路径并保存；已有业务资料不会被改动。'],
  python_unavailable: ['Python 可执行文件不可用。', '核对 NotAlone Conda 环境中的绝对 Python 路径，无需在终端激活后启动 App。'],
  python_version_unsupported: ['Python 版本不兼容。', '请使用项目要求的 Python 3.12 环境，然后重新检查。'],
  backend_package_missing: ['后端包或必要依赖缺失。', '核对所选项目源码和 NotAlone 环境中的依赖，安装后重新检查。'],
  project_unavailable: ['项目目录不可用。', '选择包含 backend 的 NotAlone 项目绝对目录。'],
  env_path_unavailable: ['本机配置文件路径不可用。', '核对配置文件及其目录；本页不读取或回显配置内容。'],
  info_path_unavailable: ['后端握手文件路径不可用。', '核对握手文件及其目录，然后重试。'],
  database_unconfigured: ['数据库尚未配置。', '在选定的本机配置文件中配置 NOTALONE_DATABASE_URL，然后重新检查。'],
  database_unavailable: ['数据库暂时不可连接。', '检查本机 PostgreSQL、配置及访问权限，然后重新检查。'],
  baseline_missing: ['既有数据库缺少受管基线或迁移账本。', '先独立核验结构、备份与接管方案。App 不会自动接管或升级业务库。'],
  baseline_invalid: ['数据库审计基线无效。', '核对基线与恢复验证凭证，完成受控恢复后重新检查。'],
  migration_history_mismatch: ['数据库迁移账本或基线发生漂移。', '核对原始迁移文件及实际记录，不通过补写历史成功记录绕过检查。'],
  migration_pending: ['数据库结构尚待补齐。', '启动时会在当前数据库补齐已核验的表结构。若未完成，请检查数据库权限后重试。'],
  database_writers_present: ['还有其他程序正在连接这份数据库。', '请先正常退出使用同一数据库的旧版 App 或开发工具，再重新检查连接。'],
  database_update_requires_local: ['待更新的数据库不在本机。', '自动补齐结构仅适用于本机数据库。请核对原连接配置后重试。'],
  migration_busy: ['另一个数据库结构更新仍在进行。', '请等待它完成，再重新检查连接。'],
  migration_failed: ['本机数据库结构尚未补齐。', '请核对数据库权限与迁移文件后重试。已完成的版本记录会保留。'],
  schema_incomplete: ['数据库必要结构不完整。', '账本不能替代结构就绪。请核验结构与恢复方案，然后重新检查。'],
  migration_files_invalid: ['项目迁移文件不可核验。', '核对所选项目的连续迁移文件，恢复原始文件后重新检查。'],
  diagnostic_timeout: ['机器环境检查超时。', '检查本机服务和路径后重试；重新核验结构就绪后才会启动后台读取。'],
  diagnostic_failed: ['机器环境暂时无法核验。', '核对配置文件、数据库权限及必要结构后重新检查。'],
};

function ManagedSetup({ state }: { state: StartupState }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const preparing = state.phase === 'preparing' || state.phase === 'checking';
  const ready = state.phase === 'ready';
  const steps = { 'checking-components': '正在检查 App 内的运行组件…', 'preparing-data': '正在准备仅保存在本机的资料空间…',
    'starting-database': '正在启动本机资料服务…', 'preparing-database': '正在初始化或补齐当前数据库结构…',
    'updating-schema': '正在补齐本机数据库结构…', 'stopping': '正在停止本次设置与本机服务…' };
  async function begin() {
    if (busy || preparing) return;
    setBusy(true); setError('');
    try { await window.notalone.startup.beginLocalSetup(); }
    catch { setError('设置尚未完成，请按当前提示处理后重试。'); }
    finally { setBusy(false); }
  }
  async function cancel() {
    setError('');
    try { if (!await window.notalone.startup.cancelLocalSetup()) setError('停止尚未获确认，请使用连接状态中的停读入口。'); }
    catch { setError('停止尚未获确认，请稍后重试。'); }
  }
  return <section className="startup-settings" aria-label="本机首次设置">
    <h2>{ready ? '本机环境已就绪' : '欢迎使用 NotAlone'}</h2>
    <p role={state.phase === 'blocked' ? 'alert' : 'status'}>{preparing ? (state.step ? steps[state.step] : '正在检查本机服务…')
      : ready ? '本机服务已通过检查。继续确认本人身份与模型设置。'
        : state.code ? startupMessages[state.code][0] : '准备你的本机空间。'}</p>
    {!ready && !preparing && <p>{state.code ? startupMessages[state.code][1] : startupMessages.local_setup_required[1]}</p>}
    {!ready && <div className="startup-actions">
      {preparing ? <button className="button" disabled={state.step === 'stopping'} onClick={() => void cancel()}>取消本次设置</button>
        : <button className="button primary" disabled={busy} onClick={() => void begin()}>{busy ? '正在开始…'
          : state.phase === 'first-run' ? '开始本机设置' : state.phase === 'cancelled' ? '继续本机设置' : '重试本机设置'}</button>}
    </div>}
    {state.phase === 'blocked' && <button className="button" onClick={() => void cancel()}>停止并返回</button>}
    {error && <p role="alert">{error}</p>}
  </section>;
}
