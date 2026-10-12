/** These functions are serialized and evaluated inside the selected mini-program context. */
export function requestHook(action: "install" | "drain" | "remove") {
    const g = globalThis as any;
    const key = "__wmpfMcpCapture_v1";
    const state = g[key];
    if (action === "drain") {
        if (!state) return { records: [], missing: true };
        const records = state.queue.splice(0);
        const dropped = state.dropped; state.dropped = 0;
        return { records, dropped, active: g.wx?.request === state.wrapper };
    }
    if (action === "remove") {
        if (!state) return { removed: false };
        state.active = false;
        if (g.wx?.request === state.wrapper) {
            try { if (state.descriptor) Object.defineProperty(g.wx, "request", state.descriptor); else delete g.wx.request; }
            catch { g.wx.request = state.original; }
        }
        delete g[key];
        return { removed: true };
    }
    if (state && g.wx?.request === state.wrapper) return { installed: true, appId: g.__wxConfig?.accountInfo?.appId || g.__wxConfig?.appId };
    if (!g.wx || typeof g.wx.request !== "function") return { installed: false, reason: "wx.request unavailable in this context" };
    if (state) state.active = false;
    const original = g.wx.request;
    const descriptor = Object.getOwnPropertyDescriptor(g.wx, "request");
    const s: any = { original, descriptor, queue: [], dropped: 0, counter: 0, active: true, templates: new Map() };
    function copy(value: any) {
        try {
            if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return undefined;
            const text = typeof value === "string" ? value : JSON.stringify(value);
            return typeof text === "string" && text.length <= 262144 ? text : undefined;
        } catch { return undefined; }
    }
    function push(record: any) {
        if (!s.active) return;
        if (s.queue.length >= 100) { s.queue.shift(); s.dropped++; }
        s.queue.push(record);
    }
    s.wrapper = function(this: any, options: any, ...rest: any[]) {
        if (!options || typeof options !== "object") return original.call(this, options, ...rest);
        const signature = String(options.method || "GET").toUpperCase() + " " + String(options.url || "");
        if (!s.templates.has(signature) && s.templates.size >= 40) s.templates.delete(s.templates.keys().next().value);
        const { success, fail, complete, ...template } = options;
        try { if (JSON.stringify(template).length <= 65536) s.templates.set(signature, template); } catch {}
        const id = ++s.counter;
        const started = Date.now();
        const base = { id, url: String(options.url || ""), method: options.method || "GET", started };
        const wrapped = { ...options,
            success: function(this: any, response: any) {
                try { push({ ...base, status: response.statusCode, body: copy(response.data), ended: Date.now() }); } catch {}
                return options.success?.apply(this, arguments);
            },
            fail: function(this: any, error: any) {
                try { push({ ...base, error: String(error?.errMsg || error), ended: Date.now() }); } catch {}
                return options.fail?.apply(this, arguments);
            },
        };
        return original.call(this, wrapped, ...rest);
    };
    try {
        Object.defineProperty(g.wx, "request", {
            configurable: descriptor?.configurable ?? true,
            enumerable: descriptor?.enumerable ?? true,
            writable: descriptor && "writable" in descriptor ? descriptor.writable : true,
            value: s.wrapper,
        });
        g[key] = s;
        return { installed: true, appId: g.__wxConfig?.accountInfo?.appId || g.__wxConfig?.appId };
    } catch (error) { return { installed: false, reason: String(error) }; }
}

export function inspectContext() {
    const g = globalThis as any;
    let pages: any[] = [];
    try { pages = typeof g.getCurrentPages === "function" ? g.getCurrentPages() : []; } catch {}
    return {
        hasDocument: !!g.document?.querySelectorAll, hasWxRequest: typeof g.wx?.request === "function",
        hasPageStack: typeof g.getCurrentPages === "function",
        title: g.document?.title, url: g.location?.href,
        appId: g.__wxConfig?.accountInfo?.appId || g.__wxConfig?.appId,
        pages: pages.map(p => ({ route: p.route || p.__route__, dataKeys: Object.keys(p.data || {}).slice(0, 80) })),
    };
}

export function pageSnapshot(args: { selector: string; limit: number; offset: number }) {
    const g = globalThis as any;
    if (!g.document?.querySelectorAll) throw new Error("No DOM in this context; select a renderer context or use page_data.");
    const nodes: any[] = [];
    function walk(root: any) {
        for (const element of root.querySelectorAll("*")) {
            if (element.matches(args.selector)) nodes.push(element);
            if (element.shadowRoot) walk(element.shadowRoot);
        }
    }
    walk(g.document);
    const visible = nodes.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
    g.__wmpfMcpNodes = new Map();
    const generation = (g.__wmpfMcpGeneration || 0) + 1;
    g.__wmpfMcpGeneration = generation;
    const selected = visible.slice(args.offset, args.offset + args.limit);
    return { generation, total: visible.length, nextOffset: args.offset + selected.length < visible.length ? args.offset + selected.length : null,
        nodes: selected.map((el, i) => {
            const ref = generation + ":" + i;
            g.__wmpfMcpNodes.set(ref, el);
            const r = el.getBoundingClientRect();
            return { ref, tag: el.tagName.toLowerCase(), id: el.id || undefined, role: el.getAttribute("role") || undefined,
                text: String(el.innerText || el.textContent || "").trim().slice(0, 180),
                placeholder: el.getAttribute("placeholder") || undefined,
                value: /input|textarea/i.test(el.tagName) ? el.value : undefined,
                rect: { x: r.x, y: r.y, width: r.width, height: r.height } };
        }) };
}

export function findElement(args: { ref?: string; selector?: string }) {
    const g = globalThis as any;
    const el = args.ref ? g.__wmpfMcpNodes?.get(args.ref) : g.document?.querySelector(args.selector);
    if (!el?.isConnected) throw new Error("Element missing or stale. Take a new snapshot.");
    el.scrollIntoView({ block: "center", inline: "center" });
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) throw new Error("Element is hidden");
    el.focus?.();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
}

export function pageData() {
    const g = globalThis as any;
    if (typeof g.getCurrentPages !== "function") throw new Error("getCurrentPages unavailable; select an app-service context");
    return g.getCurrentPages().map((p: any) => ({ route: p.route || p.__route__, data: p.data }));
}
