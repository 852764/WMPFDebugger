import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createContext, runInContext } from "node:vm";
import WebSocket, { WebSocketServer } from "ws";
import { MiniappSession } from "../src/mcp/session";

test("interrupted capture resumes only in the same app and service context, recovering pending and queued bodies", async () => {
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const url = "ws://127.0.0.1:" + (server.address() as any).port;
    const context = createContext({ __wxConfig: { appId: "app-a" }, getCurrentPages: () => [],
        wx: { request(o: any) { o.success({ statusCode: 200, data: { id: "queued", price: 2 } }); return {}; } } });
    const original = (context as any).wx.request;
    let uniqueId = "service-original";
    let peer: WebSocket;
    server.on("connection", socket => {
        peer = socket;
        socket.on("message", raw => {
            const msg = JSON.parse(raw.toString());
            let result: any = {};
            if (msg.method === "Runtime.enable") socket.send(JSON.stringify({
                method: "Runtime.executionContextCreated", params: { context: { id: 4, uniqueId, name: "service" } },
            }));
            if (msg.method === "Runtime.evaluate") result = { result: { value: runInContext(msg.params.expression, context) } };
            if (msg.method === "Network.getResponseBody") result = { body: '{"id":"pending","price":1}' };
            socket.send(JSON.stringify({ id: msg.id, result }));
        });
    });
    const session = new MiniappSession();
    try {
        await session.connect(url);
        await session.startCapture("auto");
        session.capture.onEvent({ method: "Network.requestWillBeSent", params: {
            requestId: "native-1", request: { url: "https://shop.test/list", method: "GET" },
        } });
        const disconnected = once(session.cdp, "disconnected");
        peer!.terminate();
        await disconnected;
        runInContext("wx.request({url:'https://shop.test/queued'})", context);
        await assert.rejects(session.reconnect(url, "wrong-app"), /identity/);
        uniqueId = "different-service";
        await assert.rejects(session.reconnect(url, "app-a"), /not the same/);
        assert.equal(session.capture.active, false);
        assert.equal(session.capture.get("1").bodyState, "pending");
        uniqueId = "service-original";
        (context as any).__wxConfig.appId = "other-app";
        await assert.rejects(session.reconnect(url, "app-a"), /not the same/);
        (context as any).__wxConfig.appId = "app-a";
        const result = await session.reconnect(url, "app-a");
        assert.equal(result.resumed, true);
        assert.deepEqual(session.capture.json("1"), { id: "pending", price: 1 });
        assert.deepEqual(session.capture.json("2"), { id: "queued", price: 2 });
        await session.startCapture("wx");
        session.cdp.emit("event", { method: "Network.requestWillBeSent", params: {
            requestId: "stale-domain", request: { url: "https://shop.test/stale", method: "GET" },
        } });
        assert.equal(session.capture.records.size, 0);
    } finally {
        await session.close();
        assert.equal((context as any).wx.request, original);
        for (const socket of server.clients) socket.terminate();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
});

