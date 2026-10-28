// Benchmark actors for Rivet Actors against Cloudflare Durable Objects.
//
// Every request answers with timestamps taken on the node's clock, so a load driver on the same
// host can place the phases of a create or wake on one timeline. SQLite work reports its own
// interval (`sqlMs`), measured around the awaited `c.db` calls, separately from the HTTP interval
// the driver measures. Payload generation happens before the SQL interval starts.
import { randomBytes } from "node:crypto";
import { actor, setup } from "rivetkit";
import { db } from "rivetkit/db";

function nowMs(): number {
	return performance.timeOrigin + performance.now();
}

function json(body: object, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function boundedInt(url: URL, name: string, fallback: number, max: number): number {
	const value = Number(url.searchParams.get(name) ?? fallback);
	if (!Number.isInteger(value) || value < 1 || value > max) {
		throw new Error(`invalid ${name}`);
	}
	return value;
}

interface StartVars {
	// Set on every start of the actor, so a wake produces a new value.
	initAtMs: number;
	wakeAtMs: number;
	// Random per start; two requests with the same value hit the same running instance.
	instance: string;
	served: number;
}

function startVars(): StartVars {
	return { initAtMs: nowMs(), wakeAtMs: 0, instance: randomBytes(8).toString("hex"), served: 0 };
}

interface Row {
	id: number;
	value: string;
}

// No user state and no database: a create or wake measures the start path alone.
function pingActor(options: { noSleep: boolean }) {
	return actor({
		options: { sleepGracePeriod: 1_000, noSleep: options.noSleep },
		createVars: startVars,
		onWake: (c) => {
			c.vars.wakeAtMs = nowMs();
		},
		onRequest: (c, request) => {
			const receivedAtMs = nowMs();
			const cold = c.vars.served === 0;
			c.vars.served += 1;
			const pathname = new URL(request.url).pathname;
			if (pathname.endsWith("/sleep")) {
				c.sleep();
				return json({ op: "sleep", actorId: c.actorId, receivedAtMs });
			}
			return json({
				op: "ping",
				actorId: c.actorId,
				instance: c.vars.instance,
				cold,
				initAtMs: c.vars.initAtMs,
				wakeAtMs: c.vars.wakeAtMs,
				receivedAtMs,
				handlerMs: nowMs() - receivedAtMs,
			});
		},
		actions: {
			ping: () => true,
		},
	});
}

// One SQLite table of (id, value) rows, the same shape as the Durable Object bench.
function sqliteActor(options: { noSleep: boolean }) {
	return actor({
		options: { sleepGracePeriod: 1_000, noSleep: options.noSleep },
		createVars: startVars,
		onWake: (c) => {
			c.vars.wakeAtMs = nowMs();
		},
		db: db({
			onMigrate: async (database) => {
				await database.execute(
					"CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
				);
			},
		}),
		onRequest: async (c, request) => {
			const receivedAtMs = nowMs();
			const cold = c.vars.served === 0;
			c.vars.served += 1;
			const url = new URL(request.url);
			const op = url.pathname.split("/").pop() ?? "";
			const rows = boundedInt(url, "rows", 1, 1_000_000);
			const bytes = boundedInt(url, "bytes", 128, 16 * 1024 * 1024);
			const id = boundedInt(url, "id", 1, 2 ** 31 - 1);
			// Hex text has a deterministic size and is not an all-zero compressible row.
			const payload =
				op === "write" || op === "tx" || op === "bulk"
					? randomBytes(Math.ceil(bytes / 2)).toString("hex").slice(0, bytes)
					: "";
			let returnedRows = 0;
			let returnedBytes = 0;
			let commitMs = 0;
			let extra: object = {};
			const sqlStartedAtMs = nowMs();
			switch (op) {
				case "ping":
					break;
				case "sleep":
					c.sleep();
					break;
				// Point read by primary key, full value materialized in JS.
				case "read": {
					const result = (await c.db.execute(
						"SELECT id, value FROM items WHERE id = ?",
						id,
					)) as unknown as Row[];
					returnedRows = result.length;
					for (const row of result) returnedBytes += row.value.length;
					break;
				}
				// First rows of the table; on an empty table this is the cheapest possible query.
				case "first": {
					const result = (await c.db.execute(
						"SELECT id, value FROM items ORDER BY id LIMIT ?",
						rows,
					)) as unknown as Row[];
					returnedRows = result.length;
					for (const row of result) returnedBytes += row.value.length;
					break;
				}
				// One autocommit insert: the durable commit is inside the SQL interval.
				case "write": {
					await c.db.execute("INSERT INTO items (value) VALUES (?)", payload);
					break;
				}
				// N inserts in one transaction, with the COMMIT timed on its own.
				case "tx": {
					await c.db.transaction(
						async (tx) => {
							for (let i = 0; i < rows; i++) {
								await tx.execute("INSERT INTO items (value) VALUES (?)", payload);
							}
							commitMs = nowMs();
						},
						{ name: "bench-tx" },
					);
					commitMs = nowMs() - commitMs;
					break;
				}
				// Seed many rows in one statement; used to build large databases quickly.
				case "bulk": {
					await c.db.execute(
						"WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x + 1 FROM n WHERE x < ?) INSERT INTO items (value) SELECT ? FROM n",
						rows,
						payload,
					);
					break;
				}
				case "stats": {
					const count = (await c.db.execute(
						"SELECT count(*) AS n, max(id) AS maxId FROM items",
					)) as unknown as { n: number; maxId: number }[];
					const pages = (await c.db.execute("PRAGMA page_count")) as unknown as Record<
						string,
						number
					>[];
					const size = (await c.db.execute("PRAGMA page_size")) as unknown as Record<
						string,
						number
					>[];
					extra = { count: count[0], pageCount: pages[0], pageSize: size[0] };
					break;
				}
				default:
					return json({ error: `unknown op ${op}` }, 404);
			}
			const sqlMs = nowMs() - sqlStartedAtMs;
			return json({
				op,
				actorId: c.actorId,
				instance: c.vars.instance,
				cold,
				initAtMs: c.vars.initAtMs,
				wakeAtMs: c.vars.wakeAtMs,
				receivedAtMs,
				sqlStartedAtMs,
				sqlMs,
				commitMs,
				rows,
				bytes,
				returnedRows,
				returnedBytes,
				handlerMs: nowMs() - receivedAtMs,
				...extra,
			});
		},
		actions: {
			ping: () => true,
		},
	});
}

export const registry = setup({
	use: {
		benchPing: pingActor({ noSleep: false }),
		benchSqlite: sqliteActor({ noSleep: false }),
		// Held variants never sleep, for throughput and memory runs.
		benchPingHeld: pingActor({ noSleep: true }),
		benchSqliteHeld: sqliteActor({ noSleep: true }),
	},
});

registry.start();
