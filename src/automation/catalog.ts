import { createHash } from "node:crypto";
import { firstAt, selectPath } from "../mcp/data";
import { formatFen, moneyFen, salesCount } from "../mcp/products";
import { AutomationProfile, setDataPath } from "./profile";
export type Observation = {
    ids: string[];
    title?: string;
    price: unknown;
    sales: unknown;
};
export type PageReceipt = {
    index: number;
    cursor: number | string;
    nextCursor?: number | string;
    at: string;
    sourceUrl: string;
    totalPages?: number;
    totalItems?: number;
    hasMore?: boolean;
    fingerprint: string;
    items: Observation[];
};
const count = (value: unknown, name: string): number => {
    const n = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)
        throw new Error(name + " is not a nonnegative integer");
    return n;
};
export function parsePage(profile: AutomationProfile, body: any, index: number, cursor: number | string): PageReceipt {
    if (profile.request.successPath && firstAt(body, profile.request.successPath) !== profile.request.successValue)
        throw new Error("API response reports failure");
    const selected = selectPath(body, profile.products.itemsPath);
    if (!selected.length || selected.some(x => !Array.isArray(x)))
        throw new Error("Product array missing; the endpoint or profile changed");
    const raw = selected.flat();
    if (raw.length > 10000)
        throw new Error("Too many products in one page");
    const items = raw.map(item => {
        const ids = profile.products.idPaths.map(p => {
            const id = firstAt(item, p);
            if ((typeof id !== "string" && typeof id !== "number") || !String(id).trim() || (typeof id === "number" && !Number.isSafeInteger(id)))
                throw new Error("Missing or unsafe product ID: " + p);
            return String(id);
        });
        const title = profile.products.titlePath ? String(firstAt(item, profile.products.titlePath) ?? "").slice(0, 300) : undefined;
        return { ids, title, price: firstAt(item, profile.products.pricePath) ?? null, sales: firstAt(item, profile.products.salesPath) ?? null };
    });
    const p = profile.pagination;
    if (p.currentPagePath && count(firstAt(body, p.currentPagePath), "Current page") !== Number(cursor))
        throw new Error("Server returned a different page");
    const totalPages = p.totalPagesPath ? count(firstAt(body, p.totalPagesPath), "Total pages") : undefined;
    const totalItems = p.totalItemsPath ? count(firstAt(body, p.totalItemsPath), "Total items") : undefined;
    const rawMore = p.hasMorePath ? firstAt(body, p.hasMorePath) : undefined;
    if (p.hasMorePath && typeof rawMore !== "boolean" && rawMore !== 0 && rawMore !== 1)
        throw new Error("hasMore must be boolean or 0/1");
    const hasMore = p.hasMorePath ? !!rawMore : undefined;
    const next = p.nextCursorPath ? firstAt(body, p.nextCursorPath) : undefined;
    if (next !== undefined && next !== null && (typeof next !== "string" && typeof next !== "number" || typeof next === "number" && !Number.isSafeInteger(next) || typeof next === "string" && next.length > 1000))
        throw new Error("Invalid next cursor");
    const nextCursor = next === "" || next === null ? undefined : next;
    const fingerprint = createHash("sha256").update(JSON.stringify(items.map(v => v.ids))).digest("hex");
    return { index, cursor, at: new Date().toISOString(), sourceUrl: profile.request.url, totalPages, totalItems, hasMore, nextCursor, fingerprint, items };
}
type Product = {
    key: string;
    ids: string[];
    title?: string;
    priceFen?: bigint;
    sales?: bigint;
    salesKind?: string;
    priceError?: string;
    salesError?: string;
    conflict: boolean;
    occurrences: number;
    pages: number[];
};
export class Catalog {
    readonly receipts: PageReceipt[] = [];
    private products = new Map<string, Product>();
    private observations = 0;
    private fingerprints = new Set<string>();
    constructor(readonly profile: AutomationProfile) { }
    nextCursor(): number | string {
        const last = this.receipts[this.receipts.length - 1];
        return !last ? this.profile.pagination.start : this.profile.pagination.kind === "page" ? Number(last.cursor) + 1 : last.nextCursor!;
    }
    requestData() { const data = structuredClone(this.profile.request.data); setDataPath(data, this.profile.pagination.requestPath, this.nextCursor()); return data; }
    add(receipt: PageReceipt) {
        if (receipt.index !== this.receipts.length + 1 || receipt.cursor !== this.nextCursor())
            throw new Error("Non-contiguous page checkpoint");
        const first = this.receipts[0];
        if (first && (first.totalItems !== receipt.totalItems || first.totalPages !== receipt.totalPages))
            throw new Error("Catalog changed while collecting; restart for a consistent catalog");
        if (receipt.items.length && this.fingerprints.has(receipt.fingerprint))
            throw new Error("Server repeated a page; pagination stopped to prevent a false complete result");
        if (!receipt.items.length && !(receipt.totalItems === 0 || receipt.hasMore === false || (this.profile.pagination.kind === "cursor" && receipt.nextCursor === undefined)))
            throw new Error("Unexpected empty page");
        if (receipt.hasMore && this.profile.pagination.kind === "cursor" && (receipt.nextCursor === undefined || receipt.nextCursor === receipt.cursor))
            throw new Error("Cursor did not advance");
        if (this.profile.pagination.kind === "cursor" && receipt.nextCursor !== undefined && (receipt.nextCursor === receipt.cursor || this.receipts.some(r => r.cursor === receipt.nextCursor)))
            throw new Error("Cursor cycle detected");
        const uniqueAfter = new Set([...this.products.keys(), ...receipt.items.map(v => JSON.stringify(v.ids))]).size;
        if (uniqueAfter > this.profile.limits.maxProducts)
            throw new Error("Product limit reached; catalog is incomplete");
        for (const item of receipt.items) {
            const key = JSON.stringify(item.ids);
            let priceFen: bigint | undefined, sales: bigint | undefined, salesKind: string | undefined;
            let priceError: string | undefined, salesError: string | undefined;
            try {
                priceFen = moneyFen(item.price, this.profile.products.priceUnit);
            }
            catch (error) {
                priceError = String(error);
            }
            try {
                const parsed = salesCount(item.sales);
                sales = parsed.count;
                salesKind = parsed.kind;
            }
            catch (error) {
                salesError = String(error);
            }
            const row: Product = { key, ids: item.ids, title: item.title, priceFen, sales, salesKind, priceError, salesError, conflict: false, occurrences: 1, pages: [receipt.index] };
            const previous = this.products.get(key);
            if (previous) {
                previous.occurrences++;
                previous.pages.push(receipt.index);
                if (previous.priceFen !== priceFen || previous.sales !== sales || previous.salesKind !== salesKind)
                    previous.conflict = true;
            }
            else
                this.products.set(key, row);
        }
        this.observations += receipt.items.length;
        this.receipts.push(receipt);
        if (receipt.items.length)
            this.fingerprints.add(receipt.fingerprint);
    }
    exhausted() {
        const last = this.receipts[this.receipts.length - 1];
        if (!last)
            return false;
        const stops: boolean[] = [];
        if (last.totalPages !== undefined)
            stops.push(this.receipts.length >= last.totalPages);
        if (last.hasMore !== undefined)
            stops.push(!last.hasMore);
        if (this.profile.pagination.kind === "cursor")
            stops.push(last.nextCursor === undefined);
        if (last.totalItems !== undefined)
            stops.push((this.profile.pagination.totalItemsMeaning === "unique_products" ? this.products.size : this.observations) >= last.totalItems);
        if (stops.some(Boolean) && stops.some(v => !v))
            throw new Error("Pagination stop conditions disagree");
        return stops.length > 0 && stops.every(Boolean);
    }
    report() {
        let catalogComplete = false, coverageError: string | undefined;
        try {
            catalogComplete = this.exhausted();
        }
        catch (error) {
            coverageError = String(error);
        }
        const last = this.receipts[this.receipts.length - 1];
        if (catalogComplete && last?.totalItems !== undefined) {
            const actual = this.profile.pagination.totalItemsMeaning === "unique_products" ? this.products.size : this.observations;
            if (actual !== last.totalItems) {
                catalogComplete = false;
                coverageError = "Observed count differs from API total";
            }
        }
        let subtotal = 0n, included = 0, missingSales = 0, invalidPrices = 0, conflicts = 0, estimatedSales = 0, lowerBoundSales = 0;
        const rows = [...this.products.values()].map(p => {
            if (p.sales === undefined)
                missingSales++;
            if (p.priceFen === undefined)
                invalidPrices++;
            if (p.conflict)
                conflicts++;
            if (p.salesKind === "estimated")
                estimatedSales++;
            if (p.salesKind === "lower_bound")
                lowerBoundSales++;
            const calculable = !p.conflict && p.sales !== undefined && p.priceFen !== undefined;
            const amount = calculable ? p.priceFen! * p.sales! : undefined;
            if (calculable) {
                subtotal += amount!;
                included++;
            }
            return { key: p.key, ids: p.ids, title: p.title, priceYuan: p.priceFen === undefined ? null : formatFen(p.priceFen),
                sales: p.sales?.toString() ?? null, salesKind: p.salesKind ?? null, amountYuan: amount === undefined ? null : formatFen(amount),
                included: calculable, conflict: p.conflict, priceError: p.priceError, salesError: p.salesError,
                occurrences: p.occurrences, pages: p.pages };
        });
        const amountComplete = catalogComplete && included === this.products.size;
        return {
            metric: "current_price_times_displayed_sales", currency: this.profile.currency, scope: this.profile.scope,
            catalogComplete, amountComplete, coverageError, pagesCollected: this.receipts.length,
            expectedPages: last?.totalPages, expectedItems: last?.totalItems, observations: this.observations,
            uniqueProducts: this.products.size, duplicateObservations: this.observations - this.products.size,
            includedProducts: included, missingSales, invalidPrices, conflicts, estimatedSales, lowerBoundSales,
            totalAmountYuan: amountComplete ? formatFen(subtotal) : null,
            capturedSubtotalYuan: included || (catalogComplete && !this.products.size) ? formatFen(subtotal) : null,
            interpretation: "Current price multiplied by displayed sales is an estimate, not verified historical revenue.",
            products: rows,
        };
    }
}
