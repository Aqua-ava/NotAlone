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
  return <section className="startup-readiness" aria-label="机器环境诊断">
    <h2>机器环境</h2>
    <p role={state.phase === 'blocked' ? 'alert' : undefined}>{state.phase === 'checking' ? '正在只读检查机器环境…'
      : state.code ? startupMessages[state.code][0] : '请在应用配置中核对本机启动路径。'}</p>
    {state.code && <p className="startup-guidance">{startupMessages[state.code][1]}</p>}
    {state.helperWarnings.includes('cli_unavailable') && <p className="startup-guidance">微信 CLI 未就绪。确认绝对路径后，才可使用已确认范围的文字同步。</p>}
    {state.helperWarnings.includes('probe_unavailable') && <p className="startup-guidance">前台定位探针未就绪。配置完整 helper 后，才可检查前台定位。</p>}
    {onConfigure && state.phase !== 'ready' && <button className="button" onClick={onConfigure}>核对启动路径</button>}
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
      .catch(() => { if (active) setError('启动路径暂时无法读取，请重新打开应用配置。'); });
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
  migration_pending: ['数据库尚有待迁移版本。', '先核验数据范围与备份，再经明确授权独立执行迁移，完成后重新检查。'],
  schema_incomplete: ['数据库必要结构不完整。', '账本不能替代结构就绪。请核验结构与恢复方案，然后重新检查。'],
  migration_files_invalid: ['项目迁移文件不可核验。', '核对所选项目的连续迁移文件，恢复原始文件后重新检查。'],
  diagnostic_timeout: ['机器环境检查超时。', '检查本机服务和路径后重试；本次没有自动迁移或启动读取进程。'],
  diagnostic_failed: ['机器环境暂时无法核验。', '核对配置文件、数据库权限及必要结构后重新检查。'],
};
