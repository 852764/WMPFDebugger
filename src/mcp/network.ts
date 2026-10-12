import { CdpClient, CdpEvent } from "./cdp";
import { safeUrl } from "./data";

export type NetworkRecord = {
    id: string; source: "cdp" | "wx"; url: string; method: string; timestamp: number;
    status?: number; mimeType?: string; body?: string; bodyState: string; error?: string;
    contextId?: number; requestId?: string;
};
export class NetworkCapture {
    readonly records = new Map<string, NetworkRecord>();
    active = false;
    dropped = 0;
    private sequence = 0;
    private epoch = 0;
    private bodyBytes = 0;
    private requests = new Map<string, string>();
    private fetching = new Set<Promise<void>>();
    constructor(private cdp: CdpClient, private maxRecords = 300, private maxBodyBytes = 512 * 1024, private totalBodyBytes = 16 * 1024 * 1024) {}
    start() { this.clear(); this.active = true; }
    stop() { this.active = false; this.epoch++; }
    clear() { this.epoch++; this.records.clear(); this.requests.clear(); this.bodyBytes = 0; this.dropped = 0; }
    private add(record: Omit<NetworkRecord, "id">): NetworkRecord {
        const item = { ...record, id: String(++this.sequence), url: safeUrl(record.url) };
        this.records.set(item.id, item);
        while (this.records.size > this.maxRecords) {
            const first = this.records.values().next().value!;
            this.bodyBytes -= Buffer.byteLength(first.body || "");
            this.records.delete(first.id);
            if (first.requestId && this.requests.get(first.requestId) === first.id) this.requests.delete(first.requestId);
            this.dropped++;
        }
        return item;
    }
    private setBody(item: NetworkRecord, body: string) {
        if (!this.records.has(item.id)) return;
        const size = Buffer.byteLength(body);
        if (size > this.maxBodyBytes) { item.bodyState = "too_large"; return; }
        while (this.bodyBytes + size > this.totalBodyBytes) {
            const old = [...this.records.values()].find(r => r.body !== undefined && r.id !== item.id);
            if (!old) { item.bodyState = "budget_exceeded"; return; }
            this.bodyBytes -= Buffer.byteLength(old.body!);
            delete old.body; old.bodyState = "evicted";
        }
        this.bodyBytes -= Buffer.byteLength(item.body || "");
        item.body = body; item.bodyState = "available"; this.bodyBytes += size;
    }
    addWx(value: any, contextId: number) {
        if (!this.active) return;
        const item = this.add({ source: "wx", contextId, url: String(value.url), method: String(value.method),
            timestamp: value.started, status: value.status, error: value.error, bodyState: value.error ? "failed" : "unavailable_or_too_large" });
        if (typeof value.body === "string") this.setBody(item, value.body);
    }
    onEvent(event: CdpEvent) {
        if (!this.active || !event.method.startsWith("Network.")) return;
        const p = event.params;
        if (event.method === "Network.requestWillBeSent") {
            const previous = this.requests.get(p.requestId);
            if (previous && p.redirectResponse) {
                const old = this.records.get(previous);
                if (old) { old.status = p.redirectResponse.status; old.bodyState = "redirect"; }
            }
            const item = this.add({ source: "cdp", requestId: p.requestId, url: p.request.url, method: p.request.method,
                timestamp: p.wallTime ? p.wallTime * 1000 : Date.now(), bodyState: "pending" });
            this.requests.set(p.requestId, item.id);
            return;
        }
        const id = this.requests.get(p.requestId);
        const item = id ? this.records.get(id) : undefined;
        if (!item) return;
        if (event.method === "Network.responseReceived") {
            item.status = p.response.status; item.mimeType = p.response.mimeType;
        } else if (event.method === "Network.loadingFailed") {
            item.bodyState = "failed"; item.error = p.errorText;
            this.requests.delete(p.requestId);
        } else if (event.method === "Network.loadingFinished") {
            this.requests.delete(p.requestId);
            if (item.mimeType && !/json|text|javascript|xml|form-urlencoded/i.test(item.mimeType)) { item.bodyState = "non_text"; return; }
            if (p.encodedDataLength > this.maxBodyBytes) { item.bodyState = "too_large"; return; }
            if (this.fetching.size >= 8) { item.bodyState = "capture_busy"; return; }
            const epoch = this.epoch;
            const job = this.cdp.request("Network.getResponseBody", { requestId: p.requestId }).then(result => {
                if (epoch !== this.epoch) return;
                const body = result.base64Encoded ? Buffer.from(result.body, "base64").toString("utf8") : result.body;
                this.setBody(item, body);
            }).catch(error => {
                if (epoch === this.epoch) { item.bodyState = "unavailable"; item.error = String(error); }
            }).finally(() => this.fetching.delete(job));
            this.fetching.add(job);
        }
    }
    async settled() { await Promise.all([...this.fetching]); }
    list(args: { after?: number; limit?: number; urlIncludes?: string } = {}) {
        const matching = [...this.records.values()].filter(r => Number(r.id) > (args.after || 0) && (!args.urlIncludes || r.url.includes(args.urlIncludes)));
        const rows = matching.slice(0, args.limit || 30);
        return { active: this.active, retained: this.records.size, dropped: this.dropped,
            nextCursor: rows.length ? Number(rows[rows.length - 1].id) : args.after || 0, hasMore: matching.length > rows.length,
            requests: rows.map(({ body, ...summary }) => ({ ...summary, bodyBytes: body === undefined ? 0 : Buffer.byteLength(body) })) };
    }
    get(id: string) {
        const item = this.records.get(id);
        if (!item) throw new Error("Request missing or evicted; list requests again");
        return item;
    }
    json(id: string): any {
        const item = this.get(id);
        if (item.body === undefined) throw new Error("Body not available: " + item.bodyState);
        try { return JSON.parse(item.body); } catch { throw new Error("Response is not JSON"); }
    }
}
