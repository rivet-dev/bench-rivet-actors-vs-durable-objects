// Durable Object cold start and SQLite benchmark.
//
// Every latency is measured inside the Worker around one call to the Durable Object, so the
// client's network distance to Cloudflare drops out. Workers only advance Date.now() across I/O
// and at 1 ms resolution, so in-DO CPU work cannot be timed from here; every number is a round
// trip from the Worker to the DO, and a write includes the wait for the write to be durable
// (the output gate).
//
// The /one and /sql1 routes make exactly one DO call per Worker invocation. That lets
// Cloudflare's own per-invocation wall time (wrangler tail, GraphQL analytics) serve as a second
// clock on the same round trip, and the DO's own invocation wall time shows the in-DO part.
import { DurableObject } from "cloudflare:workers";

interface Env {
	BENCH_DO: DurableObjectNamespace<BenchDO>;
}

type Op = "raw" | "read" | "write";

interface OpResult {
	// True on the first call this DO instance has handled since it was constructed.
	cold: boolean;
	instance: string;
	rows?: number;
}

export class BenchDO extends DurableObject<Env> {
	instance = crypto.randomUUID();
	served = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
		);
	}

	#mark(): Pick<OpResult, "cold" | "instance"> {
		const cold = this.served === 0;
		this.served++;
		return { cold, instance: this.instance };
	}

	async op(op: Op): Promise<OpResult> {
		const mark = this.#mark();
		const sql = this.ctx.storage.sql;
		switch (op) {
			case "raw":
				return mark;
			case "read": {
				const row = sql.exec("SELECT value FROM items WHERE id = 1").toArray();
				return { ...mark, rows: row.length };
			}
			case "write":
				sql.exec("INSERT OR REPLACE INTO items (id, value) VALUES (1, ?)", "v".repeat(64));
				return { ...mark, rows: 1 };
		}
	}

	async seed(rows: number, bytes: number): Promise<number> {
		const sql = this.ctx.storage.sql;
		const value = "x".repeat(bytes);
		this.ctx.storage.transactionSync(() => {
			sql.exec("DELETE FROM items");
			for (let i = 0; i < rows; i++) {
				sql.exec("INSERT INTO items (id, value) VALUES (?, ?)", i + 1, value);
			}
		});
		return rows;
	}

	async sqlBench(kind: string, n: number): Promise<number> {
		this.#mark();
		const sql = this.ctx.storage.sql;
		switch (kind) {
			case "ping":
				return 0;
			case "point_read": {
				const id = 1 + Math.floor(Math.random() * 1000);
				return sql.exec("SELECT value FROM items WHERE id = ?", id).toArray().length;
			}
			case "scan":
				return sql.exec("SELECT id, value FROM items ORDER BY id LIMIT ?", n).toArray().length;
			case "insert": {
				const value = "w".repeat(256);
				this.ctx.storage.transactionSync(() => {
					for (let i = 0; i < n; i++) {
						sql.exec("INSERT INTO items (value) VALUES (?)", value);
					}
				});
				return n;
			}
			default:
				throw new Error(`unknown sql bench ${kind}`);
		}
	}

	// The colo this DO's subrequests leave from, which is where the DO runs (inferred).
	async where(): Promise<string> {
		const text = await (await fetch("https://www.cloudflare.com/cdn-cgi/trace")).text();
		return /colo=(\w+)/.exec(text)?.[1] ?? "unknown";
	}
}

function pickId(env: Env, q: URLSearchParams): { id: DurableObjectId; name: string | null } {
	const explicit = q.get("id");
	if (explicit) {
		return { id: env.BENCH_DO.idFromString(explicit), name: q.get("name") };
	}
	let name = q.get("name");
	if (name) {
		return { id: env.BENCH_DO.idFromName(name), name };
	}
	if ((q.get("mode") ?? "name") === "unique") {
		return { id: env.BENCH_DO.newUniqueId(), name: null };
	}
	name = `create-${crypto.randomUUID()}`;
	return { id: env.BENCH_DO.idFromName(name), name };
}

async function timed<T>(f: () => Promise<T>): Promise<[number, T]> {
	const start = Date.now();
	const value = await f();
	return [Date.now() - start, value];
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const q = url.searchParams;
		const colo = (request as { cf?: { colo?: string } }).cf?.colo ?? "unknown";

		// No DO call at all: the client-side baseline for one Worker round trip.
		if (url.pathname === "/noop") {
			return Response.json({ colo });
		}

		// Exactly one DO call. Without name or id this creates a brand new DO (mode=name|unique);
		// with name or id it calls an existing one (warm second call, or a wake).
		if (url.pathname === "/one") {
			const op = (q.get("op") ?? "raw") as Op;
			const { id, name } = pickId(env, q);
			const stub = env.BENCH_DO.get(id);
			const [ms, r] = await timed(() => stub.op(op));
			return Response.json({ colo, ms, id: id.toString(), name, ...r });
		}

		// Exactly one SQLite benchmark call against an existing seeded DO.
		if (url.pathname === "/sql1") {
			const kind = q.get("kind") ?? "ping";
			const size = Number(q.get("size") ?? "1");
			const { id } = pickId(env, q);
			const stub = env.BENCH_DO.get(id);
			const [ms, rows] = await timed(() => stub.sqlBench(kind, size));
			return Response.json({ colo, ms, id: id.toString(), rows });
		}

		if (url.pathname === "/seed") {
			const { id } = pickId(env, q);
			const stub = env.BENCH_DO.get(id);
			const [ms, rows] = await timed(() =>
				stub.seed(Number(q.get("rows") ?? "1000"), Number(q.get("bytes") ?? "256")),
			);
			return Response.json({ colo, ms, id: id.toString(), rows });
		}

		if (url.pathname === "/where") {
			const { id } = pickId(env, q);
			const stub = env.BENCH_DO.get(id);
			const [ms, doColo] = await timed(() => stub.where());
			return Response.json({ colo, ms, id: id.toString(), doColo });
		}

		// Prepare named DOs for a later wake measurement: create each, store a row, return names.
		if (url.pathname === "/prepare") {
			const n = Math.min(Number(q.get("n") ?? "10"), 200);
			const run = q.get("run") ?? crypto.randomUUID();
			const names = [];
			for (let i = 0; i < n; i++) {
				const name = `wake-${run}-${i}`;
				const stub = env.BENCH_DO.get(env.BENCH_DO.idFromName(name));
				await stub.op("write");
				names.push(name);
			}
			return Response.json({ colo, names });
		}

		// Shows the frozen clock: CPU work advances neither Date.now() nor performance.now(),
		// while an awaited wait does.
		if (url.pathname === "/clock") {
			const d0 = Date.now();
			const p0 = performance.now();
			let x = 0;
			for (let i = 0; i < 30_000_000; i++) {
				x += Math.sqrt(i);
			}
			const spinDateMs = Date.now() - d0;
			const spinPerfMs = performance.now() - p0;
			const d1 = Date.now();
			await scheduler.wait(20);
			const waitDateMs = Date.now() - d1;
			return Response.json({ colo, spinDateMs, spinPerfMs, waitDateMs, nonzero: x > 0 });
		}

		return new Response("routes: /noop /one /sql1 /seed /where /prepare /clock\n", { status: 404 });
	},
};
