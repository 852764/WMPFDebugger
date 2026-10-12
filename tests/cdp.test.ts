import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { CdpClient } from "../src/mcp/cdp";

test("CDP matches out-of-order replies, reports protocol errors, times out and rejects on disconnect", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(wss, "listening");
    const client = new CdpClient();
    const connection = once(wss, "connection");
    await client.connect("ws://127.0.0.1:" + (wss.address() as any).port);
    const [socket] = await connection;
    const messages: any[] = [];
    socket.on("message", (bytes: any) => {
        const m = JSON.parse(bytes.toString()); messages.push(m);
        if (messages.length === 2) {
            socket.send(JSON.stringify({ id: messages[1].id, result: { value: 2 } }));
            socket.send(JSON.stringify({ id: messages[0].id, result: { value: 1 } }));
        }
        if (m.method === "Bad.command") socket.send(JSON.stringify({ id: m.id, error: { message: "Unsupported" } }));
    });
    try {
        assert.deepEqual(await Promise.all([client.request("A.a"), client.request("B.b")]), [{ value: 1 }, { value: 2 }]);
        await assert.rejects(client.request("Bad.command"), /Unsupported/);
        await assert.rejects(client.request("No.reply", {}, 20), /timed out/);
        const pending = client.request("Long.wait");
        const rejected = assert.rejects(pending, /closed/);
        client.disconnect();
        await rejected;
        await assert.rejects(client.connect("ws://example.com"), /local/);
    } finally { client.disconnect(); for (const ws of wss.clients) ws.terminate(); await new Promise<void>(r => wss.close(() => r())); }
});
