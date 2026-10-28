// Queries Cloudflare's GraphQL Analytics API for the block windows of one or more results files
// and prints Worker and DO invocation wall-time quantiles (converted from microseconds to ms)
// per scenario and kind (noop, cold, warm, sql), plus the DO placement colos per scenario.
// The API has a small request budget, so every window goes into as few aliased requests as
// possible, one request per results file.
//
// Usage: node analytics.mjs results/<file>.json [results/<file2>.json ...]
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename } from "node:path";

const ACCOUNT = process.env.CF_ACCOUNT_ID;
if (!ACCOUNT) {
	console.error("CF_ACCOUNT_ID is required (see `wrangler whoami`)");
	process.exit(2);
}
const SCRIPT = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "")).name;
const RESULTS = process.env.RESULTS_DIR ?? "results";

function token() {
	const cfg = readFileSync(`${homedir()}/.config/.wrangler/config/default.toml`, "utf8");
	return /^oauth_token\s*=\s*"([^"]+)"/m.exec(cfg)[1];
}

// Windows are widened to whole seconds; blocks are separated by more than two seconds.
const floorSec = (iso) => iso.replace(/\.\d+Z$/, "Z");
const ceilSec = (iso) => new Date(Math.ceil(Date.parse(iso) / 1000) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
const rangeFilter = (ws) => `{ OR: [${ws.map((w) => `{ datetime_geq: "${floorSec(w.startedAt)}", datetime_leq: "${ceilSec(w.endedAt)}" }`).join(", ")}] }`;

const Q = "wallTimeP50 wallTimeP90 wallTimeP99";
const ms = (us) => (us == null ? null : Math.round(us / 10) / 100);
const out = {};
for (const file of process.argv.slice(2)) {
	const data = JSON.parse(readFileSync(file, "utf8"));
	const parts = [];
	const index = [];
	const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
	for (const [key, s] of Object.entries(data.scenarios)) {
		if (only && !only.includes(key)) continue;
		const blocks = s.blocks ?? { mixed: [{ startedAt: s.startedAt, endedAt: s.endedAt }] };
		for (const [kind, ws] of Object.entries(blocks)) {
			const alias = `a${index.length}`;
			index.push({ key, kind, alias });
			const filter = `{ AND: [{ scriptName: "${SCRIPT}" }, ${rangeFilter(ws)}] }`;
			parts.push(`
	${alias}_w: workersInvocationsAdaptive(limit: 10, filter: ${filter}) { dimensions { status } sum { requests } quantiles { ${Q} cpuTimeP50 } }
	${alias}_d: durableObjectsInvocationsAdaptiveGroups(limit: 10, filter: ${filter}) { dimensions { status } sum { requests } quantiles { ${Q} cpuTimeP50 } }`);
			if (kind === "cold" || kind === "sql" || kind === "mixed") {
				parts.push(`
	${alias}_c: durableObjectsInvocationsAdaptiveGroups(limit: 20, filter: ${filter}) { dimensions { coloCode } sum { requests } }`);
			}
		}
	}
	const query = `{ viewer { accounts(filter: { accountTag: "${ACCOUNT}" }) { ${parts.join("\n")} } } }`;
	const res = await fetch("https://api.cloudflare.com/client/v4/graphql", {
		method: "POST",
		headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
		body: JSON.stringify({ query }),
	});
	const json = await res.json();
	if (json.errors) {
		console.error(file, JSON.stringify(json.errors, null, 1).slice(0, 2000));
		continue;
	}
	const acct = json.data.viewer.accounts[0];
	const pick = (rows) =>
		rows
			.filter((r) => r.dimensions.status === "success")
			.map((r) => ({ n: r.sum.requests, p50: ms(r.quantiles.wallTimeP50), p90: ms(r.quantiles.wallTimeP90), p99: ms(r.quantiles.wallTimeP99), cpuP50: ms(r.quantiles.cpuTimeP50) }))[0] ?? null;
	const errs = (rows) => rows.filter((r) => r.dimensions.status !== "success").map((r) => `${r.dimensions.status}:${r.sum.requests}`).join(",");
	console.log(`\n### ${file}`);
	for (const { key, kind, alias } of index) {
		const rec = { worker: pick(acct[`${alias}_w`]), workerOther: errs(acct[`${alias}_w`]), do: pick(acct[`${alias}_d`]), doOther: errs(acct[`${alias}_d`]) };
		if (acct[`${alias}_c`]) rec.doColos = Object.fromEntries(acct[`${alias}_c`].map((r) => [r.dimensions.coloCode, r.sum.requests]));
		// Keyed by the file name only, so the output carries no local paths.
		out[`${basename(file)}::${key}::${kind}`] = rec;
		const f = (o) => (o ? `n=${o.n} p50=${o.p50} p90=${o.p90} p99=${o.p99}` : "-");
		console.log(`${key.padEnd(14)} ${kind.padEnd(5)} worker[${f(rec.worker)}${rec.workerOther ? " " + rec.workerOther : ""}]  do[${f(rec.do)}${rec.doOther ? " " + rec.doOther : ""}]  ${rec.doColos ? JSON.stringify(rec.doColos) : ""}`);
	}
}
const outFile = `${RESULTS}/analytics-${Date.now()}.json`;
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log("saved", outFile);
