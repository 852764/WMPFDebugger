import { promises } from "node:fs";
import path from "node:path";
import * as frida from "frida";
import { startBridge } from "./bridge";

import { platform } from "./platform";
import { parse_cli_options, CliOptions } from "./cli";
import { create_logger, Logger } from "./logger";

type StructOffsetConfig = {
    LaunchConfigOffsets: number[];
    RemoteDebugConfigOffsets: number[];
    SceneOffset: number;
    WebSocketURLStringOffset: number;
    RemoteDebugModeOffset: number;
}

type HookConfig = {
    Version: number;
    LoadStartHookOffset: string;
    CDPFilterHookOffset: string;
    CastToJsonHookOffset?: string;
    SceneOffsets?: number[];
    MiniAppConfigStructOffsets?: StructOffsetConfig;
};

const autoDetectConfig = async (
    session: frida.Session,
    projectRoot: string,
    wmpfVersion: number,
): Promise<HookConfig> => {
    let detectorContent: string;
    try {
        detectorContent = (
            await promises.readFile(
                path.join(
                    projectRoot,
                    "frida/autodetect",
                    `${process.platform}.js`,
                ),
            )
        ).toString();
    } catch (e) {
        throw new Error("[frida] auto-detect script not found");
    }

    const detector = await session.createScript(detectorContent);
    const detectedConfig = new Promise<Omit<HookConfig, "Version">>(
        (resolve, reject) => {
            detector.message.connect((message: frida.Message) => {
                if (message.type === "error") {
                    reject(
                        new Error(
                            `[frida] auto-detect failed: ${message.description}`,
                        ),
                    );
                    return;
                }

                const payload = message.payload as {
                    type?: string;
                    config?: Omit<HookConfig, "Version">;
                    error?: string;
                };
                if (payload.type === "wmpf-offsets" && payload.config) {
                    resolve(payload.config);
                } else if (payload.type === "wmpf-offsets-error") {
                    reject(
                        new Error(
                            `[frida] auto-detect failed: ${payload.error ?? "unknown error"}`,
                        ),
                    );
                }
            });
        },
    );

    try {
        await detector.load();
        return { Version: wmpfVersion, ...(await detectedConfig) };
    } finally {
        await detector.unload();
    }
};

const fridaServer = async (options: CliOptions, logger: Logger): Promise<{ session: frida.Session; script: frida.Script }> => {
    const localDevice = await frida.getLocalDevice();
    const { pid: wmpfPid, version: wmpfVersion } = await platform.findWmpfProcess()

    // attach to process
    const session = await localDevice.attach(wmpfPid);
    try {
        // find hook script
        const projectRoot = path.join(
            path.dirname(
                (require.main && require.main.filename) ||
                    (process.mainModule && process.mainModule.filename) ||
                    process.cwd(),
            ),
            "..",
        );
        let scriptContent: string | null = null;
        try {
            scriptContent = (
                await promises.readFile(path.join(projectRoot, "frida/hook.js"))
            ).toString();
        } catch (e) {
            throw new Error("[frida] hook script not found");
        }

        let configContent: string | null = null;
        if (options.autoDetect) {
            logger.info(`[frida] auto-detecting hook offsets...`);
            const config = await autoDetectConfig(session, projectRoot, wmpfVersion);
            configContent = JSON.stringify(config);
            logger.info(`[frida] detected hook offsets: ${configContent}`);
        } else {
            try {
                configContent = (
                    await promises.readFile(
                        path.join(
                            projectRoot,
                            `frida/config/${process.platform}`,
                            `addresses.${wmpfVersion}.json`,
                        ),
                    )
                ).toString();
                configContent = JSON.stringify(JSON.parse(configContent));
            } catch (e) {
                throw new Error(`[frida] version config not found: ${wmpfVersion}`);
            }
        }

        if (scriptContent === null || configContent === null) {
            throw new Error("[frida] unable to find hook script");
        }

        // load script
        const script = await session.createScript(
            scriptContent.replace("@@CONFIG@@", configContent).replace("ws://localhost:9421", `ws://127.0.0.1:${options.debugPort}`),
        );
        script.message.connect((message: frida.Message) => {
            if (message.type === "error") {
                logger.error("[frida client]", message);
                return;
            }

            logger.frida_debug("[frida client]", message.payload);
        });
        await script.load();
        logger.info(
            `[frida] script loaded, WMPF version: ${wmpfVersion}, pid: ${wmpfPid}`,
        );
        logger.info(`[frida] you can now open any miniapps`);
        return { session, script };
    } catch (error) {
        await session.detach();
        throw error;
    }
};

const main = async () => {
    const options = parse_cli_options();
    const logger = create_logger(options);
    const bridge = await startBridge(options, logger);
    let hook: { session: frida.Session; script: frida.Script };
    try { hook = await fridaServer(options, logger); }
    catch (error) { await bridge.close(); throw error; }
    let stopping = false;
    const shutdown = async () => {
        if (stopping) return;
        stopping = true;
        await bridge.close();
        await hook.script.unload();
        await hook.session.detach();
    };
    process.on("message", (message: any) => { if (message?.type === "wmpf-shutdown") void shutdown().then(() => process.exit(0)); });
    if (process.send) process.once("disconnect", () => { void shutdown().then(() => process.exit(0)); });
    process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
    process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
};
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
