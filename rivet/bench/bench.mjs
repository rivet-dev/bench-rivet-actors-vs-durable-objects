// Load driver for the Rivet side of the benchmark.
//
// Every sample is one HTTP request through the Engine's gateway (Guard) to a benchmark actor,
// timed on the client from the first byte sent to the complete response body, on a kept-alive
// connection. The actor's own timestamps (taken on the node's clock) ride back in the JSON body
// so the SQL interval and the handler interval can be reported next to the client interval.
// Failures are recorded as samples with an `error` field and are never retried.
//
// Usage: node bench.mjs <scenario> [--option value ...]
// Environment: RIVET_ENDPOINT=http://<namespace>:<token>@<host>:<port>
//
// Scenarios (see README for what each measures):
//   warm        warm ping round robin over --actors actors
//   create      new actor, first request answered (--first ping|first|read|write)
//   wake        create, sleep, wait --idle-s, then first request (--first ping|read|write)
//   sql-read    warm point reads on one seeded actor
//   sql-write   autocommit inserts on one woken actor, sequential (also gives commits/s)
//   sql-scan    scan of --rows rows on one seeded actor
//   burst       creates at each --concurrency level (held actors), creates/s
//   probe       ping one actor --n times (readiness and client-floor checks)
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Client, Pool } from "undici";

function parseArgs(argv) {
	const args = { _: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const [k, inline] = a.slice(2).split("=", 2);
			const v = inline ?? (argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true");
			args[k] = v;
		} else {
			args._.push(a);
		}
	}
	return args;
}

const args = parseArgs(process.argv.slice(2));
const scenario = args._[0];
if (!scenario) {
	console.error("usage: node bench.mjs <scenario> [--option value ...]");
	process.exit(2);
}
const num = (k, d) => (args[k] == null ? d : Number(args[k]));
const str = (k, d) => (args[k] == null ? d : String(args[k]));

const endpointRaw = process.env.RIVET_ENDPOINT;
if (!endpointRaw) {
	console.error("RIVET_ENDPOINT is required, as http://<namespace>:<token>@<host>:<port>");
	process.exit(2);
}
const endpointUrl = new URL(endpointRaw);
const namespace = decodeURIComponent(endpointUrl.username || "default");
const token = decodeURIComponent(endpointUrl.password || "");
const origin = `${endpointUrl.protocol}//${endpointUrl.host}`;
const pool = str("pool", "default");
const outDir = str("out", "results");
const prefix = str("prefix", `${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`);
const timeoutMs = num("timeout-ms", 30_000);
mkdirSync(outDir, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowNs = () => process.hrtime.bigint();
const nsToMs = (ns) => Number(ns) / 1e6;

function pct(xs, p) {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const rank = Math.min(s.length, Math.max(1, Math.ceil((p / 100) * s.length)));
	return s[rank - 1];
}
const round = (x, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
function summary(xs) {
	return {
		n: xs.length,
		p50: round(pct(xs, 50)),
		p90: round(pct(xs, 90)),
		p99: round(pct(xs, 99)),
		p999: round(pct(xs, 99.9)),
		max: xs.length ? round(Math.max(...xs)) : null,
		mean: xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null,
	};
}

// One connection per client worker. Concurrency N uses N connections so samples never queue
// behind each other on one socket.
function makeClient(connections) {
	const opts = { pipelining: 1, keepAliveTimeout: 60_000, headersTimeout: timeoutMs, bodyTimeout: timeoutMs };
	return connections > 1 ? new Pool(origin, { ...opts, connections }) : new Client(origin, opts);
}

function gatewayPath(actor, key, method, op, query = {}) {
	const q = new URLSearchParams({
		"rvt-namespace": namespace,
		"rvt-method": method,
		"rvt-pool": pool,
		"rvt-key": key,
	});
	if (token) q.set("rvt-token", token);
	for (const [k, v] of Object.entries(query)) q.set(k, String(v));
	return `/gateway/${encodeURIComponent(actor)}/request/${op}?${q.toString()}`;
}

const outFile = `${outDir}/${scenario}-${prefix}.ndjson`;
let seq = 0;

// Sends one request and records it when `kind` is set. The client interval is `totalMs`.
async function request(client, { kind, actor, key, method, op, query, extra }) {
	const path = gatewayPath(actor, key, method, op, query);
	const sendAtMs = Date.now();
	const t0 = nowNs();
	let headersMs = null;
	let error = null;
	let answer = {};
	let status = 0;
	try {
		const res = await client.request({ path, method: "GET" });
		headersMs = nsToMs(nowNs() - t0);
		status = res.statusCode;
		const text = await res.body.text();
		if (status < 200 || status >= 300) {
			error = `HTTP ${status}: ${text.slice(0, 200)}`;
		} else {
			answer = JSON.parse(text);
		}
	} catch (e) {
		error = String(e?.message ?? e).slice(0, 300);
	}
	const totalMs = nsToMs(nowNs() - t0);
	const sample = {
		kind: kind ?? "setup",
		seq: seq++,
		key,
		op,
		sendAtMs,
		headersMs: round(headersMs),
		totalMs: round(totalMs),
		status,
		error,
		...extra,
		...answer,
	};
	if (kind) appendFileSync(outFile, `${JSON.stringify(sample)}\n`);
	return sample;
}

// Runs `f(i)` for i in [0, n) with `concurrency` workers, each pausing `gapMs` after a sample.
async function forEach(n, concurrency, gapMs, f) {
	let next = 0;
	const worker = async () => {
		while (true) {
			const i = next++;
			if (i >= n) return;
			await f(i);
			if (gapMs > 0) await sleep(gapMs);
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
}

function progress(label, i, n) {
	if ((i + 1) % 100 === 0 || i + 1 === n) console.log(`${label}: ${i + 1}/${n}`);
}

const meta = {
	scenario,
	prefix,
	args: Object.fromEntries(Object.entries(args).filter(([k]) => k !== "_")),
	endpointHost: endpointUrl.host,
	namespace,
	pool,
	node: process.version,
	startedAt: new Date().toISOString(),
};
const results = { meta, metrics: {} };

function finish(extra = {}) {
	results.meta.endedAt = new Date().toISOString();
	Object.assign(results, extra);
	const file = `${outDir}/${scenario}-${prefix}.summary.json`;
	writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
	console.log(JSON.stringify({ summary: file, metrics: results.metrics }, null, 2));
}

// Collects per-sample intervals for the summary and reports the error count.
function report(name, samples, fields = ["totalMs"]) {
	const ok = samples.filter((s) => !s.error);
	const out = { n: samples.length, errors: samples.length - ok.length };
	for (const f of fields) {
		const xs = ok.map((s) => s[f]).filter((x) => typeof x === "number");
		if (xs.length) out[f] = summary(xs);
	}
	results.metrics[name] = out;
	return out;
}

async function scenarioProbe() {
	const n = num("n", 100);
	const actor = str("actor", "benchPing");
	const client = makeClient(1);
	const key = `${prefix}-probe`;
	await request(client, { actor, key, method: "getOrCreate", op: "ping" });
	const samples = [];
	for (let i = 0; i < n; i++) {
		samples.push(await request(client, { kind: "probe", actor, key, method: "get", op: "ping" }));
	}
	report("probe", samples, ["totalMs", "handlerMs"]);
	await client.close();
	finish();
}

// Warm ping: `actors` actors created up front, then `n` pings round robin on one connection.
// --method get (default) routes to the running actor; getOrCreate is what a client that does
// not know whether the actor exists would send.
async function scenarioWarm() {
	const n = num("n", 2000);
	const actors = num("actors", 10);
	const actor = str("actor", "benchPing");
	const method = str("method", "get");
	const client = makeClient(num("concurrency", 1));
	const keys = Array.from({ length: actors }, (_, i) => `${prefix}-warm-${i}`);
	for (const key of keys) await request(client, { actor, key, method: "getOrCreate", op: "ping" });
	// A short warmup is excluded so JIT and connection setup do not land in the distribution.
	for (let i = 0; i < 50; i++) await request(client, { actor, key: keys[i % actors], method, op: "ping" });
	const samples = [];
	await forEach(n, num("concurrency", 1), num("gap-ms", 0), async (i) => {
		samples.push(await request(client, { kind: "warm", actor, key: keys[i % actors], method, op: "ping" }));
		progress("warm", i, n);
	});
	report("warm", samples, ["totalMs", "handlerMs"]);
	await client.close();
	finish();
}

// Create: `n` fresh keys, each one `getOrCreate` whose first request is `first`.
async function scenarioCreate() {
	const n = num("n", 1500);
	const first = str("first", "ping");
	const actor = str("actor", first === "ping" ? "benchPing" : "benchSqlite");
	const concurrency = num("concurrency", 1);
	const client = makeClient(concurrency);
	const query = first === "read" ? { id: 1 } : first === "write" ? { bytes: 128 } : {};
	const samples = [];
	const t0 = nowNs();
	await forEach(n, concurrency, num("gap-ms", 20), async (i) => {
		const key = `${prefix}-create-${i}`;
		const s = await request(client, { kind: "create", actor, key, method: "getOrCreate", op: first, query });
		samples.push(s);
		progress("create", i, n);
	});
	const elapsedS = nsToMs(nowNs() - t0) / 1000;
	const r = report("create", samples, ["totalMs", "headersMs", "handlerMs", "sqlMs"]);
	r.notCold = samples.filter((s) => !s.error && s.cold === false).length;
	r.createsPerSecond = round(samples.filter((s) => !s.error).length / elapsedS, 1);
	await client.close();
	finish();
}

// Wake: create `n` actors (and seed one row when the first request after wake reads it),
// put every one to sleep explicitly, wait at least `idle-s`, then send each its first request.
async function scenarioWake() {
	const n = num("n", 1200);
	const first = str("first", "ping");
	const actor = str("actor", first === "ping" ? "benchPing" : "benchSqlite");
	const idleS = num("idle-s", 10);
	const client = makeClient(1);
	const keys = Array.from({ length: n }, (_, i) => `${prefix}-wake-${i}`);
	for (let i = 0; i < n; i++) {
		await request(client, { actor, key: keys[i], method: "getOrCreate", op: "ping" });
		if (first !== "ping") await request(client, { actor, key: keys[i], method: "get", op: "write", query: { bytes: 128 } });
		progress("prepare", i, n);
	}
	const sleptAt = [];
	for (let i = 0; i < n; i++) {
		const s = await request(client, { kind: "sleep", actor, key: keys[i], method: "get", op: "sleep" });
		sleptAt.push(Date.now());
		if (s.error) console.log(`sleep error ${keys[i]}: ${s.error}`);
		progress("sleep", i, n);
	}
	console.log(`waiting ${idleS} s for the actors to sleep`);
	await sleep(idleS * 1000);
	const query = first === "read" ? { id: 1 } : first === "write" ? { bytes: 128 } : {};
	const samples = [];
	await forEach(n, 1, num("gap-ms", 20), async (i) => {
		const s = await request(client, {
			kind: "wake",
			actor,
			key: keys[i],
			method: "getOrCreate",
			op: first,
			query,
			extra: { idleMs: Date.now() - sleptAt[i] },
		});
		samples.push(s);
		progress("wake", i, n);
	});
	const r = report("wake", samples, ["totalMs", "headersMs", "handlerMs", "sqlMs"]);
	// A sample only counts as a wake if the actor started again after its sleep request.
	const restarted = samples.filter((s) => !s.error && s.cold === true && s.initAtMs > s.sendAtMs - s.idleMs);
	r.restarted = restarted.length;
	r.notRestarted = samples.filter((s) => !s.error).length - restarted.length;
	r.wakeOnly = { totalMs: summary(restarted.map((s) => s.totalMs)) };
	if (first !== "ping") r.wakeOnly.sqlMs = summary(restarted.map((s) => s.sqlMs).filter((x) => typeof x === "number"));
	r.idleMs = summary(samples.map((s) => s.idleMs));
	await client.close();
	finish();
}

// Seeds one held SQLite actor with `rows` rows of `bytes` bytes and returns its key.
async function seedActor(client, actor, key, rows, bytes) {
	await request(client, { actor, key, method: "getOrCreate", op: "ping" });
	const chunk = 50_000;
	for (let done = 0; done < rows; done += chunk) {
		const s = await request(client, { actor, key, method: "get", op: "bulk", query: { rows: Math.min(chunk, rows - done), bytes } });
		if (s.error) throw new Error(`seed failed: ${s.error}`);
	}
	const stats = await request(client, { actor, key, method: "get", op: "stats" });
	return stats;
}

// Warm point reads: one seeded held actor, random ids, `n` reads after a warmup.
async function scenarioSqlRead() {
	const n = num("n", 1200);
	const rows = num("rows", 1000);
	const actor = str("actor", "benchSqliteHeld");
	const client = makeClient(1);
	const key = `${prefix}-sqlread`;
	const stats = await seedActor(client, actor, key, rows, num("bytes", 128));
	for (let i = 0; i < 200; i++) await request(client, { actor, key, method: "get", op: "read", query: { id: 1 + (i % rows) } });
	const samples = [];
	for (let i = 0; i < n; i++) {
		const id = 1 + Math.floor(Math.random() * rows);
		const s = await request(client, { kind: "read", actor, key, method: "get", op: "read", query: { id } });
		samples.push(s);
		progress("read", i, n);
	}
	const r = report("sql-read", samples, ["totalMs", "sqlMs", "handlerMs"]);
	r.missingRows = samples.filter((s) => !s.error && s.returnedRows !== 1).length;
	await client.close();
	finish({ database: { count: stats.count, pageCount: stats.pageCount, pageSize: stats.pageSize } });
}

// Autocommit inserts: one held actor, `n` sequential 128 B inserts with zero think time. The
// seeded actor is put to sleep and woken once before the timed writes, so they run on a
// reopened database.
async function scenarioSqlWrite() {
	const n = num("n", 1200);
	const bytes = num("bytes", 128);
	const concurrency = num("concurrency", 1);
	const actor = str("actor", "benchSqliteHeld");
	const client = makeClient(concurrency);
	const actors = num("actors", concurrency);
	const keys = Array.from({ length: actors }, (_, i) => `${prefix}-sqlwrite-${i}`);
	for (const key of keys) await seedActor(client, actor, key, 1, bytes);
	for (let i = 0; i < 100; i++) await request(client, { actor, key: keys[i % actors], method: "get", op: "write", query: { bytes } });
	for (const key of keys) await request(client, { actor, key, method: "get", op: "sleep" });
	await sleep(4000);
	for (const key of keys) await request(client, { actor, key, method: "getOrCreate", op: "ping" });
	const samples = [];
	const t0 = nowNs();
	await forEach(n, concurrency, 0, async (i) => {
		samples.push(await request(client, { kind: "write", actor, key: keys[i % actors], method: "get", op: "write", query: { bytes } }));
		progress("write", i, n);
	});
	const elapsedS = nsToMs(nowNs() - t0) / 1000;
	const r = report("sql-write", samples, ["totalMs", "sqlMs", "handlerMs"]);
	r.commitsPerSecond = round(samples.filter((s) => !s.error).length / elapsedS, 1);
	r.elapsedS = round(elapsedS, 2);
	await client.close();
	finish();
}

async function scenarioSqlScan() {
	const n = num("n", 1000);
	const rows = num("rows", 1000);
	const actor = str("actor", "benchSqliteHeld");
	const client = makeClient(1);
	const key = `${prefix}-sqlscan`;
	const stats = await seedActor(client, actor, key, num("seed-rows", rows), num("bytes", 128));
	for (let i = 0; i < 20; i++) await request(client, { actor, key, method: "get", op: "first", query: { rows } });
	const samples = [];
	for (let i = 0; i < n; i++) {
		samples.push(await request(client, { kind: "scan", actor, key, method: "get", op: "first", query: { rows } }));
		progress("scan", i, n);
	}
	report("sql-scan", samples, ["totalMs", "sqlMs"]);
	await client.close();
	finish({ database: { count: stats.count } });
}

// Burst creates: for each concurrency level, `per` creates of held actors with no gap.
async function scenarioBurst() {
	const levels = str("concurrency", "1,8,32,128").split(",").map(Number);
	const per = num("per", 500);
	const actor = str("actor", "benchPingHeld");
	for (const c of levels) {
		const client = makeClient(c);
		const samples = [];
		const t0 = nowNs();
		await forEach(per, c, 0, async (i) => {
			samples.push(await request(client, { kind: `burst-c${c}`, actor, key: `${prefix}-burst-c${c}-${i}`, method: "getOrCreate", op: "ping", extra: { concurrency: c } }));
		});
		const elapsedS = nsToMs(nowNs() - t0) / 1000;
		const r = report(`burst-c${c}`, samples, ["totalMs"]);
		r.createsPerSecond = round(samples.filter((s) => !s.error).length / elapsedS, 1);
		r.elapsedS = round(elapsedS, 2);
		console.log(`burst C${c}: ${r.createsPerSecond} creates/s, p50 ${r.totalMs?.p50} ms, errors ${r.errors}`);
		await client.close();
		await sleep(2000);
	}
	finish();
}

// Resident memory of the node process and of every Engine, in KiB, through --rss-cmd (a shell
// command that prints JSON like {"node": 123456, "storage": {"10.0.0.4": 234567, ...}}).
function sampleRss(cmd) {
	return JSON.parse(execFileSync("bash", ["-c", cmd], { encoding: "utf8" }));
}

// Hold: creates held actors up to each cumulative count in --steps (concurrency 16), lets the
// cluster settle, then samples resident memory ten times one second apart.
async function scenarioHold() {
	const steps = str("steps", "0,1000,10000").split(",").map(Number);
	const actor = str("actor", "benchPingHeld");
	const rssCmd = str("rss-cmd", null);
	if (!rssCmd) throw new Error("--rss-cmd is required");
	const settleS = num("settle-s", 30);
	const client = makeClient(16);
	let created = 0;
	const memory = [];
	for (const target of steps) {
		const samples = [];
		const t0 = nowNs();
		await forEach(target - created, 16, 0, async (i) => {
			samples.push(await request(client, { kind: "hold-create", actor, key: `${prefix}-hold-${created + i}`, method: "getOrCreate", op: "ping", extra: { step: target } }));
		});
		const elapsedS = nsToMs(nowNs() - t0) / 1000;
		created = target;
		await sleep(settleS * 1000);
		const rss = [];
		for (let i = 0; i < 10; i++) {
			rss.push(sampleRss(rssCmd));
			await sleep(1000);
		}
		const med = (xs) => pct(xs, 50);
		const storageHosts = Object.keys(rss[0].storage ?? {});
		const entry = {
			actors: target,
			createdThisStep: samples.length,
			errors: samples.filter((s) => s.error).length,
			createsPerSecond: samples.length ? round(samples.filter((s) => !s.error).length / elapsedS, 1) : null,
			createMs: samples.length ? summary(samples.filter((s) => !s.error).map((s) => s.totalMs)) : null,
			nodeRssKiB: med(rss.map((r) => r.node)),
			storageRssKiB: Object.fromEntries(storageHosts.map((h) => [h, med(rss.map((r) => r.storage[h]))])),
			storageRssTotalKiB: med(rss.map((r) => storageHosts.reduce((a, h) => a + r.storage[h], 0))),
		};
		memory.push(entry);
		appendFileSync(outFile, `${JSON.stringify({ kind: "hold-memory", ...entry })}\n`);
		console.log(`hold ${target}: node ${Math.round(entry.nodeRssKiB / 1024)} MiB, engines ${Math.round(entry.storageRssTotalKiB / 1024)} MiB, errors ${entry.errors}`);
	}
	// Slope per held actor between the first and last non-zero steps.
	const nonzero = memory.filter((m) => m.actors > 0);
	if (nonzero.length >= 2) {
		const a = nonzero[0];
		const b = nonzero[nonzero.length - 1];
		results.metrics.memory = {
			perActorNodeKiB: round((b.nodeRssKiB - a.nodeRssKiB) / (b.actors - a.actors), 1),
			perActorEnginesKiB: round((b.storageRssTotalKiB - a.storageRssTotalKiB) / (b.actors - a.actors), 1),
			from: a.actors,
			to: b.actors,
		};
	}
	await client.close();
	finish({ memory });
}

const scenarios = {
	probe: scenarioProbe,
	hold: scenarioHold,
	warm: scenarioWarm,
	create: scenarioCreate,
	wake: scenarioWake,
	"sql-read": scenarioSqlRead,
	"sql-write": scenarioSqlWrite,
	"sql-scan": scenarioSqlScan,
	burst: scenarioBurst,
};
const run = scenarios[scenario];
if (!run) {
	console.error(`unknown scenario ${scenario}; one of ${Object.keys(scenarios).join(", ")}`);
	process.exit(2);
}
await run();
