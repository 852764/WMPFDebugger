import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";

async function main() {
    const { server, session } = createMcpServer();
    const transport = new StdioServerTransport();
    let closing = false;
    const shutdown = async () => {
        if (closing) return;
        closing = true;
        await session.close();
        await server.close();
    };
    process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
    process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
    process.stdin.once("end", () => { void shutdown(); });
    await server.connect(transport);
    // stdout is reserved for MCP JSON-RPC.
    console.error("[wmpf-mcp] ready; use miniapp_targets after opening a hooked mini-program");
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
