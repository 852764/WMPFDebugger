import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { profileSchema, parseMiniappLink, resolveProfile } from "../src/automation/profile";
import { Catalog, parsePage } from "../src/automation/catalog";
import { RunStorage } from "../src/automation/storage";
import { acquireLock, collect } from "../src/automation/engine";
import { runtimeRequest } from "../src/automation/runtime";
import { requestHook } from "../src/mcp/injected";
import { checkToolResult, locateText } from "../src/automation/windows";
const profile = () => profileSchema.parse({ version: 1, id: "test", name: "Test", shareNames: ["Test"], shareCodes: ["abcde"], appId: "wx0000000000000000", scope: "test", currency: "CNY", evidence: { identity: "test", productId: "id", price: "yuan", sales: "sales", pagination: "pages/count/more", unfilteredCatalog: "all" }, request: { url: "https://example.test/catalog", method: "GET" }, products: { itemsPath: "data", idPaths: ["id"], pricePath: "price", salesPath: "sales", titlePath: "title", priceUnit: "yuan" }, pagination: { kind: "page", requestPath: "page", start: 1, currentPagePath: "page", totalPagesPath: "pages", totalItemsPath: "count", hasMorePath: "more" }, limits: { intervalMs: 100, retries: 1 } });
const body = (page: number, data: any[], pages = 2, count = 3) => ({ page, data, pages, count, more: page < pages });
test("automation proves coverage, dedupes parent IDs and preserves exact money/zero sales", () => {
    const p = profile(), c = new Catalog(p);
    c.add(parsePage(p, body(1, [{ id: "a", price: "0.29", sales: 3 }, { id: "b", price: "99.00", sales: 0 }]), 1, 1));
    assert.equal(c.report().totalAmountYuan, null);
    c.add(parsePage(p, body(2, [{ id: "a", price: "0.29", sales: 3 }]), 2, 2));
    const r = c.report();
    assert.equal(r.uniqueProducts, 2);
    assert.equal(r.duplicateObservations, 1);
    assert.equal(r.totalAmountYuan, "0.87");
    assert.equal(r.amountComplete, true);
});
test("missing sales/conflicts/invalid prices never become a complete monetary total", () => {
    for (const last of [{ id: "b", price: "1", sales: null }, { id: "a", price: "1", sales: 2 }, { id: "b", price: "1-2", sales: 1 }]) {
        const p = profile(), c = new Catalog(p);
        c.add(parsePage(p, body(1, [{ id: "a", price: "1", sales: 1 }], 2, 2), 1, 1));
        const receipt = parsePage(p, body(2, [last], 2, 2), 2, 2);
        if (last.id === "a") {
            assert.throws(() => c.add(receipt), /repeated/);
            continue;
        }
        c.add(receipt);
        assert.equal(c.report().catalogComplete, true);
        assert.equal(c.report().amountComplete, false);
        assert.equal(c.report().totalAmountYuan, null);
    }
    const p = profile(), c = new Catalog(p);
    c.add(parsePage(p, body(1, [{ id: "a", price: 1, sales: 1 }, { id: "a", price: 2, sales: 1 }], 1, 2), 1, 1));
    assert.equal(c.report().conflicts, 1);
    assert.equal(c.report().totalAmountYuan, null);
});
test("pagination rejects drift, wrong pages, contradictory stops and repeated pages", () => {
    const p = profile();
    assert.throws(() => parsePage(p, body(2, []), 1, 1), /different page/);
    const c = new Catalog(p);
    c.add(parsePage(p, body(1, [{ id: "a", price: 1, sales: 1 }], 2, 2), 1, 1));
    assert.throws(() => c.add(parsePage(p, body(2, [{ id: "b", price: 1, sales: 1 }], 2, 3), 2, 2)), /Catalog changed/);
    assert.throws(() => c.add(parsePage(p, body(2, [{ id: "a", price: 1, sales: 1 }], 2, 2), 2, 2)), /repeated/);
    const d = new Catalog(p);
    d.add(parsePage(p, { ...body(1, [{ id: "a", price: 1, sales: 1 }], 2, 2), more: false }, 1, 1));
    assert.throws(() => d.exhausted(), /disagree/);
    assert.equal(d.report().totalAmountYuan, null);
});
test("cursor pagination ends only on the final cursor; repeated cursors fail", () => {
    const p = profile();
    p.pagination = { kind: "cursor", requestPath: "cursor", start: "first", nextCursorPath: "next", hasMorePath: "more", totalItemsMeaning: "rows" };
    const c = new Catalog(p);
    c.add(parsePage(p, { data: [{ id: "a", price: 1, sales: 1 }], next: "second", more: true }, 1, "first"));
    assert.equal(c.nextCursor(), "second");
    assert.throws(() => c.add(parsePage(p, { data: [{ id: "b", price: 1, sales: 1 }], next: "second", more: true }, 2, "second")), /advance/);
    c.add(parsePage(p, { data: [{ id: "b", price: 1, sales: 1 }], next: null, more: false }, 2, "second"));
    assert.equal(c.report().totalAmountYuan, "2.00");
});
test("checkpoints resume with authoritative receipts, reject profile changes, and export safe CSV", async () => {
    const p = profile(), link = parseMiniappLink("#小程序://Test/abcde"), s = await RunStorage.open(link, p);
    try {
        await s.page(parsePage(p, body(1, [{ id: "a", title: "=HYPERLINK()", price: "0.29", sales: 3 }], 2, 2), 1, 1));
        await s.update({ status: "cancelled", pages: 0 });
        const resumed = await RunStorage.open(link, p, s.state.id);
        assert.equal(resumed.state.pages, 1);
        assert.equal(resumed.catalog.nextCursor(), 2);
        assert.equal(resumed.catalog.report().capturedSubtotalYuan, "0.87");
        await assert.rejects(RunStorage.open(link, { ...p, scope: "changed" }, s.state.id), /does not match/);
        await resumed.page(parsePage(p, body(2, [{ id: "b", price: 0, sales: 0 }], 2, 2), 2, 2));
        await resumed.export();
        assert.match(await fs.readFile(resumed.state.csvFile!, "utf8"), /'=HYPERLINK/);
    }
    finally {
        await fs.rm(s.dir, { recursive: true, force: true });
    }
});
test("collection retries 429, stops on auth errors, and keeps cancellation checkpoint", async () => {
    const p = profile(), link = parseMiniappLink("#小程序://Test/abcde");
    const s = await RunStorage.open(link, p);
    let calls = 0;
    try {
        await collect(s, { bootstrap: async () => { }, request: async () => ++calls === 1 ? { status: 429, data: null, retryAfterMs: 1 } : { status: 200, data: body(1, [{ id: "a", price: "1", sales: 1 }], 1, 1) } });
        assert.equal(calls, 2);
        assert.equal(s.catalog.report().totalAmountYuan, "1.00");
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(collect(await RunStorage.open(link, p, s.state.id), { bootstrap: async () => { }, request: async () => { throw Error("should not reach"); } }, controller.signal));
    }
    finally {
        await fs.rm(s.dir, { recursive: true, force: true });
    }
    const t = await RunStorage.open(link, p);
    calls = 0;
    try {
        await assert.rejects(collect(t, { bootstrap: async () => { }, request: async () => { calls++; return { status: 401, data: null }; } }), /HTTP_401/);
        assert.equal(calls, 1);
    }
    finally {
        await fs.rm(t.dir, { recursive: true, force: true });
    }
});
test("runtime templates distinguish PHP actions and keep session credentials inside runtime", async () => {
    const calls: any[] = [];
    const context = createContext({ wx: { request: (o: any) => { calls.push(o); o.success?.({ statusCode: 200, data: { ok: true } }); return { abort() { } }; } }, __wxConfig: { appId: "wx0000000000000000" } });
    runInContext("(" + requestHook.toString() + ")('install')", context);
    runInContext("wx.request({url:'https://example.test/index.php?r=list',method:'POST',data:'page=1&session_key=private',header:{token:'private'}});wx.request({url:'https://example.test/index.php?r=other',method:'POST',data:'page=99'})", context);
    const result = await runInContext("(" + runtimeRequest.toString() + ")(" + JSON.stringify({ url: "https://example.test/index.php?r=list", method: "POST", data: { page: 2 }, headers: {}, useObservedTemplate: true }) + ")", context);
    assert.equal(result.status, 200);
    assert.equal(calls[calls.length - 1].data, "page=2&session_key=private");
    assert.equal(calls[calls.length - 1].header.token, "private");
    const drain = runInContext("(" + requestHook.toString() + ")('drain')", context);
    assert.ok(!JSON.stringify(drain).includes("private"));
    assert.ok(!JSON.stringify(result).includes("private"));
});
test("unknown share codes do not silently resolve by app name; desktop errors stop input", async () => {
    await assert.rejects(resolveProfile(parseMiniappLink("#小程序://川黔纯粮酒-龙氏酒业/xxxxx")), /PROFILE_REQUIRED/);
    assert.throws(() => checkToolResult({ content: [{ type: "text", text: '{"code":"CONTROL_PREEMPTED"}' }] }), /DESKTOP_BUSY/);
    assert.throws(() => checkToolResult({ isError: true, content: [{ type: "text", text: "failed" }] }), /DESKTOP_TOOL_FAILED/);
    const line = { text: "搜 索 小 程 序", words: [{ text: "搜索小程序", x: 10, y: 20, width: 100, height: 20 }] };
    assert.deepEqual(locateText([line], "搜索小程序"), { x: 60, y: 30 });
    assert.equal(locateText([line, line], "搜索小程序"), undefined);
});
test("only one automation collector can own the checkout", async () => {
    const release = await acquireLock();
    try {
        await assert.rejects(acquireLock(), /AUTOMATION_LOCKED/);
    }
    finally {
        await release();
    }
});
