import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { startBridge } from "../src/bridge";
const codec = require("../src/third-party/RemoteDebugCodex.js");
const proto = require("../src/third-party/WARemoteDebugProtobuf.js").mmbizwxadevremote;
test("late replies from an old CDP client are never delivered to a new one using the same ID", async () => {
    const bridge = await startBridge({ debugPort: 0, cdpPort: 0 }, { info() {}, error() {}, main_debug() {}, frida_debug() {} });
    const runtime = new WebSocket("ws://127.0.0.1:" + bridge.address().debugPort);
    await once(runtime, "open");
    const target = (await (await fetch("http://127.0.0.1:" + bridge.address().cdpPort + "/json/list")).json() as any[])[0];
    const first = new WebSocket(target.webSocketDebuggerUrl);
    let second: WebSocket | undefined;
    function reply(id: number, marker: string) {
        const data = proto.WARemoteDebug_ChromeDevtoolsResult.encode({ payload: JSON.stringify({ id, result: { marker } }) }).finish();
        runtime.send(proto.WARemoteDebug_DebugMessage.encode({ category: "chromeDevtoolsResult", data, compressAlgo: 0 }).finish());
    }
    try {
        await once(first, "open");
        const oldMessage = once(runtime, "message");
        first.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "old" } }));
        const oldWireId = JSON.parse(codec.unwrapDebugMessageData(proto.WARemoteDebug_DebugMessage.decode((await oldMessage)[0])).data.payload).id;
        first.close(); await once(first, "close");
        await new Promise(r => setTimeout(r, 10));
        second = new WebSocket(target.webSocketDebuggerUrl); await once(second, "open");
        const newMessage = once(runtime, "message");
        second.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "new" } }));
        const newWireId = JSON.parse(codec.unwrapDebugMessageData(proto.WARemoteDebug_DebugMessage.decode((await newMessage)[0])).data.payload).id;
        assert.notEqual(oldWireId, newWireId);
        const delivered: any[] = [];
        second.on("message", bytes => delivered.push(JSON.parse(bytes.toString())));
        const received = once(second, "message");
        reply(oldWireId, "stale");
        reply(newWireId, "current");
        await received;
        await new Promise(r => setTimeout(r, 10));
        assert.deepEqual(delivered, [{ id: 1, result: { marker: "current" } }]);
    } finally { first.terminate(); second?.terminate(); runtime.terminate(); await bridge.close(); }
});
