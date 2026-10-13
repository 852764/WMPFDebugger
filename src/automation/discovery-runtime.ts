import { MiniappSession } from "../mcp/session";
import { pageSnapshot } from "../mcp/injected";
import { MiniappLink } from "./profile";
import { sleep } from "./runtime";
import { cleanData, ObservedRequest, catalogEndpoint, Candidate, findCandidates } from "./discovery-data";
import { selectPath, firstAt } from "../mcp/data";
import { moneyFen } from "../mcp/products";

// Serialized into app-service. Never returns userInfo, storage or session credentials.
export function inspectDiscovery() {
    const g=globalThis as any,c=g.__wxConfig||{},a=typeof g.getApp==="function"?g.getApp():{},pages=typeof g.getCurrentPages==="function"?g.getCurrentPages():[],p=pages[pages.length-1];
    const names=[c.accountInfo?.nickname,a.globalData?.appTitle,p?.data?.app_name].filter(v=>typeof v==="string"&&v.length<150);
    const routes=(c.tabBar?.list||[]).map((v:any)=>({route:String(v.pagePath||"").replace(/\.html$/,""),text:v.text||"",tab:true}));
    if(p?.route&&!routes.some((r:any)=>r.route===p.route))routes.unshift({route:p.route,text:"current",tab:false});
    for(const route of c.pages||[])if(typeof route==="string"&&/product.*list|goods.*list|catalog/i.test(route)&&!routes.some((r:any)=>r.route===route)&&routes.length<20)routes.push({route,text:"configured product list",tab:false});
    let scopeEvidence="",priceEvidence="";let visited=0;
    function walk(node:any,depth=0){
        if(!node||typeof node!=="object"||++visited>500||depth>6)return;
        if(node.type==="dynamic-classify"&&node.param?.idx_arr?.idx_value===""&&node.currentCategory?.every((x:any)=>x==="")&&node.classifyData?.some((v:any)=>v.name==="全部"&&v.category_id==="")){
            scopeEvidence="Observed 全部 category, empty currentCategory and idx_arr.idx_value in dynamic-classify.";
            const serialized=JSON.stringify(node.content||[]);
            if(serialized.includes("￥")&&serialized.includes('"segment":"price"'))priceEvidence="Zhichi template renders ￥ with segment=price; unit yuan.";
        }
        const labels=Object.entries(node).filter(([k,v])=>/title|name|label/i.test(k)&&typeof v==="string"&&/^(\u5168\u90e8\u5546\u54c1|\u5168\u90e8\u4ea7\u54c1)$/.test(v as string));
        const selectors=Object.entries(node).filter(([k])=>/^(categoryId|category_id|currentCategory|selectedCategory|keyword)$/.test(k));
        if(!scopeEvidence&&labels.length&&selectors.length&&selectors.every(([k,v])=>v===""||v===0||v==="0"||v===null))scopeEvidence="Observed whole-catalog label "+String(labels[0][1])+" with empty category/search selectors.";
        for(const [k,v] of Object.entries(node))if(!/user|token|session|address|phone|email|list_data|goods_data/i.test(k))walk(v,depth+1);
    }walk(p?.data);
    return {appId:c.accountInfo?.appId||c.appId,names:[...new Set(names)],route:p?.route||"",routes,scopeEvidence,priceEvidence,refresh:typeof p?.onPullDownRefresh==="function"};
}
export function observedRequests() {
    const g=globalThis as any,out:any[]=[],secret=/authorization|cookie|token|session|password|secret|openid|unionid|user|phone|email|address/i;
    const clean=(v:any,depth=0):any=>{
        if(depth>8)return undefined;
        if(Array.isArray(v))return v.slice(0,100).map(x=>clean(x,depth+1));
        if(v&&typeof v==="object")return Object.fromEntries(Object.entries(v).filter(([k])=>!secret.test(k)&&!["__proto__","constructor","prototype"].includes(k)).map(([k,x])=>[k,clean(x,depth+1)]));
        return typeof v==="string"?v.slice(0,500):typeof v==="number"||typeof v==="boolean"||v===null?v:undefined;
    };
    for(const t of g.__wmpfMcpCapture_v1?.templates?.values()||[]){
        const url=String(t.url||"");
        if(!/^https:\/\//.test(url)||!/goods|product|commodity|catalog|getFormDataList/i.test(url)||/cart|order|pay|purchase|delete|update|create|submit|login|behavior|collect|refund|address|comment|review/i.test(url))continue;
        const parts=url.split("?"),pairs=(parts[1]||"").split("&");
        // Tokenized URLs need an explicit adapter; do not expose them to the model or disk.
        if(pairs.some(p=>secret.test(decodeURIComponent(p.split("=")[0]))))continue;
        let data=t.data||{},encoding="object";
        if(typeof data==="string"){
            try{data=JSON.parse(data);encoding="json"}catch{
                const obj:any={};for(const entry of data.split("&")){const i=entry.indexOf("="),decode=(v:string)=>decodeURIComponent(v.replace(/\+/g," "));const k=decode(i<0?entry:entry.slice(0,i));if(!secret.test(k)&&!["__proto__","constructor","prototype"].includes(k))obj[k]=decode(i<0?"":entry.slice(i+1))}data=obj;encoding="form";
            }
        }
        const method=String(t.method||"GET").toUpperCase();
        if(method!=="GET"&&method!=="POST")continue;
        out.push({url,method,data:clean(data),headers:{"content-type":t.header?.["content-type"]||t.header?.["Content-Type"]||"application/json"},encoding});
    }return out;
}
export type AppInspection={appId:string;names:string[];route:string;routes:{route:string;text:string;tab:boolean}[];scopeEvidence:string;priceEvidence:string;refresh:boolean};
const normalized=(s:string)=>s.replace(/[\s-]/g,"").toLowerCase();
export class DiscoveryRuntime {
    readonly session=new MiniappSession();
    app?:AppInspection;
    private contextId?:number;
    constructor(readonly port=62000){}
    async attach(link:MiniappLink,signal?:AbortSignal,expectedAppId?:string,timeoutMs=1500){
        const start=Date.now();let error="No verified matching mini-program";
        do{
            signal?.throwIfAborted();
            const targets=await(await fetch("http://127.0.0.1:"+this.port+"/json/list",{signal:AbortSignal.timeout(2500)})).json() as any[];
            for(const target of targets.filter(t=>!t.attached)){
                try{
                    await this.session.connect(target.webSocketDebuggerUrl);
                    const contexts=await this.session.describeContexts();
                    for(const c of contexts.contexts.filter(c=>c.capabilities?.hasWxRequest&&c.capabilities?.hasPageStack)){
                        const app=await this.session.run(inspectDiscovery,[],c.id) as AppInspection;
                        const identity=expectedAppId?app.appId===expectedAppId:app.names.some(n=>normalized(n)===normalized(link.name));
                        if(identity&&/^wx[a-f0-9]{16}$/.test(app.appId)){
                            this.contextId=c.id;this.session.selectedContext=c.id;this.app=app;
                            await this.session.startCapture("auto");return app;
                        }
                    }
                }catch(e){error=String(e)}
                await this.session.close();
            }
            if(Date.now()-start>=timeoutMs)break;
            await sleep(300,signal);
        }while(true);
        throw Error("DISCOVERY_IDENTITY_UNAVAILABLE: "+error);
    }
    async inspect(){if(this.contextId===undefined)throw Error("Not connected");this.app=await this.session.run(inspectDiscovery,[],this.contextId);return this.app!;}
    async navigate(link:MiniappLink,route:{route:string;tab:boolean},signal?:AbortSignal){
        if(!this.app?.routes.some(r=>r.route===route.route))throw Error("Unobserved route");
        const appId=this.app.appId;
        try{await this.session.evaluate("new Promise((resolve,reject)=>wx["+JSON.stringify(route.tab?"switchTab":"navigateTo")+"]({url:"+JSON.stringify("/"+route.route)+",success:()=>resolve(true),fail:reject}))",this.contextId);}
        catch(e){if(this.session.cdp.connected)throw e}
        await sleep(1000,signal);
        if(!this.session.cdp.connected)await this.attach(link,signal,appId,5000);
        await this.inspect();
    }
    async refresh(signal?:AbortSignal){
        if(this.app?.refresh)await this.session.evaluate("(()=>{getCurrentPages().slice(-1)[0].onPullDownRefresh();return true})()",this.contextId);
        await sleep(1400,signal);
        await this.inspect();
    }
    async candidates():Promise<Candidate[]>{
        await this.session.drain();
        const templates=await this.session.run(observedRequests,[],this.contextId) as ObservedRequest[];
        const app=await this.inspect(),out:Candidate[]=[];
        for(const record of this.session.capture.records.values()){
            if(record.status!==200||!record.body||!catalogEndpoint(record.url))continue;
            const t=templates.find(t=>t.url===record.url&&t.method===record.method.toUpperCase());
            const template=t||{url:record.url,method:record.method as "GET"|"POST",data:{},headers:{},encoding:"object" as const};
            let body;try{body=JSON.parse(record.body)}catch{continue}
            const request:ObservedRequest={...template,data:cleanData(template.data),route:app.route,tab:app.routes.some(r=>r.tab&&r.route===app.route),scopeEvidence:app.scopeEvidence,priceEvidence:app.priceEvidence};
            if(Object.entries(request.data).some(([k,v])=>/^(categoryId|category_id|category|brand_id|brandId|keyword|productId|goodsId|idx_arr\[idx_value\])$/.test(k)&&v!==""&&v!==0&&v!=="0"&&v!==null&&v!==undefined))request.scopeEvidence=undefined;
            // An explicit API price-unit declaration can support generic adapters.
            if(!request.priceEvidence){
                const unit=body?.price_unit||body?.data?.price_unit;
                if(["yuan","fen","元","分"].includes(unit))request.priceEvidence="API price_unit="+unit;
            }
            out.push(...findCandidates(body,request));
        }
        // Compare prices with nearby rendered product titles for generic yuan/fen evidence.
        if(out.some(c=>!c.request.priceEvidence)){
            let text="";for(const ctx of (await this.session.describeContexts()).contexts.filter(c=>c.capabilities?.hasDocument)){
                try{const snap=await this.session.run(pageSnapshot,[{selector:"wx-text,wx-view",limit:100,offset:0}],ctx.id);text+=snap.nodes.map((n:any)=>n.text).join("\n").slice(0,16000)}catch{}
            }
            for(const c of out.filter(c=>!c.request.priceEvidence)){
                const rows=selectPath(c.body,c.itemsPath).flat().slice(0,5);
                for(const price of c.priceCandidates){
                    let yuan=0,fen=0;
                    for(const row of rows){
                        const title=firstAt(row,"title")??firstAt(row,"name")??firstAt(row,"form_data.title");if(typeof title!=="string"||title.length<3)continue;
                        const at=text.indexOf(title);if(at<0)continue;
                        const match=text.slice(at+title.length,at+title.length+100).match(/[￥¥]\s*([\d]+(?:\.\d{1,2})?)/);if(!match)continue;
                        try{const shown=moneyFen(match[1],"yuan");if(moneyFen(firstAt(row,price),"yuan")===shown)yuan++;if(moneyFen(firstAt(row,price),"fen")===shown)fen++;}catch{}
                    }
                    if(yuan>=2&&fen===0)c.request.priceEvidence="Observed two product titles followed by ￥ prices matching "+price+" in yuan.";
                    if(fen>=2&&yuan===0)c.request.priceEvidence="Observed two product titles followed by ￥ prices matching "+price+" in fen.";
                }
            }
        }
        const pageSamples=await this.session.run(samplePageProducts,[],this.contextId);
        for(const sample of pageSamples){
            out.push(...findCandidates({data:sample.rows},{url:"page-data://catalog/"+sample.path,method:"GET",data:{},headers:{},encoding:"object",route:app.route,tab:false}));
        }
        return [...new Map(out.map(c=>[c.id,c])).values()].slice(0,12);
    }
    async close(){await this.session.close();}
}

// Extract only product-like scalar fields; never return unrelated page/account objects.
export function samplePageProducts(){
    const g=globalThis as any,p=g.getCurrentPages?.().slice(-1)[0],out:any[]=[];let visited=0;
    const allowed=/^(id|goods_id|product_id|productId|goodsId|spu_id|spuId|commodity_id|title|name|price|goods_price|sale_price|salePrice|sellingPrice|selling_price|sell_price|unit_price|retail_price|priceYuan|priceFen|sales|sales_num|sales_count|sale_num|sale_count|sold|sold_num|sold_count|sell_num|sell_count|total_sales|saleNum|salesCount|soldCount|salesVolume|stock|inventory|comment_count|review_count)$/;
    function pick(row:any,depth=0):any{
        if(!row||typeof row!=="object"||Array.isArray(row)||depth>3)return {};
        const obj:any={};for(const [k,v] of Object.entries(row)){
            if(/user|token|session|address|phone|email/i.test(k)||["__proto__","prototype","constructor"].includes(k))continue;
            if(allowed.test(k)&&(v===null||["string","number","boolean"].includes(typeof v)))obj[k]=typeof v==="string"?v.slice(0,120):v;
            else if(v&&typeof v==="object"&&!Array.isArray(v)){const child=pick(v,depth+1);if(Object.keys(child).length)obj[k]=child;}
        }return obj;
    }
    function walk(node:any,field:string,depth=0){
        if(!node||typeof node!=="object"||++visited>1000||depth>7||out.length>=6)return;
        if(Array.isArray(node)){
            const rows=node.slice(0,5).map(v=>pick(v));
            const text=JSON.stringify(rows[0]||{});
            if(/"(?:id|goods_id|product_id|productId|goodsId|spuId)"\s*:/.test(text)&&/"(?:price|goods_price|salePrice|sale_price|sellingPrice|priceFen|priceYuan)"\s*:/.test(text))out.push({path:field,rows});
            return;
        }
        for(const [k,v] of Object.entries(node))if(!/user|token|session|address|phone|email/i.test(k))walk(v,field?field+"."+k:k,depth+1);
    }walk(p?.data,"");
    return out;
}
