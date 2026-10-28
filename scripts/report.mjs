// Builds report/ from the raw results of one run: markdown tables and SVG charts, computed
// again from the samples (never from numbers typed by hand), so the output is deterministic
// for a given results directory.
//
// Usage: node scripts/report.mjs results/<date> [report-dir]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const resultsDir = process.argv[2];
const reportDir = process.argv[3] ?? "report";
if (!resultsDir) {
	console.error("usage: node scripts/report.mjs results/<date> [report-dir]");
	process.exit(2);
}
mkdirSync(join(reportDir, "charts"), { recursive: true });

function pct(xs, p) {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const rank = Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length)));
	return s[rank - 1];
}
const dist = (xs) => ({ n: xs.length, p50: pct(xs, 50), p90: pct(xs, 90), p99: pct(xs, 99), max: xs.length ? Math.max(...xs) : null });
const fmt = (x, d = 2) => (x == null ? "-" : x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(d));
const trio = (d) => (d && d.n ? `${fmt(d.p50)} / ${fmt(d.p90)} / ${fmt(d.p99)}` : "-");

// Rivet: every scenario wrote <prefix>-<run>.ndjson next to a summary.
const rivetDir = join(resultsDir, "rivet");
const rivet = {};
if (existsSync(rivetDir)) {
	for (const f of readdirSync(rivetDir)) {
		if (!f.endsWith(".ndjson")) continue;
		const name = f.replace(/\.ndjson$/, "").replace(/^[a-z-]+?-(?=[a-z])/, "");
		const samples = readFileSync(join(rivetDir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
		const summaryFile = join(rivetDir, f.replace(/\.ndjson$/, ".summary.json"));
		const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, "utf8")) : null;
		rivet[summary?.meta?.prefix ?? name] = { samples, summary };
	}
}

// Picks Rivet samples of one kind from one run, successful only, restricted to real cold
// starts or wakes where the scenario defines them.
function rivetSamples(run, kind, extra = () => true) {
	const r = rivet[run];
	if (!r) return [];
	return r.samples.filter((s) => s.kind === kind && !s.error && extra(s));
}
const rivetWake = (run) => rivetSamples(run, "wake", (s) => s.cold === true && s.initAtMs > s.sendAtMs - s.idleMs);
const rivetCreate = (run) => rivetSamples(run, "create", (s) => s.cold === true);
const field = (xs, f) => xs.map((s) => s[f]).filter((x) => typeof x === "number");

// Cloudflare: one JSON per series with every sample; analytics-*.json carry Cloudflare's own
// Worker and in-DO wall-time quantiles per block window.
const cfDir = join(resultsDir, "cloudflare");
const cf = { samples: [], analytics: {}, meta: {} };
if (existsSync(cfDir)) {
	for (const f of readdirSync(cfDir)) {
		if (!f.endsWith(".json")) continue;
		const data = JSON.parse(readFileSync(join(cfDir, f), "utf8"));
		if (f.startsWith("analytics-")) {
			for (const [k, v] of Object.entries(data)) {
				const [, key, kind] = k.split("::");
				const file = basename(k.split("::")[0]);
				cf.analytics[`${file}::${key}::${kind}`] = v;
			}
		} else if (Array.isArray(data.samples)) {
			for (const s of data.samples) cf.samples.push({ ...s, file: f, label: data.meta.label });
			cf.meta[f] = data.meta;
		}
	}
}
function cfSamples(label, scenario, kind) {
	return cf.samples.filter((s) => s.label.startsWith(label) && s.scenario === scenario && s.kind === kind && !s.error && (kind === "cold" ? s.cold === true : kind === "warm" ? s.cold === false : true));
}
function cfAnalytics(label, scenario, kind) {
	const key = Object.keys(cf.analytics).find((k) => k.startsWith(`${label}-`) && k.endsWith(`::${scenario}::${kind}`));
	return key ? cf.analytics[key] : null;
}
// Baseline Worker round trip from the client, per file, to show the client's distance.
function cfNoop(label) {
	return dist(cf.samples.filter((s) => s.label.startsWith(label) && s.kind === "noop" && !s.error).map((s) => s.clientMs));
}

// Headline rows. Each row names what the two numbers are, so they are not mistaken for the
// same measurement when they are not.
const rows = [];
function row(metric, rivetXs, rivetWhat, cfXs, cfWhat, note = "") {
	rows.push({ metric, rivet: dist(rivetXs), rivetWhat, cf: dist(cfXs), cfWhat, note });
}
const cfIn = (label, scenario, kind) => cfSamples(label, scenario, kind).map((s) => s.ms);
const cfClient = (label, scenario, kind) => cfSamples(label, scenario, kind).map((s) => s.clientMs);

row("Actor create, first request answered (no storage)", field(rivetCreate("create"), "totalMs"), "client to reply, new keyed actor", cfIn("create", "name/raw", "cold"), "Worker to DO round trip, named id (unique id below)");
row("Actor create, unique id (DO only)", [], "", cfIn("create", "unique/raw", "cold"), "Worker to DO, newUniqueId");
row("Create, first request is a SQLite read", field(rivetCreate("create-first"), "totalMs"), "client to reply, SELECT on the new table", cfIn("create", "name/read", "cold"), "Worker to DO, SELECT in the first call");
row("Create, first request is a durable SQLite write", field(rivetCreate("create-write"), "totalMs"), "client to reply, INSERT then reply", cfIn("create", "name/write", "cold"), "Worker to DO, INSERT in the first call");
row("Actor wake, first request answered", field(rivetWake("wake"), "totalMs"), "client to reply, after at least 10 s asleep", cfIn("wake-w1-read", "wake/read", "cold"), "Worker to DO, after at least 10 min idle, first call reads one row");
row("Wake, first request is a SQLite read", field(rivetWake("wake-read"), "totalMs"), "client to reply, SELECT of the stored row", cfIn("wake-w1-read", "wake/read", "cold"), "Worker to DO, read");
row("Wake, first request is a durable SQLite write", field(rivetWake("wake-write"), "totalMs"), "client to reply, INSERT then reply", cfIn("wake-w2-write", "wake/write", "cold"), "Worker to DO, write");
row("Warm request round trip (no storage)", field(rivetSamples("warm", "warm"), "totalMs"), "client to reply, running actor (get)", cfIn("sql", "ping/1", "sql"), "Worker to DO, no-op call on a running DO");
row("Warm request round trip, getOrCreate", field(rivetSamples("warm-getorcreate", "warm"), "totalMs"), "client to reply, running actor (getOrCreate)", [], "");
row("SQLite point read, warm, in the actor", field(rivetSamples("sql-read", "read"), "sqlMs"), "SQL interval inside the actor", [], "in-DO wall time: see the Cloudflare analytics table");
row("SQLite point read, warm, round trip", field(rivetSamples("sql-read", "read"), "totalMs"), "client to reply", cfIn("sql", "point_read/1", "sql"), "Worker to DO");
row("SQLite durable write (1 row), in the actor", field(rivetSamples("sql-write-woken", "write"), "sqlMs"), "SQL interval inside the actor, autocommit, actor woken once", [], "in-DO wall time: see the Cloudflare analytics table");
row("SQLite durable write (1 row), round trip", field(rivetSamples("sql-write-woken", "write"), "totalMs"), "client to reply, actor woken once", cfIn("sql", "insert/1", "sql"), "Worker to DO, INSERT in one call");
row("SQLite scan of 1,000 rows, round trip", field(rivetSamples("sql-scan", "scan"), "totalMs"), "client to reply, 128 B rows", cfIn("sql", "scan/1000", "sql"), "Worker to DO, 256 B rows");

// Throughput rows.
const tput = [];
function rivetTput(run, metricKey) {
	const m = rivet[run]?.summary?.metrics?.[metricKey];
	return m ? { rate: m.createsPerSecond ?? m.commitsPerSecond, p50: m.totalMs?.p50, errors: m.errors, n: m.n } : null;
}
// Durable Object rates come from the Worker-timed duration of each call (the `ms` field), the
// same clock as the latency rows, so the client's internet round trip to Cloudflare is excluded.
// A closed loop of `concurrency` callers completes concurrency / mean duration calls per second
// (Little's law); scaling by the success fraction counts only successful calls.
function cfTput(label, scenario, concurrency) {
	const xs = cf.samples.filter((s) => s.label.startsWith(label) && s.scenario === scenario && s.kind !== "noop");
	const ok = xs.filter((s) => !s.error && (s.kind === "sql" || s.cold === true));
	if (!xs.length || !ok.length) return null;
	const meanMs = ok.reduce((sum, s) => sum + s.ms, 0) / ok.length;
	const rate = ((concurrency * 1000) / meanMs) * (ok.length / xs.length);
	return { rate, meanMs, p50: pct(ok.map((s) => s.ms), 50), errors: xs.filter((s) => s.error).length, n: xs.length };
}
for (const c of [1, 8, 32, 128]) {
	tput.push({ metric: `Burst creates at concurrency ${c}`, rivet: rivetTput("burst", `burst-c${c}`), cf: cfTput("burst", `burst/c${c}`, c) });
}
tput.push({ metric: "Sequential durable writes on one actor (woken once)", rivet: rivetTput("write-tput-woken", "sql-write"), cf: cfTput("seqwrite", "seqwrite/1", 1) });

// Markdown.
const md = [];
md.push(`# Results: ${basename(resultsDir)}`, "");
md.push("Generated by `scripts/report.mjs` from the raw samples in this directory. Latencies are milliseconds, p50 / p90 / p99, nearest rank over successful samples, no trimming. n is the number of successful samples that qualified (a create or wake sample qualifies only when the actor's own `cold` flag proves a fresh instance).", "");
md.push("## Latency", "");
md.push("| Metric | Rivet Actor | n | Rivet measures | Durable Object | n | DO measures |");
md.push("| --- | --- | ---: | --- | --- | ---: | --- |");
for (const r of rows) {
	md.push(`| ${r.metric} | **${trio(r.rivet)}** | ${r.rivet.n || "-"} | ${r.rivetWhat} | **${trio(r.cf)}** | ${r.cf.n || "-"} | ${r.cfWhat} |`);
}
md.push("", "## Throughput", "");
md.push("Rivet rates are successful requests over the wall time of the block, closed loop, measured on the runner VM inside the cluster. Durable Object rates use the Worker-timed duration of each call, like the latency rows, so the client's internet round trip to Cloudflare is excluded. A closed loop of c concurrent callers completes c / mean duration calls per second (Little's law), so a DO burst rate is c × 1000 / mean Worker ms and the sequential write rate is 1000 / mean Worker ms, scaled by the fraction of calls that succeeded. Rivet burst creates are held actors (no sleep), so no teardown overlaps the creates.", "");
md.push("| Metric | Rivet | Rivet p50 ms | errors | Durable Objects | DO p50 ms | errors |");
md.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const t of tput) {
	md.push(`| ${t.metric} | ${t.rivet ? `**${fmt(t.rivet.rate, 0)}/s**` : "-"} | ${t.rivet ? fmt(t.rivet.p50) : "-"} | ${t.rivet?.errors ?? "-"} | ${t.cf ? `**${fmt(t.cf.rate, 1)}/s**` : "-"} | ${t.cf ? fmt(t.cf.p50) : "-"} | ${t.cf?.errors ?? "-"} |`);
}

// Cloudflare's own clocks: Worker wall time and in-DO wall time per case.
md.push("", "## Cloudflare: Worker clock against Cloudflare's own wall times", "");
md.push("| Case | Worker clock p50 / p90 / p99 (n) | CF Worker wall p50 / p90 / p99 | CF in-DO wall p50 / p90 / p99 | client from Azure p50 (noop p50) |");
md.push("| --- | --- | --- | --- | --- |");
const cfCases = [
	["create", "name/raw", "cold"], ["create", "unique/raw", "cold"], ["create", "name/read", "cold"], ["create", "name/write", "cold"],
	["create", "name/raw", "warm"], ["wake-w1-read", "wake/read", "cold"], ["wake-w2-write", "wake/write", "cold"],
	["sql", "ping/1", "sql"], ["sql", "point_read/1", "sql"], ["sql", "scan/100", "sql"], ["sql", "scan/1000", "sql"], ["sql", "insert/1", "sql"],
];
const cfDetail = {};
for (const [label, scenario, kind] of cfCases) {
	const xs = cfSamples(label, scenario, kind);
	if (!xs.length) continue;
	const a = cfAnalytics(label, scenario, kind);
	const d = dist(xs.map((s) => s.ms));
	const c = dist(xs.map((s) => s.clientMs));
	const noop = cfNoop(label);
	const w = a?.worker ? `${fmt(a.worker.p50)} / ${fmt(a.worker.p90)} / ${fmt(a.worker.p99)}` : "-";
	const inDo = a?.do ? `${fmt(a.do.p50)} / ${fmt(a.do.p90)} / ${fmt(a.do.p99)}` : "-";
	cfDetail[`${scenario}/${kind}`] = { worker: d, client: c, cfWorker: a?.worker ?? null, cfDo: a?.do ?? null, colos: a?.doColos ?? null };
	md.push(`| ${scenario} ${kind} | ${trio(d)} (${d.n}) | ${w} | ${inDo} | ${fmt(c.p50)} (${fmt(noop.p50)}) |`);
}
const placements = Object.entries(cfDetail).filter(([, v]) => v.colos).map(([k, v]) => `${k}: ${Object.entries(v.colos).map(([c, n]) => `${c} ${n}`).join(", ")}`);
if (placements.length) md.push("", `DO placement by colo (from Cloudflare analytics): ${placements.join("; ")}.`);

// Rivet detail: in-actor intervals.
md.push("", "## Rivet: in-actor intervals", "");
md.push("| Case | client to reply p50 / p90 / p99 (n) | SQL interval in the actor | handler | notes |");
md.push("| --- | --- | --- | --- | --- |");
const rivetCases = [
	["create", rivetCreate("create"), "create, ping"], ["create-first", rivetCreate("create-first"), "create, first SELECT"], ["create-write", rivetCreate("create-write"), "create, first INSERT"],
	["wake", rivetWake("wake"), "wake 10 s, ping"], ["wake-read", rivetWake("wake-read"), "wake 10 s, first SELECT"], ["wake-write", rivetWake("wake-write"), "wake 10 s, first INSERT"], ["wake120", rivetWake("wake120"), "wake 120 s, ping"],
	["warm", rivetSamples("warm", "warm"), "warm ping (get)"], ["warm-getorcreate", rivetSamples("warm-getorcreate", "warm"), "warm ping (getOrCreate)"], ["sql-read", rivetSamples("sql-read", "read"), "warm point read"],
	["sql-write-woken", rivetSamples("sql-write-woken", "write"), "autocommit insert, actor woken once"],
	["write-tput-woken", rivetSamples("write-tput-woken", "write"), "5,000 sequential inserts, actor woken once"],
	["sql-scan", rivetSamples("sql-scan", "scan"), "1,000-row scan"],
];
const rivetDetail = {};
for (const [name, xs, desc] of rivetCases) {
	if (!xs.length) continue;
	const total = dist(field(xs, "totalMs"));
	const sql = dist(field(xs, "sqlMs"));
	const handler = dist(field(xs, "handlerMs"));
	const all = rivet[name];
	const errors = all ? all.samples.filter((s) => s.error && s.kind !== "setup").length : 0;
	rivetDetail[name] = { total, sql, handler, errors };
	const notes = errors ? `${errors} errors` : "";
	md.push(`| ${desc} | ${trio(total)} (${total.n}) | ${sql.n ? trio(sql) : "-"} | ${handler.n ? trio(handler) : "-"} | ${notes} |`);
}

const hold = rivet.hold?.summary;
if (hold?.memory) {
	md.push("", "## Rivet: memory per held actor", "");
	md.push("| Held actors | node RSS MiB | all three Engines RSS MiB | creates/s while growing | errors |");
	md.push("| ---: | ---: | ---: | ---: | ---: |");
	for (const m of hold.memory) md.push(`| ${m.actors.toLocaleString("en-US")} | ${fmt(m.nodeRssKiB / 1024, 0)} | ${fmt(m.storageRssTotalKiB / 1024, 0)} | ${m.createsPerSecond ?? "-"} | ${m.errors} |`);
	md.push("", `Per held actor from ${hold.metrics.memory.from.toLocaleString("en-US")} to ${hold.metrics.memory.to.toLocaleString("en-US")}: **${fmt(hold.metrics.memory.perActorNodeKiB, 0)} KiB on the node, ${fmt(hold.metrics.memory.perActorEnginesKiB, 0)} KiB across the Engines**. Cloudflare does not publish per-object memory; idle Durable Objects are evicted after about ten seconds and are billed per request and per GB-s of storage, not per idle object.`);
	rivetDetail.memory = hold.metrics.memory;
}

// Charts: one horizontal bar chart per group, log scale, p50 with a p99 whisker.
function chart(name, title, items) {
	const width = 760;
	const rowH = 34;
	const left = 300;
	const height = 60 + items.length * rowH;
	const values = items.flatMap((i) => [i.p50, i.p99]).filter((x) => x != null && x > 0);
	if (!values.length) return;
	const lo = Math.pow(10, Math.floor(Math.log10(Math.min(...values))));
	const hi = Math.pow(10, Math.ceil(Math.log10(Math.max(...values))));
	const x = (v) => left + ((Math.log10(v) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo))) * (width - left - 20);
	const parts = [];
	parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, sans-serif" font-size="12">`);
	parts.push(`<rect width="${width}" height="${height}" fill="#ffffff"/>`);
	parts.push(`<text x="12" y="22" font-size="14" font-weight="600" fill="#1b1916">${title}</text>`);
	for (let t = lo; t <= hi; t *= 10) {
		parts.push(`<line x1="${x(t).toFixed(1)}" y1="36" x2="${x(t).toFixed(1)}" y2="${height - 20}" stroke="#e6e3dc"/>`);
		parts.push(`<text x="${x(t).toFixed(1)}" y="${height - 6}" text-anchor="middle" fill="#8a8478">${t} ms</text>`);
	}
	items.forEach((it, i) => {
		const y = 44 + i * rowH;
		const color = it.system === "Rivet" ? "#b74b23" : "#4a6fa5";
		parts.push(`<text x="${left - 8}" y="${y + 13}" text-anchor="end" fill="#1b1916">${it.label}</text>`);
		if (it.p50 != null) {
			parts.push(`<rect x="${left}" y="${y}" width="${Math.max(1, x(it.p50) - left).toFixed(1)}" height="18" fill="${color}" rx="3"/>`);
			if (it.p99 != null) parts.push(`<line x1="${x(it.p50).toFixed(1)}" y1="${y + 9}" x2="${x(it.p99).toFixed(1)}" y2="${y + 9}" stroke="${color}" stroke-width="2" stroke-dasharray="3 3"/>`);
			parts.push(`<text x="${(x(Math.max(it.p50, it.p99 ?? it.p50)) + 6).toFixed(1)}" y="${y + 13}" fill="#1b1916">${fmt(it.p50)} ms (p99 ${fmt(it.p99)})</text>`);
		} else {
			parts.push(`<text x="${left + 4}" y="${y + 13}" fill="#8a8478">not measured</text>`);
		}
	});
	parts.push(`<rect x="12" y="${height - 50}" width="10" height="10" fill="#b74b23"/><text x="26" y="${height - 41}" fill="#1b1916">Rivet Actor</text>`);
	parts.push(`<rect x="110" y="${height - 50}" width="10" height="10" fill="#4a6fa5"/><text x="124" y="${height - 41}" fill="#1b1916">Durable Object</text>`);
	parts.push(`<text x="230" y="${height - 41}" fill="#8a8478">bar: p50, dashed whisker: to p99, log scale</text>`);
	parts.push("</svg>");
	writeFileSync(join(reportDir, "charts", `${name}.svg`), parts.join("\n"));
	md.push("", `![${title}](charts/${name}.svg)`);
}
md.push("", "## Charts");
const lifecycleRows = rows.filter((r) => /^(Actor create, first|Create,|Actor wake|Wake,|Warm request round trip \(no)/.test(r.metric));
const sqliteRows = rows.filter((r) => /SQLite .*round trip$|SQLite scan/.test(r.metric));
chart("lifecycle", "Create and wake, first request answered (ms, log scale)", lifecycleRows.flatMap((r) => [
	{ label: `${r.metric.slice(0, 44)} (Rivet)`, system: "Rivet", p50: r.rivet.p50, p99: r.rivet.p99 },
	{ label: `${r.metric.slice(0, 44)} (DO)`, system: "DO", p50: r.cf.p50, p99: r.cf.p99 },
]).filter((i) => i.p50 != null));
chart("sqlite", "SQLite round trips (ms, log scale)", sqliteRows.flatMap((r) => [
	{ label: `${r.metric.slice(0, 44)} (Rivet)`, system: "Rivet", p50: r.rivet.p50, p99: r.rivet.p99 },
	{ label: `${r.metric.slice(0, 44)} (DO)`, system: "DO", p50: r.cf.p50, p99: r.cf.p99 },
]).filter((i) => i.p50 != null));

writeFileSync(join(reportDir, "results.md"), `${md.join("\n")}\n`);
writeFileSync(join(reportDir, "summary.json"), `${JSON.stringify({ resultsDir, rows, tput, cfDetail, rivetDetail }, null, 2)}\n`);
console.log(`wrote ${join(reportDir, "results.md")}`);
