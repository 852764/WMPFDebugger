import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MiniappSession } from "./session";
import { exportProducts } from "./export";
import { boundedJson, selectPath } from "./data";
import { findElement, pageData, pageSnapshot } from "./injected";

const portSchema = z.number().int().min(1).max(65535).default(62000);
const contextId = z.number().int().optional();
const limit = z.number().int().min(1).max(100).default(30);
const dataset = z.string().min(1).max(100).describe("Name scoped to one mini-program/store, e.g. xinfatongxun");
const mappingSchema = z.object({
    itemsPath: z.string().describe("Path to product array, e.g. data.list or data.list[*]"),
    idPaths: z.array(z.string().min(1)).min(1).max(5).describe("Stable product-level ID paths, e.g. [goods_id]. Do not use title or SKU for product-level totals."),
    titlePath: z.string().optional(), pricePath: z.string(), salesPath: z.string(),
    priceUnit: z.enum(["yuan", "fen"]).describe("Explicit unit from the API; never guess"),
    onConflict: z.enum(["exclude", "first", "latest"]).default("exclude"),
});

export function createMcpServer(session = new MiniappSession()) {
    const server = new McpServer({ name: "wmpf-miniapp", version: "0.1.0" });
    // Serialize calls so target changes cannot race an action or mix capture datasets.
    let queue: Promise<unknown> = Promise.resolve();
    function tool(name: string, description: string, schema: z.ZodRawShape, handler: (args: any) => Promise<any> | any, readOnly = false) {
        server.registerTool(name, { description, inputSchema: schema,
            annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: !readOnly } }, (args: any) => {
            const run = queue.then(async () => {
                try { return boundedJson(await handler(args)); }
                catch (error) { return { content: [{ type: "text" as const, text: JSON.stringify({ error: String(error) }) }], isError: true }; }
            });
            queue = run.then(() => undefined, () => undefined);
            return run;
        });
    }
    tool("miniapp_targets", "List local WMPF runtime targets. Start WMPFDebugger, then reopen the mini-program using Windows-MCP.", { port: portSchema }, async ({ port }) => {
        const response = await fetch("http://127.0.0.1:" + port + "/json/list", { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw new Error("Target discovery failed: HTTP " + response.status);
        return await response.json();
    }, true);
    tool("miniapp_connect", "Attach to exactly one target. Probe contexts to verify app identity. Close other DevTools clients first.", {
        port: portSchema, targetId: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
    }, ({ port, targetId }) => session.connect("ws://127.0.0.1:" + port + "/devtools/page/" + targetId));
    tool("miniapp_disconnect", "Stop capture, restore wx.request, disconnect CDP. Aggregated datasets remain until reset.", {}, async () => { await session.close(); return { connected: false }; });
    tool("miniapp_contexts", "Inspect execution contexts, appId, routes, DOM and wx.request capabilities. Service and renderer contexts differ.", {}, () => session.describeContexts(), true);
    tool("miniapp_select_context", "Select a context ID returned by miniapp_contexts for subsequent tools.", { contextId: z.number().int() }, ({ contextId }) => {
        if (!session.contexts.has(contextId)) throw new Error("Unknown or stale execution context");
        session.selectedContext = contextId;
        return { selectedContext: contextId };
    });
    tool("miniapp_snapshot", "Read a compact text/element snapshot without a screenshot. Requires DOM; refs expire on next snapshot or navigation.", {
        contextId, selector: z.string().default("button,input,textarea,a,[role=button],wx-button,wx-input,wx-text,wx-view"),
        limit: z.number().int().min(1).max(100).default(50), offset: z.number().int().min(0).default(0),
    }, args => session.run(pageSnapshot, [args], args.contextId), true);
    const element = { contextId, ref: z.string().optional(), selector: z.string().optional() };
    async function locate(args: any) {
        if (!!args.ref === !!args.selector) throw new Error("Provide exactly one of ref or selector");
        return session.run(findElement, [args], args.contextId);
    }
    tool("miniapp_click", "Click an element via CDP input; requires a renderer DOM context. The click may trigger application actions.", element, async args => {
        const { x, y } = await locate(args);
        await session.cdp.request("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await session.cdp.request("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        return { dispatched: true, x, y, hint: "Verify resulting page state." };
    });
    tool("miniapp_type", "Focus an input and insert text through CDP. Optionally replace its current value.", {
        ...element, text: z.string().max(10000), replace: z.boolean().default(true),
    }, async args => {
        await locate(args);
        if (args.replace) {
            await session.cdp.request("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
            await session.cdp.request("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, modifiers: 2 });
        }
        await session.cdp.request("Input.insertText", { text: args.text });
        return { dispatched: true };
    });
    tool("miniapp_scroll", "Scroll a DOM container or the current mini-program page to load further products.", {
        contextId, selector: z.string().optional(), y: z.number().int().min(-100000).max(100000).default(600),
    }, args => session.evaluate(`(() => {
        const selector = ${JSON.stringify(args.selector || "")}, y = ${args.y};
        if (typeof document !== "undefined") {
            const el = selector ? document.querySelector(selector) : document.scrollingElement;
            if (!el) throw new Error("Scroll container not found");
            const before = el.scrollTop; el.scrollBy(0, y); return { before, after: el.scrollTop };
        }
        if (typeof wx !== "undefined" && wx.pageScrollTo) return new Promise((resolve, reject) => wx.pageScrollTo({ scrollTop: Math.max(0, y), duration: 0, success: () => resolve({ dispatched: true }), fail: reject }));
        throw new Error("Scrolling unsupported in this context");
    })()`, args.contextId));
    tool("miniapp_page_data", "Read page-stack data from the service context. Prefer a narrow path to reduce output.", {
        contextId, path: z.string().default("$"),
    }, async args => selectPath(await session.run(pageData, [], args.contextId), args.path), true);
    tool("miniapp_navigate", "Navigate through wx APIs in the service context. Use routes observed in the app.", {
        contextId, action: z.enum(["navigateTo", "redirectTo", "switchTab", "navigateBack"]), url: z.string().optional(),
    }, args => {
        if (args.action !== "navigateBack" && !args.url) throw new Error("url required");
        return session.evaluate(`new Promise((resolve,reject) => wx[${JSON.stringify(args.action)}]({url:${JSON.stringify(args.url || "")},delta:1,success:()=>resolve({navigated:true}),fail:reject}))`, args.contextId);
    });
    tool("miniapp_evaluate", "Evaluate JavaScript for debugging in the selected context. May have side effects. Return only needed fields.", {
        contextId, expression: z.string().max(100000),
    }, args => session.evaluate(args.expression, args.contextId));
    tool("miniapp_cdp", "Advanced CDP command for debugging (Debugger, DOM, etc.). Support depends on runtime; commands may change application state.", {
        method: z.string().regex(/^[A-Za-z]+\.[A-Za-z]+$/), params: z.record(z.string(), z.unknown()).default({}),
    }, args => session.cdp.request(args.method, args.params));
    tool("miniapp_logs", "Read buffered runtime console messages and exceptions, with bounded output.", { limit }, ({ limit }) => session.logs.slice(-limit), true);
    tool("miniapp_network_start", "Capture future network requests via CDP and/or wx.request. Start before navigating; auto tries both. Bodies stay in bounded local memory.", {
        mode: z.enum(["auto", "cdp", "wx"]).default("auto"),
    }, ({ mode }) => session.startCapture(mode));
    tool("miniapp_network_list", "Drain wx.request events and list request metadata without response bodies. Poll between pagination actions.", {
        after: z.number().int().min(0).default(0), limit, urlIncludes: z.string().optional(),
    }, async args => { await session.drain(); return { ...session.capture.list(args), diagnostics: session.captureDiagnostics.slice(-5) }; }, true);
    tool("miniapp_network_response", "Read one captured response with optional JSON field projection. Sensitive keyed fields are redacted.", {
        requestId: z.string(), path: z.string().optional(), offset: z.number().int().min(0).default(0), limit,
    }, ({ requestId, path, offset, limit }) => {
        const record = session.capture.get(requestId);
        if (path) {
            const values = selectPath(session.capture.json(requestId), path).flatMap(v => Array.isArray(v) ? v : [v]);
            return { requestId, total: values.length, nextOffset: offset + limit < values.length ? offset + limit : null, values: values.slice(offset, offset + limit) };
        }
        if (record.body === undefined) return { requestId, bodyState: record.bodyState, error: record.error };
        try { return { requestId, json: JSON.parse(record.body) }; }
        catch { return { requestId, text: record.body.slice(0, 12000), truncated: record.body.length > 12000 }; }
    }, true);
    tool("miniapp_network_stop", "Drain remaining events and restore the original wx.request implementation.", {}, () => session.stopCapture());
    tool("miniapp_products_ingest", "Accumulate products from captured JSON responses into a deduplicated dataset. Inspect field meanings first; provide explicit units and stable product IDs. Repeat across pages.", {
        dataset, requestIds: z.array(z.string()).min(1).max(100), mapping: mappingSchema,
    }, async ({ dataset, requestIds, mapping }) => {
        await session.drain();
        const ledger = session.ledger(dataset);
        const results = requestIds.map((id: string) => {
            try {
                const record = session.capture.get(id);
                return { requestId: id, ...ledger.ingest(session.capture.json(id), mapping, { requestId: id, url: record.url }) };
            } catch (error) { return { requestId: id, error: String(error) }; }
        });
        return { results, report: ledger.report(0, 10) };
    });
    tool("miniapp_products_report", "Report sum(price × displayed sales) after product deduplication, with sources, conflicts and exclusions. Covers captured products, not verified historical revenue.", {
        dataset, offset: z.number().int().min(0).default(0), limit,
    }, ({ dataset, offset, limit }) => session.ledger(dataset).report(offset, limit), true);
    tool("miniapp_products_export", "Export all captured, deduplicated products and source references to a local JSON or CSV file in artifacts/.", { dataset, format: z.enum(["json", "csv"]).default("json") }, ({ dataset, format }) => exportProducts(session.ledger(dataset), dataset, format));
    tool("miniapp_products_reset", "Delete the selected in-memory product dataset to change its mapping or begin a fresh run.", { dataset }, ({ dataset }) => {
        session.datasets.delete(dataset); return { reset: dataset };
    });
    return { server, session };
}
