import { CdpClient, CdpEvent } from "./cdp";
import { NetworkCapture } from "./network";
import { ProductLedger } from "./products";
import { inspectContext, requestHook } from "./injected";

export class MiniappSession {
    readonly cdp = new CdpClient();
    readonly capture = new NetworkCapture(this.cdp);
    readonly contexts = new Map<number, any>();
    readonly datasets = new Map<string, ProductLedger>();
    readonly logs: any[] = [];
    readonly hookContexts = new Set<number | undefined>();
    private hookPending = new Set<number | undefined>();
    private captureGeneration = 0;
    private captureMode: "auto" | "cdp" | "wx" = "auto";
    private cdpCaptureEnabled = false;
    selectedContext?: number;
    target?: string;
    captureDiagnostics: any[] = [];

    constructor() {
        this.cdp.on("event", (event: CdpEvent) => {
            const p = event.params;
            if (event.method === "Runtime.executionContextCreated") {
                this.contexts.set(p.context.id, p.context);
                if (this.capture.active && this.captureMode !== "cdp") void this.installHook(p.context.id);
            } else if (event.method === "Runtime.executionContextDestroyed") {
                this.contexts.delete(p.executionContextId);
                this.hookContexts.delete(p.executionContextId);
                if (this.selectedContext === p.executionContextId) this.selectedContext = undefined;
            } else if (event.method === "Runtime.executionContextsCleared") {
                this.contexts.clear(); this.hookContexts.clear(); this.selectedContext = undefined;
            } else if (event.method === "Runtime.consoleAPICalled" || event.method === "Runtime.exceptionThrown") {
                this.logs.push({ method: event.method, ...p });
                if (this.logs.length > 100) this.logs.shift();
            }
            this.capture.onEvent(event);
        });
        this.cdp.on("disconnected", () => {
            this.contexts.clear(); this.hookContexts.clear(); this.hookPending.clear();
            this.capture.stop(); this.cdpCaptureEnabled = false; this.selectedContext = undefined;
        });
    }

    async connect(url: string) {
        await this.stopCapture();
        this.cdp.disconnect(); this.capture.clear(); this.logs.length = 0; this.target = undefined;
        await this.cdp.connect(url);
        try {
            await this.cdp.request("Runtime.enable");
            this.target = url;
        } catch (error) { this.cdp.disconnect(); throw error; }
        return { connected: true, target: url, contexts: [...this.contexts.values()],
            hint: "Probe contexts and verify appId/route before interacting. Capture starts only when requested." };
    }
    async evaluate(expression: string, contextId = this.selectedContext, timeoutMs = 10000): Promise<any> {
        const result = await this.cdp.request("Runtime.evaluate", {
            expression, returnByValue: true, awaitPromise: true,
            ...(contextId === undefined ? {} : { contextId }),
        }, timeoutMs);
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || "Evaluation failed");
        if (result.result?.subtype === "error") throw new Error(result.result.description);
        return result.result?.value ?? (result.result?.unserializableValue ? { unserializableValue: result.result.unserializableValue } : null);
    }
    run(fn: Function, args: any[], contextId = this.selectedContext) {
        return this.evaluate("(" + fn.toString() + ")(" + args.map(a => JSON.stringify(a)).join(",") + ")", contextId);
    }
    async describeContexts() {
        const results = [];
        if (!this.contexts.size) {
            try { results.push({ id: null, ...(await this.run(inspectContext, [], undefined)) }); }
            catch (error) { results.push({ id: null, error: String(error) }); }
        }
        for (const context of [...this.contexts.values()].slice(0, 40)) {
            try { results.push({ ...context, capabilities: await this.run(inspectContext, [], context.id) }); }
            catch (error) { results.push({ ...context, error: String(error) }); }
        }
        return { selectedContext: this.selectedContext, contexts: results };
    }
    private async installHook(contextId?: number) {
        if (this.hookContexts.has(contextId) || this.hookPending.has(contextId) || !this.capture.active) return;
        this.hookPending.add(contextId);
        const generation = this.captureGeneration;
        try {
            const result = await this.run(requestHook, ["install"], contextId);
            if (result?.installed) {
                if (generation !== this.captureGeneration || !this.capture.active) {
                    try { await this.run(requestHook, ["remove"], contextId); } catch {}
                    return;
                }
                this.hookContexts.add(contextId);
            }
            this.captureDiagnostics.push({ contextId, ...result });
            if (this.captureDiagnostics.length > 40) this.captureDiagnostics.shift();
        } catch (error) { this.captureDiagnostics.push({ contextId, error: String(error) }); this.captureDiagnostics = this.captureDiagnostics.slice(-40); }
        finally { this.hookPending.delete(contextId); }
    }
    async startCapture(mode: "auto" | "cdp" | "wx") {
        if (!this.cdp.connected) throw new Error("Connect to a mini-program first");
        await this.stopCapture();
        this.captureGeneration++;
        this.capture.start(); this.captureMode = mode; this.captureDiagnostics = [];
        if (mode !== "wx") {
            try { await this.cdp.request("Network.enable", { maxTotalBufferSize: 16 * 1024 * 1024, maxResourceBufferSize: 512 * 1024 }, 5000); this.cdpCaptureEnabled = true; }
            catch (error) { this.captureDiagnostics.push({ cdp: String(error) }); }
        }
        if (mode !== "cdp") {
            const ids: (number | undefined)[] = this.contexts.size ? [...this.contexts.keys()].slice(0, 40) : [undefined];
            for (const id of ids) await this.installHook(id);
        }
        return { active: true, cdpEnabled: this.cdpCaptureEnabled, wxContexts: [...this.hookContexts],
            diagnostics: this.captureDiagnostics,
            hint: "Capture future requests only. Navigate or refresh the product list after starting capture; drain regularly using network_list or products_ingest." };
    }
    async drain() {
        if (!this.cdp.connected || !this.capture.active) return;
        for (const id of [...this.hookContexts]) {
            try {
                const result = await this.run(requestHook, ["drain"], id);
                if (result?.missing || result?.active === false) { this.hookContexts.delete(id); await this.installHook(id); }
                this.capture.dropped += result?.dropped || 0;
                for (const record of result?.records || []) this.capture.addWx(record, id ?? -1);
            } catch (error) { this.captureDiagnostics.push({ contextId: id, drainError: String(error) }); this.captureDiagnostics = this.captureDiagnostics.slice(-40); }
        }
        await this.capture.settled();
    }
    async stopCapture() {
        await this.drain();
        this.captureGeneration++;
        this.capture.stop();
        if (this.cdp.connected) {
            for (const id of [...this.hookContexts]) {
                try { await this.run(requestHook, ["remove"], id); } catch {}
            }
            if (this.cdpCaptureEnabled) {
                try { await this.cdp.request("Network.disable", {}, 2000); } catch {}
            }
        }
        this.hookContexts.clear(); this.cdpCaptureEnabled = false;
        return { active: false };
    }
    ledger(dataset: string) {
        if (!this.datasets.has(dataset)) {
            if (this.datasets.size >= 10) throw new Error("Too many datasets; use products_reset before creating more");
            this.datasets.set(dataset, new ProductLedger());
        }
        return this.datasets.get(dataset)!;
    }
    async close() { await this.stopCapture(); this.cdp.disconnect(); }
}
