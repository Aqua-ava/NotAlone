export type StartupCode = 'ready' | 'launch_unconfigured' | 'configuration_invalid' | 'python_unavailable'
  | 'python_version_unsupported' | 'backend_package_missing' | 'project_unavailable'
  | 'env_path_unavailable' | 'info_path_unavailable' | 'database_unconfigured' | 'database_unavailable'
  | 'baseline_missing' | 'baseline_invalid' | 'migration_history_mismatch' | 'migration_pending'
  | 'schema_incomplete' | 'migration_files_invalid' | 'diagnostic_timeout' | 'diagnostic_failed'
  | 'runtime_components_unavailable' | 'runtime_configuration_invalid' | 'runtime_cancelled'
  | 'database_prepare_failed' | 'database_start_failed' | 'database_already_running' | 'local_setup_required' | 'runtime_stop_unconfirmed' | 'runtime_import_incomplete';

export interface DatabaseUpdateState {
  phase: 'idle' | 'checking' | 'available' | 'running' | 'failed' | 'complete';
  revision: number;
  step?: 'stopping' | 'preparing' | 'verifying' | 'updating' | 'reconnecting';
  code?: string;
  hasBackup: boolean;
  external: boolean;
  canContinue: boolean;
  canRecheck: boolean;
}

// 只传递非秘密绝对路径与固定状态，配置文件内容和握手凭据不进入界面。
export interface StartupPaths {
  pythonExecutable: string;
  projectDirectory: string;
  envFilePath: string;
  backendInfoPath: string;
  wechatCliPath: string;
  syncProbePath: string;
}
export interface StartupState {
  phase: 'idle' | 'checking' | 'ready' | 'blocked' | 'first-run' | 'preparing' | 'cancelled';
  mode?: 'managed' | 'external';
  step?: 'checking-components' | 'preparing-data' | 'starting-database' | 'preparing-database' | 'stopping';
  code?: StartupCode;
  revision: number;
  helperWarnings: Array<'cli_unavailable' | 'probe_unavailable'>;
}
export interface StartupBridge {
  getState(): Promise<StartupState>;
  getPaths(): Promise<StartupPaths>;
  savePaths(paths: StartupPaths): Promise<void>;
  prepareConfiguration(): Promise<boolean>;
  beginLocalSetup(): Promise<void>;
  cancelLocalSetup(): Promise<boolean>;
  getDataUpdateState(): Promise<DatabaseUpdateState>;
  backupAndUpdate(): Promise<void>;
  revealUpdateBackup(): Promise<void>;
  recheckDataUpdate(): Promise<void>;
  revealUpdateRecovery(): Promise<void>;
  onDataUpdateChanged(listener: (state: DatabaseUpdateState) => void): () => void;
  retry(): Promise<void>;
  onStateChanged(listener: (state: StartupState) => void): () => void;
}
