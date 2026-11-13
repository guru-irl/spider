# Roaming agents

## Goals and scope

A top-level pi session can live on a remote Linux machine and keep working while the Mac is off. Moving an idle session between the Mac and a box takes one action. Spider's portable database rows merge when the machines reconnect.

The Mac is the database and move hub. Sync and moves require an awake Mac, but active homes continue without it. The hub runs as a launchd user service independently of pi, with one process lock and a two-minute default sync period per peer. Live intercom uses separate bridges. Approved peer mode delivers box-to-box messages with the Mac off. Hub-only fallback does not.

Version 1 includes replication, provisioning, restart, and idle moves. Children stay with their parent. Moves refuse unsettled work. Acceptance gates both directions first.

Resume restores conversation and triggers, not execution or a continuation prompt. Examples are synthetic. Private receipts and credentials stay outside the repository.

## Ownership and component boundaries

A machine has a random UUID in a private `machine.json`. The routing alias `box-1.invalid` is not that identity. A home is `{sessionId, machineId, epoch}`. Only the hub writes `session_homes`, assigning initial homes and using compare-and-swap for later epochs. Each home change, including rollback, increments the epoch.

Durable local session state is `active`, `frozen`, or `retired`. For participants, a session-ID lock prevents duplicate local IDs. The existing canonical-file lease protects one file. Neither lock crosses machines. Existing file-lease claims check liveness under a process lock (`packages/herdr/src/sessions/lease.ts:75-101`).

A source acknowledges freeze only after its admission gates and database writers are stopped and its frozen state is durable. Freeze never expires. A frozen or retired copy cannot reactivate from a cached home. An offline active home can continue because the hub cannot move it without that source's fresh freeze acknowledgement.

After home commit, the hub calls `session start` at epoch `e + 1`. Persist readiness before consumers. Thereafter recovery stays at destination, even with lost replies. Rollback requires proved launch failure and retirement. Lost-machine recovery is the exclusion exception.

| Owner | Responsibility |
| --- | --- |
| `@spider/db-core` | Portable keys, schema migration, generated SQL capture, HLC comparison, export, apply, and read-only replica resolution. |
| New `@spider/roam` | Hub, supervisor, provisioning, operation journals, sync orchestration, move transitions, bridge storage, exchange scheduling, and enrollment through injected ports. No pi imports. |
| New `@spider/intercom` | Forked tool, client, broker, federation protocol, receipts, and skill. |
| `@spider/herdr` | Generic argv execution, chunk transfer, exact-file terminal launch, and Mac-only placement. It does not import roaming. |
| `@spider/host` | First-registered admission handler, fork loading, identity and admission integration, per-session control socket, lifecycle guards, `/move`, readiness, and usage adapters. |
| `@spider/subagents` | Local-origin checks for operational run consumers, a read-only blocker inventory, and remote-aware dispatch that bypasses mirror bodies and replay. |

Publish `dist/roam/cli.mjs` and `dist/roam/supervisor.mjs`, add root `bin.spider`, and install the Mac shell command. The root has no `bin` (`package.json:1-151`). `/move` is primary. Help opens no DB or Herdr connection.

Configuration holds role, hub, replication peers and executable paths, discovery roots, core unit, sync period, limits, and separate intercom mode and routes. Boxes have no outbound replication peers. Only the Mac changes homes. Peer intercom access is separately approved. Validate CLI, configuration, SQL, file, and hc boundaries.

## Checked starting point

The checked source baseline is `e732fa07`, the parent of the original design commit.

| Existing behavior | Checked source |
| --- | --- |
| Registry keys and DB placement come from local worktree and Git common-directory paths. | `packages/db-core/src/registry.ts:69-75`, `packages/db-core/src/registry.ts:108-130` |
| Core schema version is 13. Its early return also accepts future versions. | `packages/db-core/src/migrate.ts:4-8`, `packages/db-core/src/migrate.ts:163-168` |
| Todos have integer IDs and per-session sequences without a uniqueness constraint. Run events have integer IDs. | `packages/db-core/src/schema.ts:140-164` |
| Core connections use WAL. Wrapper effects run after transaction commit. | `packages/db-core/src/db.ts:132-141`, `packages/db-core/src/db.ts:153-183` |
| The reaper selects active runs with a nonnull `host_pid`. Durable adoption requires a supervisor directory from an event. | `packages/subagents/src/reaper.ts:24-45`, `packages/subagents/src/durable-adoption.ts:21-40` |
| Run-event append also publishes an operational bus event. | `packages/db-core/src/events.ts:28-43` |
| Herdr currently requires app configuration and constructs an app client during activation. | `packages/herdr/src/config.ts:29-60`, `packages/host/src/herdr/mount.ts:459-502` |
| hc launch supports remote addressing, background lifetime, labels, and no notification. File reads return text and writes accept bytes. | `packages/herdr/src/client/hc.ts:122-148` |
| Terminal mappings persist exact session files. Removal requires proof that the terminal was removed. | `packages/herdr/src/sessions/registry.ts:90-106` |
| Trigger restore reads `spider-triggers` entries for the same persistent session. | `packages/host/src/loop/index.ts:159-186` |
| Usage has its own shipped migrations and complete-layout validation. Startup restores unreported run usage. | `packages/host/src/usage/migrate.ts:9-23`, `packages/host/src/usage/migrate.ts:43-68`, `packages/host/src/usage-accounting.ts:90-92` |

Pi citations use `pi/` for the installed coding-agent package at version 1.2.0. Explicit-file open derives runtime cwd from the header, unless an override is passed (`pi/dist/core/session-manager.js:1326-1347`). Missing or empty files can initialize a new session (`pi/dist/core/session-manager.js:665-689`). Loading selects the last physical entry as the leaf (`pi/dist/core/session-manager.js:732-741`). The public API exposes `getLeafId()` (`pi/dist/core/session-manager.d.ts:289-290`).

## Portable identities and reads

### Repository and workspace identity

Normalize HTTPS, SSH URL, and scp-style origins. Remove credentials, query, fragment, default ports, trailing slash, and one trailing `.git`. Lowercase the host, preserve path case and nondefault ports, and decode only unreserved escapes. Default-port HTTPS and SSH identify the same repository. Hash the resulting host and path as `origin:<sha256>`. Never send the credential-bearing URL.

Run a service-specific canonicalizer table first. It maps a legacy host family to its canonical host and drops the default collection segment. Synthetic fixtures equate `https://org.legacy.example/DefaultCollection/team/_git/repo`, `https://code.example/org/team/_git/repo`, and `git@ssh.code.example:v3/org/team/repo`. All produce `code.example/org/team/repo`. Unknown services use generic normalization or explicit maps, never guessed cross-host equivalence.

Without a usable network origin, hash the sorted root commit set from `git rev-list --max-parents=0 --all` as `root:<sha256>`. Cache that result per common repository, rather than walking all refs on each move. An explicit repo map refreshes the cache. An origin change, repository replacement, or changed fallback result requires an explicit mapping decision, never silent rekeying. An unborn repository needs an explicit key.

`spider roam repo map <repo-key> <path>` pins an identity locally. An optional per-repo `worktreeCommand` argv replaces `git worktree add` for a repository that needs its own worktree tool. Discovery proposes mappings within configured roots. Ambiguous mappings refuse transfer. Each logical checkout has a workspace UUID, independent of branch name, with one mapped checkout per machine. Linked worktrees have distinct UUIDs but share repo memory.

Store keys are `global`, `repo:<repo-key>`, and `worktree:<repo-key>:<workspace-id>`. On apply, local maps derive DB placement and registry paths. Wire records never contain those paths. Non-Git data can sync under an explicit key, but automatic workspace transfer requires Git. A separate binding also requires a destination map.

### Hub reads without a checkout

Only the hub keeps unmapped stores, under `<globalRoot>/roam/stores/<store-key-hash>.db`. A box receives global memory, mapped repo memory, and worktree stores it hosts or is preparing to host. The Mac remains the full replica of all participating stores. A missing box mapping is not permission to invent a checkout.

Local `roam_locations` maps each session to its portable stores, latest home, and any local exact file and cwd. On the hub, session-addressed todo views, session search, and run history resolve through this catalog. A remote home's reads use the mapped replica or unmapped hub store, read-only. Thus `spider todo view session=<id>` works for a box-created worktree that has no Mac checkout. Default current-worktree search keeps its current scope.

Later mapping merges versions and tombstones, verifies equality, and retains a read-only redirect. Never copy integer IDs or fabricate foreign-path `projects` rows. Unavailable historical locators display their origin, not a coincidentally matching local file.

## Data model and migration

### Portable rows

The descriptor registry is the single source for row keys, SQL projections, session predicates, and export codecs. It generates literal SQL at build time. Persistent triggers contain no application-defined functions.

| Entity | Portable key and projection | Additive source changes |
| --- | --- | --- |
| `global_memory`, `memory` | UUID. All existing columns except local integer `id`. | Nullable `machine_id TEXT` on both tables. |
| `sessions` | `id`. Existing columns except `imported_from`, plus origin. | `origin_machine TEXT NOT NULL DEFAULT ''`. |
| `todos` | UUID. All columns except integer `id`. | Nullable `uuid TEXT`, filled after insert. |
| `runs` | Existing UUID `id`. All columns except `pid`, `host_pid`, `pid_start_time`, and `intercom_session`. | `origin_machine TEXT NOT NULL DEFAULT ''`. |
| `run_events` | UUID. All columns except integer `id`. Payload follows the export policy below. | Nullable `uuid TEXT`, filled after insert. |
| `session_homes` | `session_id`, with `machine_id`, positive `epoch`, nullable `move_id`, and `updated_at`. | New global table, writable only by the hub command path. |

Session origin is the creation machine. Run origin is the execution machine. Both are immutable. Events derive origin from their run, or their envelope without a run. Envelope `writer_epoch` diagnoses late writes without apply-time authorization. Imported historical identities do not roam. No search-source columns or import-relocation migration are added.

### Migration and local state

Raise core schema to 14 with additive migrations and matching fresh DDL for all three scopes. Read `user_version` inside an IMMEDIATE transaction. A newer version fails before application queries. Before migrating each existing core DB, synchronously `VACUUM INTO` one mode-0600 backup under `<globalRoot>/roam/backups/`, after a free-space check. Backup failure refuses migration. Keep the backup after success or failure. Validate owned columns, indexes, and triggers on writable opens. Missing data columns refuse open. Trigger-shape drift disables capture for that store and doctor reports it, never refusing open. Pin generated SQL to schema 14. Do not edit shipped version-13 SQL.

Backfill todo and event UUIDs with `lower(hex(randomblob(16)))`, preserving local integer IDs and FTS rowids. Create unique UUID indexes. Existing session and run origins become the local machine ID. New SQL inserts that omit these fields get plain-SQL after-insert fills. UUID and origin updates are immutable once nonempty. Normalization updates produce only one captured insertion, including on connections with recursive triggers enabled.

Before adding unique `(session_id, seq)` for todos, detect duplicates. If present, skip that index, commit the rest of migration, set the store non-roamable, and report conflicting row IDs. Ordinary spider work continues at v14. Doctor repairs nothing automatically. After deliberate repair, enable creates the index and clears the flag. Layout validation explicitly permits only this diagnosed missing-index case.

Worktree-local `roam_sessions` has primary key `session_id`, `epoch`, `state`, `move_id`, and freeze barrier sequence. State is `active`, `frozen`, or `retired`. Table membership controls participation. SQL reads state in the writing transaction. Frozen writes raise, rather than silently escape capture. Hub and participant journals record move actions and results. Maps, locations, and supervisor intent stay local.

A session joins replication at its first move preparation or creation on a box. Without a home row, its session origin owns it. The hub records epoch 1 at first sync after collecting observed origins. Conflicting unassigned origins persist a replicated `session_homes` marker with `machine_id=''`, epoch 1, and no move ID. This is not an assigned home. It blocks admission and requires `spider roam claim <session> <machine>`, only for an unassigned initial home with all conflicting machines reachable and competing copies stopped. Existing homes change through moves or explicit lost-machine recovery, never automatic offline takeover.

A first move checks against the synthetic expected home `{origin, epoch: 1}`. Seed and sync must establish that exact owner and epoch before freeze. At first-move `checked`, add active membership and seed unversioned session rows in bounded, resumable transactions while ordinary capture continues. Sync the seed before freeze. Abort retains membership. Freeze only changes state and ships the delta. Its local journal spans stores, and acknowledgement waits for every store. New box admission records origin, active membership, and seeds before ordinary consumers. The first seed chunk sets `store_key` and enables capture. Enable seeds global and mapped repo memory atomically on every machine and enables hub global capture for homes. Memory uses LWW without session freeze.

### Common replication tables

These tables belong to canonical core DBs, never `usage.db`. Initialize machine and stream UUIDs with capture disabled. The nullable store key is filled before capture or sync. Stream identity belongs to a concrete replica, not its path.

```sql
CREATE TABLE roam_meta (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	machine_id TEXT NOT NULL,
	stream_id TEXT NOT NULL UNIQUE,
	store_key TEXT,
	hlc_ms INTEGER NOT NULL DEFAULT 0,
	hlc_count INTEGER NOT NULL DEFAULT 0,
	capture_enabled INTEGER NOT NULL DEFAULT 0,
	importing INTEGER NOT NULL DEFAULT 0,
	roamable INTEGER NOT NULL DEFAULT 1,
	problem TEXT
);
CREATE TABLE roam_changes (
	seq INTEGER PRIMARY KEY AUTOINCREMENT,
	change_id TEXT NOT NULL UNIQUE,
	entity TEXT NOT NULL,
	row_key TEXT NOT NULL,
	op TEXT NOT NULL CHECK (op IN ('put', 'delete')),
	hlc_ms INTEGER NOT NULL,
	hlc_count INTEGER NOT NULL,
	origin_machine TEXT NOT NULL,
	origin_stream TEXT NOT NULL,
	writer_session TEXT,
	writer_epoch INTEGER,
	schema_version INTEGER NOT NULL,
	body_json TEXT,
	wire_json TEXT,
	CHECK ((op = 'delete') = (body_json IS NULL))
);
CREATE TABLE roam_versions (
	entity TEXT NOT NULL,
	row_key TEXT NOT NULL,
	change_id TEXT NOT NULL,
	hlc_ms INTEGER NOT NULL,
	hlc_count INTEGER NOT NULL,
	origin_machine TEXT NOT NULL,
	origin_stream TEXT NOT NULL,
	deleted INTEGER NOT NULL,
	PRIMARY KEY (entity, row_key)
);
CREATE TABLE roam_cursors (
	peer_machine TEXT NOT NULL,
	peer_stream TEXT NOT NULL,
	last_seq INTEGER NOT NULL,
	PRIMARY KEY (peer_machine, peer_stream)
);
CREATE TABLE roam_receipts (
	peer_machine TEXT NOT NULL,
	batch_id TEXT NOT NULL,
	peer_stream TEXT NOT NULL,
	after_seq INTEGER NOT NULL,
	through_seq INTEGER NOT NULL,
	sha256 TEXT NOT NULL,
	applied_at INTEGER NOT NULL,
	PRIMARY KEY (peer_machine, batch_id)
);
```

`body_json` is the captured projection. Export converts declared locators once, caching portable content in `wire_json` before publication. Leave `wire_json` NULL when equal to `body_json`, including imports. Forwarding and dedupe use `coalesce(wire_json, body_json)` without changing envelopes.

### Plain-SQL capture and freeze fences

Doctor checks SQLite >=3.42 for every writer, including the CLI. This generated todo SQL uses the additive UUID column and local session-state table. UUID fill works even with capture disabled, so old applications can omit UUIDs.

```sql
CREATE TRIGGER roam_todos_uuid_fill AFTER INSERT ON todos
WHEN NEW.uuid IS NULL OR NEW.uuid = ''
BEGIN
	UPDATE todos SET uuid = lower(hex(randomblob(16))) WHERE id = NEW.id;
END;
CREATE TRIGGER roam_todos_uuid_fixed BEFORE UPDATE ON todos
WHEN OLD.uuid IS NOT NULL AND OLD.uuid != '' AND NEW.uuid IS NOT OLD.uuid
BEGIN
	SELECT RAISE(ABORT, 'roaming UUID cannot change');
END;
CREATE TRIGGER roam_todos_frozen_bi BEFORE INSERT ON todos
WHEN (SELECT importing FROM roam_meta WHERE id = 1) = 0
BEGIN
	SELECT RAISE(ABORT, 'session is frozen')
	WHERE (SELECT state FROM roam_sessions WHERE session_id = NEW.session_id)
		IN ('frozen', 'retired');
END;
CREATE TRIGGER roam_todos_capture_ai AFTER INSERT ON todos
WHEN NEW.uuid IS NOT NULL AND NEW.uuid != ''
	AND (SELECT capture_enabled = 1 AND importing = 0 FROM roam_meta WHERE id = 1)
	AND EXISTS (SELECT 1 FROM roam_sessions WHERE session_id = NEW.session_id)
BEGIN
	UPDATE roam_meta SET (hlc_ms, hlc_count) = (
		WITH sample(ms) AS (
			SELECT CAST(unixepoch('subsec') * 1000 AS INTEGER)
		)
		SELECT max(roam_meta.hlc_ms, sample.ms),
			CASE WHEN sample.ms > roam_meta.hlc_ms THEN 0 ELSE roam_meta.hlc_count + 1 END
		FROM sample
	) WHERE id = 1;
	INSERT INTO roam_changes (
		change_id, entity, row_key, op, hlc_ms, hlc_count,
		origin_machine, origin_stream, writer_session, writer_epoch,
		schema_version, body_json
	)
	SELECT lower(hex(randomblob(16))), 'todos', NEW.uuid, 'put', hlc_ms, hlc_count,
		machine_id, stream_id, NEW.session_id,
		(SELECT epoch FROM roam_sessions WHERE session_id = NEW.session_id), 14,
		json_object('uuid', NEW.uuid, 'session_id', NEW.session_id, 'seq', NEW.seq,
			'text', NEW.text, 'done', NEW.done, 'created_at', NEW.created_at,
			'updated_at', NEW.updated_at)
	FROM roam_meta WHERE id = 1;
	INSERT INTO roam_versions
	SELECT entity, row_key, change_id, hlc_ms, hlc_count,
		origin_machine, origin_stream, 0
	FROM roam_changes WHERE seq = last_insert_rowid()
	ON CONFLICT(entity, row_key) DO UPDATE SET
		change_id = excluded.change_id, hlc_ms = excluded.hlc_ms,
		hlc_count = excluded.hlc_count, origin_machine = excluded.origin_machine,
		origin_stream = excluded.origin_stream, deleted = excluded.deleted;
END;
```

Generate the remaining literal SQL with these rules:

- Every entity has after-insert, after-update, and after-delete capture. Update uses the same clock, log insert, and version upsert as insertion, but compares the old and new projected `json_object` values with `IS NOT`. UUID fill is therefore captured by after-update once, while the insert trigger skips its null `NEW.uuid`. An explicit UUID insert is captured once by after-insert. Do not depend on trigger creation order.
- Delete uses `OLD` keys and session, `op = 'delete'`, a null body, and `deleted = 1`. UUID, session ID, and other portable primary identities cannot change. Runs normalize an omitted origin before capture using the same fill-and-update pattern. PID-only changes are absent from projections and emit nothing.
- Worktree participation requires `roam_sessions` membership. Session identity is `sessions.id` or the other row's `session_id`. Generate before-update and before-delete frozen checks using `OLD.session_id`, with `OLD.id` for sessions. Before-update also checks the new session identity. All fences bypass only when `importing = 1`. Memory and homes have no session predicate or writer epoch.
- Source and capture changes share the caller's transaction. Any trigger failure rolls everything back. No SQL function performs reentrant connection queries. A CLI connection and an older build register no functions and can still write unrelated sessions and active participating sessions.

Apply inserts a missing `retired` membership row for each foreign participating session in the same transaction as its first rows. Existing local state is unchanged. Apply sets `roam_meta.importing = 1`, mutates rows, inserts original envelopes, updates versions and cursors, then clears the flag within one IMMEDIATE transaction. A crash rolls back the flag. SQLite's single-writer rule prevents another connection from exploiting it.

Cross-session todo edits get one admission check in the todo store. Mutating a participating session's todos requires that session's current home and active local state. Allocation uses an IMMEDIATE transaction. After resolving a display sequence, updates and deletes address the UUID. Other-session views remain read-only. A locally originated write after its session's freeze barrier reports a doctor error with `writer_epoch`, without an apply-time history dependency.

## Replication protocol

### Batches and convergence

A handshake checks enrolled machine identity, current core identity, protocol 1, and core schema 14. Reject mismatches before mutation and identify the machine needing repair. A core identity change invalidates handles. Restart fails in-flight calls, and journalled retries make that safe. There is no downgrade projection or local fallback after remote failure.

Export emits immutable UTF-8 NDJSON from a SQLite snapshot. The header has protocol, schema, batch ID, sender machine and stream, store key, exclusive `after`, inclusive `through`, and record count. Each record has sender sequence, change ID, entity, row key, operation, original HLC, writer session and epoch, schema, and body. A separate manifest has byte length and SHA-256. Export never holds a writer transaction across transport.

Sequences order local exports, not conflicts. Forwarding preserves change ID, HLC, and portable body with a new local sequence. Dedupe before log insertion, never with `INSERT OR IGNORE`. Unpruned logs are contiguous. Export requires sequences `after + 1` through `through`; a gap is corruption. Accept only a matching durable cursor or exact receipted replay. Re-export other overlaps. Empty exports return count zero and `through = after`, with no import or receipt.

Batch selection uses bytes and observed apply time, not a record-count cap. Receipts adjust the byte target, including lexical work. Apply time is a target, not a timeout. Larger rows use singleton batches within hard limits. Oversized rows stop the store with their key, never trimmed data.

Compare row versions lexicographically by `(hlc_ms, hlc_count, origin_machine, origin_stream)`. On local capture, use the larger of wall time and durable milliseconds, reset the counter to zero when wall time wins, and increment otherwise. On receive, let `m` be the maximum of local milliseconds, remote milliseconds, and wall time. If both clocks equal `m`, use their maximum counter plus one. If one equals `m`, increment its counter. Otherwise use zero. Persist that observation with apply. Reject overflow and any remote clock more than five minutes ahead of receiver wall time. Backward wall-clock changes retain logical progress.

Validate the whole artifact before an IMMEDIATE apply transaction. Append every unseen envelope, including losing versions. A winning put replaces the portable row. A winning delete removes it and retains a tombstone. Equal clocks with different contents or IDs are corruption. Change-ID uniqueness prevents loops. Logs, seen IDs, and tombstones remain indefinitely.

Only hub-origin changes alter homes. Reject lower epochs and equal epochs with different owners or move IDs. Session data does not wait for historical home records. Admission uses the current home. HLC resolves concurrent memory rows, including archive and approval status, without merging fields or rerunning review. Report memory-cap overflow instead of deleting accepted rows.

### Apply receipts and conflicts

Commit row changes, tombstones, original log inserts, HLC observation, local FTS maintenance, embedding-queue changes, receive cursor, and digest-bound receipt together. Return batch ID, stream, `through`, digest, and apply duration only after commit. Lost replies are reconciled by operation ID and receipt. Never infer failure from a timeout and start an unrelated replacement import.

Duplicate IDs must have the same canonical envelope. Replays do not allocate another local rowid, publish completion, or bill usage. Invalid batches leave cursors unchanged. Stores commit independently. Moves wait for every required store barrier.

On secondary unique conflict, an incoming todo for a non-home session replaces a different-UUID local row at the same `(session_id, seq)` only if the local row has no log entry. Remove its FTS entry transactionally. Otherwise quarantine the batch, preserve the cursor, and report both UUIDs. Never renumber a tracked todo or discard its tombstone.

The hub pulls a peer's available changes before pushing the merged stream back. One transfer runs per peer. Peers progress independently. First sync runs at hub startup. Disconnected peers retry after 30, 60, and then 120 seconds. Sync does not launch or restart the Mac app or core. If either is closed, report the unavailable function. App closure delays placement. Mac core closure prevents box transport.

### Derived data and event policy

`applyBatch` alone writes base rows and lets SQLite allocate local IDs. It then calls derived effects with the prior rowid and body and the resulting rowid, or NULL for a delete, in the same transaction. Effects update only derived state, including todo and active-memory FTS. Session FTS uses replicated name and summary. Keep imported excerpts local and preserve unrelated imported FTS rows. Memory changes remove stale vectors and enqueue current text transactionally. Embedding completion retains the existing `(id, text, enqueued_at)` guard before clearing work. Lexical search needs no embedding provider.

Apply emits only a post-commit replica invalidation, not operational run events. Foreign runs have all process columns nulled, including intercom identity. Export strips supervisor directories, transcript directories, endpoints, and tokens from known `child_supervisor` and `child_transcript` payloads. `chain_steps` becomes a count and origin-qualified history reference, never executable continuation data.

Unknown event types and versions export unchanged as inert history. A unit test requires an explicit policy for every known producer type, including dynamic child events. This catches omissions in CI without stopping production sync when a producer adds an event. Existing named helpers are in `packages/subagents/src/run-events.ts:4-30`.

Reaper, adoption, kill, completion delivery, run-status mutation, and usage reporting require local run origin. Foreign delivery and accounting sentinels are history only. Preserve local per-run event order when forwarding and allocating replica rowids. There is one execution writer per run, so no extra origin-sequence column is needed. A rebuilt replica has no PIDs or supervisor directories to adopt, even when it receives its own old history.

Machine tags use nullable UUIDs, not changeable aliases. NULL applies everywhere. Injection excludes other-machine rows. At enable, doctor lists likely machine-specific entries without rewriting prose. `spider roam memory tag <store-key> <uuid> <machine|all>` changes only that tag, leaving doctor read-only.

Registry placement, bindings, routes, leases, message delivery, usage DBs, skills, curator state, indexed content, routing events, upstream-watch state, native indexes, ownership files, job journals, and backups never replicate. Moves reconstruct placement and bindings. Only declared locator fields become `{machineId, repoKey, workspaceId, relativePath}` or opaque origin-qualified references.

## Herdr transport and measured limits

Invoke the pinned remote CLI by argv through `hc exec --on`. Long operations use labelled `hc run --bg --no-notify --outlive-parent --no-parent` with receipts. Add no routable listener. Additional private loopback routes are limited to approved intercom enrollment. Commands check operation ID, machine, and expected epoch. Private socket modes remain, but same-user capability files are unnecessary.

Commands cover inventory, export, import, cursor and receipt inspection, artifact split and assembly, and session inspect, freeze, start, retire, and unfreeze. Journal argument digests before effects. Repeated IDs reconcile. Changed arguments under one ID fail.

Admission serves a per-session mode-0600 control socket in a 0700 runtime directory keyed by the session-ID hash. It accepts only `inspect`, `freeze`, `unfreeze`, and `shutdown`, checked against move ID and expected epoch. Session CLI commands contact the live lease owner. Live retirement requests shutdown, then records retirement after proved exit. With proved absent ownership, the CLI holds both local locks and uses a dormant path: journal and write freeze, unfreeze, or retirement directly, and read the last physical entry as pi's loader does. Uncertain ownership blocks.

### Measured limits

The box spike measured one test box over its Herdr connection while another workload ran on it. Writes of 384 KiB chunks through `hc file write` took a median of 0.22 seconds (p90 0.70, about 1.2 MiB/s). Byte-exact binary reads through `hc exec --on <machine> -- cat <path>` took a median of 0.18 seconds (p90 0.20, about 2 MiB/s). A no-op `hc exec` took 0.13 seconds. `hc file read --json` refuses binary content, so binary reads use `cat`. Values below derive from those numbers, with margin. At these rates a 200 MiB session artifact takes about three minutes to send, which is why it is pre-staged before freeze.

| Limit | Value | Application |
| --- | --- | --- |
| Raw chunk | 384 KiB | Written raw through stdin and read raw through `cat`. The slowest measured call took under 2 seconds. |
| Single hc reply budget | 1 MiB | Matches the existing client ceiling in `packages/herdr/src/client/limits.ts:2-7`. |
| Manifest page | 512 KiB | Digest-linked pages describe larger artifacts. |
| Export batch target | 4 MiB | Adapt downward to the apply-time target. |
| Apply-time target | 250 ms | Includes lexical maintenance, not transport. |
| Hard batch and single-row wire limit | 16 MiB | Includes the header and newlines. Larger rows travel alone only if the whole batch fits. No record-count cap. |
| Workspace bundle total per move | 256 MiB | Includes pre-stage and final delta. Refuse above it, never send full history. |
| Session artifact | 1 GiB | Stream the JSONL, not one buffered reply. |
| Release or agent-file artifact | 256 MiB | Split selected files into separately bounded artifacts. |
| Staging quota per peer | 4 GiB | Includes encoded chunks and reconstructed files. |
| File call deadline | 30 seconds | Each chunk read or write, about 15 times the slowest measured call. |
| Control call deadline | 60 seconds | Inventory, cursor, or session-control call. |
| Export command deadline | 120 seconds | Separate from ordinary client defaults. |
| Import command deadline | 600 seconds | Includes FTS work and commit. |
| Direct hc execution maximum | 600 seconds | Longer operations use background receipts. |
| Background launch call deadline | 60 seconds | The returned terminal is not operation completion. |
| Destination readiness deadline | 60 seconds | Expiry means unknown until reconciled. |
| Artifact transfer deadline | 30 minutes | Pause and retain resumable staging on expiry. |
| Concurrent peer transfers | 2, unmeasured | Never overlap transfers to the same peer. |
| Chunk retry policy | 3 retries, after 1, 2, and 4 seconds | Reuse immutable chunks and the operation ID. |

Override the shorter client deadline (`packages/herdr/src/client/cli-transport.ts:8-12`) with the table's command deadlines. The model-facing copy cap does not apply here.

Chunks carry artifact ID, index, raw length, and SHA-256. Resolve the machine once per transfer. Write through raw stdin and read through a raw-bytes exec path, not the JSON-parsing client. Manifests order hashes and record length and whole-file hash. Receive into exclusive-create private staging, verify, fsync, then atomically rename. Reuse matching chunks. A conflicting digest or incomplete data cannot install or advance cursors.

Committed transfer artifacts can be removed after receipt verification. Incomplete staging survives service restart and expires after seven days only when no live move or unapplied batch references it. Quota errors name the directory and stop transfers. They never delete source workspaces, database logs, or tombstones. Lower limits locally. Raising limits requires explicit configuration, never automatic fallback.

## Cross-machine intercom

Intercom ships inside spider as `@spider/intercom`, a clean fork of pi-intercom 0.13.0 under its MIT licence. Spider owns and develops the fork. No separate intercom package installation, version pin, upstream release, or tracking process is required. Preserve Nico Bailon's copyright and the complete licence in the package and distributed notices.

An admitted session can list, send to, ask, and reply to sessions on enrolled machines by name through the existing `intercom` tool. Lists and incoming headers show the machine. Local messages retain the local broker. Remote messages use a live bridge channel, never database sync or replicated message rows.

### Fork adoption and rolling deployment

First ship the fork without messaging behavior changes. Preserve the tool name, local broker protocol and framing, socket discovery, scope, configuration, stable IDs, pending-ask files, and existing state under the configured pi agent directory's `intercom` directory. Bring in the complete 0.13.0 source test inventory and port it to the repository's test runner. Record public source provenance once. Ship the intercom skill once through spider.

Spider's extension loads the fork directly in parent sessions and RPC children, including `PI_SUBAGENT_CHILD=1`. Children retain `--no-extensions` and explicitly load the spider bundle, never resolve `pi-intercom` through user or project settings. Remove the separate child extension lookup and migrate its callers, child identity environment, and launch records to bundled-fork availability. User and project `pi-intercom` declarations therefore cannot load alongside the fork in a child. Reject legacy intercom paths in forwarded child extension lists before spawn. An unexpected child conflict triggers the guard and fails child readiness, not a fallback to the legacy copy. Parent conflicts retain the behavior below.

Bundle a separate compiled broker entry and spawn it with `process.execPath`, without requiring tsx or package-manager execution at runtime. Resolve packaged entries from the running release, not cwd.

The fork checks for another intercom before registering functional handlers, the tool, or a broker connection. During factory loading, collect foreign intercom registry-ready signals. At `session_start`, after pi binds the runtime, inspect `pi.getAllTools()` before registering. That API is unavailable during factory loading. A conflict disables the fork, leaves the existing intercom alone, and reports `Another intercom extension is loaded. Remove its package or extension entry and run /reload.` Doctor reports `intercom-extension-conflict`. Cover both load orders, repeated fork loads, project declarations, and explicit extension paths.

The deploy transaction ships the fork and removes the separately installed `pi-intercom` declarations from pi settings together. Include string and object package declarations and explicit extension and skill paths in each selected settings scope. Do not silently edit unrelated projects. An unresolved project or manual duplicate blocks readiness through the runtime guard. Back up changed settings and make retries and rollback safe.

Old and new clients interoperate through the same socket and broker protocol during staggered `/reload`s. Keep the old package files until no old client can reconnect or respawn its broker. Do not uninstall its files merely because its settings declaration was removed. Do not force-stop a legacy broker with connected clients, ask edges, or queued mail. A legacy broker without a quiescence query is not proof of an empty mailbox. Report migration pending until clients drain and the broker exits naturally, or an explicit supported metadata query proves quiescence. Federation remains unavailable on that broker. Never unlink a live socket to force takeover.

### Broker federation and topology

The Mac hub and each box supervisor own one machine-local bridge, independently of pi and the app. Extend `HubRuntimePorts`, not `HubPorts`. The bridge has one writer, a process lock, and a private queue database. It continues with no session clients.

The bridge connects to the local broker as one privileged federation client. Negotiate broker feature `federation-v1` alongside existing features. Only one bridge can register for the configured pi agent directory. Helpers request exchanges through this private broker connection but do not register as additional bridges. The bridge requires the correct agent directory and compatible broker before advertising remote readiness. Its connection prevents the broker's no-session idle exit. Account for one steady broker process even when no pi session is connected.

The broker adds remote roster entries and routes remote sends, receipts, and controls to the bridge. It derives the real local sender. It never queues remote mail in its in-memory mailbox. Remote entries carry portable identity, scope, machine, endpoint, and `remote: true`. They cannot shadow a local ID or carry local PID, trust, or process-control handles. Clients preserve existing confirmation, attachment handling, inbound-trigger policy, reply inference, self-target refusal, and one outbound ask. Local behavior remains unchanged. Legacy clients retain local compatibility and are not offered unsupported remote entries.

Use the existing private broker socket for federation and helper exchanges. Its directory has mode 0700 and socket mode 0600. Reject overlong paths before bind and never fall back to TCP. The separate admission socket still accepts only `inspect`, `freeze`, `unfreeze`, and `shutdown`.

Configuration separates intercom routes from replication peers. Boxes have no outbound replication peers and cannot assign homes. Intercom has `hub-only` and `peers` modes, disabled until acceptance.

In `peers` mode, each box pair has one bidirectional enrolled edge. The lower persistent machine UUID initiates it. The Mac initiates its existing box edges. Box-to-box delivery continues with the Mac off. Do not elect relays, discover additional machines, or silently switch modes.

In `hub-only` mode, the Mac relays box traffic over the specified two-edge path. With the Mac off, ordinary sends queue at their source and asks report `link-down`. This fallback does not pass peer-mode acceptance.

### Enrollment and revocation

Box-to-box enrollment is approved separately from pi-auth transfer. Provisioning shows the selected persistent machine identities, directed access graph, and this consent text before transport effects:

> Enrolling this pair lets the initiating box execute commands as your user on its peer. A compromised initiating box can access every peer enrolled to it. This approval is separate from copying pi authentication. Revoke the pair by removing its dedicated authorized key and hc machine route.

Notify the machine owner or coordinating operator before any box contact. Do not disturb running hc jobs. Provisioning can install the approved loopback connector, ask the user to complete device-code sign-in on each initiating box, authorize a dedicated key per pair, and run argv-based hc enrollment. Use `from="127.0.0.1",restrict` on each authorized key. Reuse an existing key-only loopback SSH service and add no routable listener. Credentials and private keys remain machine-local, never replicated or logged.

Approval records bind exact machine UUIDs and the access graph. Repeated setup installs no duplicate key, route, or service. A missing connector or interactive sign-in leaves the pair pending, not implicitly enrolled. Read-only doctor never performs installation or login.

Revocation first withdraws the intercom edge and closes its active bridge exchanges. Remove only that pair's authorized key and hc machine route. Reconcile active transport access so key removal does not leave an authenticated connection usable. If shared hc jobs prevent safe closure, report revocation incomplete and require the operator to drain them. Never claim completed revocation from a settings edit alone. Other pair keys and replication routes remain unchanged.

### Bounded transport and liveness

Use argv-based `hc exec --on` with stdin and a packaged slim `roam intercom exchange` helper. Include `--global-root` from enrolled peer configuration and resolve the configured pi agent directory, never a cwd-derived or guessed broker root. The helper loads no SQLite, contacts only its local broker and bridge, and never reads conversation files or executes message text. Complete outcome envelopes require exit zero. Nonzero, missing, truncated, or identity-mismatched replies supply no trusted acknowledgement. Reuse permanent machine and core identity checks. Restart fails an in-flight call. An actual identity change invalidates the handle. Never execute locally after a remote failure.

Each edge permits one inbound long-poll and one concurrent outbound call. A poll holds for at most 25 seconds and wakes within 25 ms of a frame, receipt, or acknowledgement. A short outbound call sends one batch without a poll hold. New outbound frames join the next batch when a call is already active. Encoded requests and replies each fit 512 KiB.

Use remote timeouts up to 30 seconds for a poll and 10 seconds for outbound. Total local deadlines, including identity brackets, are 45 and 20 seconds. Reserve five seconds for the post-call bracket on polls and background pushes. At spawn, round the remaining remote budget down, cap it at the operation's remote timeout, and refuse to spawn when less than one second remains after the reserve. Shorten the poll hold to leave five seconds inside its remote timeout. Abort locally at the total deadline.

Measured hc behavior supports concurrent calls and stops remote programs within three seconds after a local stop. Keep per-edge persistent generations despite that result. A newer poll makes its predecessor return empty within 100 ms. A stale-generation result cannot advance a cursor, apply a control, or release a frame. Cumulative acknowledgement application is idempotent. Frames remain replayable until durable inbox acceptance, and the source payload remains until consumption evidence or expiry.

Reuse connected-line evidence from the bracket's existing machine-list observations. A route is live while a bounded poll has that evidence, or a valid exchange succeeded within 35 seconds. A transient failure marks the route recovering and its cached status stale. Preserve active ask waits through the first retry, after one second, using a bounded ten-second probe. Retry success keeps those waits. Retry failure marks the route down and ends them with `link-down`. Identity mismatch or proved endpoint exit ends affected waits immediately. No retry extends an ask deadline. The bounded poll lease cannot outlive its 45-second local deadline. No extra one-second liveness polling is required. After the first retry, continue reconnect backoff at 2, 4, 8, 15, then 30 seconds, with repeated failures at 30 seconds. Success restores normal long-poll cadence.

Retain known peer identities, names, and mailbox addresses during an outage. Mark cached endpoint status stale and reachability down, rather than deleting peers or reporting old status as live. Ten-minute tunnel drops and much longer machine outages are normal. Ordinary sends queue quietly. Produce one persistent metadata-only diagnostic per continuous outage, update its reason without repeating warnings, and clear it after a valid identity and endpoint reconciliation. Retries do not generate notifications. Coalesce the general hosting status with this outage item instead of issuing a second link-only warning at ten minutes.

A tunnel authentication failure does not prove that the remote core or session stopped. Distinguish `link-down`, missing sign-in, core unavailability, identity change, and proved endpoint exit. A confirmed host restart withdraws old activation endpoints. If the link is unavailable, endpoint state remains unknown until reconciliation. In peer mode, loss of a Mac edge does not disable healthy box edges.

### Identity and target resolution

The portable address is the persistent pi session ID plus intercom scope. Map configured broker stable IDs to that address. Origin-qualified runtime-only identities do not move. Machine alias, name, cwd, model, PID, and cached status are never routing authority.

A bare name resolves only when unique across local and remote entries in the same scope. Otherwise require `box-1.invalid/name`, `box-2.invalid/name`, or the portable ID. Encode qualifier separators. Two same-name sessions on one machine still require the ID. Ambiguous resolution has no send effect. Unqualified cwd-only targeting remains local. Explicit remote targeting can use destination cwd as a guard. Remote discovery does not open a pane.

Presence carries machine identity, portable address, home epoch when assigned, activation endpoint, name, and status. A settled move preserves the name and portable address and changes the machine qualifier. Stale home or activation epochs cannot receive a message. Route withdrawal and destination readiness are live observations, not permission to assign a home or launch pi.

### Acceptance, consumption, and uncertainty

Persist message ID, immutable content digest, sender, logical recipient, and sender-recipient sequence before transfer. Transact inbox acceptance before link acknowledgement. A reused ID with changed authored content or recipient fails. Link acknowledgement does not release the source copy.

Retain the existing delivery vocabulary and distinguish acceptance from consumption:

- `queued` reports `delivered:true`, `delivery:"queued"`, and the durable queue location. It is accepted, not consumed.
- `socket_delivered` reports the recipient socket dispatch, not transcript injection.
- `failed` reports a proved refusal with `delivered:false`.
- `unknown` has `outcomeKnown:false`. Report whether durable acceptance is known and return the original message ID. Do not label uncertainty as a proved refusal.

Consumption evidence is `injected` only after the owning recipient observes the appended `intercom_message` session entry carrying that immutable message ID. `pi.sendMessage` returns `void` and can queue a steer while busy. Its return, queue admission, and queue removal are not injection evidence. Register pending IDs before sending. Use `message_end` as an observation trigger and verify the corresponding physical session entry, not a rendered or compacted projection. `matched_waiter` requires the reply to be durably recorded and handed to its matching waiter. Neither receipt means the agent acted on the content.

Reuse spider's owned RPC delivery pattern in `packages/subagents/src/rpc-child.ts`, consumed by `packages/subagents/src/actions/message.ts`. Extract its pi-free acceptance, observation, and settlement tracker into `@spider/intercom/protocol` for both RPC and fork consumers. Keep RPC's serialized text correlation in its adapter. The fork correlates immutable message IDs and authoritative entry metadata. Do not add a second delivery-confirmation mechanism or change existing owned RPC result vocabulary.

Early `receiver_received` or `acknowledged` receipts do not qualify. On `session_shutdown`, abort, or next `session_start`, settle pending IDs from observed entries. A message absent when its session generation ends produces `not_injected` and retains the source payload. If absence or generation exclusion cannot be proved, retain `unknown`. Busy headless refusal also produces `not_injected`. After proved non-injection and exclusion or clearing of any old queued copy, return the payload to undispatched state and clear that receipt blocker. Retry on the recipient's next idle or `session_start`, with the same ID and only once per readiness transition. Undelivered asks still obey their original dispatch duration. Never retry a settled ask, including one settled by a recorded busy-refusal reply. Its uninjected question expires visibly at the original deadline. Suppressed duplicates return prior evidence, never invented success, and must allow this proved same-ID retry. Delete source payload only after qualifying evidence or visible expiry.

`spider message`, subagent relays, and outbox sends use broker resolution and preserve the same immutable ID across retries. Use the bridge instead of a `message_mirror` body only when the target resolved to a remote machine or to a session with a roaming home record at send time. Record that send-time routing provenance in machine-local intercom metadata. A portable session ID alone does not select the bridge. Local offline targets without a roaming home retain legacy mailbox replay.

`pollPendingMessages` skips bridge-routed rows even after the recipient moves to the sender's machine. Apply the same predicate to historical rows using recorded send-time route or home evidence, never address shape. Missing historical evidence remains unresolved without replay or payload deletion. Proved local offline rows still replay. Remote admission is not followed by a second local mailbox delivery after a move.

Preserve pair dispatch order across ordinary reconnects. Cancellation and expiry write sequence tombstones. An uncertain dispatch is settled for ordering, so later messages advance, but its evidence remains unresolved. A recovered uncertain message can arrive after later messages and retains its original ID.

On `session_start`, the owning fork reads only its own restored session-entry metadata for `intercom_message` IDs and waiter receipt records. Inspect complete physical entries, not a compacted model-context projection. Injection evidence yields a receipt. Proven absence requires a complete authoritative restored file and exclusion of the old activation generation. Only that proof permits same-ID redelivery. An incomplete file, missing owner, or competing generation remains `unknown`. Helpers and bridges never read transcripts. Do not promise exactly-once injection across process death without this evidence.

### Asks and normal recovery paths

Install the waiter before dispatch. Preserve the ten-minute default and `PI_INTERCOM_ASK_TIMEOUT_MS`, one outbound ask, scope, exact sender-recipient reply matching, and self-target and mutual-wait refusal. Resolve machine-qualified names and ID targets to the authoritative sender address before installing the waiter. Match the reply's sender address and original ask ID, never the display name or raw target string. Broker metadata queries expose inbound and outbound ask edges and pending delivery IDs for move blockers.

The source owns the original deadline. Wire frames carry remaining duration, not an absolute timestamp from another machine. Every hop decreases the duration. Before transferring an undelivered ask, subtract that hop's full bounded call budget and a five-second safety allowance. The destination expires against its own elapsed clock. A relay or retry never refreshes the duration. If no safe duration remains, expire the ask early instead of risking injection after its source deadline. Source restart never extends a persisted deadline. Clock rollback without an elapsed-time proof expires the undelivered ask conservatively.

An ask not injected within its dispatch duration receives an `expired` tombstone and is never injected later. Ordinary messages can remain queued for 24 hours, but undelivered asks cannot. Timeout ends the source wait and prevents later question injection. It does not cancel a question already delivered.

A new ask to a known-down link fails immediately with `link-down` and the unavailable edge. Report `Link down to box-1.invalid. This ask is no longer waiting for a reply.`, using the affected machine's display name. A fresh outbound probe is required when reachability is uncertain. Each attempt has a ten-second total local budget, remote timeout up to five seconds, and a two-second post-bracket reserve. Allow one retry after one second for a transient failure, at most 21 seconds for both attempts. Stop sooner at the original ask deadline. Round each timeout down from its remaining budget after the reserve. The failed retry reports `link-down`, not a ten-minute wait. Identity mismatch or proved endpoint exit has no retry. The longer 20-second background send budget does not govern probes. New asks to a recovering route fail promptly as unavailable rather than creating additional probes.

Queued or unknown dispatch alone retains the waiter while the route remains live or its first transient-failure retry is pending. An observed route failure ends an active wait with `link-down` only after that retry fails, except for identity mismatch or proved endpoint exit. Preserve the original ask ID, durable question state, and any later answer. Broker reconnect alone does not reset or reject a surviving runtime's remote waiter. `/reload` interrupts the old await stack with `session-reloaded`, but retains the thread. Session exit reports interruption. No await stack is reconstructed or moved.

Deliver late, timed-out, or orphaned replies as ordinary threaded messages carrying the original ask ID. Tell the replier `Delivered; the asker was no longer waiting.` Explicit cancellation is distinct from expiry and travels through both bridges. Reply retention uses the ordinary mail TTL, not the expired question's dispatch deadline.

### Queue limits and move fencing

Cap each encoded message, including attachments, at 256 KiB. Cap queued payloads at 256 messages and 64 MiB per destination, including relay queues. Ordinary payloads expire after 24 hours. Refuse before acceptance rather than evict accepted mail. Retain deduplication and tombstone metadata for at least 24 hours after expiry and keep evidence referenced by an unresolved ask or delivery. Queue expiry and quota refusal are sender-visible without echoing content.

Close bridge dispatch intake atomically with admission before freeze. Drain started dispatches and recheck inbound and outbound asks, pending dispatch IDs, unknown outcomes, and unobserved receipts. Return exact blockers without cancellation. Include the closure generation in freeze acknowledgement and reinspection.

While frozen or moving, reject asks and retain ordinary mail by portable recipient without injection. After committed home change and admitted readiness, rebind only mail proved undispatched at the old endpoint, preserving its ID and authored recipient. Unknown old dispatch blocks the move. Matching abort or current destination readiness reopens the gate. Live route hints cannot mutate database homes.

### Privacy, cost, and acceptance

Use private machine-local queues, SQLite `secure_delete=ON`, and WAL checkpoint and truncation after payload settlement or expiry. Do not claim forensic erasure of backups or filesystem snapshots. Queue databases, journals containing payloads, credentials, and keys never enter replication. Bridge logs contain IDs, byte counts, and outcome codes only, never bodies, attachments, or credential-bearing stderr. Intentional recipient rendering is separate.

Verify with a synthetic sentinel that the actual core does not log `machine.exec` stdin before enablement. The helper and bridge do not launch pi, provision machines, change homes, or interpret text as commands.

Measure helper cold start, four bracket calls, end-to-end consumption-receipt latency, and idle CPU, process counts, and transient process-seconds for the hub, supervisor, broker, hc, helpers, connectors, and SSH. Ten 25-second idle polls imply about 0.4 remote helper starts and two local hc starts per second, before retries or outbound traffic. These are scheduling estimates, not measurements.

Intercom and database transfers share a multiplexed SSH line. Keep transfer chunks at the existing 384 KiB cap. The latency budget includes chunk bytes divided by measured link throughput, brackets, cold start, and both relay hops. Before task 4.7, the maintainer attributes the measured transport tail to line re-establishment, exec, or one of the four local bracket calls. Use synthetic calls and record each component, including failures. Confirm the one-retry probe policy and its budgets against those observations. The p95 targets remain at most two seconds direct and five seconds relayed, excluding agent thinking, both idle and under representative transfer contention, pending that qualification. A successful tail call remains a latency sample. If the measurements cannot meet these targets or probe budgets, keep peer mode disabled and obtain an explicit revised decision before 4.7, then update the spec and plan together. Do not silently relax the gate. Failed calls are not latency samples.

Require isolated behavioral acceptance, fork switchover soak, and a maintainer-run two-box Mac-off test before peer enablement. Use only synthetic sessions and disposable resources. An unavailable box or missing observation is blocked, not passed. Routine link-only outages must preserve mail and names without duplicate injection or repeated warnings. A proved host restart must withdraw old endpoints.

## Provisioning and hosting

### Installation and readiness

`spider roam provision box-1.invalid` shows the box inventory and selected destinations. Require Linux, Git, systemd user services, an existing hc core, and Node >=22.19.0. Pin pi 1.2.0, spider tarball hashes, and the tested Node range. Intercom ships inside spider, forked from pi-intercom 0.13.0 under its MIT licence. Provisioning removes a separately installed pi-intercom settings entry as it ships the fork. Retain old files during rolling reloads. Doctor fails remote readiness on duplicate intercom instances, an undrained legacy broker, or missing federation support. Install under a home-directory npm prefix, with Linux native SQLite modules. Set `SPIDER_GLOBAL_ROOT` for the install command as well as for pi, because spider's install script creates the global database. Never copy Mac binaries or silently install prerequisites with sudo.

Copy allowlisted settings, model definitions, keybindings, themes, AGENTS.md, and selected skills with supporting files. Extensions, prompts, MCP configuration, and system-prompt files need explicit selection. Refuse Mac-absolute paths or unsupported credential commands and list affected files. Generate box paths and configuration. Exclude trust decisions, sessions, broker state, and caches. Preserving existing broker state during an on-machine switchover does not authorize copying it to another machine.

Back up overwritten files once. Re-provisioning replaces only selected files and creates no duplicate service or agent. Hand-edited selected files may need re-editing. No ownership manifest or override adaptation is needed.

Authentication is not copied by default. `--include-auth` requires explicit human confirmation for this target and provider list. Credential-bearing settings count as auth. Do not execute secret commands to collect their output. Secret values use a separate private artifact, never logs, labels, or argv, and staging is removed after installation. Without destination sign-in, installation finishes but hosting stays disabled. Ambient Git and CLI credentials remain destination setup.

Doctor probes native modules, extension load, exact-session launch, file modes, core ownership, configured resources, and authentication. Tool probes include `gh auth status`, Git identity, and configured CLIs. Move preflight reports missing tool parity as warnings, for example `This session's loops call gh, but gh is not signed in on box-1.invalid.`  Missing pi authentication or an invalid exact session file does.

### Service limits and core-only mode

The Mac launchd plist runs resolved absolute Node and CLI paths with `RunAtLoad`, `KeepAlive`, private logs, and a process lock. Doctor checks that Node still exists. Rerunning enable rewrites the plist for the current supported Node after an upgrade. It does not rely on an interactive shell's version manager.

Install only a supervisor user unit, enabled under `default.target`. Put `After=`, `Requires=`, and `PartOf=` for the existing core on that unit, with `Restart=on-failure` and a private umask. Core restart then restarts the supervisor. Never edit or restart the core during provisioning or add reverse dependencies. Lingering needs any required administrative permission.

The shell launcher uses `ulimit -Sn` before executing the provisioned absolute pi path. It raises the soft limit toward 65536, never lowering it or exceeding the hard limit. Node never sets process limits. If a box's hard limit is low, doctor gives a human the repair command and warns that core restart kills terminals. Provisioning never restarts it. Check inotify floors of 1024 instances and 524288 watches. Raising them needs administrative consent.

Add Herdr mode `full` or `core-only`, defaulting to full. Only full mode requires app configuration and AppClient. Core-only retains ownership, presence, status, children, and job monitoring, without app mods, layout, or absent-app warnings. App actions say `This view is available on the Mac.` Unconfigured `on` destinations refuse, never run locally.

### Supervisor and availability

The supervisor reconciles at startup, on core and home events, and every ten seconds. Launch requires a local home, or matching origin before first sync, active state in every affected store, no unfinished local freeze journal, and desired state running. It verifies epoch, exact file, header, cwd, destination authentication, release, and both local locks. A live or uncertain owner blocks launch. Process identity includes Linux `boot_id`, PID, and start time. Stale ownership needs proved absence of that identity.

Launch a fresh local-core terminal with background lifetime, no notification, and no parent dependency. Run the leased launcher with exact `pi --session <file>` in the mapped cwd. Inherit only that core's destination HC values. Labels carry session, machine, epoch, and move ID. Readiness reports operation ID, actual session ID, epoch, cwd, file, core, and terminal after admission.

Restart crashes after 5, 15, 60, and 300 seconds. Five failures in ten minutes suspend and notify the hub. Ten stable minutes clear the count. Missing auth, invalid files, or uncertain ownership suspend immediately. Stop and user quit persist stopped intent. Resume requires doctor. Reload keeps ownership without another terminal.

WSL updates restart it within seconds, but terminals die, so the supervisor recreates exact-session terminals. Windows reboot leaves WSL down until desktop sign-in.

Every sync reconciles local proxy panes in the session's remembered Mac space and tab, including new remote terminal IDs after restart. Never launch pi for placement. Preserve proxy creation, uncertain-launch, and user-close rules. A box session's proxy header shows one machine pill in the existing header pill style. Local sessions show none. Retain pending placement while the app or core is unavailable without starting either. Ten minutes unreachable with homed sessions, or session suspension, produces one status item. Confirmed hosting failure or suspension also produces the existing single Mac notification. Link-only outages produce no hosting notification. Coalesce their intercom diagnostic into the status item without repeated warnings or claims of endpoint death. Clear the item on verified recovery.

## Moving a session

### Preflight and preparation

`/move <machine>` on the Mac targets the current persistent top-level session. `spider move <session> <machine>` uses an exact ID, unambiguous prefix, or unambiguous name from the hub catalog. Machine `mac` names the enrolled Mac. Box request rows are deferred because moves require an awake Mac anyway. Box `/move` directs callers there without enqueuing.

Serialize moves per session. Repeat IDs return results. A second destination conflicts. Same-home moves are verified no-ops. Require reachable, compatible machines, a guard-capable live source or dormant control, and ready destination installation, auth, workspace, and binding maps.

Require no request, retry, compaction, queued prompt, editor draft, direct shell, outbound intercom ask, or unresolved inbound ask. Block pending or uncertain dispatches and unobserved receipts. Retain child, pipeline, job, and completion checks. Inspect owning stores, run and job journals, the bridge, and the live forked broker and runtime. Return exact blocker IDs without stopping work.

Report tool-readiness and actual intercom route warnings. Require compatible source and destination bridges before preparation. Moves preserve names and portable IDs. Pending asks block instead of migrating. Success names the new machine-qualified intercom address and repeats applicable warnings, without a blanket lost-peer list.

Hold a Mac power assertion through preparation, move, and recovery until completion, abort, or rollback. Print `Keep the Mac awake until the move finishes.` Pre-stage the workspace bundle and a complete transcript prefix while the source is active. Freeze then transfers only final changes. A freeze does not expire if the Mac nevertheless sleeps or loses power.

### Git-native workspace snapshot

Copy the real index to a private `GIT_INDEX_FILE` before `git write-tree`, then run `git add -A` on a second private copy to capture working files and nonignored untracked files. Explicitly exclude `.spider` and `.pi-subagents`, refusing tracked local state. Never change the real index's staged content. Create private commits under `refs/spider-roam/<move-id>/`: index commit parented on HEAD, working commit parented on index. Both staged and working content remain reachable. Use immutable per-snapshot refs so final deltas need no forced ref updates. Never push these refs to origin. Use fixed synthetic commit metadata for private snapshots so missing Git identity remains a warning, without changing user configuration.

Record HEAD object ID, symbolic branch, object format, both tree IDs, relative cwd, sparse-checkout patterns, and per-worktree config. Refuse unresolved indexes, merge or rebase in progress, submodules, escaping symlinks, case-fold collisions, unsupported file types, and unmaterialized LFS content. Another known workspace writer blocks transfer. Custom filters or normalization that cannot round-trip changed file bytes also block. Materialized LFS requires verified content objects available on both sides. No full-workspace byte manifest is built.

During pre-stage, the destination runs `git fetch origin` with its own credentials and advertises fetched commits. Bundle snapshot refs excluding a verified shared merge base and verified pre-stage prerequisites. Missing prerequisites, verification failure, or exceeding the bundle cap refuses with a fetch or setup instruction. Never fall back to full history.

Import refs into the mapped common repository. Reuse the workspace's mapped checkout only if its HEAD, index, and working trees equal its last exported snapshot. Otherwise refuse with a diff summary. Initialize a private index from its last exported working tree and refresh its stat cache. Use that index for `git read-tree -m -u` to update files in place to the incoming working snapshot. With no mapping, create with `git worktree add --detach --no-checkout`, enable `extensions.worktreeConfig`, which changes shared repository config, copy the source's sparse-checkout patterns and per-worktree config, then check out. A configured `worktreeCommand` replaces creation but preserves this no-checkout sequence and all checks. Fetch, creation, and checkout finish during pre-stage, including for a virtualized or sparse checkout. After freeze, apply only the final delta. Journal prepared trees so retries recognize their own changes. Abort restores the prior snapshot only if the checkout still matches the prepared trees.

Set the index with `git read-tree` without changing working files. Refresh its stat cache once with `git update-index --refresh`, accepting exit 1 only for expected `needs update` paths. Restore HEAD to the source HEAD object without checkout or reset. Restore the symbolic branch only if its destination ref matches or can be created without changing another worktree. Otherwise remain detached and report the saved branch name.

Compare destination index and temporary-index working trees to the recorded tree IDs. Git's stat cache avoids rehashing unchanged files. Recompute source trees after freeze and before commit. Edits after freeze invalidate preparation. Git preserves binary edits, deletions, renames, modes, and partial staging. Rebuild ignored output locally. Cwd is the destination root plus validated relative cwd. Retain source files and mark their checkout not home after commit.

### Session file and usage

Freeze stops spider-owned transcript producers, including scheduler delivery, notices, cache warming, and organism reports. Pi metadata edits can still append. Immediately before home commit, require source size and digest to match the freeze acknowledgement. Discard retired-source appends after commit. For a live source, capture runtime cwd and `getLeafId()`, not the last physical line. Require a complete newline-terminated version-3 JSONL file with the expected header, unique entry IDs, valid parent links, and valid compaction boundaries. Older formats upgrade normally on the source before freezing. Unknown extension entries remain opaque.

Pre-stage immutable full-sized prefix chunks under the move's artifact ID. Final manifests reuse those hashes and send only remaining chunks. A changed source prefix invalidates preparation and aborts before home commit. Assemble the complete file and verify its source digest. On the destination, preserve every post-header entry byte-for-byte. Rewrite only `header.cwd` to the mapped cwd. Rewrite `parentSession` only if a destination file is known. Otherwise remove that stale header locator and retain its origin reference in marker metadata. Do not replace paths inside historical messages or compaction lists.

Append a non-context `spider-roam-segment` custom entry, parented on the captured leaf, with a fresh ID. Data is `{version: 1, moveId, epoch, previousMachine, nextMachine, historyMachine, parentRef}`, with null `parentRef` when absent. The first marker sets `historyMachine = previousMachine`. Later markers retain that initial history machine. This preserves a selected branch that ends before the last physical entry. Usage segments follow physical order, not branch navigation.

Validate the destination digest, unchanged-history digest, header, marker, and cwd. Fsync the file and directory, then install by same-directory atomic rename in the effective destination session directory. A prior same-ID file needs a proved dormant owner, prefix-compatible history, and a private backup. Divergence blocks. Immediately before launch, require the exact nonempty regular file to match the manifest. Do not use a prefix, `--continue`, `--fork`, a cwd override, or an initial prompt.

Usage remains per machine. Append shipped usage migration 7, updating fresh creation and expected layout:

```sql
ALTER TABLE calls ADD COLUMN execution_machine TEXT;
ALTER TABLE calls ADD COLUMN managed_entry_key TEXT;
CREATE UNIQUE INDEX idx_calls_managed_entry
	ON calls(managed_entry_key) WHERE managed_entry_key IS NOT NULL;
```

Never backfill, rewrite, or delete historical calls. NULL `execution_machine` means local before roaming. Preserve IDs (`packages/host/src/usage/parse.ts:271-277`), prices, proof, and duplicate-path facts. Only segment-aware participating ingest sets `managed_entry_key` to canonical JSON `[localMachine, transcriptSessionId, entryId]`. Children use their header session ID, not the parent's accounting ID. Other keys stay NULL.

Ingest through the frozen source end, skipping foreign segments. Already-counted checks treat NULL and local execution machines alike. Match transcript identity, including children's historical source headers. A second local path keeps the first fact and emits a diagnostic without changing old totals. Persist parser state. Relocation resets caches, not facts. Discover exact local files.

Filter native run usage discovery, event accounting, and `UsageAccounting.unreportedRuns` by local run origin, including its startup restore path. Foreign usage events and reported sentinels cannot generate local charges. Round trips retain facts and bill only new local entries, including compaction and cache warming. No usage DB or account counter is replicated.

### Durable move states

Journal each action before execution. Participants record operation ID, argument digest, expected epoch, and result. Reconcile uncertain effects instead of relaunching. Seven forward states record completed work.

| State | Completed work and next step |
| --- | --- |
| `checked` | Preflight passed and destination space is reserved. Seed active membership in chunks and sync it. Pre-stage workspace checkout and transcript without changing source ownership, then request freeze. |
| `frozen` | Source gates are closed, writers drained, idle blockers rechecked, and frozen state committed in every affected store. Acknowledgement records process identity or proved dormancy, leaf, transcript size and digest, and per-store high sequences. |
| `transferred` | Final Git delta and JSONL are verified. Pull source changes and push required global, repo, and worktree barriers. Destination cursors reach every barrier. Local maps, exact file, binding, and retired destination state are ready. |
| `home-committed` | One hub transaction changed source epoch `e` to destination epoch `e + 1` and journaled it. Replicate home, then the hub's `session start` at that epoch sets active state and running intent. Only then may the supervisor launch. Source remains frozen. |
| `destination-ready` | Destination persisted readiness before normal consumers and reported actual session, cwd, file, epoch, core, and terminal. Recovery now stays there. Ask source to shut down with reason move. |
| `source-stopped` | Source process identity is absent. Mark it retired and desired stopped. Remove only its recorded terminal, then call `registry.remove(id, provedRemoved)` after terminal-removal proof. |
| `done` | One admitted destination owner is verified. Record result, reconcile placement, clean unused staging, and delete `refs/spider-roam/<move-id>/` on both sides. App closure or cleanup failure leaves pending work, not rollback. |

Before home commit, abort proves the home still names the source at epoch `e` and permanently cancels that move's commit action. The source records cancellation before restoring active state and gates. Destination reachability is unnecessary because no destination home was published. A delayed operation with the cancelled move ID cannot activate or overwrite a later operation. Partial freezes reconcile their local journal before unfreeze.

After commit, timeouts mean unknown. Inspect destination journal, readiness, home, and process identity. Rollback requires proved launch failure, no readiness receipt, and destination acknowledgement of stopped ownership and durable retirement. Disconnection cannot prove this, so the source stays frozen. Then CAS home back at `e + 2`, replicate, and readmit the source. Reuse its process if alive, otherwise launch its exact original file. Add no segment to the untouched source.

Once destination readiness exists, a later crash is supervisor recovery, not rollback. A lost readiness reply cannot weaken that rule. Hub startup reconciles incomplete moves before accepting another for that session. `spider roam recover <move-id>` reports the exact safe next action or the missing observation. No automatic timeout restores an old home.

### Lost-machine recovery

On every sync, the hub pulls each peer-homed session's appended JSONL bytes into a read-only, append-only mirror keyed by session and home epoch. Validate the existing prefix and complete lines. Each epoch's mirror starts from its installed session file. Mirrors make conversations readable on the Mac without moving them.

`spider roam forget <machine>` requires typed confirmation that the machine is destroyed. The hub durably revokes its identity and refuses future sync handshakes forever. If it reconnects, a retire-only response tells its supervisor to stop all sessions before any sync. The hub moves affected homes to the Mac at `epoch + 1`, restoring the last mirrored prefix under the session-file validation and segment-marker rules. Hosting waits for a valid local workspace and authentication, then uses `session start` to activate. Interrupted moves reconcile against those new homes.

Forget is a human assertion. A live offline machine can run a second copy until reconnection. Conversation after the last mirror sync and untransferred workspace edits are lost. Missing mirrors block restoration and require explicit recovery.

## Admission and user controls

Pi awaits event handlers in registration order (`pi/dist/core/extensions/runner.js:813-819`). Register admission first and publish a module-local activation flag that all later spider startup consumers check. Do not build an async coordinator. Check before session upsert, reaping, adoption, triggers, feeds, usage publication, and organism work. Startup writes and reaping are in `packages/host/src/hooks.ts:148-163`.

Participation requires membership or a home row, including conflict markers. Read with `withRetry`. Nonparticipants take no session-ID lock or gate. Unknown participation on read failure admits and warns once. Known participants block read or lock failures with a plain message. Load affected worktree membership, global homes, and `<globalRoot>/roam/journal.db` freeze state, empty until move control ships. Participating admission requires a local home or matching initial origin, active state in every affected store, no unfinished local freeze journal, expected epoch, session-ID lock, and exact-file lease. A frozen source stays alive control-only for recovery. Retired, foreign, or uncertain copies initialize no ordinary spider work. Reload preserves durable frozen state. A process restart cannot clear it.

Recheck at `input`, `before_agent_start`, `turn_start`, `tool_call`, `user_bash`, scheduler delivery, notices, and cache-warming decisions. Disallowed input is handled with a home message. Agent starts call `ctx.abort()`. Tools and direct shell calls return a block. Freeze also suppresses shutdown consolidation. `ctx.abort()` and pending-message checks are public (`pi/dist/core/extensions/types.d.ts:235-246`), and startup abort precedes the provider request (`pi/dist/core/agent-session.js:709-714`). Test that contract against the pinned pi release.

| Command | Behavior |
| --- | --- |
| `/move <machine>`, `spider move <session> <machine>` | Ask the Mac hub to move once and stream bounded progress. |
| `spider roam status [--json]` | Show connections, last sync, homes, backlog, log sizes, suspensions, warnings, and incomplete moves. Distinguish cached status. |
| `spider roam sync [machine]` | Sync now and report committed cursors or repair needs. |
| `spider roam enable`, `disable` | Enable checks live top-level process-presence records in the Herdr session registry. Missing or older spider build capability refuses until reload. Install or stop hub scheduling. Disable refuses an in-progress home change and does not stop boxes or erase homes. |
| `spider roam provision <machine>`, `doctor [machine]` | Install selected files or run read-only readiness checks with repair commands. |
| `spider roam recover <move-id>`, `cancel <move-id>` | Reconcile, or abort before commit. After commit, cancellation needs the proved rollback conditions. |
| `spider roam forget <machine>` | Confirm destruction, revoke identity, and restore affected homes from mirrors, accepting the stated split-copy and data-loss costs. |
| `spider roam stop <session>`, `resume <session>` | Change desired hosting state without changing the home. |
| `spider roam repo map <repo-key> <path>`, `claim <session> <machine>` | Resolve explicit identity ambiguity with the checks above. |

Mac controls use a mode-0600 same-user socket. Doctor, local status, and repo mapping can run on a box. Other box commands point to the Mac. No model-callable operation provisions credentials or changes homes directly. Exit codes are 0 for verified completion or no-op, 1 for refusal or failure, 2 for invalid arguments, and 3 for durable pending or unknown outcome. JSON includes a stable reason, operation ID, current home, epoch, and repair command.

Refusals name the home, exact blockers, or missing evidence. For an unknown destination, say `The source is paused to avoid running two copies.` Success names the destination, terminal, and intercom address and repeats applicable warnings. Never print secrets, conversation bodies, uncommitted contents, or message bodies in diagnostics.

## Security and known limits

Trust enrolled machines and authenticated Herdr transport, not hostile same-user processes. Use 0700 directories and executables, and 0600 files and sockets. Reject foreign-owned or symlink destinations. Batch data cannot select paths or service configuration. Moves carry the selected workspace and conversation, not additional credentials or machine Git identity.

### Known limits and follow-ups

- Sync and moves need an awake hub. No election or automatic takeover exists. An incorrect `forget` assertion risks unsynced data loss and two copies.
- Windows reboot requires desktop sign-in before the existing task starts WSL again.
- Restored or cloned machine disks need a new identity and hub reconciliation before hosting.
- Resume cannot restore in-flight tools, drafts, extension runtime state, or a pipeline coordinator.
- `spider roam upgrade` orchestration is deferred. Re-provision installs a release picked up on restart or reload.
- `spider roam uninstall` is deferred. Move homes away, disable peer sync, stop and remove the supervisor, then remove selected files manually while retaining data and credentials unless separately requested.
- Box-side `/move` request rows are deferred. Run moves from the Mac, including while a box session is active.
- Per-target store allowlists and secret-field scanning beyond auth consent are deferred. Review selected data before provisioning.
- Box-to-box move acceptance follows the two gated directions, using the same hub path.
- Intercom uses the spider-owned fork and approved live bridges. Peer mode requires verified enrollment and Mac-off acceptance. Hub-only mode waits for the Mac and can exceed the 24-hour mail TTL. Reload and link failure interrupt live ask waits, but preserve threaded questions and replies. Moves do not transfer await stacks.
- Cross-machine usage views, richer remote sidebar rows, and sidebar move controls are deferred.
- Ongoing skills sync is deferred. Provisioned skill snapshots do not update through replication.
- Imported-session search excerpts, completed child transcripts, indexed content, and saved output remain on their origin.
- Ignored build products and unsupported Git features do not move. Old paths in historical text remain text.
- LWW can lose concurrent memory edits. There is no field-level merge or semantic deduplication.
- Log and tombstone compaction is deferred. Status reports their sizes.
- Running children, native Windows hosting, and machine power-on automation are outside v1.

## Verification and delivery

Use disposable SQLite files, independent machine roots, actual migrations, and generated triggers. Fake hc records argv and rejects local fallback. Test isolated cores before a real box. Never manipulate unrelated terminals or production conversations. Unit and integration tests keep a five-second ceiling. Core- or pi-starting stories run serially in their declared Herdr acceptance tiers with existing harness deadlines. Inject launchd, systemd, power, boot-ID, and limit operations. Tests use fakes for these OS operations.

### Acceptance scenarios

| ID | Scenario and observable result |
| --- | --- |
| A1 | Record hc chunk throughput and latency, export and import timing, native-module installation, core-only in-terminal extension load, and inherited file limits. In phase 4, watch a pi terminal survive two hours without a Mac client. |
| A2 | Equivalent URLs, including the multi-shape fixture, share a key. Fresh and v13 migration preserves UUIDs and rowids in every scope. Duplicate sequences disable roaming only. Future schema fails before mutation. Root fallback is cached with explicit refresh. |
| A3 | New, function-free old-build, and sqlite3 CLI connections capture inserts, updates, and deletes atomically, including omitted UUIDs and origins. Cover disabled capture, importing, recursion on and off, rollback, trigger failure, frozen writes, PID-only changes, and unrelated sessions. First foreign-row apply creates retired membership atomically, blocking subsequent non-home CLI inserts, updates, and deletes. |
| A4 | Disconnected memory and todo edits and deletes converge across three roots in every peer order. Tombstones resist old puts. Idle sync stops log growth. Backward clocks progress logically. Excess future skew leaves batches unapplied. |
| A5 | Replay a lost import acknowledgement without duplicate IDs, notices, or charges. Corruption, cursor skips, and schema mismatch preserve cursors. Replace unlogged non-home todo conflicts, but quarantine tracked conflicts with both UUIDs visible. |
| A6 | Read remote todos, session search, and history without a Mac checkout. Mapping retains versions and tombstones. FTS and embeddings reflect winning text. Machine-tagged injection filters correctly. Unknown events sync, while missing known-producer policies fail CI. |
| A7 | Foreign PIDs and directories match unrelated local fixtures. Reaper, adoption, kill, completion, startup usage restore, and ingest ignore them. An origin-store rebuild cannot adopt old history. Native completion still delivers once. |
| A8 | Transfer binary and session artifacts above 64 MiB within table limits. Missing, truncated, wrongly indexed, or corrupt chunks cannot install or advance cursors. Resume reuses chunks. Import and export use separate deadlines and reconcile lost results. |
| A9 | A second hub refuses its lock. Closed app and core states never auto-start them. Placement reconciles once on return. Unreachable-home and suspension notices clear on recovery. Doctor detects broken Node paths and enable repairs the plist. |
| A10 | Without consent, no auth transfers or hosting starts. After sign-in, native modules and extension load pass. Core-only children and status work without app config. Reruns create no duplicate service. Core units and terminals stay untouched. Low hard limits and missing CLI auth report correctly. |
| A11 | A trigger fires once without the Mac. Reconnection converges rows. Subsystem or core restart restores one exact-file owner and triggers, then new-terminal placement on sync. Repeated crashes suspend. Deliberate stop stays stopped. Reboot remains unavailable until sign-in. |
| A12 | Move both directions with unpushed commits, staged and unstaged binary edits, deletion, exec-bit change, staged-only content, and untracked files. HEAD, trees, cwd, and branch handling match. A round trip reuses the mapped checkout and refuses divergence. Cover sparse cone mode and a partial-clone or alternate-backed fixture, including configured worktree creation. Missing prerequisites, oversized bundles, dirty unrelated checkouts, submodules, or escaping symlinks cannot cause full-history fallback or unrelated writes. |
| A13 | Move an older selected leaf with a sentinel at the old cwd. Verify mapped cwd, branch, ID, compaction, and triggers. Empty or missing exact files refuse launch. A round trip after both machines accrue usage and parser resets bills only local entries once, without rekeying. |
| A14 | Requests, drafts, prompts, children, pipelines, jobs, receipts, outbound asks, and unresolved inbound asks return exact blockers. Moves preserve intercom identity and report actual unavailable routes. Missing tool auth warns without blocking. Preparation holds a power assertion and pre-stages before freeze. |
| A15 | Fail at every transition and after effects before replies, then restart services. Exercise live and dormant control, suspended sources, and multi-store admission. Recover, prove higher-epoch rollback, or pause explicitly. Disconnect and lost readiness never permit unsafe rollback. Retired source mappings prevent reboot resume. Normal moves never run two copies. Forget restores mirrors at a higher epoch and refuses revoked sync, including after hub restart. |
| A16 | Copies of participating session files on machines with replicated membership, and reloads, reject nonowner input, timers, messages, tools, and shell calls before requests or writes. A nonparticipating Mac file copied to a fresh box can appear new. Offline active homes continue. Frozen and retired copies stay blocked. Interrupted multi-store seeding reconciles once. Conflicting origins require claim. |
| A17 | All intercom actions work by name across machines. Collisions have no effects. Fork switchover and a move to the sender's machine never inject a message twice. Consumption evidence, original reply IDs, unknown reconciliation, ordering, deadline expiry, and fencing are observed. Routine ten-minute link drops preserve queues and known peers quietly, emit one diagnostic per outage, and fail live asks with `link-down` after the first retry fails. A busy recipient reloads before its steer drains, retains the source payload, and receives a proved same-ID redelivery. Local offline mailbox replay remains intact. Direct box delivery continues with the Mac off. Hub-only fallback reports its limitation. |
| A18 | A box session's local proxy retains its remembered space and tab and shows one machine pill in the existing header style. Local sessions show none. |

### Five delivery phases

| Phase | Work and verifiable end state |
| --- | --- |
| 0. Spike | One box's transfer rates set the measured-limits table. pi 1.2.0 and spider install with prebuilt Linux native modules and no compiler. Spider activates without a Herdr environment, not yet in a core-spawned terminal. Export and import timing remain for phase 2, core-only in-terminal load for phase 3, and two-hour no-client terminal survival for phase 4. |
| 1. Local replication | Add identity, schema, SQL capture, HLC, merge, derived data, origin filters, usage migration, and admission fixtures. A2 through A7 pass on disposable roots. Foreign runs cannot reach an unguarded consumer. No remote hosting is enabled. |
| 2. Transport and hub | Add chunking, durable operation receipts, launchd, sync, unmapped reads, diagnostics, and placement reconciliation. A8 and A9 pass through fake hc and isolated cores. Independent peers converge without pi being open on the Mac. |
| 3. Box hosting | Begin with behavior-preserving fork adoption and rolling switchover. Add pinned provisioning, consent, core-only mode, launcher limits, supervisor recovery, federation, bridge storage and runtime, approved enrollment, and isolated A17 acceptance before the phase gate. A10 and A11 pass under isolated roots. Verify core-only extension activation inside a core-spawned terminal with no app configuration. Opt-in synthetic hosting continues without the Mac. Existing core units remain unchanged. |
| 4. Moves and real-box acceptance | Add bridge fence ports before move consumers and the machine pill before placement acceptance. Add Git snapshots, file markers, barriers, home CAS, rollback, forget, commands, and fault injection. A12 through A18 pass. Repeat applicable scenarios on real boxes with disposable repositories and synthetic sessions. Privately check the real URL pair and worktree creation path. Task 4.7 includes real intercom checks in its existing two-hour no-Mac window and enablement decision, with no later acceptance dependency. Keep peer mode disabled while a required observation is blocked or failed. Explicit hub-only selection acknowledges its limitation and is not a peer-mode pass. |

Gate release on typecheck, tests, build, packaged CLI, isolated Herdr acceptance, and private real-box receipts. Inspect session IDs, cwd, homes, leases, trees, ledgers, placement, and unchanged unrelated roots. Keep the feature off until phase 4 passes. Before enabling replication, deploy compatible schemas and reload all consumers, including detached usage workers. Enable mechanically refuses older live top-level builds using Herdr process-presence records. Detached usage workers must reload too. Baseline SQL replay proves actual writers, not just function-free connections. Old usage openers refuse v7 without writes. New ingest later catches up from transcripts. Interrupted rollout keeps hosting disabled or retains all admission and origin filters.
