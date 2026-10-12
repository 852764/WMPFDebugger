import { promises as fs } from "node:fs";
import path from "node:path";
import { ProductLedger } from "./products";
export async function exportProducts(ledger: ProductLedger, dataset: string, format: "json" | "csv") {
    const report = ledger.report(0, 100000);
    const root = path.resolve(__dirname, "../../artifacts");
    await fs.mkdir(root, { recursive: true });
    const name = dataset.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60) || "products";
    const file = path.join(root, name + "-" + Date.now() + "." + format);
    let content: string;
    if (format === "json") content = JSON.stringify(report, null, 2);
    else {
        const columns = ["key", "title", "priceYuan", "sales", "salesKind", "estimateYuan", "included", "conflict", "occurrences", "requestId", "url"];
        const quote = (value: unknown) => {
            let text = String(value ?? "");
            if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
        };
        content = "\uFEFF" + [columns.join(","), ...report.products.map(p => [
            p.key, p.title, p.priceYuan, p.sales, p.salesKind, p.estimateYuan, p.included, p.conflict, p.occurrences, p.source.requestId, p.source.url,
        ].map(quote).join(","))].join("\r\n");
    }
    await fs.writeFile(file, content, { encoding: "utf8", flag: "wx" });
    return { file, products: report.uniqueProducts, totalEstimateYuan: report.totalEstimateYuan };
}
