import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { findCandidates, hasValidSales, noSalesEvidence, ObservedRequest } from "../src/automation/discovery-data";
import { BatchManager, BatchRunner } from "../src/automation/batch";
import { batchDirectory } from "../src/automation/batch-storage";
import { profileSchema, parseMiniappLink } from "../src/automation/profile";
import { catalogKey } from "../src/automation/identity";
import { atomicJson, readReport, runDirectory, RunStorage } from "../src/automation/storage";
import { collect } from "../src/automation/engine";
import type { AutomationProfile } from "../src/automation/profile";

const request: ObservedRequest = { url:"https://example.test/api/product/list", method:"POST", data:{page:1}, headers:{}, encoding:"object", route:"pages/shop/index", tab:false, scopeEvidence:"all products", priceEvidence:"yuan" };
function rows(sales:(number|string|null|undefined)[]){return sales.map((value,index)=>({productId:"p"+index,price:"12.5",...(value===undefined?{}:{sales:value})}));}
function profile(link:string,tenant:string){
    const parsed=parseMiniappLink(link);
    return profileSchema.parse({version:1,id:"batch-test",name:parsed.name,shareNames:[parsed.name],shareCodes:[parsed.code],appId:"wx0000000000000000",scope:"all products",currency:"CNY",evidence:{identity:"test",productId:"observed id",price:"yuan",sales:"sales",pagination:"page",unfilteredCatalog:"all"},request:{url:"https://example.test/api/product/list",method:"POST",data:{tenant,page:1}},products:{itemsPath:"data",idPaths:["productId"],pricePath:"price",salesPath:"sales",priceUnit:"yuan"},pagination:{kind:"page",requestPath:"page",start:1,totalPagesPath:"pages"},limits:{intervalMs:100,retries:0}}) as AutomationProfile;
}
test("sales evidence examines the whole bounded page, accepts zero, and never skips truncated evidence",()=>{
    const late=findCandidates({data:rows([...Array(9).fill(null),0])},request)[0];
    assert.ok(late);assert.ok(hasValidSales(late));assert.equal(noSalesEvidence([late]),false);
    const blank=findCandidates({data:rows(Array(12).fill(null)),pages:1},request)[0];
    assert.ok(blank);assert.equal(noSalesEvidence([blank]),true);
    const paged=findCandidates({data:rows(Array(12).fill(null)),totalPage:2},{...request,data:{currentPage:1}})[0];assert.ok(paged);assert.equal(noSalesEvidence([paged]),false);
    const filtered=findCandidates({data:rows(Array(12).fill(null))},{...request,scopeEvidence:undefined})[0];assert.ok(filtered);assert.equal(noSalesEvidence([filtered]),false);
    const unknown=findCandidates({data:rows(Array(1001).fill(null)),pages:1},request)[0];
    assert.ok(unknown);assert.equal(unknown.truncated,true);assert.equal(noSalesEvidence([unknown]),false);
    const invalid=findCandidates({data:rows(Array(12).fill("unknown")),pages:1},request)[0];
    assert.ok(invalid);assert.equal(noSalesEvidence([invalid]),false);
});
test("catalog deduplication keeps store filters and amount field mapping in scope",()=>{
    const a=profile("#小程序://StoreA/AAAAA","tenant-a"),alias=profile("#小程序://Alias/BBBBB","tenant-a"),b=profile("#小程序://StoreB/CCCCC","tenant-b");
    assert.equal(catalogKey(a),catalogKey(alias));assert.notEqual(catalogKey(a),catalogKey(b));
    const changed=profileSchema.parse({...a,products:{...a.products,salesPath:"sold"}});
    assert.notEqual(catalogKey(a),catalogKey(changed));
});
test("batch isolates no-sales links, deduplicates verified catalogs, and resumes pending work",async()=>{
    const links=["#小程序://StoreA/AAAAA","#小程序://Alias/BBBBB","#小程序://NoSales/DDDDD","#小程序://StoreB/CCCCC"];
    const collected:string[]=[],runIds:string[]=[];
    const fake:BatchRunner={
        async resolve(link){
            if(link.name==="NoSales")return {status:"skipped_no_sales",reason:"NO_SALES",evidence:{}} as any;
            return {status:"adapted",profile:profile(link.raw,link.name==="StoreB"?"tenant-b":"tenant-a")};
        },
        async collect(item,_profile,_options,_signal,created){
            const id="batchtest-"+item.index+"-"+Date.now();runIds.push(id);collected.push(item.link);
            await created(id);await fs.mkdir(runDirectory(id),{recursive:true});
            const amount=item.link.includes("StoreB")?"20.00":"10.00";
            const report={runId:id,totalAmountYuan:amount,products:[]};await atomicJson(path.join(runDirectory(id),"report.json"),report);
            return {version:1,id,link:parseMiniappLink(item.link),profileId:"batch-test",profileHash:"test",status:"completed",stage:"finished",createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),pages:1,uniqueProducts:1,reportFile:path.join(runDirectory(id),"report.json")} as any;
        },async close(){}
    };
    const manager=new BatchManager(()=>fake);
    let batchId="";
    try{
        const started=await manager.start({links,desktop:false,perItemTimeoutMs:5000});batchId=(started as any).batchId;
        const finished=await manager.wait(batchId);
        assert.equal(finished.status,"finished");assert.equal(finished.counts.completed,2);assert.equal(finished.counts.duplicate,1);assert.equal(finished.counts.skipped_no_sales,1);
        assert.equal(finished.completedSubtotalYuan,"30.00");assert.equal(finished.totalAmountYuan,null);assert.equal(collected.length,2);
        assert.equal((await readReport(runIds[0],0,0)).totalAmountYuan,"10.00");
    }finally{await manager.close();if(batchId)await fs.rm(batchDirectory(batchId),{recursive:true,force:true});for(const id of runIds)await fs.rm(runDirectory(id),{recursive:true,force:true});}

    let startedResolve!:()=>void;const startedSignal=new Promise<void>(r=>startedResolve=r);let first=true;
    const interruptible:BatchRunner={...fake,async collect(item,p,o,signal,created){
        if(first){first=false;startedResolve();await new Promise<never>((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new Error("cancelled")),{once:true}));}
        return fake.collect(item,p,o,signal,created);
    }};
    const firstManager=new BatchManager(()=>interruptible);let interruptedId="";
    try{
        const started=await firstManager.start({links:[links[0],links[3]],desktop:false,perItemTimeoutMs:5000});interruptedId=(started as any).batchId;
        await startedSignal;await firstManager.cancel(interruptedId);const cancelled=await firstManager.wait(interruptedId);
        assert.equal(cancelled.status,"cancelled");assert.equal(cancelled.counts.cancelled,1);assert.equal(cancelled.counts.pending,1);
    }finally{await firstManager.close();}
    const resumedManager=new BatchManager(()=>fake);
    try{
        const resumed=await resumedManager.start({resumeId:interruptedId});await resumedManager.wait(interruptedId);
        assert.equal(resumed.batchId,interruptedId);
        const final=await resumedManager.status(interruptedId);assert.equal(final.status,"finished");assert.equal(final.counts.completed,2);
    }finally{await resumedManager.close();if(interruptedId)await fs.rm(batchDirectory(interruptedId),{recursive:true,force:true});for(const id of runIds)await fs.rm(runDirectory(id),{recursive:true,force:true});}
});
test("no sales is decided only after the full paginated catalog",async()=>{
    const p=profileSchema.parse({version:1,id:"no-sales-pages",name:"Test",shareNames:["Test"],shareCodes:["abcde"],appId:"wx0000000000000000",scope:"test",currency:"CNY",evidence:{identity:"test",productId:"id",price:"yuan",sales:"sales",pagination:"pages",unfilteredCatalog:"all"},request:{url:"https://example.test/catalog",method:"GET"},products:{itemsPath:"data",idPaths:["id"],pricePath:"price",salesPath:"sales",priceUnit:"yuan"},pagination:{kind:"page",requestPath:"page",start:1,currentPagePath:"page",totalPagesPath:"pages",totalItemsPath:"count",hasMorePath:"more"},limits:{intervalMs:100,retries:0}});
    const link=parseMiniappLink("#小程序://Test/abcde"),missing=()=>({page:1,data:[{id:"a",price:"1"}],pages:2,count:2,more:true});
    const first=await RunStorage.open(link,p);let calls=0;
    try{
        await collect(first,{bootstrap:async()=>{},request:async()=>({status:200,data:++calls===1?missing():{page:2,data:[{id:"b",price:"1",sales:0}],pages:2,count:2,more:false}})});
        assert.equal(calls,2);assert.equal(first.catalog.report().missingSales,1);
    }finally{await fs.rm(first.dir,{recursive:true,force:true});}
    const second=await RunStorage.open(link,p);calls=0;
    try{
        await assert.rejects(collect(second,{bootstrap:async()=>{},request:async()=>{calls++;return {status:200,data:{page:calls,data:[{id:"p"+calls,price:"1"}],pages:2,count:2,more:calls<2}}}}),/NO_SALES/);
        assert.equal(calls,2);
    }finally{await fs.rm(second.dir,{recursive:true,force:true});}
});