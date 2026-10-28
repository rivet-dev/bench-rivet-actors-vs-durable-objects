// Splices the generated headline tables from report/summary.json into README.md between the
// RESULTS_TABLE markers, so the README never carries hand-typed numbers.
//
// Usage: node scripts/update-readme.mjs [report-dir]
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const reportDir = process.argv[2] ?? "report";
const summary = JSON.parse(readFileSync(join(reportDir, "summary.json"), "utf8"));
const fmt = (x, d = 2) => (x == null ? "-" : x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(d));
const trio = (d) => (d && d.n ? `${fmt(d.p50)} / ${fmt(d.p90)} / ${fmt(d.p99)}` : "-");

const headline = [];
headline.push("Milliseconds, p50 / p90 / p99, nearest rank, no trimming. In-system time on both sides: Rivet is the client on the runner VM to the actor's reply through the Engine gateway; Durable Objects is the Worker to the DO and back, timed in the Worker. Full tables, the in-DO wall times from Cloudflare's analytics and the in-actor SQL intervals are in [report/results.md](report/results.md).", "");
headline.push("| Metric | Rivet Actor | n | Durable Object | n |");
headline.push("| --- | --- | ---: | --- | ---: |");
for (const r of summary.rows) {
	if (!r.rivet.n && !r.cf.n) continue;
	headline.push(`| ${r.metric} | **${trio(r.rivet)}** | ${r.rivet.n || "-"} | **${trio(r.cf)}** | ${r.cf.n || "-"} |`);
}
headline.push("", "| Throughput | Rivet | Durable Objects |", "| --- | ---: | ---: |");
for (const t of summary.tput) {
	headline.push(`| ${t.metric} | ${t.rivet ? `**${fmt(t.rivet.rate, 0)}/s** (${t.rivet.errors} errors of ${t.rivet.n})` : "-"} | ${t.cf ? `**${fmt(t.cf.rate, 1)}/s** (${t.cf.errors} errors of ${t.cf.n})` : "-"} |`);
}
headline.push("", "Durable Object rates use the Worker-timed duration of each call, like the latency rows; the client's internet round trip to Cloudflare is excluded. Bursts at concurrency c are c × 1000 / mean Worker ms (Little's law); sequential writes are 1000 / mean Worker ms.");

let readme = readFileSync("README.md", "utf8");
const splice = (text, marker, body) => {
	const begin = `<!-- ${marker}:begin -->`;
	const end = `<!-- ${marker}:end -->`;
	const block = `${begin}\n${body.join("\n")}\n${end}`;
	if (text.includes(begin)) {
		return text.replace(new RegExp(`${begin}[\\s\\S]*?${end}`), block);
	}
	return text.replace(marker, block);
};
readme = splice(readme, "RESULTS_TABLE", headline);
writeFileSync("README.md", readme);
console.log("README.md updated");
