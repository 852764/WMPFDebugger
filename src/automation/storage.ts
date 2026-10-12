import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AutomationProfile, MiniappLink, profileHash } from "./profile";
import { Catalog, PageReceipt } from "./catalog";
export const runsRoot = path.resolve(__dirname, "../../artifacts/runs");
export type RunState = {
    version: 1;
    id: string;
    link: MiniappLink;
    profileId: string;
    profileHash: string;
    status: "running" | "completed" | "incomplete" | "needs_input" | "failed" | "cancelled";
    stage: string;
    createdAt: string;
    updatedAt: string;
    pages: number;
    uniqueProducts: number;
    error?: string;
    reportFile?: string;
    csvFile?: string;
};
export function runDirectory(id: string) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id))
        throw new Error("Invalid run ID");
    return path.join(runsRoot, id);
}
async function atomicJson(file: string, value: unknown) {
    const temp = file + "." + randomUUID() + ".tmp";
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
    await fs.rename(temp, file);
}
export class RunStorage {
    private constructor(readonly dir: string, public state: RunState, readonly catalog: Catalog) { }
    static async open(link: MiniappLink, profile: AutomationProfile, resumeId?: string) {
        const id = resumeId || new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + randomUUID().slice(0, 8);
        const dir = runDirectory(id);
        const catalog = new Catalog(profile);
        let state: RunState;
        if (resumeId) {
            state = JSON.parse(await fs.readFile(path.join(dir, "state.json"), "utf8"));
            if (state.version !== 1 || state.id !== id || state.link.raw !== link.raw || state.profileHash !== profileHash(profile))
                throw new Error("Resume profile/link does not match checkpoint");
            const names = (await fs.readdir(dir)).filter(n => /^page-\d{6}\.json$/.test(n)).sort();
            for (const name of names)
                catalog.add(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")));
            if (state.status === "completed")
                throw new Error("This run is already complete");
        }
        else {
            await fs.mkdir(dir, { recursive: true });
            state = { version: 1, id, link, profileId: profile.id, profileHash: profileHash(profile),
                status: "running", stage: "created", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), pages: 0, uniqueProducts: 0 };
        }
        const storage = new RunStorage(dir, state, catalog);
        await storage.update({ status: "running", stage: resumeId ? "resuming" : "created", error: undefined, pages: catalog.receipts.length, uniqueProducts: catalog.report().uniqueProducts });
        return storage;
    }
    async update(change: Partial<RunState>) {
        this.state = { ...this.state, ...change, updatedAt: new Date().toISOString() };
        await atomicJson(path.join(this.dir, "state.json"), this.state);
    }
    async page(receipt: PageReceipt) {
        this.catalog.add(receipt);
        // Receipts are authoritative if the process exits between these two writes.
        await atomicJson(path.join(this.dir, "page-" + String(receipt.index).padStart(6, "0") + ".json"), receipt);
        await this.update({ pages: this.catalog.receipts.length, uniqueProducts: this.catalog.report().uniqueProducts });
    }
    async export() {
        const result = { runId: this.state.id, link: this.state.link.raw, profile: this.state.profileId,
            startedAt: this.state.createdAt, finishedAt: new Date().toISOString(), ...this.catalog.report() };
        const reportFile = path.join(this.dir, "report.json"), csvFile = path.join(this.dir, "products.csv");
        await atomicJson(reportFile, result);
        const columns = ["key", "title", "priceYuan", "sales", "salesKind", "amountYuan", "included", "conflict", "occurrences", "priceError", "salesError"];
        const quote = (value: unknown) => {
            let text = String(value ?? "");
            if (/^[=+@\-\t\r]/.test(text))
                text = "'" + text;
            return '"' + text.replace(/"/g, '""') + '"';
        };
        const csv = "\uFEFF" + [columns.join(","), ...result.products.map(p => columns.map(k => quote((p as any)[k])).join(","))].join("\r\n");
        await fs.writeFile(csvFile, csv, "utf8");
        await this.update({ reportFile, csvFile });
        return result;
    }
}
export async function readRun(id: string) { return JSON.parse(await fs.readFile(path.join(runDirectory(id), "state.json"), "utf8")) as RunState; }
export async function readReport(id: string, offset = 0, limit = 30) {
    const report = JSON.parse(await fs.readFile(path.join(runDirectory(id), "report.json"), "utf8"));
    const total = report.products.length;
    return { ...report, nextOffset: limit > 0 && offset + limit < total ? offset + limit : null, products: report.products.slice(offset, offset + limit) };
}
