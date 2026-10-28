# Rivet Actors against Cloudflare Durable Objects

A reproducible benchmark of the two actor runtimes on the operations that matter to an
application: how long a new actor takes to answer its first request, how long a sleeping one
takes to wake, how fast its SQLite database reads and writes, and how many creates and commits
per second one client can push through.

Every number in this repository comes from raw samples under `results/<date>/`, and every table
and chart under `report/` is generated from them by one script. Nothing is typed in by hand.

- Rivet side: the public release `rivetdev/engine:3.0.0-preview.2` and `rivetkit@3.0.0-preview.2`
  on three Azure VMs with local NVMe in three availability zones, plus one runner VM.
- Cloudflare side: a Worker with one SQLite-backed Durable Object class, deployed with wrangler,
  driven from the same Azure region as the Rivet cluster.

## Results

![Bar chart, p50 with a line to p99, Rivet Actors against Cloudflare Durable Objects: create and first request 4.06 ms against 158 ms (39 times faster), durable SQLite write 0.68 ms against 19 ms (28 times faster), request from your backend 0.84 ms against 11 ms (13 times faster)](report/charts/headline.png)

The chart is drawn from the same raw samples as the [headline table](#headline) below. The
"Request from your backend" group is each side's baseline: the round trip of a no-op request to
a running actor (Rivet client to actor, 0.84 ms; Worker to Durable Object, 11 ms). The create and write groups
subtract that median baseline from every sample, so they show the work itself rather than the
hop to reach the actor. Its create group uses the Durable Object unique-id create, the faster of
the two DO create rows. See
[report/results.md](report/results.md) for the generated tables and charts of the latest run.

### How it's measured

The goal is an apples to apples comparison of the work each platform does.

- The Durable Object side is measured entirely within Cloudflare's network, timed inside the
  Worker, so where the load generator runs has no effect on it.
- Cloudflare freezes timers for Spectre mitigations, so `performance.now()` can't time work inside
  a Worker or DO: timers only advance across I/O, in 1 ms steps. Each sample is the Worker → DO
  round trip around one awaited call.
- Each side's baseline is the round trip of a no-op request to a running actor: Worker → DO
  (11 ms p50) and Rivet client → actor (0.84 ms p50). The chart subtracts each side's median
  baseline from every create and write sample, so those groups show the work itself; the request
  group is the baseline.
- This is favorable to Durable Objects: their create and write numbers in the chart are about
  11 ms lower than what serial requests to a DO actually see.
- It also excludes any latency within Cloudflare's routers between the client and the Worker,
  which is generous to Cloudflare.
- This run was Worker (IAD) → DO (EWR). The Durable Object samples are from 2026-10-27 and the
  Rivet samples from 2026-10-28, same region, client VM size and method.
- The headline table below keeps the raw round trips, with nothing subtracted.

If anyone at Cloudflare has a better way of measuring, please open an issue.

### Headline

<!-- RESULTS_TABLE:begin -->
Milliseconds, p50 / p90 / p99, nearest rank, no trimming. In-system time on both sides: Rivet is the client on the runner VM to the actor's reply through the Engine gateway; Durable Objects is the Worker to the DO and back, timed in the Worker. Full tables, the in-DO wall times from Cloudflare's analytics and the in-actor SQL intervals are in [report/results.md](report/results.md).

| Metric | Rivet Actor | n | Durable Object | n |
| --- | --- | ---: | --- | ---: |
| Actor create, first request answered (no storage) | **4.90 / 7.18 / 7.59** | 1500 | **222 / 394 / 1,028** | 200 |
| Actor create, unique id (DO only) | **-** | - | **169 / 258 / 875** | 200 |
| Create, first request is a SQLite read | **5.44 / 7.74 / 8.69** | 1200 | **234 / 783 / 1,936** | 200 |
| Create, first request is a durable SQLite write | **7.00 / 9.14 / 10.16** | 1200 | **218 / 326 / 1,278** | 200 |
| Actor wake, first request answered | **8.22 / 12.66 / 34.10** | 1200 | **49.00 / 399 / 1,306** | 200 |
| Wake, first request is a SQLite read | **9.27 / 14.07 / 26.44** | 1200 | **49.00 / 399 / 1,306** | 200 |
| Wake, first request is a durable SQLite write | **10.42 / 16.80 / 79.62** | 1200 | **105 / 303 / 1,358** | 200 |
| Warm request round trip (no storage) | **0.84 / 1.21 / 1.43** | 2000 | **11.00 / 13.00 / 20.00** | 300 |
| Warm request round trip, getOrCreate | **0.78 / 1.17 / 1.34** | 2000 | **-** | - |
| SQLite point read, warm, in the actor | **0.08 / 0.25 / 0.41** | 1200 | **-** | - |
| SQLite point read, warm, round trip | **0.95 / 1.15 / 1.33** | 1200 | **11.00 / 12.00 / 14.00** | 300 |
| SQLite durable write (1 row), in the actor | **0.68 / 0.75 / 1.07** | 1200 | **-** | - |
| SQLite durable write (1 row), round trip | **1.52 / 1.65 / 3.01** | 1200 | **30.00 / 32.00 / 92.00** | 300 |
| SQLite scan of 1,000 rows, round trip | **1.13 / 1.26 / 2.23** | 1000 | **12.00 / 14.00 / 17.00** | 300 |

| Throughput | Rivet | Durable Objects |
| --- | ---: | ---: |
| Burst creates at concurrency 1 | **173/s** (0 errors of 500) | **3.4/s** (0 errors of 500) |
| Burst creates at concurrency 8 | **784/s** (0 errors of 500) | **26.3/s** (0 errors of 500) |
| Burst creates at concurrency 32 | **1,435/s** (0 errors of 500) | **114/s** (0 errors of 500) |
| Burst creates at concurrency 128 | **1,252/s** (0 errors of 500) | **520/s** (0 errors of 500) |
| Sequential durable writes on one actor (woken once) | **646/s** (0 errors of 5000) | **25.8/s** (0 errors of 2000) |

Durable Object rates use the Worker-timed duration of each call, like the latency rows; the client's internet round trip to Cloudflare is excluded. Bursts at concurrency c are c × 1000 / mean Worker ms (Little's law); sequential writes are 1000 / mean Worker ms.
<!-- RESULTS_TABLE:end -->

## What is measured

| Metric | Rivet Actor (this repo) | Durable Object (this repo) |
| --- | --- | --- |
| Actor create | `getOrCreate` of a new key through the Engine gateway; the actor's first request is a ping, a `SELECT` or an `INSERT`; client send to full reply | one Worker invocation that calls a brand-new DO (named id or unique id); `Date.now()` around the awaited RPC inside the Worker |
| Actor wake | the actor is put to sleep explicitly (`c.sleep()`), confirmed asleep for at least 10 s (or 120 s), then woken by its first request | a DO created at least 10 minutes earlier and idle since (DOs are evicted after about 10 s idle), woken by one call |
| Warm round trip | ping to a running actor | second call to a running DO |
| SQLite read | point read by primary key on a seeded table, value materialized in JS; the actor reports the interval around `c.db.execute` and the client reports the round trip | `sql.exec` point read inside the DO; Worker round trip, plus Cloudflare's in-DO wall time from the analytics API |
| SQLite write | one autocommit `INSERT` of a 128 B row, on an actor that has slept and woken once before the series; the reply waits for the durable commit (acknowledged by two of three zones) | one `INSERT` in a DO; the reply waits for the output gate, so it is durable |
| Scans | 1,000-row scan | the same |
| Burst creates | creates per second at client concurrency 1, 8, 32 and 128 | the same concurrencies; rate is concurrency × 1000 / mean Worker-timed create ms |
| Writes per actor | sequential durable commits per second on one actor | the same on one DO; rate is 1000 / mean Worker-timed commit ms |

Rivet samples carry the actor's own `cold` flag (first request on a fresh instance); a create or
wake counts only when that flag proves a fresh start. Durable Object samples carry the same flag
from the DO class. Percentiles are nearest rank over successful samples, without trimming;
failures are counted and never retried.

### Where the clock is

Both systems are timed in the layer that sits in front of the actor, with the client in the same
place in both cases:

- Rivet: the load driver runs on the runner VM (the RivetKit node) in the Engine's zone and
  times client send to full reply through the Engine gateway. The actor also reports its SQL
  interval and its handler interval.
- Cloudflare: the Worker times the awaited DO call (Workers freeze `Date.now()` during CPU work,
  so this captures I/O round trips, which is what a DO call is). Cloudflare's own per-invocation
  wall time, pulled from its GraphQL analytics for every block of calls, gives the Worker wall
  time and the time spent inside the DO. The Azure client's own round trip to the Worker is kept
  as a third clock and reported next to a `/noop` baseline.

So "Rivet client to reply" and "Worker to DO round trip" are both the in-system time to reach an
actor and get its answer back, excluding the public internet. The Durable Object throughput rates
are derived from the same Worker-timed durations.

## Hardware and regions

| Role | Rivet | Cloudflare |
| --- | --- | --- |
| Actors | three `Standard_L8as_v5` (8 vCPU AMD EPYC 9V45, 64 GiB, 1.7 TB local NVMe, ext4 noatime) in Azure eastus2 zones 1, 2 and 4, one Engine process each; three partitions, each replicated on all three workers and maintained by a different zone's worker | wherever Cloudflare places the DO (the analytics report the colo; from eastus2 the Worker ran in IAD and DOs in IAD and EWR) |
| Node / client | `Standard_D16as_v7` in zone 1: the RivetKit node (Node 24.10.0) and the load driver | the same VM runs the Cloudflare client |
| Cold store | Azure Blob, Standard LRS, Hot, eastus2 | n/a |

Engine configuration: `rivet/engine/overrides.json` raises the per-process caps and disables
automatic partition balancing, so partition placement is identical on every run and results
are reproducible. It otherwise keeps defaults.

## Reproduce it

Requirements on your machine: `terraform` 1.5+, `az` logged in to a subscription with the
resource group, `gh`, `jq`, `node` 22+, `pnpm` 10, and a wrangler login for the Cloudflare side.

1. `cp infra/azure/terraform.tfvars.example infra/azure/terraform.tfvars` and set your SSH
   source address (and the resource group if it is not `rivet-vs-do-bench`).
2. `scripts/provision.sh` creates the VMs, network and storage account.
3. `scripts/deploy-rivet.sh` installs the pinned Engine release on the storage VMs (downloaded
   from the Docker image by digest, hash-checked), provisions the partitions, installs Node and the
   RivetKit app on the runner, and checks a probe request.
4. `scripts/run-rivet.sh <run>` runs the Rivet suite (about 15 minutes). `scripts/run-rivet.sh <run> create wake` runs only some groups.
5. `scripts/run-cloudflare.sh <run>` deploys the Worker and runs the Durable Object series from the
   runner VM (about 40 minutes, including the ten-minute idle wait before the wake sets).
6. `scripts/collect.sh <run>` copies raw results into `results/<date>/`, then
   `scripts/cf-analytics.sh <date>` adds Cloudflare's wall times.
7. `node scripts/report.mjs results/<date>` regenerates `report/`, `node scripts/update-readme.mjs`
   refreshes the headline tables in this README, and
   `python3 scripts/headline-chart.py results/<date>` redraws `report/charts/headline.png`.
8. `scripts/destroy.sh` removes everything the Terraform created.

The Rivet app (`rivet/app`) is plain RivetKit: an actor with no database and one with a SQLite
table, each answering timed requests. The driver (`rivet/bench/bench.mjs`) speaks to the Engine
gateway over HTTP with `undici`. The Cloudflare bench (`cloudflare/`) is one Worker, one DO class
and a driver with the same shape.

## Caveats

- Rivet ran on three Azure `Standard_L8as_v5` VMs (local NVMe) across three zones; Durable Objects
  ran on Cloudflare's own hardware and placement. A DO's wake cost depends on how long it was idle
  and on what tier its storage sits in, which Cloudflare does not expose.
- The Rivet SQLite "in the actor" intervals exclude HTTP; the round-trip rows are the comparable
  numbers.
- One run per condition (1,000 to 2,000 samples per Rivet row, 200 to 1,000 per Durable Object
  row), one region. The Durable Object and Rivet runs are a day apart (2026-10-27 and 2026-10-28).
- The 10 GB per-object limit of Durable Objects is documented by Cloudflare and was not probed;
  Rivet's database size is bounded by the object store.
