// Drives the deployed bench Worker, one DO call per HTTP request, and records three clocks per
// sample: the client's (performance.now around the fetch), the Worker's (Date.now around the DO
// call, returned in the body), and Cloudflare's own per-invocation wall time from `wrangler tail`
// for both the Worker invocation and the DO invocation.
//
// Each scenario runs in blocks, one kind of call per block (noop, cold, warm or sql), with a gap
// between blocks, so Cloudflare's analytics windows (analytics.mjs) hold one population each.
//
// Usage:
//   node run.mjs create [perScenario]        create cold start matrix, name|unique x raw|read|write
//   node run.mjs prepare <run> <count>       create named DOs for a later wake run
//   node run.mjs wake <run> <op>             wake the DOs of <run> with op read|write
//   node run.mjs sql [perCase]               warm SQLite cases on one seeded DO
//   node run.mjs burst [per] [c1,c2,...]     named-DO creates at each concurrency, creates/s
//   node run.mjs seqwrite [n]                sequential 1-row inserts on one DO, commits/s
//   node run.mjs clock                       show the frozen Worker clock
//   node run.mjs where <results.json> [per]  ask a sample of DOs from a run where they live
//   node run.mjs tail <out.json> <seconds>   collect tail events for a run driven elsewhere
//   node run.mjs join <results.json> <tail>  join a collected tail onto a NO_TAIL run
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SCRIPT = JSON.parse(readFileSync(new URL("./wrangler.jsonc", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "")).name;
const BASE = process.env.BENCH_URL;
if (!BASE) {
	console.error("BENCH_URL is required (the deployed Worker's URL, printed by wrangler deploy)");
	process.exit(2);
}
const RESULTS = process.env.RESULTS_DIR ?? "results";
const CHUNK = 50;
const BLOCK_GAP_MS = 2500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path) {
	const r = await fetch(BASE + path);
	if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
	return r.json();
}

// One timed request. `clientMs` is wall time around fetch and body read on a kept-alive
// connection; `at` is the client's epoch ms at send time, used to place tail events.
let seq = 0;
async function sample(path, extra = {}) {
	const t = `${Date.now().toString(36)}-${(seq++).toString(36)}`;
	const sep = path.includes("?") ? "&" : "?";
	const at = Date.now();
	const start = performance.now();
	try {
		const body = await get(`${path}${sep}t=${t}`);
		const clientMs = performance.now() - start;
		return { t, at, clientMs, ...body, ...extra };
	} catch (err) {
		// A transient Worker or DO failure is a data point, not a reason to lose the run.
		const clientMs = performance.now() - start;
		const message = String(err.message ?? err).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 300);
		console.log(`sample error: ${message}`);
		return { t, at, clientMs, error: message, ...extra };
	}
}

const pct = (xs, p) => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const round = (x) => (x == null ? null : Math.round(x * 100) / 100);
const summary = (xs) => ({
	n: xs.length,
	p50: round(pct(xs, 50)),
	p90: round(pct(xs, 90)),
	p99: round(pct(xs, 99)),
	max: xs.length ? round(Math.max(...xs)) : null,
});

// Tail collector: wrangler prints one pretty-printed JSON object per event, closed by a line
// that is exactly "}".
function startTail() {
	// On a remote client without wrangler, collect the tail elsewhere (`node run.mjs tail`) and
	// join it later (`node run.mjs join`).
	if (process.env.NO_TAIL) {
		return { events: [], async stop() { return { events: [], stderr: "no tail (NO_TAIL set)" }; } };
	}
	const child = spawn("pnpm", ["exec", "wrangler", "tail", SCRIPT, "--format", "json"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const events = [];
	let buf = "";
	child.stdout.on("data", (chunk) => {
		buf += chunk.toString();
		let idx;
		while ((idx = buf.indexOf("\n}\n")) !== -1) {
			const text = buf.slice(0, idx + 2);
			buf = buf.slice(idx + 3);
			try {
				events.push(JSON.parse(text));
			} catch {
				// A partial or non-event line; skip it.
			}
		}
	});
	let stderr = "";
	child.stderr.on("data", (c) => (stderr += c.toString()));
	return {
		events,
		async stop() {
			await sleep(6000);
			child.kill("SIGINT");
			await sleep(500);
			return { events, stderr };
		},
	};
}

// Join tail events onto samples. Worker events match by the unique t= in the URL. DO events
// match by DO id and by how close the event's start is to where the DO call should sit inside
// the sample's window (the DO runs in the middle of the Worker's await); each event is used once.
// The tail drops events under load, so coverage is partial, and dropped events skew fast, so
// only per-sample comparisons are valid, not distributions of the matched subset.
function joinTail(samples, events) {
	const workerByT = new Map();
	const doById = new Map();
	for (const e of events) {
		if (e.executionModel === "stateless") {
			const m = /[?&]t=([^&]+)/.exec(e.event?.request?.url ?? "");
			if (m) workerByT.set(m[1], e);
		} else if (e.executionModel === "durableObject") {
			if (!doById.has(e.durableObjectId)) doById.set(e.durableObjectId, []);
			doById.get(e.durableObjectId).push(e);
		}
	}
	for (const s of samples) {
		for (const k of ["cfWorkerMs", "cfWorkerCpuMs", "cfOutcome", "cfDoMs", "cfDoCpuMs", "cfDoResidualMs", "cfDoAmbiguous"]) delete s[k];
	}
	// Client clock against Cloudflare's, estimated from Worker events sitting mid-request.
	const skews = [];
	for (const s of samples) {
		const w = workerByT.get(s.t);
		if (!w) continue;
		s.cfWorkerMs = w.wallTime;
		s.cfWorkerCpuMs = w.cpuTime;
		s.cfOutcome = w.outcome;
		skews.push(w.eventTimestamp - (s.at + (s.clientMs - w.wallTime) / 2));
	}
	const skew = pct(skews, 50) ?? 0;
	const expectedStart = (s, wall) => s.at + skew + (s.clientMs - (s.ms ?? 0)) / 2 + ((s.ms ?? 0) - wall) / 2;
	const byId = new Map();
	for (const s of samples) {
		if (!s.id || s.error) continue;
		if (!byId.has(s.id)) byId.set(s.id, []);
		byId.get(s.id).push(s);
	}
	for (const [id, ss] of byId) {
		const evs = doById.get(id) ?? [];
		const pairs = [];
		for (const e of evs) for (const s of ss) pairs.push({ e, s, r: Math.abs(e.eventTimestamp - expectedStart(s, e.wallTime)) });
		pairs.sort((a, b) => a.r - b.r);
		const usedE = new Set();
		const usedS = new Set();
		for (const p of pairs) {
			if (p.r > 150 || usedE.has(p.e) || usedS.has(p.s)) continue;
			usedE.add(p.e);
			usedS.add(p.s);
			p.s.cfDoMs = p.e.wallTime;
			p.s.cfDoCpuMs = p.e.cpuTime;
			p.s.cfDoResidualMs = Math.round(p.r);
		}
	}
	return { skew, skewN: skews.length };
}

function summarize(samples) {
	const by = (kind, field, pred = () => true) =>
		samples.filter((s) => s.kind === kind && s[field] != null && pred(s)).map((s) => s[field]);
	const coldOnly = (s) => s.cold === true;
	const out = {};
	for (const kind of ["cold", "warm", "noop", "sql"]) {
		if (!samples.some((s) => s.kind === kind)) continue;
		const pred = kind === "cold" ? coldOnly : () => true;
		out[kind] = {
			worker: summary(by(kind, "ms", pred)),
			client: summary(by(kind, "clientMs", pred)),
			cfWorker: summary(by(kind, "cfWorkerMs", pred)),
			cfDo: summary(by(kind, "cfDoMs", pred)),
			cfDoCpu: summary(by(kind, "cfDoCpuMs", pred)),
		};
	}
	out.errors = samples.filter((s) => s.error).length;
	out.notCold = samples.filter((s) => s.kind === "cold" && s.cold === false).length;
	out.warmNotWarm = samples.filter((s) => s.kind === "warm" && s.cold === true).length;
	out.tailWorkerMatched = samples.filter((s) => s.kind !== "noop" && s.cfWorkerMs != null).length;
	out.tailDoMatched = samples.filter((s) => s.kind !== "noop" && s.cfDoMs != null).length;
	out.calls = samples.filter((s) => s.kind !== "noop" && !s.error).length;
	return out;
}

function printScenario(key, s) {
	const fmt = (o) => (o && o.n ? `n=${o.n} p50=${o.p50} p90=${o.p90} p99=${o.p99} max=${o.max}` : "-");
	console.log(`== ${key}  (errors=${s.errors}, notCold=${s.notCold}, warmNotWarm=${s.warmNotWarm}, tail worker ${s.tailWorkerMatched}/${s.calls}, tail do ${s.tailDoMatched}/${s.calls})`);
	for (const kind of ["cold", "warm", "sql", "noop"]) {
		if (!s[kind]) continue;
		for (const src of ["worker", "cfWorker", "cfDo", "client"]) {
			if (kind === "noop" && src !== "client") continue;
			console.log(`   ${kind.padEnd(5)} ${src.padEnd(9)} ${fmt(s[kind][src])}`);
		}
	}
}

// Runs one block of calls and records its time window.
async function block(windows, kind, fn) {
	const startedAt = new Date().toISOString();
	await fn();
	const endedAt = new Date().toISOString();
	(windows[kind] ??= []).push({ startedAt, endedAt });
	await sleep(BLOCK_GAP_MS);
}

// A scenario of `count` cold calls plus a warm follow-up on each, in alternating cold and warm
// blocks of CHUNK, after one block of `noops` baseline calls.
async function coldWarmScenario({ noops, count, cold, warm }) {
	const out = [];
	const windows = {};
	await block(windows, "noop", async () => {
		for (let i = 0; i < noops; i++) out.push(await sample("/noop", { kind: "noop" }));
	});
	let done = 0;
	while (done < count) {
		const batch = [];
		await block(windows, "cold", async () => {
			for (let i = 0; i < CHUNK && done < count; i++) {
				const c = await cold();
				out.push(c);
				if (c.error) continue;
				if (c.cold) done++;
				batch.push(c);
			}
		});
		await block(windows, "warm", async () => {
			for (const c of batch) out.push(await warm(c));
		});
	}
	return { out, windows };
}

async function runScenarios(label, scenarios, meta = {}) {
	await get("/noop");
	const tail = startTail();
	await sleep(8000);
	const allSamples = [];
	const windows = {};
	let colo;
	mkdirSync(RESULTS, { recursive: true });
	const file = `${RESULTS}/${label}-${Date.now()}.json`;
	const partial = () => writeFileSync(file, JSON.stringify({ meta: { ...meta, label, base: BASE, workerColo: colo, partial: true }, scenarios: windows, samples: allSamples }, null, 1));
	for (const [key, run] of scenarios) {
		const startedAt = new Date().toISOString();
		const { out: samples, windows: blocks } = await run();
		const endedAt = new Date().toISOString();
		colo = samples.find((s) => s.colo)?.colo ?? colo;
		for (const s of samples) s.scenario = key;
		allSamples.push(...samples);
		windows[key] = { startedAt, endedAt, blocks };
		console.log(`${key}: ${samples.length} samples, ${startedAt} .. ${endedAt}`);
		partial();
	}
	const { events, stderr } = await tail.stop();
	const { skew, skewN } = joinTail(allSamples, events);
	const tailExceptions = events
		.filter((e) => e.outcome !== "ok")
		.map((e) => ({ at: e.eventTimestamp, model: e.executionModel, outcome: e.outcome, url: e.event?.request?.url ?? null, exceptions: e.exceptions }));
	const result = {
		meta: { ...meta, label, base: BASE, workerColo: colo, tailEvents: events.length, tailSkewMs: skew, tailSkewN: skewN, tailStderr: stderr.slice(-500), tailExceptions },
		scenarios: {},
		samples: allSamples,
		tail: events,
	};
	for (const key of Object.keys(windows)) {
		const s = summarize(allSamples.filter((x) => x.scenario === key));
		result.scenarios[key] = { ...windows[key], ...s };
		printScenario(key, result.scenarios[key]);
	}
	writeFileSync(file, JSON.stringify(result, null, 1));
	console.log("saved", file, "tail exceptions", tailExceptions.length, "skew", Math.round(skew), "ms");
	return result;
}

const [cmd, a1, a2] = process.argv.slice(2);

if (cmd === "create") {
	const per = Number(a1 ?? 200);
	const scenarios = [];
	for (const mode of ["name", "unique"]) {
		for (const op of ["raw", "read", "write"]) {
			scenarios.push([
				`${mode}/${op}`,
				() =>
					coldWarmScenario({
						noops: 100,
						count: per,
						cold: () => sample(`/one?mode=${mode}&op=${op}`, { kind: "cold" }),
						warm: (c) => sample(`/one?op=${op}&id=${c.id}`, { kind: "warm" }),
					}),
			]);
		}
	}
	await runScenarios("create", scenarios, { per });
} else if (cmd === "prepare") {
	const names = [];
	while (names.length < Number(a2)) {
		names.push(...(await get(`/prepare?run=${a1}-${names.length}&n=20`)).names);
	}
	mkdirSync(RESULTS, { recursive: true });
	writeFileSync(`${RESULTS}/wake-${a1}.json`, JSON.stringify({ preparedAt: Date.now(), names }));
	console.log("prepared", names.length);
} else if (cmd === "wake") {
	const { preparedAt, names } = JSON.parse(readFileSync(`${RESULTS}/wake-${a1}.json`, "utf8"));
	const op = a2 ?? "read";
	const idleSec = Math.round((Date.now() - preparedAt) / 1000);
	console.log(`wake ${a1} op=${op}, idle ${idleSec}s since prepare`);
	let next = 0;
	await runScenarios(
		`wake-${a1}-${op}`,
		[
			[
				`wake/${op}`,
				() =>
					coldWarmScenario({
						noops: 100,
						count: names.length,
						cold: () => sample(`/one?op=${op}&name=${names[next++]}`, { kind: "cold" }),
						warm: (c) => sample(`/one?op=${op}&id=${c.id}`, { kind: "warm" }),
					}),
			],
		],
		{ preparedAt, idleSec, op },
	);
} else if (cmd === "sql") {
	const per = Number(a1 ?? 300);
	const name = `sql-${Date.now()}`;
	const seeded = await get(`/seed?name=${name}&rows=1000&bytes=256`);
	console.log("seeded", seeded);
	await get(`/sql1?name=${name}&kind=ping`);
	const cases = [["ping", 1], ["point_read", 1], ["scan", 100], ["scan", 1000], ["insert", 1]];
	const scenarios = cases.map(([kind, size]) => [
		`${kind}/${size}`,
		async () => {
			const out = [];
			const windows = {};
			await block(windows, "noop", async () => {
				for (let i = 0; i < 100; i++) out.push(await sample("/noop", { kind: "noop" }));
			});
			await block(windows, "sql", async () => {
				for (let i = 0; i < per; i++) out.push(await sample(`/sql1?name=${name}&kind=${kind}&size=${size}`, { kind: "sql" }));
			});
			return { out, windows };
		},
	]);
	await runScenarios("sql", scenarios, { per, name, seeded });
} else if (cmd === "tail") {
	const tail = startTail();
	console.log("tail started, collecting for", a2, "s");
	await sleep(Number(a2) * 1000);
	const { events, stderr } = await tail.stop();
	writeFileSync(a1, JSON.stringify({ events, stderr }));
	console.log("saved", a1, "events", events.length);
} else if (cmd === "join") {
	const data = JSON.parse(readFileSync(a1, "utf8"));
	const { events } = JSON.parse(readFileSync(a2, "utf8"));
	const { skew, skewN } = joinTail(data.samples, events);
	data.meta.tailEvents = events.length;
	data.meta.tailSkewMs = skew;
	data.meta.tailSkewN = skewN;
	data.meta.tailFile = a2;
	data.meta.tailExceptions = events
		.filter((e) => e.outcome !== "ok")
		.map((e) => ({ at: e.eventTimestamp, model: e.executionModel, outcome: e.outcome, url: e.event?.request?.url ?? null, exceptions: e.exceptions }));
	data.tail = events;
	for (const key of Object.keys(data.scenarios)) {
		const { startedAt, endedAt, blocks } = data.scenarios[key];
		data.scenarios[key] = { startedAt, endedAt, blocks, ...summarize(data.samples.filter((x) => x.scenario === key)) };
		printScenario(key, data.scenarios[key]);
	}
	writeFileSync(a1, JSON.stringify(data, null, 1));
	console.log("updated", a1, "skew", Math.round(skew), "ms");
} else if (cmd === "burst") {
	// Creates of named DOs at each concurrency level, with no gap, to show creates per second
	// as the load grows. Every sample is a cold create (checked by the DO's `cold` flag).
	const per = Number(a1 ?? 500);
	const levels = (a2 ?? "1,8,32,128").split(",").map(Number);
	const scenarios = levels.map((c) => [
		`burst/c${c}`,
		async () => {
			const out = [];
			const windows = {};
			await block(windows, "cold", async () => {
				let next = 0;
				const worker = async () => {
					while (next < per) {
						next++;
						out.push(await sample("/one?mode=name&op=raw", { kind: "cold", concurrency: c }));
					}
				};
				await Promise.all(Array.from({ length: c }, worker));
			});
			const w = windows.cold[0];
			const ok = out.filter((s) => !s.error && s.cold);
			const elapsedS = (Date.parse(w.endedAt) - Date.parse(w.startedAt)) / 1000;
			console.log(`burst C${c}: ${ok.length} creates in ${elapsedS.toFixed(1)} s = ${(ok.length / elapsedS).toFixed(1)}/s, errors ${out.filter((s) => s.error).length}`);
			return { out, windows };
		},
	]);
	await runScenarios("burst", scenarios, { per, levels });
} else if (cmd === "seqwrite") {
	// Sequential durable inserts on one DO: commits per second for one object.
	const n = Number(a1 ?? 2000);
	const name = `seqwrite-${Date.now()}`;
	await get(`/seed?name=${name}&rows=1&bytes=256`);
	for (let i = 0; i < 50; i++) await get(`/sql1?name=${name}&kind=insert&size=1`);
	await runScenarios(
		"seqwrite",
		[
			[
				"seqwrite/1",
				async () => {
					const out = [];
					const windows = {};
					await block(windows, "sql", async () => {
						for (let i = 0; i < n; i++) out.push(await sample(`/sql1?name=${name}&kind=insert&size=1`, { kind: "sql" }));
					});
					const w = windows.sql[0];
					const elapsedS = (Date.parse(w.endedAt) - Date.parse(w.startedAt)) / 1000;
					console.log(`seqwrite: ${out.filter((s) => !s.error).length} inserts in ${elapsedS.toFixed(1)} s = ${(out.filter((s) => !s.error).length / elapsedS).toFixed(1)}/s`);
					return { out, windows };
				},
			],
		],
		{ n, name },
	);
} else if (cmd === "clock") {
	for (let i = 0; i < 5; i++) console.log(await get("/clock"));
} else if (cmd === "where") {
	const data = JSON.parse(readFileSync(a1, "utf8"));
	const per = Number(a2 ?? 10);
	const out = {};
	for (const key of Object.keys(data.scenarios)) {
		const ids = [...new Set(data.samples.filter((s) => s.scenario === key && s.kind !== "noop" && s.id).map((s) => s.id))].slice(0, per);
		const colos = {};
		for (const id of ids) {
			const r = await get(`/where?id=${id}`);
			colos[r.doColo] = (colos[r.doColo] ?? 0) + 1;
		}
		out[key] = colos;
		console.log(key, JSON.stringify(colos));
	}
	mkdirSync(RESULTS, { recursive: true });
	const file = `${RESULTS}/where-${data.meta.label}-${Date.now()}.json`;
	writeFileSync(file, JSON.stringify({ source: a1, workerColo: data.meta.workerColo, placements: out }, null, 1));
	console.log("saved", file);
} else {
	console.log("usage: create [per] | prepare <run> <count> | wake <run> <op> | sql [per] | burst [per] [levels] | seqwrite [n] | clock | where <file> | tail <out> <s> | join <results> <tail>");
}
