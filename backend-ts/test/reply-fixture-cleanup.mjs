/** 验收夹具清理：失败仍释放自有连接，退出未确认则保留DB/temp现场。 */
async function deadline(work, milliseconds, stage) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(work),
            new Promise((_, reject) => {
                timer = setTimeout(() => {
                    const error = new Error(`夹具清理超时：${stage}`);
                    error.code = 'CLEANUP_TIMEOUT';
                    reject(error);
                }, milliseconds);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** 仅操作本轮spawn返回的ChildProcess；强退仍作为失败保留。 */
export async function stopOwnedChild(process, {graceMs = 7000, forcedMs = 1000} = {}) {
    if (!process) return;
    const child = process.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (!child.pid) throw new Error('自有进程spawn未确认');
    child.kill('SIGTERM');
    try {
        await deadline(() => process.exited, graceMs, '等待自有进程退出');
    } catch (error) {
        if (error.code !== 'CLEANUP_TIMEOUT') throw error;
        child.kill('SIGKILL');
        try {
            await deadline(() => process.exited, forcedMs, '等待强退回执');
        } catch (confirmation) {
            throw new AggregateError([error, confirmation], '自有进程退出未确认', {cause: error});
        }
        throw new Error('自有进程强退，不能记为正常清理', {cause: error});
    }
}

export async function cleanupReplyFixture(options) {
    const failures = [];
    const attempt = async (stage, work) => {
        try {
            return {ok: true, value: await deadline(work, options.stageTimeoutMs ?? 9000, stage)};
        } catch (error) {
            failures.push({stage, error});
            return {ok: false};
        }
    };
    const stop = options.stopChild ?? stopOwnedChild;
    let provider, client;
    try {
        await attempt('释放供应商屏障', () => options.releasePending?.());
        for (const worker of options.workers ?? []) await attempt('停止自有worker', () => stop(worker));
        for (const host of options.hosts ?? []) await attempt('停止自有host', () => stop(host));
    } finally {
        try {
            provider = await attempt('关闭自有provider', options.closeProvider);
        } finally {
            client = await attempt('关闭自己的PG client', options.closeClient);
        }
    }
    const confirmation = await attempt('确认自有进程退出', options.confirmOwnedProcesses);
    const processes = confirmation.value ?? [{state: 'unconfirmed'}];
    const confirmed = confirmation.ok && processes.every(process => process.state === 'gone');
    if (!confirmed) failures.push({stage: '确认自有进程退出', error: new Error('自有进程退出未确认，保留现场')});
    let disposalAttempted = false, disposed = false;
    // stop失败也保留现场；不能因为稍后pid消失就吞掉原始失败并DROP库。
    if (failures.length === 0 && confirmed && provider.ok && client.ok) {
        disposalAttempted = true;
        disposed = (await attempt('删除自有库与临时目录', options.disposeFixture)).ok;
    }
    const proof = {
        state: disposed ? 'cleaned' : 'unconfirmed', processes,
        providerClosed: provider.ok, clientClosed: client.ok,
        fixtureRetained: !disposalAttempted, fixtureDisposed: disposed,
        failureStages: failures.map(failure => failure.stage),
        errors: failures.map(failure => ({stage: failure.stage, message: failure.error.message})),
    };
    await attempt('保存清理证明', () => options.writeProof(proof));
    if (failures.length) {
        const error = new AggregateError(failures.map(failure => failure.error), '夹具清理未确认', {cause: failures[0].error});
        error.proof = proof;
        throw error;
    }
    return proof;
}
