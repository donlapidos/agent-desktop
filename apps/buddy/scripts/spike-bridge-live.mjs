// Spike: call the running Buddy through buddy-mcp the way Claude does (read-only tools only).
//   node scripts/spike-bridge-live.mjs <electron.exe> <src/mcp-server.js>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [electron, helper] = process.argv.slice(2);
const client = new Client({ name: "live-check", version: "1" });
await client.connect(new StdioClientTransport({ command: electron, args: [helper], env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }));
let t = Date.now();
const wins = await client.callTool({ name: "list_windows", arguments: {} });
console.log(`list_windows ${Date.now() - t}ms\n` + wins.content[0].text.split("\n").slice(0, 6).join("\n"));
t = Date.now();
const look = await client.callTool({ name: "look", arguments: { app: "EXCEL.EXE", skeleton: true } });
console.log(`look ${Date.now() - t}ms: ` + look.content[0].text.split("\n").slice(0, 4).join(" | "));
await client.close();
