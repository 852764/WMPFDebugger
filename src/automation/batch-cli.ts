import { promises as fs } from "node:fs";
import { parseArgs } from "node:util";
import { BatchManager } from "./batch";
async function main(){
    const {values}=parseArgs({options:{"links-file":{type:"string"},resume:{type:"string"},"no-desktop":{type:"boolean"},"retry-failed":{type:"boolean"},"force-discover":{type:"boolean"},port:{type:"string"},"item-timeout":{type:"string"},help:{type:"boolean",short:"h"}}});
    if(values.help){console.log("npm run batch -- --links-file links.txt [--no-desktop] [--item-timeout 180]\nnpm run batch -- --resume BATCH_ID [--retry-failed]\nUse a sampling-capable MCP client for AI adapters; CLI uses verified platform adapters and leaves unresolved items for AI review.");return;}
    let links:string[]|undefined,text:string|undefined;
    if(values["links-file"]){
        const buffer=await fs.readFile(values["links-file"]);
        const content=(buffer[0]===0xff&&buffer[1]===0xfe?buffer.toString("utf16le"):buffer.toString("utf8")).replace(/^\uFEFF/,"");
        if(values["links-file"].toLowerCase().endsWith(".json")){const parsed=JSON.parse(content);if(!Array.isArray(parsed))throw Error("JSON input must be an array of links");links=parsed;}
        else text=content;
    }
    const manager=new BatchManager();let id:string|undefined;
    const cancel=()=>{if(id)void manager.cancel(id)};
    process.once("SIGINT",cancel);process.once("SIGTERM",cancel);
    try{
        const state=await manager.start({links,text,resumeId:values.resume,desktop:values["no-desktop"]?false:undefined,retryFailed:values["retry-failed"],forceDiscover:values["force-discover"],port:values.port?Number(values.port):undefined,perItemTimeoutMs:values["item-timeout"]?Number(values["item-timeout"])*1000:undefined});
        id=state.batchId;console.error("Batch "+id);
        const report=await manager.wait(id);
        console.log(JSON.stringify(report,null,2));
        if(report.status!=="finished"||(report.counts.failed||report.counts.timed_out||report.counts.needs_adaptation||report.counts.needs_input))process.exitCode=2;
    }finally{await manager.close();process.removeListener("SIGINT",cancel);process.removeListener("SIGTERM",cancel);}
}
main().catch(e=>{console.error(String(e));process.exitCode=1});
