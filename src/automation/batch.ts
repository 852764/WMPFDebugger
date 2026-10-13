import { promises as fs } from "node:fs";
import path from "node:path";
import { AutomationManager, acquireLock } from "./engine";
import { AutomationProfile, MiniappLink, parseMiniappLink, resolveProfile } from "./profile";
import { DebuggerProcess } from "./debugger";
import { discoverAdapter, AdapterSampler, Resolution, parseAdapterResponse, adapterPrompt } from "./discovery";
import { catalogKey } from "./identity";
import { atomicJson, readReport, readRun, RunState } from "./storage";
import { BatchState, BatchItem, batchDirectory, newBatch, loadBatch, saveBatch, exportBatch, parseLinks, summarizeBatch, batchesRoot } from "./batch-storage";
export type BatchOptions={links?:string[];text?:string;resumeId?:string;port?:number;desktop?:boolean;perItemTimeoutMs?:number;retryFailed?:boolean;forceDiscover?:boolean};
export interface BatchRunner{
    resolve(link:MiniappLink,options:BatchState["options"],signal:AbortSignal,stage:(text:string)=>Promise<void>,decision?:unknown):Promise<Resolution|{status:"adapted";profile:AutomationProfile}>;
    collect(item:BatchItem,profile:AutomationProfile,options:BatchState["options"],signal:AbortSignal,created:(id:string)=>Promise<void>):Promise<RunState>;
    close():Promise<void>;
}
export class DefaultBatchRunner implements BatchRunner{
    private automation=new AutomationManager();private debug?:DebuggerProcess;
    constructor(private sampler?:AdapterSampler){}
    async resolve(link:MiniappLink,options:BatchState["options"],signal:AbortSignal,stage:(text:string)=>Promise<void>,decision?:unknown){
        if(!options.forceDiscover&&!decision)try{return {status:"adapted" as const,profile:await resolveProfile(link)}}catch(e){if(!String(e).includes("PROFILE_REQUIRED"))throw e}
        this.debug??=new DebuggerProcess(options.port);
        return discoverAdapter(link,{...options,sampler:this.sampler,onStage:stage,decision},signal,this.debug);
    }
    async collect(item:BatchItem,profile:AutomationProfile,options:BatchState["options"],signal:AbortSignal,created:(id:string)=>Promise<void>){
        return this.automation.runResolved({link:item.link,resumeId:item.runId,port:options.port,desktop:options.desktop},profile,signal,created);
    }
    async close(){await this.automation.close();await this.debug?.close();}
}
export class BatchManager{
    private jobs=new Map<string,{controller:AbortController;done:Promise<void>}>();
    constructor(private factory:()=>BatchRunner=()=>new DefaultBatchRunner(),private lock=acquireLock){}
    get active(){return this.jobs.size>0;}
    async start(options:BatchOptions){
        if(!options.resumeId&&(!options.links&&!options.text))throw Error("links or text is required");
        if(options.resumeId&&(options.links||options.text))throw Error("Resume cannot replace the original input list");
        const unlock=await this.lock();let state:BatchState;
        try{
            if(options.resumeId){
                state=await loadBatch(options.resumeId);
                if(state.status==="running"&&this.jobs.has(state.id))throw Error("Batch is already running");
                for(const item of state.items){
                    const proposal=await fs.access(path.join(batchDirectory(state.id),"decision-"+item.index+".json")).then(()=>true,()=>false);
                    if(["running","cancelled","needs_input"].includes(item.status)||item.status==="needs_adaptation"&&proposal||options.retryFailed&&["failed","timed_out","needs_adaptation","incomplete"].includes(item.status)){
                        item.status="pending";item.reason=undefined;item.stage="resuming";
                    }
                }
                state.options={...state.options,...(options.desktop===undefined?{}:{desktop:options.desktop}),...(options.port===undefined?{}:{port:options.port})};
                state.status="running";state.error=undefined;await saveBatch(state);
            }else{
                const timeout=options.perItemTimeoutMs??180000;
                if(!Number.isInteger(timeout)||timeout<1000||timeout>900000)throw Error("perItemTimeoutMs must be 1000–900000");
                const port=options.port??62000;if(!Number.isInteger(port)||port<1||port>65535)throw Error("Invalid port");
                state=await newBatch(parseLinks(options.links||options.text!),{port,desktop:options.desktop??true,perItemTimeoutMs:timeout,forceDiscover:options.forceDiscover??false});
            }
        }catch(e){await unlock();throw e}
        const controller=new AbortController(),runner=this.factory();
        const done=this.execute(state,runner,controller.signal).catch(async e=>{state.status="failed";state.error=String(e);await saveBatch(state);await exportBatch(state);})
            .finally(async()=>{try{await runner.close()}finally{this.jobs.delete(state.id);await unlock()}});
        this.jobs.set(state.id,{controller,done});void done.catch(()=>{});
        return this.status(state.id);
    }
    private async execute(state:BatchState,runner:BatchRunner,signal:AbortSignal){
        const completed=new Map<string,number>(state.items.filter(i=>i.status==="completed"&&i.catalogKey).map(i=>[i.catalogKey!,i.index]));
        for(const item of state.items){
            if(signal.aborted)break;
            if(item.status!=="pending")continue;
            item.status="running";item.attempts++;item.stage="starting";await saveBatch(state);
            const controller=new AbortController();let timedOut=false;
            const abort=()=>controller.abort(signal.reason);signal.addEventListener("abort",abort,{once:true});
            const timer=setTimeout(()=>{timedOut=true;controller.abort(Error("ITEM_TIMEOUT"));},state.options.perItemTimeoutMs);
            try{
                let profile=item.profile;
                if(!profile){
                    let decision;try{decision=JSON.parse(await fs.readFile(path.join(batchDirectory(state.id),"decision-"+item.index+".json"),"utf8"))}catch(e:any){if(e.code!=="ENOENT")throw e}
                    const resolution=await runner.resolve(parseMiniappLink(item.link),state.options,controller.signal,async stage=>{item.stage=stage;await saveBatch(state)},decision);
                    controller.signal.throwIfAborted();
                    if("evidence" in resolution){
                        item.appId=resolution.evidence.appId;
                        item.discoveryFile=path.join(batchDirectory(state.id),"discovery-"+item.index+".json");
                        await atomicJson(item.discoveryFile,resolution.evidence);
                    }
                    if(resolution.status!=="adapted"){
                        item.status=resolution.status;item.reason=resolution.reason;item.stage="skipped";await saveBatch(state);await exportBatch(state);continue;
                    }
                    profile=resolution.profile;item.profile=profile;item.profileId=profile.id;item.appId=profile.appId;
                }
                item.catalogKey=catalogKey(profile);
                const prior=completed.get(item.catalogKey);
                if(prior!==undefined){item.status="duplicate";item.duplicateOf=prior;item.reason="Same verified app/store/catalog as an already completed item";item.stage="skipped";continue;}
                item.stage="collecting";await saveBatch(state);
                let recovered:RunState|undefined;
                if(item.runId){const previous=await readRun(item.runId);if(previous.status==="completed")recovered=previous;}
                const result=recovered||await runner.collect(item,profile,state.options,controller.signal,async id=>{item.runId=id;await saveBatch(state)});
                controller.signal.throwIfAborted();
                item.status=result.status==="running"?"failed":result.status;item.reason=result.error;
                item.uniqueProducts=result.uniqueProducts;item.reportFile=result.reportFile;item.csvFile=result.csvFile;
                const report=await readReport(result.id,0,0);
                item.amountYuan=result.status==="completed"?report.totalAmountYuan:null;
                if(item.status==="completed")completed.set(item.catalogKey,item.index);
                if(item.status==="needs_input"&&/DESKTOP_BUSY/.test(item.reason||"")){state.status="needs_input";break;}
            }catch(e){
                item.amountYuan=null;item.reason=String(e).slice(0,1500);
                item.status=timedOut?"timed_out":signal.aborted?"cancelled":/NO_SALES:/.test(item.reason)?"skipped_no_sales":/DESKTOP_BUSY/.test(item.reason)?"needs_input":"failed";
                if(item.status==="needs_input"){state.status="needs_input";break;}
            }finally{
                clearTimeout(timer);signal.removeEventListener("abort",abort);
                item.stage=item.status==="completed"?"finished":item.stage;
                await saveBatch(state);await exportBatch(state);
            }
        }
        if(signal.aborted)state.status="cancelled";else if(state.status==="running")state.status="finished";
        await saveBatch(state);await exportBatch(state,true);
    }
    async status(id:string,offset=0,limit=20){
        const state=await loadBatch(id);
        return {...summarizeBatch(state),interrupted:state.status==="running"&&!this.jobs.has(id)?await this.interrupted():false,
            nextOffset:limit>0&&offset+limit<state.items.length?offset+limit:null,
            items:state.items.slice(offset,offset+limit).map(({profile,...item})=>item)};
    }
    private async interrupted(){try{const owner=JSON.parse(await fs.readFile(path.resolve(batchesRoot,"../runs/automation.lock"),"utf8"));process.kill(owner.pid,0);return false}catch{return true}}
    async report(id:string,offset=0,limit=20){return this.status(id,offset,limit)}
    async evidence(id:string,index:number,offset=0,limit=2){
        const state=await loadBatch(id);const item=state.items[index];if(!item||!item.discoveryFile)throw Error("No discovery evidence for this item");
        const evidence=JSON.parse(await fs.readFile(path.join(batchDirectory(id),"discovery-"+index+".json"),"utf8"));
        return {...evidence,candidates:evidence.candidates.slice(offset,offset+limit),nextOffset:offset+limit<evidence.candidates.length?offset+limit:null,adapterPrompt};
    }
    async adapt(id:string,index:number,raw:unknown){
        const state=await loadBatch(id),item=state.items[index];
        if(!item||item.status!=="needs_adaptation")throw Error("Item is not waiting for AI adaptation");
        const decision=parseAdapterResponse(raw),evidence=JSON.parse(await fs.readFile(path.join(batchDirectory(id),"discovery-"+index+".json"),"utf8"));
        if(decision.action==="profile"&&!evidence.candidates.some((c:any)=>c.id===decision.candidateId))throw Error("Unobserved candidate ID");
        await atomicJson(path.join(batchDirectory(id),"decision-"+index+".json"),decision);
        return {batchId:id,index,decisionSaved:true,next:"Resume this batch after it finishes; proposal will be validated against fresh runtime observations before collection."};
    }
    async cancel(id:string){const job=this.jobs.get(id);if(!job)throw Error("Batch is not active in this MCP process");job.controller.abort();return {batchId:id,cancellationRequested:true};}
    async wait(id:string){await this.jobs.get(id)?.done;return this.status(id)}
    async close(){for(const job of this.jobs.values())job.controller.abort();await Promise.allSettled([...this.jobs.values()].map(j=>j.done))}
}
