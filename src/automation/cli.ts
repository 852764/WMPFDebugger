import { parseArgs } from "node:util";
import { AutomationManager } from "./engine";
import { listProfiles } from "./profile";
async function main() {
    const { values } = parseArgs({ options: { link: { type: "string" }, resume: { type: "string" }, profile: { type: "string" }, port: { type: "string" }, desktop: { type: "boolean", default: true }, "no-desktop": { type: "boolean" }, "list-profiles": { type: "boolean" }, help: { type: "boolean", short: "h" } } });
    if (values.help) {
        console.log('npm run collect -- --link "#小程序://名称/分享码" [--no-desktop] [--resume RUN_ID]\nDesktop boot requires logged-in WeChat and examples/windows-mcp.json configured locally.');
        return;
    }
    if (values["list-profiles"]) {
        console.log(JSON.stringify((await listProfiles()).map(p => ({ id: p.id, name: p.name, appId: p.appId })), null, 2));
        return;
    }
    if (!values.link)
        throw Error("--link is required");
    const port = values.port === undefined ? 62000 : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw Error("Invalid --port");
    const manager = new AutomationManager();
    let currentId: string | undefined;
    const cancel = () => { if (currentId)
        void manager.cancel(currentId); };
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    try {
        const state = await manager.start({ link: values.link, resumeId: values.resume, profileId: values.profile, port, desktop: values["no-desktop"] ? false : values.desktop });
        currentId = state.id;
        console.error("Run " + state.id);
        const final = await manager.wait(state.id);
        let report;
        try {
            report = await manager.report(state.id, 0, 0);
        }
        catch { }
        console.log(JSON.stringify({ state: final, report }, null, 2));
        if (final.status !== "completed")
            process.exitCode = 2;
    }
    finally {
        await manager.close();
        process.removeListener("SIGINT", cancel);
        process.removeListener("SIGTERM", cancel);
    }
}
main().catch(e => { console.error(String(e)); process.exitCode = 1; });
