import { IPlatform, WmpfProcessInfo } from "./types";
import * as frida from "frida";

export class WindowsPlatform implements IPlatform {
    async findWmpfProcess(): Promise<WmpfProcessInfo> {
        const processes = await (await frida.getLocalDevice()).enumerateProcesses({ scope: frida.Scope.Metadata });
        const candidates = processes.filter(p => p.name === "WeChatAppEx.exe"
            && !/WXWork|wmpf_Applet/i.test(String(p.parameters.path || "")));
        // Prefer the browser process itself. Do not choose the busiest parent: it can be WXWork.
        const parents = candidates.filter(p => candidates.some(child => Number(child.parameters.ppid) === p.pid));
        const browser = parents.find(p => !(p.parameters.argv as string[] | undefined)?.some(a => a.startsWith("--type=")))
            || parents[0];
        if (!browser) throw new Error("[frida] WeChat mini-program runtime not found. Open a mini-program once, close its window, then retry.");
        const argv = (browser.parameters.argv || []) as string[];
        const location = argv.find(a => a.startsWith("--flue-runtime-dir")) || String(browser.parameters.path || "");
        const versionMatch = location.match(/RadiumWMPF[\\/](\d+)[\\/]/i);
        if (!versionMatch) throw new Error("[frida] Cannot identify WMPF version from runtime path: " + location);
        return { pid: browser.pid, version: Number(versionMatch[1]) };
    }
}
