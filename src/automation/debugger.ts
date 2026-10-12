import { spawn, ChildProcess } from "node:child_process";
import path from "node:path";
import { sleep } from "./runtime";
export class DebuggerProcess {
    private child?: ChildProcess;
    constructor(readonly port = 62000) { }
    async healthy() {
        try {
            const r = await fetch("http://127.0.0.1:" + this.port + "/json/version", { signal: AbortSignal.timeout(1000) });
            const d = await r.json() as any;
            return r.ok && d.Browser === "WMPFDebugger-MCP";
        }
        catch {
            return false;
        }
    }
    async start(signal?: AbortSignal) {
        if (await this.healthy())
            return;
        const root = path.resolve(__dirname, "../..");
        let failure = "";
        const child = spawn(process.execPath, ["--require", "ts-node/register", path.join(root, "src/index.ts"), "--cdp-port", String(this.port)], { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"] });
        this.child = child;
        child.on("error", error => { failure = error.message; });
        child.stderr?.on("data", b => { failure = (failure + b.toString()).slice(-2000); });
        let ready = false;
        child.stdout?.on("data", b => { if (b.toString().includes("you can now open any miniapps"))
            ready = true; });
        for (let i = 0; i < 50; i++) {
            signal?.throwIfAborted();
            if (ready && await this.healthy())
                return;
            if (child.exitCode !== null || failure.includes("version config not found"))
                break;
            await sleep(200, signal);
        }
        await this.close();
        throw Error("DEBUGGER_START_FAILED: " + failure.slice(-1000));
    }
    async close() {
        const child = this.child;
        this.child = undefined;
        if (!child || child.exitCode !== null)
            return;
        if (child.connected)
            child.send({ type: "wmpf-shutdown" });
        await Promise.race([new Promise<void>(r => child.once("exit", () => r())), sleep(2500)]);
        if (child.exitCode === null)
            child.kill(); // Only our own child.
    }
}
