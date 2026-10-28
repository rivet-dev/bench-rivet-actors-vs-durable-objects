// Prints markdown tables from one or more results files, plus a per-sample agreement check
// between the Worker's Date.now clock and Cloudflare's own invocation wall time.
//
// Usage: node report.mjs results/<file>.json [...]
import { readFileSync } from "node:fs";

const pct = (xs, p) => {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const r1 = (x) => (x == null ? "-" : (Math.round(x * 10) / 10).toString());
const trio = (xs) => (xs.length ? `${r1(pct(xs, 50))} / ${r1(pct(xs, 90))} / ${r1(pct(xs, 99))}` : "-");
const f = (xs, k) => xs.filter((s) => s[k] != null).map((s) => s[k]);

for (const file of process.argv.slice(2)) {
	const data = JSON.parse(readFileSync(file, "utf8"));
	console.log(`\n### ${file}  (worker colo ${data.meta.workerColo}, tail events ${data.meta.tailEvents}, skew ${r1(data.meta.tailSkewMs)} ms${data.meta.idleSec ? `, idle ${data.meta.idleSec} s` : ""})\n`);
	const hasCold = data.samples.some((s) => s.kind === "cold");
	console.log("| Scenario | kind | n | Worker clock p50 / p90 / p99 | CF Worker wall p50 / p90 / p99 (n) | CF DO wall p50 / p90 / p99 (n) | Client minus noop p50 | errors |");
	console.log("| --- | --- | --- | --- | --- | --- | --- | --- |");
	const agreement = [];
	for (const key of Object.keys(data.scenarios)) {
		const all = data.samples.filter((s) => s.scenario === key);
		const noop50 = pct(all.filter((s) => s.kind === "noop").map((s) => s.clientMs), 50);
		const errors = all.filter((s) => s.error).length;
		const groups = hasCold
			? [
					["cold", all.filter((s) => s.kind === "cold" && s.cold === true)],
					["warm", all.filter((s) => s.kind === "warm" && s.cold === false)],
					["rewake", all.filter((s) => s.kind === "warm" && s.cold === true)],
				]
			: [["sql", all.filter((s) => s.kind === "sql" && !s.error)]];
		for (const [kind, xs] of groups) {
			if (xs.length === 0) continue;
			const cfw = f(xs, "cfWorkerMs");
			const cfd = f(xs, "cfDoMs");
			console.log(`| ${key} | ${kind} | ${xs.length} | ${trio(f(xs, "ms"))} | ${trio(cfw)} (${cfw.length}) | ${trio(cfd)} (${cfd.length}) | ${r1(pct(f(xs, "clientMs"), 50) - noop50)} | ${kind === "cold" || kind === "sql" ? errors : ""} |`);
			for (const s of xs) {
				if (s.cfWorkerMs != null) agreement.push({ key, kind, d: s.cfWorkerMs - s.ms, dd: s.cfDoMs != null ? s.ms - s.cfDoMs : null, client: s.clientMs - noop50 - s.ms });
			}
		}
	}
	console.log("\nClock agreement per sample (CF Worker wall minus Worker clock, ms):\n");
	console.log("| Scenario | kind | n | delta p50 | delta p90 | delta max | within 1 ms | within 2 ms | Worker clock minus CF DO wall p50 | client minus noop minus Worker clock p50 |");
	console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
	const groups = new Map();
	for (const a of agreement) {
		const k = `${a.key}|${a.kind}`;
		if (!groups.has(k)) groups.set(k, []);
		groups.get(k).push(a);
	}
	for (const [k, xs] of groups) {
		const [key, kind] = k.split("|");
		const d = xs.map((x) => x.d);
		const w1 = xs.filter((x) => Math.abs(x.d) <= 1).length;
		const w2 = xs.filter((x) => Math.abs(x.d) <= 2).length;
		const dd = xs.filter((x) => x.dd != null).map((x) => x.dd);
		console.log(`| ${key} | ${kind} | ${xs.length} | ${r1(pct(d, 50))} | ${r1(pct(d, 90))} | ${r1(Math.max(...d))} | ${Math.round((100 * w1) / xs.length)}% | ${Math.round((100 * w2) / xs.length)}% | ${r1(pct(dd, 50))} | ${r1(pct(xs.map((x) => x.client), 50))} |`);
	}
}
