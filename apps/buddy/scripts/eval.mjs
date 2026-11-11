// Runs Buddy's model check (src/evals.js) from the command line, for comparing providers and models.
//   npm run eval -- --provider openai --model gpt-6.1-sol
//   npm run eval -- --provider ollama --model qwen3:8b
//   npm run eval -- --provider custom --base-url https://llm.example.com/v1 --model m --cases excel-sort,word-pdf
// The key comes from the provider's usual variable (OPENAI_API_KEY, ANTHROPIC_API_KEY, ...) or BUDDY_EVAL_KEY.
// Each case is a few model calls on that account. --json writes the full results, tool calls included.
import fs from "node:fs";
import { parseArgs } from "node:util";
import { setBrainDefaults } from "../src/brain.js";
import { CASES, runEvals } from "../src/evals.js";
import { PROVIDERS } from "../src/providers.js";

const { values: o } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    "base-url": { type: "string" },
    effort: { type: "string", default: "low" },
    cases: { type: "string" },
    json: { type: "string" },
  },
});
const provider = /** @type {import("../src/providers.js").ProviderId} */ (o.provider);
if (!provider || !PROVIDERS[provider] || !o.model) {
  console.error(`Usage: npm run eval -- --provider <${Object.keys(PROVIDERS).join("|")}> --model <id> [--base-url <url>] [--effort low|medium|high] [--cases ${CASES.map((c) => c.id).join(",")}] [--json out.json]`);
  process.exit(2);
}
const apiKey = process.env.BUDDY_EVAL_KEY ?? process.env[PROVIDERS[provider].keyEnv ?? ""] ?? "";
if (PROVIDERS[provider].key === "required" && !apiKey) {
  console.error(`Set ${PROVIDERS[provider].keyEnv} (or BUDDY_EVAL_KEY) to a ${PROVIDERS[provider].label} key.`);
  process.exit(2);
}
const wanted = o.cases ? o.cases.split(",") : null;
const cases = wanted ? CASES.filter((c) => wanted.includes(c.id)) : CASES;

setBrainDefaults({ model: provider === "anthropic" ? o.model : "claude-opus-5-5", effort: o.effort ?? "low", providerModels: { [provider]: o.model } });
console.log(`${PROVIDERS[provider].label} · ${o.model} · ${cases.length} case(s)\n`);
const run = await runEvals({
  provider,
  apiKey,
  baseURL: o["base-url"] ?? PROVIDERS[provider].baseURL,
  cases,
  onCase: (r, i, n) => console.log(`${r.passed ? "PASS" : "FAIL"}  ${String(i + 1).padStart(2)}/${n}  ${r.title.padEnd(44)} ${(r.ms / 1000).toFixed(1).padStart(5)} s  ${r.turns} turn(s)${r.problem ? `\n      ${r.problem}\n      reply: ${r.reply.replace(/\s+/g, " ").slice(0, 160)}` : ""}`),
});
console.log(`\n${run.passed}/${run.total} passed · ${(run.avgMs / 1000).toFixed(1)} s per case on average`);
if (o.json) fs.writeFileSync(o.json, JSON.stringify({ provider, model: o.model, at: new Date().toISOString(), ...run }, null, 2));
process.exit(run.passed === run.total ? 0 : 1);
