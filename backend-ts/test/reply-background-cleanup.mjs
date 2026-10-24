/** B5-01清理适配：仅正常确认退出后释放fixture，失败不删除原现场。 */
import {cleanupReplyFixture} from './reply-fixture-cleanup.mjs';
import {mkdtemp, chmod} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

export async function prepareB5ArtifactDirectory(configured) {
    if (configured) return configured;
    const directory = await mkdtemp(join(tmpdir(), 'notalone-b5-raw-'));
    await chmod(directory, 0o700);
    return directory;
}

export async function cleanupB5BackgroundFixture(options) {
    const host = options.host;
    const state = () => {
        if (!host) return [];
        const child = host.child;
        const result = [{pid: child.pid ?? null,
            state: child.exitCode === 0 && child.signalCode === null ? 'gone' : 'unconfirmed'}];
        if (typeof options.legacyPid !== 'number') result.push({role: 'legacy', state: 'unconfirmed'});
        else result.push({role: 'legacy', pid: options.legacyPid,
            state: options.legacyGone(options.legacyPid) ? 'gone' : 'unconfirmed'});
        return result;
    };
    return cleanupReplyFixture({
        stageTimeoutMs: options.stageTimeoutMs,
        hosts: host ? [host] : [],
        releasePending: options.releasePending,
        stopChild: async owned => {
            const child = owned.child;
            if (child.exitCode === null && child.signalCode === null) {
                if (!child.pid) throw new Error('B5-01自有spawn未确认，保留现场');
                const response = await options.shutdown();
                if (response.data?.state !== 'stopped') throw new Error('B5-01正常shutdown未确认');
                await owned.exited; // 外层已审helper的stage deadline为此等待设定上限。
            }
            if (child.exitCode !== 0 || child.signalCode !== null) {
                throw new Error('B5-01自有进程退出异常或强退，保留现场');
            }
            await options.checkClientConnections?.();
        },
        closeProvider: async () => {
            let original;
            try { await options.closeProvider(); } catch (error) { original = error; }
            try { await options.captureEvidence(); }
            catch (error) {
                if (original) throw new AggregateError([original, error], '关闭provider及保存原证据失败', {cause: original});
                throw error;
            }
            if (original) throw original;
        },
        closeClient: options.closeClient,
        disposeFixture: options.disposeFixture,
        confirmOwnedProcesses: state,
        writeProof: options.writeProof,
    });
}
