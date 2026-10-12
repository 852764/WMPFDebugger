import { EventEmitter } from "node:events";
import WebSocket from "ws";

export type CdpEvent = { method: string; params: any; sessionId?: string };
export class CdpClient extends EventEmitter {
    private socket?: WebSocket;
    private nextId = 0;
    private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    get connected() { return this.socket?.readyState === WebSocket.OPEN; }

    async connect(url: string, timeoutMs = 8000): Promise<void> {
        await this.disconnect();
        const parsed = new URL(url);
        if (parsed.protocol !== "ws:" || !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) || parsed.username || parsed.password) {
            throw new Error("Only local ws:// debugging endpoints are accepted");
        }
        const socket = new WebSocket(url, { maxPayload: 32 * 1024 * 1024, handshakeTimeout: timeoutMs });
        this.socket = socket;
        socket.on("message", data => {
            if (this.socket !== socket) return;
            let message: any;
            try { message = JSON.parse(data.toString()); } catch { return; }
            if (typeof message.id === "number") {
                const pending = this.pending.get(message.id);
                if (!pending) return;
                clearTimeout(pending.timer);
                this.pending.delete(message.id);
                if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
                else pending.resolve(message.result ?? {});
            } else if (message.method) this.emit("event", message as CdpEvent);
        });
        socket.on("error", () => {});
        socket.on("close", (_code, reason) => {
            if (this.socket !== socket) return;
            this.socket = undefined;
            this.rejectPending(new Error("CDP disconnected: " + reason.toString()));
            this.emit("disconnected");
        });
        await new Promise<void>((resolve, reject) => {
            socket.once("open", resolve);
            socket.once("error", reject);
            socket.once("close", () => reject(new Error("CDP closed before connection")));
        });
    }
    request(method: string, params: Record<string, unknown> = {}, timeoutMs = 10000): Promise<any> {
        if (!this.connected) return Promise.reject(new Error("Not connected. Open the mini-program, list targets, then connect."));
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(method + " timed out; target may not support this domain or context."));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.socket!.send(JSON.stringify({ id, method, params }), error => {
                if (error && this.pending.delete(id)) { clearTimeout(timer); reject(error); }
            });
        });
    }
    private rejectPending(error: Error) {
        for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
        this.pending.clear();
    }
    async disconnect() {
        const socket = this.socket;
        this.socket = undefined;
        this.rejectPending(new Error("CDP connection replaced or closed"));
        if (!socket) return;
        this.emit("disconnected");
        if (socket.readyState === WebSocket.CLOSED) return;
        // Wait for the close handshake so the bridge releases exclusive ownership.
        await new Promise<void>(resolve => {
            const timer = setTimeout(() => { socket.terminate(); resolve(); }, 1000);
            timer.unref();
            socket.once("close", () => { clearTimeout(timer); resolve(); });
            if (socket.readyState === WebSocket.OPEN) socket.close();
            else socket.terminate();
        });
    }
}
