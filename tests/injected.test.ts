import { test } from "node:test";
import assert from "node:assert/strict";
import { createContext, runInContext } from "node:vm";
import { requestHook } from "../src/mcp/injected";
function run(context: any, action: string) { return runInContext("(" + requestHook.toString() + ")(" + JSON.stringify(action) + ")", context); }
test("request hook preserves failures/complete and restores inherited methods", () => {
    let failures = 0, completes = 0;
    const original = (options: any) => { options.fail({ errMsg: "offline" }); options.complete(); return 42; };
    const wx = Object.create({ request: original });
    const context = createContext({ wx });
    assert.equal(run(context, "install").installed, true);
    assert.equal(wx.request({ url: "/fail", fail() { failures++; }, complete() { completes++; } }), 42);
    const result = run(context, "drain");
    assert.equal(result.records[0].error, "offline");
    assert.equal(failures, 1); assert.equal(completes, 1);
    run(context, "remove");
    assert.equal(wx.request, original);
    assert.equal(Object.prototype.hasOwnProperty.call(wx, "request"), false);
});
test("non-writable request is diagnosed and unrelated replacements are left intact", () => {
    const wx = {};
    Object.defineProperty(wx, "request", { value() {}, writable: false, configurable: false });
    const context = createContext({ wx });
    assert.equal(run(context, "install").installed, false);
    const mutable = createContext({ wx: { request() {} } });
    run(mutable, "install");
    const replacement = () => "replacement";
    (mutable as any).wx.request = replacement;
    run(mutable, "remove");
    assert.equal((mutable as any).wx.request, replacement);
});
test("hook queue is bounded and reports dropped responses", () => {
    const context = createContext({ wx: { request(options: any) { options.success({ statusCode: 200, data: { price: 1 } }); } } });
    run(context, "install");
    for (let i = 0; i < 105; i++) (context as any).wx.request({ url: "/products" });
    const result = run(context, "drain");
    assert.equal(result.records.length, 100);
    assert.equal(result.dropped, 5);
    assert.equal(run(context, "drain").records.length, 0);
    run(context, "remove");
});

test("configurable accessor APIs used by real WeChat are captured and restored", () => {
    const wx = {};
    const original = (options: any) => options.success({ statusCode: 200, data: { goods: [1] } });
    const descriptor = { configurable: true, enumerable: true, get: () => original, set: (_value: any) => {} };
    Object.defineProperty(wx, "request", descriptor);
    const context = createContext({ wx });
    assert.equal(run(context, "install").installed, true);
    (wx as any).request({ url: "/products" });
    assert.equal(run(context, "drain").records.length, 1);
    run(context, "remove");
    assert.deepEqual(Object.getOwnPropertyDescriptor(wx, "request"), descriptor);
    assert.equal((wx as any).request, original);
});
