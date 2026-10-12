import { test } from "node:test";
import assert from "node:assert/strict";
import { ProductLedger, ProductMapping, moneyFen, salesCount } from "../src/mcp/products";
import { redact, selectPath } from "../src/mcp/data";
const mapping: ProductMapping = { itemsPath: "data.list", idPaths: ["id"], pricePath: "price", salesPath: "sales", priceUnit: "yuan", onConflict: "exclude" };
test("deduplicates products across pages and makes repeated ingestion idempotent", () => {
    const ledger = new ProductLedger();
    ledger.ingest({ data: { list: [{ id: 1, price: "0.10", sales: 3 }, { id: 2, price: "19.99", sales: 2 }] } }, mapping, { requestId: "1", url: "/page/1" });
    const page2 = { data: { list: [{ id: 2, price: "19.99", sales: 2 }, { id: 3, price: "1.20", sales: "1万+" }] } };
    ledger.ingest(page2, mapping, { requestId: "2", url: "/page/2" });
    ledger.ingest(page2, mapping, { requestId: "2", url: "/page/2" });
    const report = ledger.report();
    assert.equal(report.uniqueProducts, 3);
    assert.equal(report.duplicates, 1);
    assert.equal(report.totalEstimateYuan, "12040.28");
    assert.equal(report.exactInputSubtotalYuan, "40.28");
    assert.equal(report.lowerBoundSalesSubtotalYuan, "12000.00");
});
test("conflicting product IDs are excluded; missing IDs and ambiguous prices are rejected", () => {
    const ledger = new ProductLedger();
    ledger.ingest({ data: { list: [
        { id: "a", price: 10, sales: 2 }, { id: "a", price: 20, sales: 2 },
        { price: 10, sales: 3 }, { id: "b", price: "10-20", sales: 1 },
    ] } }, mapping, { requestId: "1", url: "/" });
    assert.equal(ledger.report().totalEstimateYuan, "0.00");
    assert.equal(ledger.report().excludedConflicts, 1);
    assert.equal(ledger.report().rejected, 2);
    assert.throws(() => ledger.ingest({}, { ...mapping, priceUnit: "fen" }, { requestId: "2", url: "/" }), /Mapping changed/);
});
test("explicit conflict policy and units are honored", () => {
    const ledger = new ProductLedger();
    ledger.ingest({ data: { list: [{ id: "a", price: 1999, sales: 2 }, { id: "a", price: 2000, sales: 3 }] } }, { ...mapping, onConflict: "latest", priceUnit: "fen" }, { requestId: "1", url: "/" });
    assert.equal(ledger.report().totalEstimateYuan, "60.00");
    assert.equal(ledger.report().conflicts, 1);
});
test("money is exact, sales abbreviations are classified, malformed numeric data fails", () => {
    assert.equal(moneyFen("￥1,234.56", "yuan"), 123456n);
    assert.equal(moneyFen("0.29", "yuan") * 3n, 87n);
    assert.equal(moneyFen("12345678901234567890.12", "yuan"), 1234567890123456789012n);
    assert.deepEqual(salesCount("已售 1.2万+件"), { count: 12000n, kind: "lower_bound" });
    assert.deepEqual(salesCount("1.2万"), { count: 12000n, kind: "estimated" });
    for (const value of ["-1", "10起", "1,2", "0.001"]) assert.throws(() => moneyFen(value, "yuan"));
    assert.throws(() => salesCount("0.5"));
});
test("field projections and redaction cannot traverse prototypes", () => {
    assert.deepEqual(selectPath({ data: [{ id: 1 }, { id: 2 }] }, "data[*].id"), [1, 2]);
    assert.throws(() => selectPath({}, "__proto__.x"));
    assert.deepEqual(redact({ token: "secret", data: { price: 5, openid: "user" } }), { token: "[REDACTED]", data: { price: 5, openid: "[REDACTED]" } });
});
