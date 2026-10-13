import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createContext, runInContext } from "node:vm";
import WebSocket from "ws";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startBridge } from "../src/bridge";
import { createMcpServer } from "../src/mcp/server";
const codec = require("../src/third-party/RemoteDebugCodex.js");
const proto = require("../src/third-party/WARemoteDebugProtobuf.js").mmbizwxadevremote;
const logger = { info() {}, error() {}, main_debug() {}, frida_debug() {} };

test("two runtimes remain isolated; MCP captures wx requests and deduplicates across pages end to end", { timeout: 20000 }, async () => {
    const bridge = await startBridge({ debugPort: 0, cdpPort: 0 }, logger);
    const runtimeA = new WebSocket("ws://127.0.0.1:" + bridge.address().debugPort);
    await once(runtimeA, "open");
    const runtimeB = new WebSocket("ws://127.0.0.1:" + bridge.address().debugPort);
    await once(runtimeB, "open");
    let callsToB = 0;
    runtimeB.on("message", () => callsToB++);
    let page = 0;
    let aborts = 0;
    let callbackThis: any;
    const context = createContext({
        wx: { request(options: any) {
            page++;
            options.success.call({ callback: true }, { statusCode: 200, data: {
                list: page === 1 ? [{ id: "a", price: "0.10", sales: 3 }, { id: "b", price: 10, sales: 2 }]
                    : [{ id: "b", price: 10, sales: 2 }, { id: "c", price: "2.50", sales: 4 }],
            } });
            options.complete?.();
            return { abort() { aborts++; } };
        } },
        getCurrentPages: () => [{ route: "pages/products", data: { loaded: true } }],
        __wxConfig: { appId: "test-app" },
        remember(value: any) { callbackThis = value; },
    });
    const originalRequest = (context as any).wx.request;
    let seq = 0;
    let runtimeEnabled = true; // A previous debugger left the domain enabled.
    const send = (message: any) => {
        const data = proto.WARemoteDebug_ChromeDevtoolsResult.encode({ payload: JSON.stringify(message) }).finish();
        runtimeA.send(proto.WARemoteDebug_DebugMessage.encode({
            seq: ++seq, category: "chromeDevtoolsResult", data, compressAlgo: 0, originalSize: data.length,
        }).finish());
    };
    runtimeA.on("message", data => {
        const decoded = codec.unwrapDebugMessageData(proto.WARemoteDebug_DebugMessage.decode(data));
        const message = JSON.parse(decoded.data.payload);
        try {
            if (message.method === "Runtime.enable") {
                if (!runtimeEnabled) send({ method: "Runtime.executionContextCreated", params: { context: { id: 7, name: "AppService", origin: "" } } });
                runtimeEnabled = true;
                send({ id: message.id, result: {} });
            } else if (message.method === "Runtime.disable") {
                runtimeEnabled = false;
                send({ id: message.id, result: {} });
            } else if (message.method === "Runtime.evaluate") {
                const value = runInContext(message.params.expression, context, { timeout: 1000 });
                send({ id: message.id, result: { result: { type: "object", value } } });
            } else if (message.method === "Network.enable") {
                send({ id: message.id, error: { message: "Native network unsupported; use wx capture" } });
            } else send({ id: message.id, result: {} });
        } catch (error) { send({ id: message.id, result: { exceptionDetails: { text: String(error) } } }); }
    });
    const { server, session } = createMcpServer();
    const client = new Client({ name: "integration-test", version: "1" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const call = async (name: string, args: any = {}) => {
        const result = await client.callTool({ name, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        return JSON.parse((result.content as any)[0].text);
    };
    try {
        const registered=(await client.listTools()).tools.map(t=>t.name);
        for(const name of ["miniapp_batch_start","miniapp_batch_resume","miniapp_batch_status","miniapp_batch_report","miniapp_batch_cancel","miniapp_batch_evidence","miniapp_batch_adapt"])assert.ok(registered.includes(name),"Missing MCP tool: "+name);
        assert.ok(registered.length >= 27);
        const targets = await call("miniapp_targets", { port: bridge.address().cdpPort });
        assert.equal(targets.length, 2);
        // Root legacy endpoint must not choose a random mini-program.
        const ambiguous = new WebSocket("ws://127.0.0.1:" + bridge.address().cdpPort);
        ambiguous.on("error", () => {});
        await assert.rejects(once(ambiguous, "open"));
        await call("miniapp_connect", { port: bridge.address().cdpPort, targetId: targets[0].id });
        const competing = new WebSocket(targets[0].webSocketDebuggerUrl);
        competing.on("error", () => {});
        await assert.rejects(once(competing, "open"));
        const contexts = await call("miniapp_contexts");
        assert.equal(contexts.contexts[0].capabilities.appId, "test-app");
        await call("miniapp_select_context", { contextId: 7 });
        const start = await call("miniapp_network_start", { mode: "auto" });
        assert.equal(start.cdpEnabled, false);
        assert.deepEqual(start.wxContexts, [7]);
        await call("miniapp_evaluate", { expression: "wx.request({url:'https://shop.test/list?page=1',success:function(){remember(this)}}).abort(); 'ok'" });
        await call("miniapp_evaluate", { expression: "wx.request({url:'https://shop.test/list?page=2'}); 'ok'" });
        assert.equal(aborts, 1);
        assert.equal(callbackThis.callback, true);
        const requests = await call("miniapp_network_list");
        assert.equal(requests.requests.length, 2);
        const ids = requests.requests.map((r: any) => r.id);
        const mapping = { itemsPath: "list", idPaths: ["id"], pricePath: "price", salesPath: "sales", priceUnit: "yuan" };
        await call("miniapp_products_ingest", { dataset: "test", requestIds: ids, mapping });
        const report = await call("miniapp_products_report", { dataset: "test" });
        assert.equal(report.uniqueProducts, 3);
        assert.equal(report.duplicates, 1);
        assert.equal(report.totalEstimateYuan, "30.30");
        assert.equal(callsToB, 0);
        await call("miniapp_network_stop");
        assert.equal((context as any).wx.request, originalRequest);
        await call("miniapp_disconnect");
        await call("miniapp_connect", { port: bridge.address().cdpPort, targetId: targets[0].id });
        assert.equal((await call("miniapp_contexts")).contexts[0].id, 7);
        runtimeA.close();
        await once(runtimeA, "close");
        await new Promise(r => setTimeout(r, 20));
        const failed = await client.callTool({ name: "miniapp_evaluate", arguments: { expression: "1" } });
        assert.equal(failed.isError, true);
    } finally {
        await session.close(); await client.close(); await server.close();
        runtimeA.terminate(); runtimeB.terminate(); await bridge.close();
    }
});

test("stdio server initializes and handles tools without polluting stdout", { timeout: 15000 }, async () => {
    const client = new Client({ name: "stdio-smoke", version: "1" });
    const transport = new StdioClientTransport({
        command: process.execPath, args: ["--require", "ts-node/register", "src/mcp/index.ts"], cwd: process.cwd(), stderr: "pipe",
    });
    try {
        await client.connect(transport);
        const tools = await client.listTools();
        assert.ok(tools.tools.some(t => t.name === "miniapp_products_ingest"));
        const result = await client.callTool({ name: "miniapp_products_report", arguments: { dataset: "empty" } });
        assert.equal(JSON.parse((result.content as any)[0].text).totalEstimateYuan, "0.00");
    } finally { await client.close(); }
});
