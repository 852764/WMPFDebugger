import { z } from "zod";
import { createHash } from "node:crypto";
import { firstAt } from "../mcp/data";
import { moneyFen, salesCount } from "../mcp/products";
import { AutomationProfile, MiniappLink, profileSchema } from "./profile";

export const secretKey=/authorization|cookie|token|session|password|secret|openid|unionid|user|phone|email|address/i;
export const salesField=/^(sales|sales_num|sales_count|sale_num|sale_count|sold|sold_num|sold_count|sell_num|sell_count|total_sales|saleNum|salesCount|soldCount|salesVolume)$/i;
const idField=/^(id|goods_id|product_id|productId|goodsId|commodity_id|spu_id|spuId)$/;
const priceField=/^(price|goods_price|sale_price|selling_price|sell_price|priceYuan|priceFen|salePrice|sellingPrice|unit_price|retail_price)$/;
export type ObservedRequest={url:string;method:"GET"|"POST";data:Record<string,unknown>;headers:Record<string,string>;encoding:"object"|"form"|"json";route:string;tab:boolean;scopeEvidence?:string;priceEvidence?:string};
export type Candidate={id:string;request:ObservedRequest;itemsPath:string;sampleCount:number;inspectedCount:number;truncated:boolean;catalogComplete:boolean;fields:Record<string,unknown[]>;salesEvidence:Record<string,{valid:number;blank:number;invalid:number}>;metadata:Record<string,unknown>;idCandidates:string[];priceCandidates:string[];salesCandidates:string[];body:any};
export type PublicCandidate=Omit<Candidate,"body">;
export function catalogEndpoint(url:string) {
    return /goods|product|commodity|catalog|getFormDataList/i.test(url) && !/cart|order|pay|purchase|delete|update|create|submit|login|behavior|collect|refund|address|comment|review/i.test(url);
}
export function cleanData(value:any,depth=0):any {
    if(depth>8)return undefined;
    if(Array.isArray(value))return value.slice(0,100).map(v=>cleanData(v,depth+1));
    if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).filter(([k])=>!secretKey.test(k)&&!["__proto__","constructor","prototype"].includes(k)).map(([k,v])=>[k,cleanData(v,depth+1)]));
    if(typeof value==="string")return value.slice(0,500);
    return typeof value==="number"||typeof value==="boolean"||value===null?value:undefined;
}
function scalarFields(value:any,prefix="",depth=0):Record<string,unknown> {
    const out:Record<string,unknown>={};if(!value||typeof value!=="object"||depth>4)return out;
    for(const [k,v] of Object.entries(value)){
        if(secretKey.test(k)||["__proto__","prototype","constructor"].includes(k))continue;
        const key=prefix?prefix+"."+k:k;
        if(v===null||["string","number","boolean"].includes(typeof v))out[key]=typeof v==="string"?v.slice(0,120):v;
        else if(!Array.isArray(v))Object.assign(out,scalarFields(v,key,depth+1));
    }return out;
}
function provesSinglePage(request:ObservedRequest,metadata:Record<string,unknown>){
    const inputs=scalarFields(request.data),page=Object.entries(inputs).find(([k])=>/^(page|pageNo|pageNum|page_no|page_num|currentPage|current_page)$/i.test(k.split(".").pop()!));
    const current=page?Number(page[1]):1;if(!Number.isFinite(current)||current>1)return false;
    const totalEntry=Object.entries(metadata).find(([k])=>/(^|\.)(totalpages?|total_page|totalpage|pagecount|pages)$/i.test(k));
    if(totalEntry){const total=Number(totalEntry[1]);return Number.isInteger(total)&&total===1;}
    const more=Object.entries(metadata).find(([k])=>/(^|\.)(hasmore|has_more|ismore|is_more)$/i.test(k));
    return !!more&&(more[1]===false||more[1]===0||more[1]==="0"||more[1]==="false");
}
export function findCandidates(body:any,request:ObservedRequest):Candidate[] {
    if(!catalogEndpoint(request.url))return [];
    const out:Candidate[]=[];let visited=0;
    const walk=(node:any,prefix:string,depth:number)=>{
        if(++visited>500||depth>6||out.length>=8||!node||typeof node!=="object")return;
        if(Array.isArray(node)){
            if(!node.length||!node[0]||typeof node[0]!=="object"||Array.isArray(node[0]))return;
            const inspected=node.slice(0,1000).map(v=>scalarFields(v)),fields:Record<string,unknown[]>={};
            for(const sample of inspected)for(const [k,v] of Object.entries(sample)){
                // Only product identity/amount fields and their semantic names go to the model.
                if(!idField.test(k.split(".").pop()!)&&!priceField.test(k.split(".").pop()!)&&!salesField.test(k.split(".").pop()!)&&!/stock|count|quantity|title|name|unit|currency|price|sales|sold|sell/i.test(k))continue;
                if(!fields[k])fields[k]=[];if(fields[k].length<3&&!fields[k].some(x=>JSON.stringify(x)===JSON.stringify(v)))fields[k].push(v);
            }
            const keys=Object.keys(fields),ids=keys.filter(k=>idField.test(k.split(".").pop()!)),prices=keys.filter(k=>priceField.test(k.split(".").pop()!));
            if(ids.length&&prices.length){
                const id=createHash("sha256").update(request.method+request.url+prefix+JSON.stringify(request.data)).digest("hex").slice(0,16);
                const metadata=Object.fromEntries(Object.entries(scalarFields(body)).filter(([k])=>/page|total|count|more|cursor|status|code|success|unit|currency/i.test(k)).slice(0,35));
                const salesCandidates=keys.filter(k=>salesField.test(k.split(".").pop()!));
                const salesEvidence:Candidate["salesEvidence"]={};
                for(const field of salesCandidates){
                    let valid=0,blank=0,invalid=0;
                    for(const row of inspected){
                        const value=row[field];
                        if(value===null||value===undefined||typeof value==="string"&&!value.trim()){blank++;continue;}
                        try{salesCount(value);valid++;}catch{invalid++;}
                    }
                    salesEvidence[field]={valid,blank,invalid};
                }
                out.push({id,request,itemsPath:prefix||"$",sampleCount:node.length,inspectedCount:inspected.length,truncated:node.length>inspected.length,catalogComplete:provesSinglePage(request,metadata),fields,metadata,salesEvidence,idCandidates:ids,priceCandidates:prices,salesCandidates,body});
            }return;
        }
        for(const [k,v] of Object.entries(node))if(!secretKey.test(k))walk(v,prefix?prefix+"."+k:k,depth+1);
    };walk(body,"",0);return out;
}
export function publicCandidate(c:Candidate):PublicCandidate {const {body,...rest}=c;return rest;}
export const adapterDecisionSchema=z.discriminatedUnion("action",[
    z.object({action:z.literal("profile"),candidateId:z.string(),products:profileSchema.shape.products,pagination:profileSchema.shape.pagination,
        evidence:z.object({productId:z.string().min(1).max(500),price:z.string().min(1).max(500),sales:z.string().min(1).max(500),pagination:z.string().min(1).max(500),unfilteredCatalog:z.string().min(1).max(500)}),
        scope:z.string().min(1).max(500)}),
    z.object({action:z.literal("skip_no_sales"),candidateIds:z.array(z.string()).min(1),reason:z.string().min(1).max(500)}),
    z.object({action:z.literal("unresolved"),reason:z.string().min(1).max(500)})
]);
export type AdapterDecision=z.infer<typeof adapterDecisionSchema>;
export type DiscoveryEvidence={version:1;link:MiniappLink;appId:string;names:string[];route:string;routes:{route:string;text:string;tab:boolean}[];candidates:PublicCandidate[];observedAt:string;notes:string[]};
export function proposeZhichi(link:MiniappLink,appId:string,c:Candidate):AdapterDecision|undefined {
    if(!c.request.url.includes("r=AppData/getFormDataList")||c.itemsPath!=="data")return;
    const d=c.request.data;
    const category=d["idx_arr[idx_value]"]??(d.idx_arr as any)?.idx_value;
    if(category!==""||d.form!=="goods"||typeof d.app_id!=="string"||!d.app_id||!c.request.scopeEvidence)return;
    if(!c.salesCandidates.includes("form_data.sales"))return;
    return {action:"profile",candidateId:c.id,products:{itemsPath:"data",idPaths:["form_data.id"],titlePath:"form_data.title",pricePath:"form_data.price",salesPath:"form_data.sales",priceUnit:"yuan"},
        pagination:{kind:"page",requestPath:"page",start:1,currentPagePath:"current_page",totalPagesPath:"total_page",totalItemsPath:"count",hasMorePath:"is_more",totalItemsMeaning:"rows"},
        scope:"商城全部商品，当前商品标价（元）×接口销量；商品级去重，非历史订单收入。",
        evidence:{productId:"Observed form_data.id; nested goods_model SKU rows are excluded.",price:"Verified Zhichi goods-list price mapping uses yuan; "+(c.request.priceEvidence||""),sales:"Observed product form_data.sales, never stock/comment counts.",pagination:"Observed current_page, total_page, count, is_more; verified by replay.",unfilteredCatalog:c.request.scopeEvidence}};
}
export function profileFromDecision(link:MiniappLink,appId:string,names:string[],candidate:Candidate,raw:unknown):AutomationProfile {
    const d=adapterDecisionSchema.parse(raw);
    if(!candidate.request.url.startsWith("https://"))throw Error("ADAPTER_INVALID: Page samples cannot be replayed as network requests");
    if(d.action!=="profile"||d.candidateId!==candidate.id)throw Error("ADAPTER_INVALID: Candidate mismatch");
    if(d.products.itemsPath!==candidate.itemsPath)throw Error("ADAPTER_INVALID: Array was not observed");
    if(!candidate.salesCandidates.includes(d.products.salesPath))throw Error("ADAPTER_INVALID: Sales mapping must be an observed sales field, not stock/reviews");
    if(d.products.idPaths.some(p=>!candidate.idCandidates.includes(p)))throw Error("ADAPTER_INVALID: Product identity was not observed");
    if(!candidate.priceCandidates.includes(d.products.pricePath))throw Error("ADAPTER_INVALID: Price was not observed");
    const pageValue=firstAt(candidate.request.data,d.pagination.requestPath);
    if(pageValue===undefined)throw Error("ADAPTER_INVALID: Pagination request field was not observed");
    if(!candidate.request.scopeEvidence)throw Error("ADAPTER_UNPROVEN_SCOPE: No observed unfiltered catalog state");
    if(!candidate.request.priceEvidence)throw Error("ADAPTER_UNPROVEN_UNIT: No observed price-unit evidence");
    if(d.products.priceUnit==="fen"&&!/fen|分/i.test(candidate.request.priceEvidence))throw Error("ADAPTER_UNPROVEN_UNIT: Fen not supported by observed evidence");
    if(d.products.priceUnit==="yuan"&&!/yuan|元|￥|¥/i.test(candidate.request.priceEvidence))throw Error("ADAPTER_UNPROVEN_UNIT: Yuan not supported by observed evidence");
    const key=createHash("sha256").update(appId+candidate.id).digest("hex").slice(0,12);
    const success=Object.entries(candidate.metadata).find(([key,value])=>/(^|\.)(status|code|success)$/i.test(key)&&(value===0||value==="0"||value===true));
    return profileSchema.parse({version:1,id:"auto-"+key,name:link.name,shareNames:[link.name],shareCodes:[link.code],appId,
        windowTitle:names[0]||link.name,currency:"CNY",scope:d.scope,
        evidence:{identity:"Runtime appId "+appId+"; names "+names.join(", "),...d.evidence},
        request:{...candidate.request,useObservedTemplate:true,successPath:success?.[0],successValue:success?.[1] as any},
        bootstrap:{route:candidate.request.route?"/"+candidate.request.route:undefined,action:candidate.request.tab?"switchTab":"navigateTo",refreshList:true},
        products:d.products,pagination:d.pagination});
}
export function hasValidSales(c:Candidate) {return c.salesCandidates.some(p=>c.salesEvidence[p]?.valid>0);}
export function noSalesEvidence(candidates:Candidate[]) {
    return candidates.length>0&&candidates.every(c=>!!c.request.scopeEvidence&&c.catalogComplete&&!c.truncated&&c.salesCandidates.every(p=>{
        const evidence=c.salesEvidence[p];return !!evidence&&evidence.valid===0&&evidence.invalid===0&&evidence.blank===c.inspectedCount;
    }));
}
