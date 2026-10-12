import { test } from "node:test";
import assert from "node:assert/strict";
import { CdpClient } from "../src/mcp/cdp";
import { NetworkCapture } from "../src/mcp/network";

test("capture fetches response bodies, tracks redirects and failures, bounds memory", async () => {
    const cdp = new CdpClient();
    cdp.request = async () => ({ body: '{"price":19.99}', base64Encoded: false });
    const capture = new NetworkCapture(cdp, 2, 50, 50);
    capture.start();
    const event = (method: string, params: any) => capture.onEvent({ method: "Network." + method, params });
    event("requestWillBeSent", { requestId: "r1", request: { url: "https://example.test/?token=secret", method: "GET" } });
    event("requestWillBeSent", { requestId: "r1", request: { url: "https://example.test/products", method: "GET" }, redirectResponse: { status: 302 } });
    assert.equal(capture.get("1").bodyState, "redirect");
    assert.ok(!capture.get("1").url.includes("secret"));
    event("responseReceived", { requestId: "r1", response: { status: 200, mimeType: "application/json" } });
    event("loadingFinished", { requestId: "r1", encodedDataLength: 14 });
    await capture.settled();
    assert.deepEqual(capture.json("2"), { price: 19.99 });
    event("requestWillBeSent", { requestId: "r2", request: { url: "https://example.test/fail", method: "GET" } });
    event("loadingFailed", { requestId: "r2", errorText: "aborted" });
    assert.equal(capture.get("3").bodyState, "failed");
    assert.equal(capture.dropped, 1);
    capture.addWx({ url: "/", method: "GET", started: 0, body: "x".repeat(100) }, 1);
    assert.equal(capture.get("4").bodyState, "too_large");
});
test("late response cannot repopulate cleared capture", async () => {
    let resolve!: (value: any) => void;
    const cdp = new CdpClient();
    cdp.request = () => new Promise(r => { resolve = r; });
    const capture = new NetworkCapture(cdp);
    capture.start();
    capture.onEvent({ method: "Network.requestWillBeSent", params: { requestId: "a", request: { url: "/", method: "GET" } } });
    capture.onEvent({ method: "Network.loadingFinished", params: { requestId: "a" } });
    capture.clear();
    resolve({ body: "{}", base64Encoded: false });
    await capture.settled();
    assert.equal(capture.records.size, 0);
});
