import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { redact } from "../mcp/data";
const withoutCredentials = (value: unknown) => JSON.stringify(value) === JSON.stringify(redact(value));
const field = z.string().min(1).max(200).refine(s => !s.split(/[.\[\]]/).some(p => ["__proto__", "prototype", "constructor"].includes(p)), "Unsafe field path");
export const profileSchema = z.object({
    version: z.literal(1),
    id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,59}$/),
    name: z.string().min(1).max(100),
    shareCodes: z.array(z.string().regex(/^[A-Za-z0-9_-]{5,100}$/)).min(1),
    shareNames: z.array(z.string().min(1).max(100)).min(1),
    appId: z.string().regex(/^wx[a-f0-9]{16}$/),
    windowTitle: z.string().min(1).max(100).optional(),
    scope: z.string().min(1).max(1000),
    currency: z.literal("CNY"),
    evidence: z.object({
        identity: z.string().min(1), productId: z.string().min(1), price: z.string().min(1),
        sales: z.string().min(1), pagination: z.string().min(1), unfilteredCatalog: z.string().min(1),
    }),
    request: z.object({
        url: z.string().url().refine(s => new URL(s).protocol === "https:" && !new URL(s).username && !new URL(s).password && withoutCredentials(Object.fromEntries(new URL(s).searchParams)), "HTTPS endpoint without credentials required"),
        method: z.enum(["GET", "POST"]),
        data: z.record(z.string(), z.unknown()).default({}).refine(withoutCredentials, "Keep credentials in runtime memory, not profiles"),
        // Only non-secret headers belong in profiles. Session credentials are captured in runtime memory.
        headers: z.record(z.string(), z.string()).default({}).refine(v => !Object.keys(v).some(k => /authorization|cookie|token|secret/i.test(k)), "Do not store credentials in profiles"),
        useObservedTemplate: z.boolean().default(false),
        successPath: field.optional(),
        successValue: z.union([z.string(), z.number(), z.boolean()]).optional(),
    }),
    bootstrap: z.object({
        refreshList: z.boolean().default(false),
        route: z.string().regex(/^\/?pages\//).optional(),
        action: z.enum(["navigateTo", "switchTab"]).default("navigateTo"),
    }).default({ action: "navigateTo", refreshList: false }),
    products: z.object({
        itemsPath: field, idPaths: z.array(field).min(1).max(5),
        titlePath: field.optional(), pricePath: field, salesPath: field,
        priceUnit: z.enum(["yuan", "fen"]),
    }),
    pagination: z.object({
        kind: z.enum(["page", "cursor"]),
        requestPath: field.refine(s => /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(s), "Use a dotted object path"),
        start: z.union([z.number().int().min(0), z.string()]).default(1),
        currentPagePath: field.optional(),
        totalPagesPath: field.optional(),
        totalItemsPath: field.optional(),
        hasMorePath: field.optional(),
        nextCursorPath: field.optional(),
        totalItemsMeaning: z.enum(["rows", "unique_products"]).default("rows"),
    }).refine(v => !!(v.totalPagesPath || v.totalItemsPath || v.hasMorePath || v.nextCursorPath), "A verifiable pagination stop condition is required")
        .refine(v => v.kind !== "cursor" || !!v.nextCursorPath, "Cursor pagination needs nextCursorPath")
        .refine(v => v.kind !== "page" || typeof v.start === "number", "Page start must be a number"),
    limits: z.object({
        maxPages: z.number().int().min(1).max(5000).default(1000),
        maxProducts: z.number().int().min(1).max(100000).default(100000),
        intervalMs: z.number().int().min(100).max(30000).default(600),
        retries: z.number().int().min(0).max(5).default(2),
    }).default({ maxPages: 1000, maxProducts: 100000, intervalMs: 600, retries: 2 }),
});
export type AutomationProfile = z.infer<typeof profileSchema>;
export type MiniappLink = {
    raw: string;
    name: string;
    code: string;
};
export function parseMiniappLink(raw: string): MiniappLink {
    const match = raw.trim().match(/^#小程序:\/\/([^/\r\n]{1,100})\/([A-Za-z0-9_-]{5,100})$/);
    if (!match)
        throw new Error("Use a WeChat share link: #小程序://名称/分享码");
    return { raw: raw.trim(), name: match[1], code: match[2] };
}
export const profilesRoot = path.resolve(__dirname, "../../profiles");
export async function listProfiles(): Promise<AutomationProfile[]> {
    await fs.mkdir(profilesRoot, { recursive: true });
    const files = (await fs.readdir(profilesRoot)).filter(n => /^[a-z0-9_-]+\.json$/.test(n));
    return Promise.all(files.map(async (name) => profileSchema.parse(JSON.parse(await fs.readFile(path.join(profilesRoot, name), "utf8")))));
}
export async function resolveProfile(link: MiniappLink, id?: string): Promise<AutomationProfile> {
    const profiles = await listProfiles();
    const matching = profiles.filter(p => p.shareNames.includes(link.name) && p.shareCodes.includes(link.code) && (!id || p.id === id));
    if (matching.length !== 1)
        throw new Error("PROFILE_REQUIRED: No unique verified profile for " + link.name + ". Discover the app first and save a profile with field and pagination evidence.");
    return matching[0];
}
export function profileHash(profile: AutomationProfile) { return createHash("sha256").update(JSON.stringify(profile)).digest("hex"); }
export function setDataPath(data: Record<string, unknown>, fieldPath: string, value: unknown) {
    field.parse(fieldPath);
    const parts = fieldPath.split(".");
    let cursor: any = data;
    for (const part of parts.slice(0, -1)) {
        if (cursor[part] === undefined)
            cursor[part] = {};
        if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part]))
            throw new Error("Pagination field parent is not an object");
        cursor = cursor[part];
    }
    cursor[parts[parts.length - 1]] = value;
}
