import { createHash } from "node:crypto";
import type { AutomationProfile } from "./profile";
export function stableJson(value: any): string {
    if (Array.isArray(value)) return "["+value.map(stableJson).join(",")+"]";
    if (value && typeof value==="object") return "{"+Object.keys(value).sort().map(k=>JSON.stringify(k)+":"+stableJson(value[k])).join(",")+"}";
    return JSON.stringify(value);
}
function normalizedValues(value: any): any {
    if (Array.isArray(value)) return value.map(normalizedValues);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalizedValues(v)]));
    return value === null ? null : String(value);
}
export function catalogKey(profile: AutomationProfile) {
    const data=structuredClone(profile.request.data),parts=profile.pagination.requestPath.split(".");
    let parent:any=data;for(const key of parts.slice(0,-1))parent=parent?.[key];
    if(parent&&typeof parent==="object")delete parent[parts[parts.length-1]];
    // Keep tenant, filters and endpoint: two stores sharing an appId are not the same catalog.
    return createHash("sha256").update(stableJson({
        appId:profile.appId,url:profile.request.url,method:profile.request.method,data:normalizedValues(data),
        items:profile.products.itemsPath,ids:profile.products.idPaths,price:profile.products.pricePath,
        sales:profile.products.salesPath,priceUnit:profile.products.priceUnit,
    })).digest("hex");
}
