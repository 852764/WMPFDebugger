import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AutomationProfile, parseMiniappLink } from "./profile";
import { atomicJson, readReport } from "./storage";
import { formatFen, moneyFen } from "../mcp/products";
export const batchesRoot=path.resolve(__dirname,"../../artifacts/batches");
export type ItemStatus="pending"|"running"|"completed"|"incomplete"|"skipped_no_sales"|"duplicate"|"invalid_link"|"needs_adaptation"|"needs_input"|"failed"|"timed_out"|"cancelled";
export type BatchItem={index:number;link:string;name?:string;status:ItemStatus;stage?:string;attempts:number;runId?:string;appId?:string;catalogKey?:string;profile?:AutomationProfile;profileId?:string;duplicateOf?:number;reason?:string;amountYuan?:string|null;uniqueProducts?:number;reportFile?:string;csvFile?:string;discoveryFile?:string};
export type BatchState={version:1;id:string;status:"running"|"finished"|"cancelled"|"needs_input"|"failed";createdAt:string;updatedAt:string;options:{port:number;desktop:boolean;perItemTimeoutMs:number;forceDiscover:boolean};items:BatchItem[];summaryFile:string;productsFile:string;error?:string};
export function batchDirectory(id:string){if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw Error("Invalid batch ID");return path.join(batchesRoot,id);}
export function parseLinks(value:string|string[]):string[]{
    const links=Array.isArray(value)?value:value.replace(/^\uFEFF/,"").split(/\r?\n/).map(v=>v.trim()).filter(v=>v&&!v.startsWith("//"));
    if(!links.length||links.length>500)throw Error("Provide 1–500 links, one per line");
    if(links.some(v=>typeof v!=="string"||v.length>500))throw Error("Each link must be at most 500 characters");
    return links.map(v=>v.trim());
}
export function seedItems(links:string[]):BatchItem[]{
    const seen=new Map<string,number>();
    return links.map((link,index)=>{
        const item:BatchItem={index,link,status:"pending",attempts:0};
        try{item.name=parseMiniappLink(link).name;}catch(e){item.status="invalid_link";item.reason=String(e);return item}
        if(seen.has(link)){item.status="duplicate";item.duplicateOf=seen.get(link);item.reason="Identical input link";}else seen.set(link,index);
        return item;
    });
}
export async function newBatch(links:string[],options:BatchState["options"]):Promise<BatchState>{
    const id="batch-"+Date.now()+"-"+randomUUID().slice(0,8),dir=batchDirectory(id);
    await fs.mkdir(dir,{recursive:true});
    const now=new Date().toISOString();
    const state:BatchState={version:1,id,status:"running",createdAt:now,updatedAt:now,options,items:seedItems(links),summaryFile:path.join(dir,"summary.json"),productsFile:path.join(dir,"products.csv")};
    await saveBatch(state);return state;
}
export async function loadBatch(id:string):Promise<BatchState>{const state=JSON.parse(await fs.readFile(path.join(batchDirectory(id),"state.json"),"utf8"));if(state.version!==1||state.id!==id)throw Error("Invalid batch state");return state}
export async function saveBatch(state:BatchState){state.updatedAt=new Date().toISOString();await atomicJson(path.join(batchDirectory(state.id),"state.json"),state)}
export function summarizeBatch(state:BatchState){
    const counts:Record<string,number>={};let sum=0n,products=0;const scopes=new Set<string>();
    for(const item of state.items){
        counts[item.status]=(counts[item.status]||0)+1;
        if(item.status==="completed"&&item.amountYuan!==null&&item.amountYuan!==undefined&&item.catalogKey&&!scopes.has(item.catalogKey)){
            scopes.add(item.catalogKey);sum+=moneyFen(item.amountYuan,"yuan");products+=item.uniqueProducts||0;
        }
    }
    const allAmountsAvailable=state.items.every(i=>i.status==="completed"||i.status==="duplicate"&&state.items[i.duplicateOf!]?.status==="completed");
    return {batchId:state.id,status:state.status,createdAt:state.createdAt,updatedAt:state.updatedAt,inputCount:state.items.length,counts,completedCatalogs:scopes.size,uniqueProductsInCompletedCatalogs:products,
        completedSubtotalYuan:formatFen(sum),allAmountsAvailable,totalAmountYuan:allAmountsAvailable?formatFen(sum):null,
        metric:"current_price_times_displayed_sales",currency:"CNY",interpretation:"Only complete, distinct catalogs contribute to completedSubtotalYuan; skipped/failed apps do not count as zero. Not historical revenue.",
        summaryFile:state.summaryFile,productsFile:state.productsFile};
}
export function csvCell(value:unknown){let text=String(value??"");if(/^[=+@\-\t\r\n]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"'}
export async function exportBatch(state:BatchState,includeProducts=false){
    const rows=state.items.map(({profile,...item})=>item),summary={...summarizeBatch(state),items:rows};
    await atomicJson(state.summaryFile,summary);
    const columns=["index","name","link","appId","status","uniqueProducts","amountYuan","duplicateOf","reason","runId"];
    const dir=batchDirectory(state.id),csv="\uFEFF"+[columns.join(","),...rows.map(row=>columns.map(k=>csvCell((row as any)[k])).join(","))].join("\r\n");
    await fs.writeFile(path.join(dir,"summary.csv"),csv,"utf8");
    if(includeProducts){
        const temp=state.productsFile+".tmp",handle=await fs.open(temp,"w"),seen=new Set<string>();
        try{
            await handle.write("\uFEFFbatchItem,appId,catalogKey,productKey,title,priceYuan,sales,amountYuan,included,runId\r\n");
            for(const item of state.items){
                if(!item.runId||!item.catalogKey||item.status==="duplicate"||seen.has(item.catalogKey))continue;
                seen.add(item.catalogKey);
                let offset=0;
                while(true){
                    let report;try{report=await readReport(item.runId,offset,500)}catch{break}
                    for(const p of report.products)await handle.write([item.index,item.appId,item.catalogKey,p.key,p.title,p.priceYuan,p.sales,p.amountYuan,item.status==="completed"&&p.included,item.runId].map(csvCell).join(",")+"\r\n");
                    if(report.nextOffset===null)break;offset=report.nextOffset;
                }
            }
        }finally{await handle.close();}
        await fs.rename(temp,state.productsFile);
    }
    return summary;
}
