import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { CliOptions } from "./cli";
import { Logger } from "./logger";

const codex = require("./third-party/RemoteDebugCodex.js");
const proto = require("./third-party/WARemoteDebugProtobuf.js").mmbizwxadevremote;
type Pending = { originalId: number; client: WebSocket; timer: NodeJS.Timeout };
type Target = { id: string; runtime: WebSocket; client?: WebSocket; connectedAt: string; pending: Map<number, Pending> };
function clearPending(target: Target, client?: WebSocket) {
    for (const [id, pending] of target.pending) {
        if (!client || pending.client === client) { clearTimeout(pending.timer); target.pending.delete(id); }
    }
}

/** One selected runtime per CDP connection. Exclusive ownership prevents CDP ID collisions. */
export async function startBridge(options: Pick<CliOptions, "debugPort" | "cdpPort">, logger: Logger) {
    const targets = new Map<string, Target>();
    let sequence = 0;
    const debug = new WebSocketServer({ host: "127.0.0.1", port: options.debugPort, maxPayload: 32 * 1024 * 1024 });
    const proxy = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
    const http = createServer((req, res) => {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        if (req.headers.origin || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "")) {
            res.writeHead(403).end(JSON.stringify({ error: "Local clients only" }));
            return;
        }
        if (url.pathname === "/json" || url.pathname === "/json/list") {
            res.end(JSON.stringify([...targets.values()].map(t => ({
                id: t.id, type: "page", title: "WMPF runtime " + t.id.slice(0, 8),
                url: "", connectedAt: t.connectedAt, attached: !!t.client,
                webSocketDebuggerUrl: "ws://127.0.0.1:" + address().cdpPort + "/devtools/page/" + t.id,
                description: "Probe execution contexts to identify the mini-program.",
            }))));
        } else if (url.pathname === "/json/version") {
            res.end(JSON.stringify({ Browser: "WMPFDebugger-MCP", "Protocol-Version": "1.3" }));
        } else if (url.pathname === "/health") {
            res.end(JSON.stringify({ ok: true, targets: targets.size, ...address() }));
        } else {
            res.writeHead(404).end(JSON.stringify({ error: "Use /json/list" }));
        }
    });
    function address() {
        return { debugPort: (debug.address() as { port: number }).port, cdpPort: (http.address() as { port: number }).port };
    }
    debug.on("connection", runtime => {
        const target: Target = { id: randomUUID(), runtime, connectedAt: new Date().toISOString(), pending: new Map() };
        targets.set(target.id, target);
        logger.info("[miniapp] connected target", target.id);
        runtime.on("message", bytes => {
            try {
                const decoded = proto.WARemoteDebug_DebugMessage.decode(bytes);
                const message = codex.unwrapDebugMessageData(decoded);
                if (message?.category === "chromeDevtoolsResult" && target.client?.readyState === WebSocket.OPEN) {
                    const response = JSON.parse(String(message.data.payload));
                    if (typeof response.id === "number") {
                        const pending = target.pending.get(response.id);
                        if (!pending || pending.client !== target.client) return;
                        clearTimeout(pending.timer); target.pending.delete(response.id);
                        response.id = pending.originalId;
                    }
                    target.client.send(JSON.stringify(response));
                }
            } catch (error) { logger.error("[miniapp] invalid debug frame", String(error)); }
        });
        runtime.on("error", error => logger.error("[miniapp]", error.message));
        runtime.on("close", () => {
            targets.delete(target.id);
            clearPending(target);
            target.client?.close(1011, "Mini-program disconnected; list targets and reconnect");
            logger.info("[miniapp] disconnected target", target.id);
        });
    });
    http.on("upgrade", (req, socket, head) => {
        const reject = (code: number, reason: string) => {
            socket.end("HTTP/1.1 " + code + " " + reason + "\r\nConnection: close\r\n\r\n");
        };
        if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || "") || (req.headers.origin && req.headers.origin !== "devtools://devtools")) {
            reject(403, "Forbidden"); return;
        }
        const pathname = new URL(req.url || "/", "http://127.0.0.1").pathname;
        const id = pathname.startsWith("/devtools/page/") ? pathname.slice("/devtools/page/".length) : undefined;
        const target = id ? targets.get(id) : pathname === "/" && targets.size === 1 ? [...targets.values()][0] : undefined;
        if (!target) { reject(404, "Select a target from /json/list"); return; }
        if (target.client) { reject(409, "Target already attached; close DevTools or the other MCP connection"); return; }
        proxy.handleUpgrade(req, socket, head, client => {
            target.client = client;
            client.on("message", bytes => {
                if (target.runtime.readyState !== WebSocket.OPEN) { client.close(1011, "Runtime disconnected"); return; }
                try {
                    const request = JSON.parse(bytes.toString());
                    const wireId = ++sequence;
                    if (typeof request.id === "number") {
                        const originalId = request.id;
                        if (target.pending.size >= 1000) {
                            client.send(JSON.stringify({ id: originalId, error: { code: -32000, message: "Too many pending CDP commands" } }));
                            return;
                        }
                        const timer = setTimeout(() => {
                            target.pending.delete(wireId);
                            if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify({ id: originalId, error: { code: -32000, message: "Runtime command timed out" } }));
                        }, 30000);
                        timer.unref();
                        target.pending.set(wireId, { originalId, client, timer });
                        request.id = wireId;
                    }
                    const payload = JSON.stringify(request);
                    const wrapped = codex.wrapDebugMessageData({ jscontext_id: "", op_id: wireId, payload }, "chromeDevtools", 0);
                    target.runtime.send(proto.WARemoteDebug_DebugMessage.encode({
                        seq: sequence, category: "chromeDevtools", data: wrapped.buffer,
                        compressAlgo: 0, originalSize: wrapped.originalSize,
                    }).finish(), { binary: true });
                } catch (error) { logger.error("[cdp] invalid frame", String(error)); }
            });
            client.on("error", error => logger.error("[cdp]", error.message));
            client.on("close", () => { clearPending(target, client); if (target.client === client) target.client = undefined; });
        });
    });
    const debugReady = once(debug, "listening");
    const httpReady = once(http, "listening");
    http.listen(options.cdpPort, "127.0.0.1");
    async function close() {
        for (const target of targets.values()) { clearPending(target); target.client?.terminate(); target.runtime.terminate(); }
        await Promise.all([
            new Promise<void>(resolve => debug.close(() => resolve())),
            new Promise<void>(resolve => proxy.close(() => resolve())),
            new Promise<void>(resolve => http.close(() => resolve())),
        ]);
    }
    try { await Promise.all([debugReady, httpReady]); }
    catch (error) { await close(); throw error; }
    logger.info("[server] targets: http://127.0.0.1:" + address().cdpPort + "/json/list");
    return { close, address };
}
