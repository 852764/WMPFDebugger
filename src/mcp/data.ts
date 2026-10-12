const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|token|session[_-]?(id|key)|password|secret|openid|unionid)$/i;
export function redact(value: any, depth = 0): any {
    if (depth > 30) return "[depth limit]";
    if (Array.isArray(value)) return value.map(v => redact(v, depth + 1));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitive.test(k) ? "[REDACTED]" : redact(v, depth + 1)]));
    return value;
}
export function safeUrl(raw: string): string {
    try {
        const url = new URL(raw);
        url.username = ""; url.password = "";
        for (const key of [...url.searchParams.keys()]) if (sensitive.test(key)) url.searchParams.set(key, "[REDACTED]");
        return url.toString();
    } catch { return raw.slice(0, 2000); }
}
/** Dot paths plus array indices/wildcards; no eval or arbitrary JSONPath expressions. */
export function selectPath(root: any, path: string): any[] {
    if (!path || path === "$") return [root];
    const parts = path.replace(/^\$\.?/, "").replace(/\[(\d+|\*)\]/g, ".$1").split(".").filter(Boolean);
    let values = [root];
    for (const part of parts) {
        if (["__proto__", "prototype", "constructor"].includes(part)) throw new Error("Unsafe path component");
        values = values.flatMap(v => {
            if (part === "*") return Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v) : [];
            return v != null && typeof v === "object" && Object.prototype.hasOwnProperty.call(v, part) ? [v[part]] : [];
        });
    }
    return values;
}
export function firstAt(root: any, path: string): any { return selectPath(root, path)[0]; }
export function boundedJson(value: any, maxChars = 24000) {
    const text = JSON.stringify(redact(value));
    if (text.length <= maxChars) return { content: [{ type: "text" as const, text }] };
    return { content: [{ type: "text" as const, text: JSON.stringify({ truncated: true, totalChars: text.length, preview: text.slice(0, maxChars), hint: "Use a narrower path, smaller limit, or the next cursor." }) }] };
}
