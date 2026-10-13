import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AutomationProfile } from "./profile";
import { sleep } from "./runtime";
const exec = promisify(execFile);
const root = path.resolve(__dirname, "../..");
const configSchema = z.object({ command: z.string().min(1), args: z.array(z.string()).default(["windows-mcp", "serve"]), env: z.record(z.string(), z.string()).optional() });
export type OcrLine = {
    text: string;
    words: {
        text: string;
        x: number;
        y: number;
        width: number;
        height: number;
    }[];
};
export function locateText(lines: OcrLine[], text: string) {
    const needle = text.replace(/\s/g, "");
    const matches = lines.filter(l => l.text.replace(/\s/g, "").includes(needle));
    if (matches.length !== 1)
        return undefined;
    const words = matches[0].words;
    if (!words.length)
        return undefined;
    const left = Math.min(...words.map(w => w.x)), top = Math.min(...words.map(w => w.y));
    return { x: (left + Math.max(...words.map(w => w.x + w.width))) / 2, y: (top + Math.max(...words.map(w => w.y + w.height))) / 2 };
}
export function checkToolResult(result: any) {
    const text = (result.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
    if (/CONTROL_PREEMPTED|USER_ACTIVE|USER_CONTROL|"state"\s*:\s*"user"/i.test(text))
        throw Error("DESKTOP_BUSY: User input interrupted Windows-MCP. Resume when the desktop is available.");
    if (result.isError)
        throw Error("DESKTOP_TOOL_FAILED: " + text.slice(0, 500));
    return text;
}
export class WindowsLauncher {
    private client = new Client({ name: "wmpf-launcher", version: "1" });
    private connected = false;
    private imageFile = path.join(root, "artifacts", "launcher-" + process.pid + ".png");
    constructor(private signal?: AbortSignal) { }
    private async call(name: string, args: Record<string, unknown> = {}) {
        this.signal?.throwIfAborted();
        const result = await this.client.callTool({ name, arguments: args }, undefined, { timeout: 45000 });
        checkToolResult(result);
        this.signal?.throwIfAborted();
        return result;
    }
    async connect() {
        const configFile = process.env.WMPF_WINDOWS_MCP_CONFIG || path.join(root, "artifacts", "windows-mcp.local.json");
        let config;
        try {
            config = configSchema.parse(JSON.parse((await fs.readFile(configFile, "utf8")).replace(/^\uFEFF/, "")));
        }
        catch {
            throw Error("WINDOWS_MCP_CONFIG_REQUIRED: Create artifacts/windows-mcp.local.json from examples/windows-mcp.json.");
        }
        const transport = new StdioClientTransport({ ...config, cwd: root, stderr: "pipe" });
        transport.stderr?.on("data", () => { }); // Consume diagnostics; stdout belongs to our MCP server.
        await this.client.connect(transport, { timeout: 60000 });
        this.connected = true;
        for (let i = 0; i < 4; i++) {
            try {
                await this.call("ControlStatus");
                break;
            }
            catch (error) {
                if (!String(error).includes("DESKTOP_BUSY") || i === 3)
                    throw error;
                await sleep(10000, this.signal);
            }
        }
        await this.call("Snapshot", { use_vision: false, use_ui_tree: false });
    }
    private async window(title: string) {
        const { stdout } = await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/windows.ps1"), "-Title", title], { windowsHide: true, encoding: "utf8", timeout: 15000 });
        const windows = JSON.parse(stdout.replace(/^\uFEFF/, "")).filter((w: any) => w.right > w.left && w.bottom > w.top && w.left >= 0 && w.top >= 0 && (title !== "微信" || w.right - w.left >= 700 * w.dpi / 96));
        if (windows.length !== 1)
            throw Error("WINDOW_UNCERTAIN: Expected exactly one visible " + title + " window.");
        return windows[0];
    }
    private async ocr(rect: any) {
        const region = [rect.left, rect.top, rect.right, rect.bottom];
        const result = await this.call("Screenshot", { region, use_annotation: false });
        const block = (result.content as any[]).find(b => b.type === "image");
        if (!block)
            throw Error("Screenshot missing");
        await fs.mkdir(path.dirname(this.imageFile), { recursive: true });
        await fs.writeFile(this.imageFile, Buffer.from(block.data, "base64"));
        const { stdout } = await exec("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/ocr.ps1"), "-Image", this.imageFile], { windowsHide: true, encoding: "utf8", timeout: 25000 });
        const resultOcr = JSON.parse(stdout.replace(/^\uFEFF/, ""));
        return { lines: resultOcr.lines as OcrLine[], sx: (rect.right - rect.left) / resultOcr.width, sy: (rect.bottom - rect.top) / resultOcr.height };
    }
    private async textPoint(rect: any, text: string, minY = 0) {
        const scan = await this.ocr(rect), point = locateText(scan.lines.filter(l => l.words.some(w => w.y * scan.sy >= minY)), text);
        return point ? { x: Math.round(rect.left + point.x * scan.sx), y: Math.round(rect.top + point.y * scan.sy) } : undefined;
    }
    private async click(x: number, y: number) { await this.call("Click", { loc: [Math.round(x), Math.round(y)] }); await sleep(600, this.signal); }
    async open(profile: Pick<AutomationProfile, "name">) {
        await this.call("Shortcut", { shortcut: "ctrl+alt+w" });
        await sleep(800, this.signal);
        let w;
        try {
            w = await this.window("微信");
        }
        catch {
            await this.call("Shortcut", { shortcut: "ctrl+alt+w" });
            await sleep(600, this.signal);
            w = await this.window("微信");
        }
        const scale = w.dpi / 96;
        if (!/^4\./.test(w.version || "") || !/^WeChat|^Weixin/i.test(w.process) || w.right - w.left < 700 * scale)
            throw Error("LAUNCH_LAYOUT_UNSUPPORTED: Launcher is calibrated for desktop WeChat 4.x.");
        const existing = await this.textPoint(w, profile.name.split("-")[0], 120 * scale);
        if (existing) {
            await this.click(existing.x, existing.y);
            await sleep(1600, this.signal);
            return;
        }
        // Non-destructive navigation; subsequent text entry requires the search placeholder.
        await this.click(w.left + 38 * scale, w.top + 257 * scale);
        const nav = { ...w, right: w.left + 230 * scale };
        const mini = await this.textPoint(nav, "小程");
        if (!mini)
            throw Error("LAUNCH_CONTROL_MISSING: Mini-program navigation not found.");
        await this.click(mini.x, mini.y);
        let scan = await this.ocr(w);
        const recent = scan.lines.find(l => l.text.replace(/\s/g, "").includes("最近使用") && l.words.some(v => v.height * scan.sy >= 18 * scale));
        if (recent) {
            const left = Math.min(...recent.words.map(v => v.x)) * scan.sx;
            const top = Math.min(...recent.words.map(v => v.y)) * scan.sy;
            await this.click(w.left + left + 448 * scale, w.top + top + 10 * scale);
            scan = await this.ocr(w);
        }
        // The search icon belongs to the mini-program pane, which can be narrowed by a web tab.
        // Its OCR glyph is Q/0; require the observed toolbar row and icon-sized bounds.
        if (!locateText(scan.lines, "搜索小程序")) {
            const icons = scan.lines.filter(l => /^[Q0Oo]$/.test(l.text.trim()) && l.words.length === 1)
                .map(l => l.words[0]).filter(v => v.x * scan.sx > 230 * scale && v.y * scan.sy > 35 * scale && v.y * scan.sy < 75 * scale && v.width * scan.sx < 26 * scale && v.height * scan.sy < 26 * scale)
                .sort((a, b) => a.x - b.x);
            if (!icons.length)
                throw Error("LAUNCH_SEARCH_UNVERIFIED: Mini-program search icon not found.");
            const icon = icons[0];
            await this.click(w.left + (icon.x + icon.width / 2) * scan.sx, w.top + (icon.y + icon.height / 2) * scan.sy);
        }
        const search = await this.textPoint(w, "搜索小程序");
        if (!search)
            throw Error("LAUNCH_SEARCH_UNVERIFIED: No verified mini-program search field; no text was entered.");
        await this.call("Type", { loc: [search.x, search.y], text: profile.name, clear: true, press_enter: true });
        await sleep(1800, this.signal);
        // Search results sometimes extend outside the main window; the main pane still contains the app title.
        const result = await this.textPoint(w, profile.name.split("-")[0], 100 * scale);
        if (!result)
            throw Error("LAUNCH_RESULT_UNCERTAIN: No unique mini-program result. Open it once, then resume.");
        await this.click(result.x, result.y);
        await sleep(1600, this.signal);
    }
    async reenter(profile: Pick<AutomationProfile, "windowTitle">) {
        if (!profile.windowTitle)
            throw Error("REENTRY_REQUIRED: Reopen the mini-program once after debugger startup.");
        const w = await this.window(profile.windowTitle), scale = w.dpi / 96;
        await this.click(w.right - 102 * scale, w.top + 42 * scale);
        const point = await this.textPoint(w, "重新进入小程序");
        if (!point)
            throw Error("REENTRY_CONTROL_MISSING: Reopen the mini-program once, then resume.");
        await this.click(point.x, point.y);
    }
    async close() { if (this.connected)
        await this.client.close(); await fs.rm(this.imageFile, { force: true }); }
}
