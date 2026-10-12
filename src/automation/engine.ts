import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { parseMiniappLink, resolveProfile } from "./profile";
import { RunStorage, runsRoot, readRun, readReport } from "./storage";
import { RuntimeConnection, PageResponse, sleep } from "./runtime";
import { parsePage } from "./catalog";
import { DebuggerProcess } from "./debugger";
import { WindowsLauncher } from "./windows";
export type RunOptions = {
    link: string;
    profileId?: string;
    resumeId?: string;
    port?: number;
    desktop?: boolean;
};
export interface CollectionRuntime {
    bootstrap(signal?: AbortSignal): Promise<void>;
    request(data: Record<string, unknown>, signal?: AbortSignal): Promise<PageResponse>;
}
export async function collect(storage: RunStorage, runtime: CollectionRuntime, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const { catalog } = storage, profile = catalog.profile;
    if (!catalog.exhausted())
        await runtime.bootstrap(signal);
    while (!catalog.exhausted()) {
        signal?.throwIfAborted();
        if (catalog.receipts.length >= profile.limits.maxPages)
            throw Error("PAGE_LIMIT: Catalog is incomplete.");
        await storage.update({ stage: "collecting_page_" + (catalog.receipts.length + 1) });
        let response: PageResponse | undefined;
        for (let attempt = 0; attempt <= profile.limits.retries; attempt++) {
            try {
                response = await runtime.request(catalog.requestData(), signal);
                if (response.status === 429 || response.status >= 500)
                    throw Error("RETRYABLE_HTTP_" + response.status);
                if (response.status < 200 || response.status >= 300)
                    throw Error("HTTP_" + response.status);
                break;
            }
            catch (error) {
                signal?.throwIfAborted();
                const message = String(error);
                const retryable = /RETRYABLE_HTTP|disconnect|timed out|timeout|request:fail|TARGET_UNAVAILABLE/i.test(message);
                if (!retryable || attempt === profile.limits.retries)
                    throw error;
                await sleep(Math.max(profile.limits.intervalMs, Math.min(30000, response?.retryAfterMs || 500 * 2 ** attempt)), signal);
            }
        }
        await storage.page(parsePage(profile, response!.data, catalog.receipts.length + 1, catalog.nextCursor()));
        if (!catalog.exhausted())
            await sleep(profile.limits.intervalMs, signal);
    }
}
// One automation owner per checkout. Stale process locks are reclaimed without touching live owners.
export async function acquireLock() {
    await fs.mkdir(runsRoot, { recursive: true });
    const file = path.join(runsRoot, "automation.lock"), token = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const handle = await fs.open(file, "wx");
            try {
                await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
            }
            finally {
                await handle.close();
            }
            return async () => { try {
                const current = JSON.parse(await fs.readFile(file, "utf8"));
                if (current.token === token)
                    await fs.unlink(file);
            }
            catch { } };
        }
        catch (error: any) {
            if (error.code !== "EEXIST")
                throw error;
            let owner;
            try {
                owner = JSON.parse(await fs.readFile(file, "utf8"));
            }
            catch {
                throw Error("AUTOMATION_LOCKED: Lock is unreadable; inspect artifacts/runs/automation.lock.");
            }
            try {
                process.kill(owner.pid, 0);
            }
            catch (e: any) {
                if (e.code === "ESRCH") {
                    await fs.unlink(file);
                    continue;
                }
                throw Error("AUTOMATION_LOCKED: Cannot verify the current owner.");
            }
            throw Error("AUTOMATION_LOCKED: Another collection is running.");
        }
    }
    throw Error("AUTOMATION_LOCKED");
}
export class AutomationManager {
    private jobs = new Map<string, {
        controller: AbortController;
        done: Promise<void>;
    }>();
    async start(options: RunOptions) {
        const link = parseMiniappLink(options.link), profile = await resolveProfile(link, options.profileId);
        const unlock = await acquireLock();
        let storage: RunStorage;
        try {
            storage = await RunStorage.open(link, profile, options.resumeId);
        }
        catch (e) {
            await unlock();
            throw e;
        }
        const controller = new AbortController();
        const done = this.execute(storage, options, controller.signal).finally(async () => { this.jobs.delete(storage.state.id); await unlock(); });
        this.jobs.set(storage.state.id, { controller, done });
        // Always observe failures, including disk failures during reporting.
        void done.catch(() => { });
        return { ...storage.state };
    }
    private async execute(storage: RunStorage, options: RunOptions, signal: AbortSignal) {
        const runtime = new RuntimeConnection(storage.catalog.profile, options.port);
        const debuggerProcess = new DebuggerProcess(options.port);
        let launcher: WindowsLauncher | undefined;
        try {
            await storage.update({ stage: "connecting" });
            let attached = false;
            if (await debuggerProcess.healthy()) {
                try {
                    await runtime.attach(signal, 1000);
                    attached = true;
                }
                catch {
                    signal.throwIfAborted();
                }
            }
            if (!attached) {
                // With no runtime yet, opening once creates WeChatAppEx; start hook, then reenter.
                try {
                    await debuggerProcess.start(signal);
                }
                catch (error) {
                    if (!options.desktop)
                        throw error;
                }
                if (!options.desktop)
                    throw Error("OPEN_MINIAPP_REQUIRED: Open this mini-program in hooked WeChat, or set desktop=true to use Windows-MCP.");
                await storage.update({ stage: "opening_wechat" });
                launcher = new WindowsLauncher(signal);
                await launcher.connect();
                await launcher.open(storage.catalog.profile);
                if (!await debuggerProcess.healthy())
                    await debuggerProcess.start(signal);
                try {
                    await runtime.attach(signal, 3500);
                }
                catch {
                    signal.throwIfAborted();
                    await launcher.reenter(storage.catalog.profile);
                    await runtime.attach(signal, 15000);
                }
                await launcher.close();
                launcher = undefined;
            }
            await collect(storage, runtime, signal);
            const report = await storage.export();
            await storage.update({ status: report.amountComplete ? "completed" : "incomplete", stage: "finished" });
        }
        catch (error) {
            const message = String(error).slice(0, 1500);
            await storage.export();
            await storage.update({ status: signal.aborted ? "cancelled" : /DESKTOP_|LAUNCH_|WINDOW_|WINDOWS_MCP_|OPEN_MINIAPP_|REENTRY_|REQUEST_TEMPLATE_REQUIRED/.test(message) ? "needs_input" : "failed", stage: "stopped", error: message });
        }
        finally {
            try {
                await runtime.close();
            }
            finally {
                try {
                    await launcher?.close();
                }
                finally {
                    await debuggerProcess.close();
                }
            }
        }
    }
    async status(id: string) {
        const state = await readRun(id);
        if (state.status === "running" && !this.jobs.has(id)) {
            let live = false;
            try {
                const owner = JSON.parse(await fs.readFile(path.join(runsRoot, "automation.lock"), "utf8"));
                process.kill(owner.pid, 0);
                live = true;
            }
            catch { }
            return { ...state, interrupted: !live, hint: live ? "Owned by another process" : "Process ended; resume using this run ID." };
        }
        return state;
    }
    report = readReport;
    async cancel(id: string) {
        const job = this.jobs.get(id);
        if (!job)
            throw Error("Run is not active in this MCP process; interrupt its CLI process or resume an interrupted run.");
        job.controller.abort();
        return { runId: id, cancellationRequested: true };
    }
    async wait(id: string) { await this.jobs.get(id)?.done; return this.status(id); }
    async close() { const jobs = [...this.jobs.values()]; for (const j of jobs)
        j.controller.abort(); await Promise.allSettled(jobs.map(j => j.done)); }
}
