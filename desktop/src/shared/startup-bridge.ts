export type StartupCode = 'ready' | 'launch_unconfigured' | 'configuration_invalid' | 'python_unavailable'
  | 'python_version_unsupported' | 'backend_package_missing' | 'project_unavailable'
  | 'env_path_unavailable' | 'info_path_unavailable' | 'database_unconfigured' | 'database_unavailable'
  | 'baseline_missing' | 'baseline_invalid' | 'migration_history_mismatch' | 'migration_pending'
  | 'schema_incomplete' | 'migration_files_invalid' | 'diagnostic_timeout' | 'diagnostic_failed'
  | 'database_writers_present' | 'database_update_requires_local' | 'migration_busy' | 'migration_failed'
  | 'sqlite_business_unavailable' | 'sqlite_storage_failed'
  | 'runtime_components_unavailable' | 'runtime_configuration_invalid' | 'runtime_cancelled'
  | 'database_prepare_failed' | 'database_start_failed' | 'database_already_running' | 'local_setup_required' | 'runtime_stop_unconfirmed'
  | 'database_cutover_required' | 'database_maintenance' | 'cutover_manifest_invalid' | 'cutover_authorization_required'
  | 'cutover_authorization_invalid' | 'cutover_legacy_target_unclassified' | 'cutover_legacy_writer_running' | 'cutover_cleanup_failed'
  | 'cutover_checks_failed' | 'cutover_target_unrecorded' | 'cutover_configuration_conflict' | 'cutover_storage_failed' | 'sqlite_cancelled';

// 只传递非秘密绝对路径与固定状态，配置文件内容和握手凭据不进入界面。
export interface StartupPaths {
  projectDirectory: string;
  envFilePath: string;
  backendInfoPath: string;
  wechatCliPath: string;
  syncProbePath: string;
}
export interface SqliteDevelopmentState {
  capabilities?: ('contacts'|'skills'|'history'|'discussions'|'memory')[];
  phase: 'ready' | 'blocked';
  code: string;
  schemaVersion?: number;
  sqliteVersion?: string;
  /** 维护态：只保留现场与重试入口，不启动旧 PG 或双写后台。 */
  maintenance?: boolean;
}
export interface StartupState {
  sqlite?: SqliteDevelopmentState;
  phase: 'idle' | 'checking' | 'ready' | 'blocked' | 'first-run' | 'preparing' | 'cancelled';
  mode?: 'managed' | 'external';
  step?: 'checking-components' | 'preparing-data' | 'starting-database' | 'preparing-database' | 'updating-schema' | 'stopping';
  code?: StartupCode;
  revision: number;
  helperWarnings: Array<'cli_unavailable' | 'probe_unavailable'>;
}
export interface DiagnosticPreview { previewId: string; json: string; }
export interface DiagnosticExportResult { status: 'saved' | 'cancelled'; }
export interface StartupBridge {
  previewDiagnostics(): Promise<DiagnosticPreview>;
  exportDiagnostics(previewId: string): Promise<DiagnosticExportResult>;
  getState(): Promise<StartupState>;
  getPaths(): Promise<StartupPaths>;
  savePaths(paths: StartupPaths): Promise<void>;
  prepareConfiguration(): Promise<boolean>;
  revealUpdateBackup(): Promise<void>;
  retry(): Promise<void>;
  onStateChanged(listener: (state: StartupState) => void): () => void;
}
