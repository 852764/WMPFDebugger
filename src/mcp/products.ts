import { firstAt, selectPath } from "./data";

export type ProductMapping = {
    itemsPath: string; idPaths: string[]; pricePath: string; salesPath: string; titlePath?: string;
    priceUnit: "yuan" | "fen"; onConflict: "exclude" | "first" | "latest";
};
type Source = { requestId: string; url: string };
type Product = {
    key: string; title?: string; priceFen: bigint; sales: bigint; salesKind: "exact" | "estimated" | "lower_bound";
    source: Source; occurrences: number; conflict: boolean;
};
export function moneyFen(value: unknown, unit: "yuan" | "fen"): bigint {
    if (typeof value === "number" && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) throw new Error("Unsafe numeric price");
    if (typeof value !== "string" && typeof value !== "number") throw new Error("Price is missing or not numeric");
    if (String(value).length > 80) throw new Error("Price is too long");
    if (typeof value === "number" && unit === "yuan" && value > Number.MAX_SAFE_INTEGER / 100) throw new Error("Large prices must be decimal strings");
    const text = String(value).trim().replace(/^[¥￥]\s*/, "").replace(/\s*元$/, "");
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) throw new Error("Price is a range or non-numeric");
    const [whole, fraction = ""] = text.replace(/,/g, "").split(".");
    if (unit === "fen") {
        if (fraction && !/^0+$/.test(fraction)) throw new Error("Fractional fen is not supported");
        return BigInt(whole);
    }
    if (fraction.length > 2 && !/^0*$/.test(fraction.slice(2))) throw new Error("Price has sub-fen precision");
    return BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
}
export function salesCount(value: unknown): { count: bigint; kind: Product["salesKind"] } {
    if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("Sales must be a safe integer");
    if (typeof value !== "string" && typeof value !== "number") throw new Error("Sales missing");
    if (String(value).length > 80) throw new Error("Sales display is too long");
    const text = String(value).trim().replace(/^(已售|销量|月售)\s*/, "").replace(/\s*(件|笔)$/, "");
    const m = text.match(/^(\d+|\d{1,3}(?:,\d{3})+)(?:\.(\d+))?\s*(万|千|[wWkK])?(\+)?$/);
    if (!m) throw new Error("Unsupported sales display");
    const scale = /万|w/i.test(m[3] || "") ? 10000n : /千|k/i.test(m[3] || "") ? 1000n : 1n;
    const fraction = m[2] || "";
    const denominator = 10n ** BigInt(fraction.length);
    const numerator = BigInt(m[1].replace(/,/g, "") + fraction) * scale;
    if (numerator % denominator !== 0n) throw new Error("Sales is not a whole count");
    return { count: numerator / denominator, kind: m[4] ? "lower_bound" : m[3] ? "estimated" : "exact" };
}
export function formatFen(value: bigint): string { return (value / 100n).toString() + "." + (value % 100n).toString().padStart(2, "0"); }

export class ProductLedger {
    private rows = new Map<string, Product>();
    private seenSources = new Set<string>();
    private mapping?: ProductMapping;
    private rejected: { requestId: string; row: number; reason: string }[] = [];
    private rejectedCount = 0;
    private duplicateCount = 0;
    clear() { this.rows.clear(); this.seenSources.clear(); this.mapping = undefined; this.rejected = []; this.rejectedCount = 0; this.duplicateCount = 0; }
    ingest(body: any, mapping: ProductMapping, source: Source) {
        if (this.mapping && JSON.stringify(this.mapping) !== JSON.stringify(mapping)) throw new Error("Mapping changed. Reset this dataset or use a new dataset name.");
        if (!mapping.idPaths.length) throw new Error("At least one stable product ID field is required");
        this.mapping = { ...mapping };
        if (this.seenSources.has(source.requestId)) return { alreadyIngested: true, added: 0 };
        const selected = selectPath(body, mapping.itemsPath).flatMap(v => Array.isArray(v) ? v : [v]);
        if (!selected.length) throw new Error("itemsPath matched no products; inspect the JSON response first");
        if (selected.length > 10000) throw new Error("Too many products in one response");
        let added = 0;
        selected.forEach((item, row) => {
            try {
                const ids = mapping.idPaths.map(path => {
                    const id = firstAt(item, path);
                    if ((typeof id !== "string" && typeof id !== "number") || String(id).trim() === "" || (typeof id === "number" && !Number.isSafeInteger(id))) throw new Error("Missing or unsafe stable product ID: " + path);
                    return String(id);
                });
                const key = JSON.stringify(ids);
                const priceFen = moneyFen(firstAt(item, mapping.pricePath), mapping.priceUnit);
                const sales = salesCount(firstAt(item, mapping.salesPath));
                const product: Product = { key, title: mapping.titlePath ? String(firstAt(item, mapping.titlePath) ?? "").slice(0, 300) : undefined,
                    priceFen, sales: sales.count, salesKind: sales.kind, source, occurrences: 1, conflict: false };
                const previous = this.rows.get(key);
                if (previous) {
                    this.duplicateCount++;
                    product.occurrences = previous.occurrences + 1;
                    product.conflict = previous.conflict || previous.priceFen !== priceFen || previous.sales !== sales.count || previous.salesKind !== sales.kind;
                    if (mapping.onConflict === "latest") this.rows.set(key, product);
                    else { previous.occurrences++; previous.conflict = product.conflict; }
                } else {
                    if (this.rows.size >= 100000) throw new Error("Dataset capacity exceeded");
                    this.rows.set(key, product); added++;
                }
            } catch (error) {
                this.rejectedCount++;
                if (this.rejected.length < 50) this.rejected.push({ requestId: source.requestId, row, reason: String(error) });
            }
        });
        this.seenSources.add(source.requestId);
        return { added, matched: selected.length };
    }
    report(offset = 0, limit = 30) {
        let total = 0n, exact = 0n, estimated = 0n, lowerBound = 0n, included = 0, conflicts = 0;
        const rows = [...this.rows.values()];
        for (const row of rows) {
            if (row.conflict) conflicts++;
            if (row.conflict && this.mapping?.onConflict === "exclude") continue;
            const amount = row.priceFen * row.sales;
            total += amount; included++;
            if (row.salesKind === "exact") exact += amount;
            if (row.salesKind === "estimated") estimated += amount;
            if (row.salesKind === "lower_bound") lowerBound += amount;
        }
        return {
            metric: "observed_product_price_times_displayed_sales", currency: "CNY",
            scope: "Captured products only; current prices and displayed sales do not establish historical revenue or complete catalog coverage.",
            totalEstimateYuan: formatFen(total), exactInputSubtotalYuan: formatFen(exact),
            estimatedSalesSubtotalYuan: formatFen(estimated), lowerBoundSalesSubtotalYuan: formatFen(lowerBound),
            uniqueProducts: rows.length, includedProducts: included, duplicates: this.duplicateCount, conflicts,
            excludedConflicts: this.mapping?.onConflict === "exclude" ? conflicts : 0,
            rejected: this.rejectedCount, rejectionExamples: this.rejected,
            ingestedResponses: this.seenSources.size,
            nextOffset: offset + limit < rows.length ? offset + limit : null,
            products: rows.slice(offset, offset + limit).map(row => ({
                key: row.key, title: row.title, priceYuan: formatFen(row.priceFen), sales: row.sales.toString(),
                salesKind: row.salesKind, estimateYuan: formatFen(row.priceFen * row.sales),
                included: !(row.conflict && this.mapping?.onConflict === "exclude"), conflict: row.conflict,
                occurrences: row.occurrences, source: row.source,
            })),
        };
    }
}
