import { useEffect } from 'react';
import type { ContactSessionView } from './contact-session';
import { MemoryProcessingEntry } from './MemoryProcessingEntry';
import { SqliteMemoryManagementPanel } from './SqliteMemoryManagementPanel';
import './memory.css';

export function MemoryPage({ session, visible = true }: { session: ContactSessionView; visible?: boolean }) {
  const processingBridge = window.notalone.fixedMemoryProcessing;
  const managementBridge = window.notalone.sqliteMemoryManagement;
  const { selectedContactId: contactId, scopeRevision } = session.state;
  // 连接代次重挂子树时保留页面持有的桥，避免旧子树的迟到释放撤下新资料。
  useEffect(() => () => {
    void processingBridge.release().catch(() => {});
    void managementBridge.release().catch(() => {});
  }, [processingBridge, managementBridge]);
  return <MemoryProcessingEntry
    releaseOnUnmount={false} visible={visible} bridge={processingBridge}
    backend={window.notalone.backend} contactId={contactId}
    scopeKey={`${contactId}:${scopeRevision}`}>
    {(processingRevision, completedRunId) => <SqliteMemoryManagementPanel
      releaseOnUnmount={false} visible={visible} bridge={managementBridge}
      contactId={contactId} scopeRevision={scopeRevision}
      documentsRefreshKey={processingRevision} completedRunId={completedRunId}/>}
  </MemoryProcessingEntry>;
}
