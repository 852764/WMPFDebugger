import { MiniappSession } from "../mcp/session";
import { inspectContext } from "../mcp/injected";
import { AutomationProfile } from "./profile";
export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
        reject(new Error("Cancelled"));
        return;
    }
    const abort = () => { clearTimeout(timer); reject(new Error("Cancelled")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
});
export type PageResponse = {
    status: number;
    data: unknown;
    retryAfterMs?: number;
};
/** Runs inside WeChat. Credentials from observed templates never cross the CDP boundary. */
export function runtimeRequest(request: AutomationProfile["request"] & {
    data: Record<string, unknown>;
}): Promise<PageResponse> {
    const g = globalThis as any;
    const signature = request.method + " " + request.url;
    const template = g.__wmpfMcpCapture_v1?.templates?.get(signature);
    if (request.useObservedTemplate && !template)
        throw new Error("REQUEST_TEMPLATE_REQUIRED: Open or refresh the verified product list once to observe its request.");
    if (typeof g.wx?.request !== "function")
        throw new Error("wx.request unavailable");
    let data: any = { ...(typeof template?.data === "object" ? template.data : {}), ...request.data };
    if (typeof template?.data === "string") {
        const flat: Record<string, any> = {};
        for (const entry of template.data.split("&")) {
            const pos = entry.indexOf("=");
            const decode = (s: string) => decodeURIComponent(s.replace(/\+/g, " "));
            flat[decode(pos < 0 ? entry : entry.slice(0, pos))] = decode(pos < 0 ? "" : entry.slice(pos + 1));
        }
        Object.assign(flat, request.data);
        data = Object.entries(flat).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(String(v))).join("&");
    }
    return new Promise((resolve, reject) => {
        g.wx.request({
            ...(template || {}), url: request.url, method: request.method, data,
            header: { ...(template?.header || {}), ...request.headers },
            timeout: 15000,
            success: (response: any) => {
                try {
                    let data = response.data;
                    if (typeof data === "string")
                        data = JSON.parse(data);
                    if (JSON.stringify(data).length > 2 * 1024 * 1024)
                        throw new Error("Response exceeds automation body limit");
                    const seconds = Number(response.header?.["Retry-After"] || response.header?.["retry-after"] || 0);
                    resolve({ status: response.statusCode, data, retryAfterMs: Number.isFinite(seconds) ? Math.min(30000, seconds * 1000) : 0 });
                }
                catch (error) {
                    reject(new Error(String(error)));
                }
            },
            fail: (error: any) => reject(new Error(error?.errMsg || "WeChat request failed")),
        });
    });
}
export class RuntimeConnection {
    readonly session = new MiniappSession();
    private serviceId?: number;
    constructor(readonly profile: AutomationProfile, readonly port = 62000) { }
    async attach(signal?: AbortSignal, timeoutMs = 30000) {
        const started = Date.now();
        let last = "No matching target";
        do {
            signal?.throwIfAborted();
            try {
                const targets = await (await fetch("http://127.0.0.1:" + this.port + "/json/list", { signal: AbortSignal.timeout(3000) })).json() as any[];
                for (const target of targets.filter(t => !t.attached)) {
                    try {
                        await this.session.connect(target.webSocketDebuggerUrl);
                        const described = await this.session.describeContexts();
                        const service = described.contexts.find(c => c.capabilities?.appId === this.profile.appId && c.capabilities?.hasWxRequest && c.capabilities?.hasPageStack);
                        if (service) {
                            this.serviceId = service.id;
                            this.session.selectedContext = service.id;
                            await this.session.startCapture("wx");
                            return;
                        }
                        last = "Target appId did not match " + this.profile.appId;
                    }
                    catch (error) {
                        last = String(error);
                    }
                    await this.session.close();
                }
            }
            catch (error) {
                last = String(error);
            }
            if (Date.now() - started >= timeoutMs)
                break;
            await sleep(500, signal);
        } while (true);
        throw new Error("TARGET_UNAVAILABLE: " + last);
    }
    async verify() {
        if (!this.session.cdp.connected || this.serviceId === undefined)
            throw new Error("Runtime disconnected");
        const context = await this.session.run(inspectContext, [], this.serviceId);
        if (context.appId !== this.profile.appId || !context.hasWxRequest)
            throw new Error("Mini-program identity changed");
    }
    async request(data: Record<string, unknown>, signal?: AbortSignal): Promise<PageResponse> {
        signal?.throwIfAborted();
        if (!this.session.cdp.connected) {
            await this.attach(signal);
            await this.bootstrap(signal);
        }
        await this.verify();
        const args = { ...this.profile.request, data };
        const expression = "(" + runtimeRequest.toString() + ")(" + JSON.stringify(args) + ")";
        const result = await this.session.evaluate(expression, this.serviceId, 18000);
        signal?.throwIfAborted();
        return result;
    }
    async bootstrap(signal?: AbortSignal) {
        const route = this.profile.bootstrap.route;
        if (!route)
            return;
        await this.verify();
        const expression = "new Promise((resolve,reject)=>wx[" + JSON.stringify(this.profile.bootstrap.action) + "]({url:" + JSON.stringify(route) + ",success:()=>resolve(true),fail:reject}))";
        try {
            await this.session.evaluate(expression, this.serviceId);
        }
        catch (error) {
            if (this.session.cdp.connected)
                throw error;
        }
        await sleep(1500, signal);
        if (!this.session.cdp.connected)
            await this.attach(signal);
        await this.verify();
        if (this.profile.bootstrap.refreshList) {
            await this.session.evaluate("(()=>{const p=getCurrentPages().slice(-1)[0];if(typeof p.onPullDownRefresh!=='function')throw Error('List refresh unavailable');p.onPullDownRefresh();return true})()", this.serviceId);
            await sleep(1800, signal);
        }
    }
    async close() { await this.session.close(); }
}
