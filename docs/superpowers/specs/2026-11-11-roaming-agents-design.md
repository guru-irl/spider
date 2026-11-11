# Roaming agents

## Goals and scope

A top-level pi session can live on a remote Linux machine and keep working while the Mac is off. Moving an idle session between the Mac and a box takes one action. Spider's portable database rows merge when the machines reconnect.

The Mac is the hub. It reaches boxes through Herdr. Boxes cannot reach the Mac or each other. Sync and moves require an awake Mac, but an active home continues without it. The hub runs as a launchd user service, independently of pi, with one process lock and a default sync period of two minutes per peer.

Version 1 includes replication, provisioning, unattended restart, and idle-session moves. Children run where their parent runs. Moves refuse running children and unsettled jobs. Acceptance gates Mac-to-box and box-to-Mac moves first.

Resume restores conversation and triggers, not suspended execution or a continuation prompt. An idle session waits for input or a trigger. Examples are synthetic. Private inventories, credentials, and test receipts stay outside the repository.

## Ownership and component boundaries

A machine has a random UUID in a private `machine.json`. The routing alias `box-1.invalid` is not that identity. A home is `{sessionId, machineId, epoch}`. Only the hub writes `session_homes`, using compare-and-swap on the expected epoch. Each home change, including rollback, increments the epoch.

Durable local session state is `active`, `frozen`, or `retired`. A session-ID lock prevents duplicate local IDs, while the existing canonical-file lease protects one file. Neither lock crosses machines. Existing file-lease claims check liveness under a process lock (`packages/herdr/src/sessions/lease.ts:75-101`).

A source acknowledges freeze only after its admission gates and database writers are stopped and its frozen state is durable. Freeze never expires. A frozen or retired copy cannot reactivate from a cached home. An offline active home can continue because the hub cannot move it without that source's fresh freeze acknowledgement. This is the exclusion argument. A timed lease alone would not give that guarantee.

The destination activates after home commit without an armed launch or release step. Readiness is durable before ordinary consumers. Once readiness exists, even with a lost reply, recovery stays there. Rollback requires proved launch failure and destination retirement.

| Owner | Responsibility |
| --- | --- |
| `@spider/db-core` | Portable keys, schema migration, generated SQL capture, HLC comparison, export, apply, and read-only replica resolution. |
| New `@spider/roam` | Hub, supervisor, provisioning, operation journals, sync orchestration, and move transitions through injected transport and process ports. No pi imports. |
| `@spider/herdr` | Generic argv execution, chunk transfer, exact-file terminal launch, and Mac-only placement. It does not import roaming. |
| `@spider/host` | First-registered admission handler, lifecycle guards, `/move`, readiness, and usage adapters. |
| `@spider/subagents` | Local-origin checks for operational run consumers and a read-only blocker inventory. |

Publish `dist/roam/cli.mjs` and `dist/roam/supervisor.mjs`. Add root `bin.spider` and a Mac installation step. The current root has no `bin` (`package.json:1-151`), so building alone does not install a shell command. `/move` is primary. CLI help opens no DB or Herdr connection.

Local configuration contains role, hub identity, peer aliases and executable paths, discovery roots, core unit, sync period, and limits. A box has no outbound peers. Validate inputs at CLI, configuration, SQL, file, and hc boundaries.

## Checked starting point

The checked source baseline is `e732fa07`, the parent of the original design commit. Everything proposed below is new work.

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

Pi citations use `pi/` for the installed coding-agent package at version 1.2.0. Explicit-file open derives runtime cwd from the header, unless an override is passed (`pi/dist/core/session-manager.js:1326-1347`). Missing or empty files can initialize a new session (`pi/dist/core/session-manager.js:665-689`). Loading selects the last physical entry as the leaf (`pi/dist/core/session-manager.js:732-741`). The public API exposes `getLeafId()` (`pi/dist/core/session-manager.d.ts:289-290`). These contracts require header rewriting, exact-file validation, and a leaf-parented marker.

## Portable identities and reads

### Repository and workspace identity

Normalize HTTPS, SSH URL, and scp-style origins. Remove credentials, query, fragment, default ports, trailing slash, and one trailing `.git`. Lowercase the host, preserve path case and nondefault ports, and decode only unreserved escapes. Default-port HTTPS and SSH identify the same repository. Hash the resulting host and path as `origin:<sha256>`. Never send the credential-bearing URL.

Run a service-specific canonicalizer table first so one repository's URL shapes share a key. Synthetic fixtures equate `https://org.code.example/team/_git/repo`, `https://code.example/org/team/_git/repo`, and `git@ssh.code.example:v3/org/team/repo`. All produce `code.example/org/team/repo`. Unknown services use generic normalization or explicit maps, avoiding guessed equivalence across unrelated hosts.

Without a usable network origin, hash the sorted root commit set from `git rev-list --max-parents=0 --all` as `root:<sha256>`. Cache that result per common repository, rather than walking all refs on each move. An explicit repo map refreshes the cache. An origin change, repository replacement, or changed fallback result requires an explicit mapping decision, never silent rekeying. An unborn repository needs an explicit key.

`spider roam repo map <repo-key> <path>` pins an identity locally. Discovery is bounded to configured roots and proposes mappings. Ambiguous checkouts block workspace transfer. Each logical checkout has a workspace UUID, independent of branch name. Linked worktrees have distinct workspace UUIDs but share repo memory.

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

Raise core schema to 14 with additive migrations and matching fresh DDL for all three scopes. Read `user_version` inside an IMMEDIATE transaction. A newer version fails before application queries. Validate owned columns, indexes, and triggers on writable opens. Do not edit shipped version-13 SQL. Use a private SQLite backup API snapshot or `VACUUM INTO`, not a live `.db` byte copy.

Backfill todo and event UUIDs with `lower(hex(randomblob(16)))`, preserving local integer IDs and FTS rowids. Create unique UUID indexes. Existing session and run origins become the local machine ID. New SQL inserts that omit these fields get plain-SQL after-insert fills. UUID and origin updates are immutable once nonempty. Normalization updates produce only one captured insertion, including on connections with recursive triggers enabled.

Before adding unique `(session_id, seq)` for todos, detect duplicates. If present, skip that index, commit the rest of migration, set the store non-roamable, and report conflicting row IDs. Ordinary spider work continues at v14. Doctor repairs nothing automatically. After deliberate repair, enable creates the index and clears the flag. Layout validation explicitly permits only this diagnosed missing-index case.

Worktree-local `roam_sessions` has primary key `session_id`, `epoch`, `state`, `move_id`, and freeze barrier sequence. State is `active`, `frozen`, or `retired`. Table membership controls participation. SQL reads state in the writing transaction. Frozen writes raise, rather than silently escape capture. Hub and participant journals record move actions and results. Maps, locations, and supervisor intent stay local.

A session joins replication when first moved or created on a box. A session with no home row belongs to its session row's origin. The hub records epoch 1 at first sync. Conflicting origins stop admission and produce `spider roam claim <session> <machine>` for an explicit, proved choice. Claim resolves only an unassigned initial home, with all conflicting machines reachable and competing copies stopped. Existing homes change through moves, never offline takeover.

First-move freeze atomically adds frozen membership and seeds that session's rows in each affected worktree. Retries do not reseed. A local journal preserves freeze across partial multi-store completion. Acknowledge only after all stores commit. New box admission records origin, active membership, and seeds before ordinary consumers. Memory seeds once, atomically with enablement, without session freeze because memory uses LWW.

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

`body_json` is the captured projection. Export converts declared locators once and caches the portable body in `wire_json` before publication. Imports store portable content in both columns. Forwarding and dedupe use cached wire content, keeping conversion out of triggers without changing envelopes between machines.

### Plain-SQL capture and freeze fences

This generated todo SQL uses the additive UUID column and local session-state table. The UUID fill works even with capture disabled, so old applications can omit UUIDs.

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
		WITH sample(ms) AS MATERIALIZED (
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

Apply sets `roam_meta.importing = 1`, mutates rows, inserts original envelopes, updates versions and cursors, then clears the flag within one IMMEDIATE transaction. A crash rolls back the flag with the transaction. SQLite's single-writer rule prevents another connection from exploiting the temporary flag. This replaces connection-specific functions and per-row machine authorization.

Cross-session todo edits get one admission check in the todo store. Mutating a participating session's todos requires that session's current home and active local state. Allocation uses an IMMEDIATE transaction. After resolving a display sequence, updates and deletes address the UUID. Other-session views remain read-only. A locally originated write after its session's freeze barrier reports a doctor error with `writer_epoch`, without an apply-time history dependency.

## Replication protocol

### Batches and convergence

A handshake checks enrolled machine identity, current core identity, protocol 1, and core schema 14. Reject mismatches before mutation and identify the machine needing repair. A core restart invalidates in-flight observations, not the enrolled machine UUID. There is no downgrade projection or local fallback for a failed remote command.

Export reads a SQLite snapshot and emits immutable UTF-8 NDJSON. The header has protocol, schema, batch ID, sender machine and stream, store key, exclusive `after`, inclusive `through`, and record count. Each record has sender sequence, change ID, entity, row key, operation, original HLC, writer session and epoch, schema, and body. A separate manifest has byte length and SHA-256. Export never holds a writer transaction across transport.

Sequences order local exports, not conflicts. Forwarding preserves change ID, HLC, and portable body with a new local sequence. Dedupe before log insertion, never with `INSERT OR IGNORE`. Unpruned logs are contiguous. Export requires sequences `after + 1` through `through`; a gap is corruption. Accept only a matching durable cursor or exact receipted replay. Re-export other overlaps. Empty exports return count zero and `through = after`, with no import or receipt.

Batch selection uses bytes and observed apply time, not a record-count cap. Receipts adjust the byte target, including lexical work. Apply time is a target, not a timeout. Larger rows use singleton batches within hard limits. Oversized rows stop the store with their key, never trimmed data.

Compare row versions lexicographically by `(hlc_ms, hlc_count, origin_machine, origin_stream)`. On local capture, use the larger of wall time and durable milliseconds, reset the counter to zero when wall time wins, and increment otherwise. On receive, let `m` be the maximum of local milliseconds, remote milliseconds, and wall time. If both clocks equal `m`, use their maximum counter plus one. If one equals `m`, increment its counter. Otherwise use zero. Persist that observation with apply. Reject overflow and any remote clock more than five minutes ahead of receiver wall time. Backward wall-clock changes retain logical progress.

Validate the whole artifact before an IMMEDIATE apply transaction. Append every unseen envelope, including losing versions. A winning put replaces the portable row. A winning delete removes it and retains a tombstone. Equal clocks with different contents or IDs are corruption. Change-ID uniqueness prevents loops. Logs, seen IDs, and tombstones remain indefinitely.

Only hub-origin changes can alter homes. A lower home epoch cannot replace a higher one, and an equal epoch must have the same owner and move ID. Session data does not wait for historical home records. Admission uses the current home. HLC resolves concurrent memory rows, including archive and approval status, without merging fields or rerunning review. Report memory-cap overflow instead of deleting accepted rows.

### Apply receipts and conflicts

Commit row changes, tombstones, original log inserts, HLC observation, local FTS maintenance, embedding-queue changes, receive cursor, and digest-bound receipt together. Return batch ID, stream, `through`, digest, and apply duration only after commit. Lost replies are reconciled by operation ID and receipt. Never infer failure from a timeout and start an unrelated replacement import.

Duplicate IDs must have the same canonical envelope. Replays do not allocate another local rowid, publish completion, or bill usage. Invalid batches leave cursors unchanged. Stores commit independently. Moves wait for every required store barrier.

On secondary unique conflict, an incoming todo for a non-home session replaces a different-UUID local row at the same `(session_id, seq)` only if the local row has no log entry. Remove its FTS entry transactionally. Otherwise quarantine the batch, preserve the cursor, and report both UUIDs. Never renumber a tracked todo or discard its tombstone.

The hub pulls a peer's available changes before pushing the merged stream back. One transfer runs per peer. Peers progress independently. First sync runs at hub startup. Disconnected peers retry after 30, 60, and then 120 seconds. Sync does not launch or restart the Mac app or core. If either is closed, report the unavailable function. A closed app only delays placement. A closed Mac core prevents box transport.

### Derived data and event policy

Apply allocates local IDs and updates todo and active-memory FTS transactionally. Session FTS uses replicated name and summary. Keep imported excerpts local and preserve unrelated imported FTS rows. Memory changes remove stale vectors and enqueue current text transactionally. Embedding completion checks the version before clearing work. Lexical search needs no embedding provider.

Apply emits only a post-commit replica invalidation, not operational run events. Foreign runs have all process columns nulled, including intercom identity. Export strips supervisor directories, transcript directories, endpoints, and tokens from known `child_supervisor` and `child_transcript` payloads. `chain_steps` becomes a count and origin-qualified history reference, never executable continuation data.

Unknown event types and versions export unchanged as inert history. A unit test requires an explicit policy for every known producer type, including dynamic child events. This catches omissions in CI without stopping production sync when a producer adds an event. Existing named helpers are in `packages/subagents/src/run-events.ts:4-30`.

Reaper, adoption, kill, completion delivery, run-status mutation, and usage reporting require local run origin. Foreign delivery and accounting sentinels are history only. Preserve local per-run event order when forwarding and allocating replica rowids. There is one execution writer per run, so no extra origin-sequence column is needed. A rebuilt replica has no PIDs or supervisor directories to adopt, even when it receives its own old history.

Use nullable machine IDs rather than alias text because aliases can change. Null applies everywhere. Injection excludes other-machine rows. At enable, doctor lists likely machine-specific entries without rewriting prose. `spider roam memory tag <store-key> <uuid> <machine|all>` changes only that tag, leaving doctor read-only.

Registry placement, bindings, routes, leases, message delivery, usage DBs, skills, curator state, indexed content, routing events, upstream-watch state, native indexes, ownership files, job journals, and backups never replicate. A move reconstructs local placement and bindings. Historical text may retain old paths. Only declared locator fields become `{machineId, repoKey, workspaceId, relativePath}` or opaque origin-qualified references.

## Herdr transport and measured limits

Invoke the pinned remote CLI by argv through `hc exec --on`. Long operations use labelled `hc run --bg --no-notify --outlive-parent --no-parent` with receipts. Add no listener or SSH route. Commands check operation ID, machine, and expected epoch. Private socket modes remain, but same-user capability files are unnecessary.

Commands cover inventory, export, import, cursor and receipt inspection, artifact split and assembly, and session inspect, freeze, start, retire, and unfreeze. Journal argument digests before effects. Repeated IDs reconcile. Changed arguments under one ID fail.

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
| Concurrent peer transfers | 2 | Never overlap transfers to the same peer. |
| Chunk retry policy | 3 retries, after 1, 2, and 4 seconds | Reuse immutable chunks and the operation ID. |

The existing client's default deadline is shorter (`packages/herdr/src/client/cli-transport.ts:8-12`). Roaming supplies explicit command deadlines from the table. The model-facing copy action is not the roaming transport and does not impose its single-file cap here.

Chunks carry artifact ID, index, raw length, and SHA-256. Write with `hc file write` through stdin and read with `hc exec --on <machine> -- cat <path>`. Manifests order hashes and record length and whole-file hash. Receive into exclusive-create private staging, verify, fsync, then atomically rename. Reuse matching chunks. A conflicting digest or incomplete data cannot install or advance cursors.

Committed transfer artifacts can be removed after receipt verification. Incomplete staging survives service restart and expires after seven days only when no live move or unapplied batch references it. Quota errors name the directory and stop transfers. They never delete source workspaces, database logs, or tombstones. Limits can be lowered locally. Raising them requires an explicit configuration change, not automatic fallback.

## Provisioning and hosting

### Installation and readiness

`spider roam provision box-1.invalid` shows the box inventory and selected destinations. Require Linux, Git, systemd user services, an existing hc core, and Node >=22.19.0. Pin pi 1.2.0, intercom 0.13.0, spider tarball hashes, and the tested Node range. Install under a home-directory npm prefix, with Linux native SQLite modules. Set `SPIDER_GLOBAL_ROOT` for the install command as well as for pi, because spider's install script creates the global database. Never copy Mac binaries or silently install prerequisites with sudo.

Copy allowlisted settings, model definitions, keybindings, themes, AGENTS.md, and selected skills with supporting files. Extensions, prompts, MCP configuration, and system-prompt files need explicit selection. Refuse Mac-absolute paths or unsupported credential commands and list affected files. Generate box paths and configuration. Exclude trust decisions, sessions, broker state, and caches.

Back up overwritten files once. Re-provisioning replaces only selected files and creates no duplicate service or agent. Hand-edited selected files may need re-editing. No ownership manifest or override adaptation is needed.

Authentication is not copied by default. `--include-auth` requires explicit human confirmation for this target and provider list. Credential-bearing settings count as auth. Do not execute secret commands to collect their output. Secret values use a separate private artifact, never logs, labels, or argv, and staging is removed after installation. Without destination sign-in, installation finishes but hosting stays disabled. Ambient Git and CLI credentials remain destination setup.

Doctor probes native modules, extension load, exact-session launch, file modes, core ownership, configured resources, and authentication. Tool probes include `gh auth status`, Git identity, and configured CLIs. Move preflight reports missing tool parity as warnings, for example `This session's loops call gh, but gh is not signed in on box-1.invalid.` These warnings do not block a move. Missing pi authentication or an invalid exact session file does.

### Service limits and core-only mode

The Mac launchd plist runs resolved absolute Node and CLI paths with `RunAtLoad`, `KeepAlive`, private logs, and a process lock. Doctor checks that Node still exists. Rerunning enable rewrites the plist for the current supported Node after an upgrade. It does not rely on an interactive shell's version manager.

Install only a supervisor user unit, enabled under `default.target`. Put `After=`, `Requires=`, and `PartOf=` for the existing core on that unit, with `Restart=on-failure` and a private umask. Core restart then restarts the supervisor. Never edit or restart the core during provisioning or add reverse dependencies. Lingering needs any required administrative permission.

The pi launcher raises its soft file limit to 65536, bounded by the inherited hard limit. The test box's core-spawned terminals already allow 1,048,576 open files. If a box's hard limit is low, doctor gives a human the repair command and warns that core restart kills terminals. Provisioning never restarts it. Check inotify floors of 1024 instances and 524288 watches; the test box allows 128 instances, so doctor warns there. Raising them needs administrative consent.

Add Herdr mode `full` or `core-only`, defaulting to full. Only full mode requires app configuration and AppClient. Core-only retains ownership, presence, status, children, and job monitoring, without app mods, layout, or absent-app warnings. App actions say `This view is available on the Mac.` Unconfigured `on` destinations refuse, never run locally.

### Supervisor and availability

The supervisor reconciles at startup, on core and home events, and every ten seconds. It launches only locally homed active sessions with desired state running. It verifies epoch, exact file, header, and cwd, destination authentication, release, session-ID lock, and canonical-file lease. A live or uncertain owner prevents a second launch. Stale ownership needs PID-and-start-identity proof of absence.

Launch a fresh local-core terminal with background lifetime, no notification, and no parent dependency. Run the leased launcher with exact `pi --session <file>` in the mapped cwd. Inherit only that core's destination HC values. Labels carry session, machine, epoch, and move ID. Readiness reports operation ID, actual session ID, epoch, cwd, file, core, and terminal after admission. A shell or heartbeat is insufficient.

Restart crashes after 5, 15, 60, and 300 seconds. Five failures in ten minutes suspend and notify the hub. Ten stable minutes clear the count. Missing auth, invalid files, or uncertain ownership suspend immediately. Stop and user quit persist stopped intent. Resume requires doctor. Reload keeps ownership without another terminal.

An existing Windows logon task keeps WSL running without a client. The box owner reports seven days up, including a Mac offline period. WSL updates restart it within seconds, but terminals die, so the supervisor recreates exact-session terminals. Windows reboot leaves WSL down until desktop sign-in. A box cannot sign itself in or power on its host.

Every sync reconciles live session terminals into their machine's Mac app space, including new IDs after restart. Never launch pi for placement. Closed apps defer it. Ten minutes unreachable with homed sessions, or session suspension, produces one Mac notification and Herdr status item. Clear status on recovery. Retain pending status while the app or core is unavailable, without starting either.

## Moving a session

### Preflight and preparation

`/move <machine>` on the Mac targets the current persistent top-level session. `spider move <session> <machine>` uses an exact ID, unambiguous prefix, or unambiguous name from the hub catalog. Machine `mac` names the enrolled Mac. Box request rows are deferred because moves require an awake Mac anyway. Box `/move` directs callers there without enqueuing.

Serialize moves per session. A repeated operation ID returns its result. A second destination conflicts with the current move. Same-home moves are verified no-ops. Both machines must be reachable and compatible. The source must run the guard-capable build. Destination installation, authentication, workspace, and binding maps must be ready. Resume absent sources at their current home first.

Require a settled session with no request, retry, compaction, queued prompt, editor draft, direct shell command, or pending intercom ask. Block queued, running, or paused children, detached durable children, pending pipeline stages, local background jobs, unsettled remote receipts, and unobserved completions. Inspect the owning run DB, local routes, and top-level and child job journals. Return exact blocker IDs without stopping them.

Show tool-readiness warnings and list the live intercom peers the session will lose. Intercom 0.13.0 uses a machine-local broker socket (`intercom/broker/paths.ts:65-74`). Here `intercom/` names the installed package. Pending asks block rather than disappear. The completed move result repeats the lost-peer list. This notice does not promise a relay.

Hold a Mac power assertion through preparation, move, and recovery until completion, abort, or rollback. Print `Keep the Mac awake until the move finishes.` Pre-stage the workspace bundle and a complete transcript prefix while the source is active. Freeze then transfers only final changes. A freeze does not expire if the Mac nevertheless sleeps or loses power.

### Git-native workspace snapshot

Capture the real index with `git write-tree`. Copy it to a private `GIT_INDEX_FILE`, then run `git add -A` to capture working files and nonignored untracked files. Explicitly exclude `.spider` and `.pi-subagents`, refusing tracked local state. Never change the real index's staged content. Create private commits under `refs/spider-roam/<move-id>/`: index commit parented on HEAD, working commit parented on index. Both staged and working content remain reachable. Use immutable per-snapshot refs so final deltas need no forced ref updates. Never push these refs to origin. Use fixed synthetic commit metadata for private snapshots so missing Git identity remains a warning, without changing user configuration.

Record HEAD object ID, symbolic branch, object format, both tree IDs, and relative cwd. Refuse unresolved indexes, merge or rebase in progress, submodules, escaping symlinks, case-fold collisions, unsupported file types, and unmaterialized LFS content. Another known workspace writer blocks transfer. Custom filters or normalization that cannot round-trip changed file bytes also block. Materialized LFS requires verified content objects available on both sides. No full-workspace byte manifest is built.

The destination runs `git fetch origin` with its own credentials and advertises fetched commits. Bundle snapshot refs excluding a verified shared merge base and verified pre-stage prerequisites. Missing prerequisites, verification failure, or exceeding the bundle cap refuses with a fetch or setup instruction. Never fall back to full history.

Import refs into the destination's mapped common repository. Create a dedicated linked worktree with `git worktree add --detach` at the working-tree snapshot. Set its index with `git read-tree` to the index tree without updating working files. Restore HEAD to the source HEAD object without a checkout or reset. Restore the symbolic branch only when its destination ref matches or can be created without changing another worktree. Otherwise remain detached and report the saved branch name. This choice avoids changing an unrelated branch.

Compare destination index and temporary-index working trees to the recorded tree IDs. Git's stat cache avoids rehashing unchanged files. Recompute source trees after freeze and before commit. External edits invalidate preparation. Git preserves binary edits, deletions, renames, modes, and partial staging. Rebuild ignored output locally. Cwd is the destination root plus validated relative cwd. Retain source files.

### Session file and usage

Freeze stops every transcript append source, including scheduler delivery, notices, cache warming, and organism reports. Capture actual runtime cwd and `getLeafId()`, not the last physical line. Require a complete newline-terminated version-3 JSONL file with the expected header, unique entry IDs, valid parent links, and valid compaction boundaries. Older formats upgrade normally on the source before freezing. Unknown extension entries remain opaque.

Pre-stage immutable full-sized prefix chunks under the move's artifact ID. Final manifests reuse those hashes and send only remaining chunks. A changed source prefix invalidates preparation and aborts before home commit. Assemble the complete file and verify its source digest. On the destination, preserve every post-header entry byte-for-byte. Rewrite only `header.cwd` to the mapped cwd. Rewrite `parentSession` only if a destination file is known. Otherwise remove that stale header locator and retain its origin reference in marker metadata. Do not replace paths inside historical messages or compaction lists.

Append a non-context `spider-roam-segment` custom entry, parented on the captured leaf, with a fresh ID. Data is `{version: 1, moveId, epoch, previousMachine, nextMachine, historyMachine, parentRef}`, with null `parentRef` when absent. The first marker sets `historyMachine = previousMachine`. Later markers retain that initial history machine. This preserves a selected branch that ends before the last physical entry. Usage segments follow physical order, not branch navigation.

Validate the destination digest, unchanged-history digest, header, marker, and cwd. Fsync the file and directory, then install by same-directory atomic rename in the effective destination session directory. A prior same-ID file needs a proved dormant owner, prefix-compatible history, and a private backup. Divergence blocks. Immediately before launch, require the exact nonempty regular file to match the manifest. Do not use a prefix, `--continue`, `--fork`, a cwd override, or an initial prompt.

Usage remains per machine. Append shipped usage migration 7, updating fresh creation and expected layout:

```sql
ALTER TABLE calls ADD COLUMN execution_machine TEXT;
CREATE UNIQUE INDEX idx_calls_execution_entry
	ON calls(execution_machine, session_id, entry_id)
	WHERE execution_machine IS NOT NULL AND source_kind = 'transcript';
```

Backfill `execution_machine` by UPDATE, without rekeying path-based call IDs (`packages/host/src/usage/parse.ts:271-277`) or changing prices and proof. Ingest through the frozen source end. Managed ingest skips foreign segments and existing local `(session_id, entry_id)` pairs. Relocation or header changes reset caches, never managed facts. Persist segment parser state. Discover exact local files, not foreign roots.

Filter native run usage discovery, event accounting, and `UsageAccounting.unreportedRuns` by local run origin, including its startup restore path. Foreign usage events and reported sentinels cannot generate local charges. A round trip preserves prior local facts and bills only new local entries, including compaction and cache warming. No usage DB or account counter is replicated.

### Durable move states

Journal each action before execution. Participants record operation ID, argument digest, expected epoch, and result. Reconcile uncertain effects instead of relaunching. Seven forward states record completed work.

| State | Completed work and next step |
| --- | --- |
| `checked` | Preflight passed and destination space is reserved. Pre-stage artifacts without changing source ownership, then request freeze. |
| `frozen` | Source gates are closed, writers drained, idle blockers rechecked, and frozen local state committed in every affected store. Its acknowledgement records process identity, leaf, transcript size, and per-store high sequences. |
| `transferred` | Final Git delta and JSONL are verified. Pull source changes and push required global, repo, and worktree barriers. Destination cursors reach every barrier. Local maps, exact file, binding, and retired destination state are ready. |
| `home-committed` | One hub transaction changed source epoch `e` to destination epoch `e + 1` and journaled it. Replicate that home. Destination becomes locally active and may launch. Source remains frozen. |
| `destination-ready` | Destination persisted readiness before normal consumers and reported actual session, cwd, file, epoch, core, and terminal. Recovery now stays there. Ask source to shut down with reason move. |
| `source-stopped` | Source PID-and-start identity is absent. Mark it retired and desired stopped. Remove only its recorded terminal, then call `registry.remove(id, provedRemoved)` after terminal-removal proof. |
| `done` | One admitted destination owner is verified. Record result, reconcile native placement, and clean unused staging. App closure or cleanup failure leaves pending work, not rollback. |

Before home commit, abort proves the home still names the source at epoch `e` and permanently cancels that move's commit action. The source records cancellation before restoring active state and gates. Destination reachability is unnecessary because no destination home was published. A delayed operation with the cancelled move ID cannot activate or overwrite a later operation. Partial freezes reconcile their local journal before unfreeze.

After commit, timeouts mean unknown. Inspect destination journal, readiness, home, and process identity. Rollback requires proved launch failure, no readiness receipt, and destination acknowledgement of stopped ownership and durable retirement. Disconnection cannot prove this, so the source stays frozen. Then CAS home back at `e + 2`, replicate, and readmit the source. Reuse its process if alive, otherwise launch its exact original file. Add no segment to the untouched source.

Once destination readiness exists, a later crash is supervisor recovery, not rollback. A lost readiness reply cannot weaken that rule. Hub startup reconciles incomplete moves before accepting another for that session. `spider roam recover <move-id>` reports the exact safe next action or the missing observation. No automatic timeout restores an old home.

## Admission and user controls

Pi awaits event handlers in registration order (`pi/dist/core/extensions/runner.js:813-819`). Register admission first and publish a module-local activation flag that all later spider startup consumers check. Do not build an async coordinator. Check before session upsert, reaping, adoption, triggers, feeds, usage publication, and organism work. Current startup writes and reaping are in `packages/host/src/hooks.ts:148-163`.

Nonparticipating Mac sessions keep their current behavior. Participating admission requires a local home or matching initial origin, active local state, expected epoch, session-ID lock, and exact-file lease. A frozen source stays alive control-only for recovery. Retired, foreign, or uncertain copies initialize no ordinary spider work. Reload preserves durable frozen state. A process restart cannot clear it.

Recheck at `input`, `before_agent_start`, `turn_start`, `tool_call`, `user_bash`, scheduler delivery, notices, and cache-warming decisions. Disallowed input is handled with a home message. Agent starts call `ctx.abort()`. Tools and direct shell calls return a block. Freeze also suppresses shutdown consolidation. `ctx.abort()` and pending-message checks are public (`pi/dist/core/extensions/types.d.ts:235-246`), and startup abort precedes the provider request (`pi/dist/core/agent-session.js:709-714`). Test that contract against the pinned pi release.

| Command | Behavior |
| --- | --- |
| `/move <machine>`, `spider move <session> <machine>` | Ask the Mac hub to move once and stream bounded progress. |
| `spider roam status [--json]` | Show connections, last sync, homes, backlog, log sizes, suspensions, warnings, and incomplete moves. Distinguish cached status. |
| `spider roam sync [machine]` | Sync now and report committed cursors or repair needs. |
| `spider roam enable`, `disable` | Install or stop hub scheduling. Disable refuses an in-progress home change and does not stop boxes or erase homes. |
| `spider roam provision <machine>`, `doctor [machine]` | Install selected files or run read-only readiness checks with repair commands. |
| `spider roam recover <move-id>`, `cancel <move-id>` | Reconcile, or abort before commit. After commit, cancellation needs the proved rollback conditions. |
| `spider roam stop <session>`, `resume <session>` | Change desired hosting state without changing the home. |
| `spider roam repo map <repo-key> <path>`, `claim <session> <machine>` | Resolve explicit identity ambiguity with the checks above. |

Mac controls use a mode-0600 same-user socket. Doctor, local status, and repo mapping can run on a box. Other box commands point to the Mac. No model-callable operation provisions credentials or changes homes directly. Exit codes are 0 for verified completion or no-op, 1 for refusal or failure, 2 for invalid arguments, and 3 for durable pending or unknown outcome. JSON includes a stable reason, operation ID, current home, epoch, and repair command.

Refusals name the home, exact blockers, or missing evidence. For an unknown destination, say `The source is paused to avoid running two copies.` Success names the destination and terminal and repeats intercom-loss and tool-readiness warnings. Never print secrets, transcript bodies, or uncommitted contents.

## Security and known limits

The trust boundary is one user's enrolled machines and authenticated Herdr transport, not hostile same-user processes. Use 0700 directories and executables, and 0600 files and sockets. Reject foreign-owned or symlink destinations. Batch data cannot select paths or service configuration. Moves carry the selected workspace and conversation, not additional credentials or machine Git identity.

### Known limits and follow-ups

- The hub must be awake for sync and moves. There is no election or partition takeover.
- Windows reboot requires desktop sign-in before the existing task starts WSL again.
- Restored or cloned machine disks need a new identity and hub reconciliation before hosting.
- Resume cannot restore in-flight tools, drafts, extension runtime state, or a pipeline coordinator.
- `spider roam upgrade` orchestration is deferred. Re-provision installs a release picked up on restart or reload.
- `spider roam uninstall` is deferred. Move homes away, disable peer sync, stop and remove the supervisor, then remove selected files manually while retaining data and credentials unless separately requested.
- Box-side `/move` request rows are deferred. Run moves from the Mac, including while a box session is active.
- Per-target store allowlists and secret-field scanning beyond auth consent are deferred. Review selected data before provisioning.
- Box-to-box acceptance follows the two gated directions, using the same hub path.
- Intercom relay is deferred to message rows synced through the hub, with about two minutes of online latency.
- Cross-machine usage views, richer remote sidebar rows, and sidebar move controls are deferred.
- Ongoing skills sync is deferred. Provisioned skill snapshots do not update through replication.
- Imported-session search excerpts, completed child transcripts, indexed content, and saved output remain on their origin.
- Ignored build products and unsupported Git features do not move. Old paths in historical text remain text.
- LWW can lose concurrent memory edits. There is no field-level merge or semantic deduplication.
- Log and tombstone compaction is deferred. Status reports their sizes.
- Running children, native Windows hosting, and machine power-on automation are outside v1.

## Verification and delivery

Use disposable SQLite files, independent machine roots, actual migrations, and generated triggers. Fake hc records argv and rejects local fallback. Test isolated cores before a real box. Never manipulate unrelated terminals or production conversations.

### Acceptance scenarios

| ID | Scenario and observable result |
| --- | --- |
| A1 | Record hc chunk throughput and latency, export and import timing, native-module installation, app-free extension load, and inherited file limits. A plain timestamp-loop terminal survives two hours without a Mac client. The existing seven-day WSL evidence does not replace transport or package probes. |
| A2 | Equivalent URLs, including the multi-shape fixture, share a key. Fresh and v13 migration preserves UUIDs and rowids in every scope. Duplicate sequences disable roaming only. Future schema fails before mutation. Root fallback is cached with explicit refresh. |
| A3 | New, function-free old-build, and sqlite3 CLI connections capture inserts, updates, and deletes atomically, including omitted UUIDs and origins. Cover disabled capture, importing, recursion on and off, rollback, trigger failure, frozen writes, PID-only changes, and unrelated sessions. |
| A4 | Disconnected memory and todo edits and deletes converge across three roots in every peer order. Tombstones resist old puts. Idle sync stops log growth. Backward clocks progress logically. Excess future skew leaves batches unapplied. |
| A5 | Replay a lost import acknowledgement without duplicate IDs, notices, or charges. Corruption, cursor skips, and schema mismatch preserve cursors. Replace unlogged non-home todo conflicts, but quarantine tracked conflicts with both UUIDs visible. |
| A6 | Read remote todos, session search, and history without a Mac checkout. Mapping retains versions and tombstones. FTS and embeddings reflect winning text. Machine-tagged injection filters correctly. Unknown events sync, while missing known-producer policies fail CI. |
| A7 | Foreign PIDs and directories match unrelated local fixtures. Reaper, adoption, kill, completion, startup usage restore, and ingest ignore them. An origin-store rebuild cannot adopt old history. Native completion still delivers once. |
| A8 | Transfer binary and session artifacts above 64 MiB within table limits. Missing, truncated, wrongly indexed, or corrupt chunks cannot install or advance cursors. Resume reuses chunks. Import and export use separate deadlines and reconcile lost results. |
| A9 | A second hub refuses its lock. Closed app and core states never auto-start them. Placement reconciles once on return. Unreachable-home and suspension notices clear on recovery. Doctor detects broken Node paths and enable repairs the plist. |
| A10 | Without consent, no auth transfers or hosting starts. After sign-in, native modules and extension load pass. Core-only children and status work without app config. Reruns create no duplicate service. Core units and terminals stay untouched. Low hard limits and missing CLI auth report correctly. |
| A11 | A trigger fires once without the Mac. Reconnection converges rows. Subsystem or core restart restores one exact-file owner and triggers, then new-terminal placement on sync. Repeated crashes suspend. Deliberate stop stays stopped. Reboot remains unavailable until sign-in. |
| A12 | Move both directions with unpushed commits, staged and unstaged binary edits, deletion, exec-bit change, staged-only content, and untracked files. HEAD, trees, cwd, and branch handling match. Missing prerequisites, oversized bundles, dirty unrelated checkouts, submodules, or escaping symlinks cannot cause full-history fallback or unrelated writes. |
| A13 | Move an older selected leaf with a sentinel at the old cwd. Verify mapped cwd, branch, ID, compaction, and triggers. Empty or missing exact files refuse launch. A round trip after both machines accrue usage and parser resets bills only local entries once, without rekeying. |
| A14 | Requests, drafts, prompts, children, pipelines, jobs, receipts, and asks return exact blockers. Moves report lost intercom peers and warn without blocking for missing tool auth. Preparation holds a power assertion and pre-stages before freeze. |
| A15 | Fail at every transition and after effects before replies, then restart services. Recover, prove higher-epoch rollback, or pause explicitly. Disconnect and lost readiness never permit unsafe rollback. Source mapping removal prevents reboot resume. Two copies never run turns. |
| A16 | Copied local and remote files and reloads reject nonowner input, timers, messages, tools, and shell calls before requests or writes. Offline active homes continue. Frozen and retired copies stay blocked. Interrupted multi-store seeding reconciles once. Conflicting origins require claim. |

### Five delivery phases

| Phase | Work and verifiable end state |
| --- | --- |
| 0. Spike | Done on one test box. Transfer rates set the measured-limits table. pi 1.2.0 and spider install with prebuilt Linux native modules and no compiler. Spider activates with no Herdr app. WSL and the core stayed up for days with no Mac client. Remaining from A1: export and import timing, measured in phase 2. |
| 1. Local replication | Add identity, schema, SQL capture, HLC, merge, derived data, origin filters, usage migration, and admission fixtures. A2 through A7 pass on disposable roots. Foreign runs cannot reach an unguarded consumer. No remote hosting is enabled. |
| 2. Transport and hub | Add chunking, durable operation receipts, launchd, sync, unmapped reads, diagnostics, and placement reconciliation. A8 and A9 pass through fake hc and isolated cores. Independent peers converge without pi being open on the Mac. |
| 3. Box hosting | Add pinned provisioning, consent, core-only mode, launcher limits, and supervisor recovery. A10 and A11 pass under isolated roots. Opt-in synthetic hosting continues without the Mac. Existing core units remain unchanged. |
| 4. Moves and real-box acceptance | Add Git snapshots, file markers, barriers, home CAS, rollback, commands, and fault injection. A12 through A16 pass. Repeat A8 through A16 where applicable on a real box with a disposable repo and synthetic session before ordinary enablement. |

Gate release on typecheck, tests, build, packaged CLI, isolated Herdr acceptance, and private real-box receipts. Inspect session IDs, cwd, homes, leases, trees, ledgers, placement, and unchanged unrelated roots. Keep the feature off until phase 4 passes. Before enabling replication, deploy compatible schemas and reload all consumers, including detached usage workers. Plain SQL preserves old-build writes during migration, not safe foreign-history consumption. Interrupted rollout keeps hosting disabled or retains all admission and origin filters.
