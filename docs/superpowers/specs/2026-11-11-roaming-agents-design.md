# Roaming agents

## Goals and non-goals

A top-level pi session can run on a remote Linux machine while the Mac is off. Moving that session between the Mac and a box, or between two boxes, takes one command. Portable spider records merge when the machines reconnect.

The Mac is the hub. It reaches each box through Herdr. Boxes do not connect to the Mac or to one another. A box must keep working without the hub, but it cannot change a session's home without the hub.

Version 1 includes logical database replication, box provisioning, unattended restart, and idle-session moves. It does not move an executing model request, tool process, running child, or unsettled job. It does not sync skills, message delivery, usage ledgers, or arbitrary indexed content. Cross-machine intercom, richer remote sidebar rows, native Windows hosting, and provider-specific machine wake policies are follow-ups.

Resuming a session restores conversation, not suspended execution. A successful move opens the same conversation and restores its triggers. It does not invent a "continue working" prompt. An already-running agent on a box continues without the Mac. An idle agent needs input or an existing trigger.

All names and paths in examples are synthetic. Configuration, credentials, inventories, and test reports stay outside the repository.

## Terms and invariants

| Term | Meaning |
| --- | --- |
| Machine | One enrolled installation, identified by a random UUID in a private local identity file. An hc alias, such as `box-1.invalid`, routes to a machine but is not its identity. |
| Hub | The single Mac service that syncs machines and changes session homes. |
| Home | The authoritative `{sessionId, machineId, epoch}` assignment for a top-level session. |
| Epoch | A positive integer that the hub increments on every home change, including rollback. An epoch is never reused. |
| Portable repo key | A hash of a normalized origin URL, or of a repository's root commit set when no origin exists. It identifies a repository without a checkout path. |
| Workspace ID | A UUID for a logical checkout within a repository. It distinguishes worktrees that share repo memory but have separate worktree records. |
| Store | One logical global, repo, or worktree replication scope. Each concrete database replica has its own stream ID. |
| Change log | A local SQLite table containing portable row versions and delete records in commit order. Its sequence numbers are transport cursors, not conflict timestamps. |
| HLC | A hybrid logical clock with a physical millisecond component and a logical counter. A node ID breaks ties. |
| Tombstone | A retained row version that says a portable row was deleted. |
| Admission | Local permission to activate one session at one home epoch, under a session-ID lock and an exact-file lease. |

The following invariants apply to enrolled sessions:

1. Only the hub creates a home or changes it. Initial enrollment creates epoch 1. Later changes happen only through a move transaction.
2. Only a session at its home can activate spider's session work. Local admission and the home epoch must also match.
3. A move durably freezes the source before changing the home. A freeze does not expire when the hub disconnects.
4. A destination can become live for readiness checks without permission to run turns. The hub releases it only after the source has stopped.
5. A lost acknowledgement never authorizes another launch or rollback. The hub reconciles the recorded operation first.
6. Database replication carries rows, never SQLite files, WAL files, lock files, or native index pages.
7. A foreign run is history, not permission to probe a PID, adopt a supervisor, deliver a completion, or report usage.

## Checked starting point

This design targets repository commit `e732fa07`. Changes described after this section are requirements, not claims that roaming already exists.

| Existing contract | Checked evidence |
| --- | --- |
| Registry, repo, and worktree schemas use different files. Their keys are local paths. | `packages/db-core/src/registry.ts:69-75`, `packages/db-core/src/registry.ts:108-130`, `packages/db-core/src/paths.ts:75-85` |
| Core schema version 13 has scope-specific incremental SQL and repair helpers. Fresh databases receive full DDL. The current early return accepts future versions. | `packages/db-core/src/migrate.ts:4-8`, `packages/db-core/src/migrate.ts:93-122`, `packages/db-core/src/migrate.ts:163-225` |
| Writable core databases use WAL. Wrapper transactions defer bus effects until commit. | `packages/db-core/src/db.ts:132-183`, `packages/db-core/src/db.ts:194` |
| Todos have local integer IDs and per-session sequences, but no UUID or unique session-sequence constraint. Deletion is physical. | `packages/db-core/src/schema.ts:140-145`, `packages/todo/src/store.ts:22-76` |
| Import stores a suggested session name and transcript excerpt only in FTS. Organism updates preserve the old FTS excerpt. | `packages/context/src/import.ts:107-120`, `packages/organism/src/worker.ts:273-281` |
| Startup runs the orphan reaper. It probes locally numbered host and child PIDs without a machine discriminator. | `packages/host/src/hooks.ts:148-163`, `packages/subagents/src/reaper.ts:24-62` |
| Durable adoption reads supervisor paths from events. Completion and usage claims are operational `run_events` rows. | `packages/subagents/src/durable-adoption.ts:12-43`, `packages/subagents/src/actions/run.ts:87-105`, `packages/subagents/src/usage.ts:52-69` |
| Usage has its own database. Its migration gate checks the complete durable layout, not just the version. Discovery currently scans registered runs and usage events. | `packages/host/src/usage/mount.ts:19-25`, `packages/host/src/usage/migrate.ts:19-68`, `packages/host/src/usage/discovery.ts:137-240` |
| Herdr's current parser requires app configuration. Host activation constructs an app client after proving local core ownership. | `packages/herdr/src/config.ts:29-61`, `packages/host/src/herdr/mount.ts:459-502` |
| hc launch supports a destination, background lifetime, labels, and no notification. The client exposes text file reads and byte writes. Single replies have a 1 MiB cap. | `packages/herdr/src/client/hc.ts:109-148`, `packages/herdr/src/client/limits.ts:2-7` |
| Existing layout moves reject a different machine. Existing exact-file launch checks a header and claims a local lease before spawning pi. | `packages/herdr/src/spaces/move.ts:21-28`, `packages/herdr/src/sessions/launcher.ts:21-42` |
| Trigger restore reads complete custom entries from the same pi session and rebuilds timers. | `packages/host/src/loop/index.ts:159-186`, `packages/host/src/loop/index.ts:201-203` |

Pi citations use `pi/` to mean the installed `@earendil-works/pi-coding-agent` package at version 1.2.0, not a repository directory. Its checked contracts are:

- An existing explicit session file selects runtime cwd from its header. A cwd override does not rewrite the header. See `pi/dist/core/session-manager.js:1326-1347`.
- An empty or missing explicit file can initialize a new session. An exact filename alone does not prove a successful transfer. See `pi/dist/core/session-manager.js:665-689`.
- A missing stored cwd prompts interactively or exits in noninteractive modes. See `pi/dist/main.js:554-566`.
- The persistent format is a JSONL tree with a session header, typed entries, compaction checkpoints, and inline image data. Pending assistant messages are not persisted. See `pi/docs/session-format.md:1-14`, `pi/docs/session-format.md:63-199`, `pi/docs/message-types.md:26-36`, and `pi/docs/message-types.md:124-146`.
- `ctx.abort()`, pending-message checks, and shutdown are public context operations. An abort requested during startup is honored before the first request. Throwing from `before_agent_start` is not a cancellation API. See `pi/dist/core/extensions/types.d.ts:235-246`, `pi/dist/core/agent-session.js:709-714`, and `pi/dist/core/extensions/runner.js:1130-1159`.

## Architecture and component boundaries

The dependency direction is host to roaming, roaming to db-core and Herdr, and Herdr to its existing core and app clients. No lower package imports host. No box-side network listener is added.

| Unit and owner | Responsibility and interface | Dependencies |
| --- | --- | --- |
| Portable identity, `@spider/db-core` | `resolvePortableRepo(cwd)` and `resolveWorkspace(cwd)` return branded keys. `resolvePortableStore(key)` returns a local mapped DB or a private unmapped store. | Git argv execution, local registry, configured discovery roots. |
| Capture and merge, `@spider/db-core` | `exportChanges(store, cursor, limits)` returns a bounded immutable batch. `applyChanges(store, batch)` validates and commits versions, a receive cursor, and rebuild work. | Core schemas, SQLite functions, pure row codecs, HLC functions. |
| Protocol and move engine, new `@spider/roam` | Pure `nextMove(state, observation)` produces the next durable action. `syncPeer(machine)` and `moveSession(request)` execute through injected ports. | db-core, file transfer port, process and workspace ports. No pi imports. |
| Herdr transfer adapter, `@spider/herdr` | `runRoamCommand`, `putArtifact`, `getArtifact`, `launchRoamingTerminal`, and `placeRemoteTerminal` use existing hc addressing. | HcClient, CLI transport, Mac-only AppClient. |
| Hub entry, `@spider/roam` | `spider roam hub run` holds the Mac process lock, schedules sync, serves local CLI requests, reconciles moves, and supplies the Mac's launch adapter. | Roaming engine, local authenticated Unix socket, launchd, exact-file launcher. |
| Box entry, `@spider/roam` | `spider roam supervisor run` reconciles local homes, holds launch locks, and restarts admitted sessions. `spider roam sync ...` is a short-lived export or apply process. | Local hc core, db-core, exact-file launcher, systemd. |
| Pi adapter, `@spider/host` | `registerRoaming` owns lifecycle admission, turn and tool guards, `/move`, readiness, and move-control IPC. | ExtensionContext, existing session handlers, roaming engine ports. |
| Run ownership adapters, `@spider/subagents` | Require a native, locally admitted run before reaping, adoption, signalling, delivery, or accounting. Expose a read-only move-blocker inventory. | RunStore, process identity checks, local journals. |
| Usage adapter, `@spider/host` | Attributes transcript entries and native run facts to the machine that executed them. It never imports another machine's accounting facts. | Local usage worker and shipped usage migrations. |
| Provisioner, `@spider/roam` | `provision`, `upgrade`, `doctor`, and `uninstall` reconcile a manifest of owned files and service configuration. | Transfer adapter, package release manifest, local secret-consent input. |

The package publishes `dist/roam/cli.mjs` and `dist/roam/supervisor.mjs` as explicit build entries. A new root `bin.spider` points to the CLI. This separates service lifetime from pi and avoids repurposing the existing Herdr setup entry. The CLI loads only the modules needed by its command. `--help` does not open databases or contact a core.

Domain types include `MachineId`, `RepoKey`, `WorkspaceId`, `StreamId`, `SessionId`, `MoveId`, `Epoch`, and `Hlc`. Parse config, CLI arguments, rows, hc replies, and batch bytes at their boundaries. Internal state transitions consume validated discriminated unions. Derive wire row types and capture projections from one versioned entity descriptor registry. Herdr does not import the roaming package. Its generic argv, artifact, and terminal adapter exports structurally satisfy the ports that roaming owns.

### Configuration

Keep machine configuration at `<globalRoot>/roam/config.json`, mode 0600. It has these version-1 fields. The provisioner writes a box-specific file rather than copying the hub file.

| Field | Contract |
| --- | --- |
| `version` | Exactly 1. |
| `role` | `hub` on the Mac or `box` on Linux. |
| `hubMachineId` | The enrolled Mac UUID. Local machine identity comes only from `machine.json`. |
| `peers` | On the hub, a list of `{machineId, hcAlias, enabled, nodePath, cliPath, agentDirectory, globalRoot}` with verified absolute paths. `enabled` defaults to true and controls scheduled sync, not explicit repair commands. On a box, an empty list. |
| `repoDiscoveryRoots` | Local absolute roots for bounded checkout discovery. Default `[]`, requiring explicit maps. Never scan the whole home directory. |
| `storeAllowlist` | `null` for all enrolled stores, or a list of exact store keys. Default `null`. |
| `resourceMappings` | Explicit typed `{source, destination}` path mappings used by provisioning and move preflight. Default `[]`. No replacement inside prose. |
| `coreUnit` | On a box, the verified existing systemd user unit name. Not an arbitrary shell command. |
| `syncIntervalSeconds` | Hub period, default 120. It must be an integer of at least 30. |
| `limits` | Byte limits `sessionBytes = 1073741824`, `workspaceBytes = 8589934592`, and `stagingBytes = 34359738368`, with `transferDeadlineSeconds = 1800`. Values must be positive safe integers. |

The 30-second sync floor prevents an accidental tight loop from keeping every box busy. Release versions, selected agent files, auth consent, and managed-file digests belong to the separate private provision manifest. Operational command timeouts and chunk sizes are protocol constants. A second hub instance, invalid config, or unreachable local socket produces a repair message, not an implicit service launch.

## Portable identities and placement

### Repository identity

Normalize `remote.origin.url` without making a network request:

1. Parse HTTPS, SSH URL, or scp-style Git syntax. Reject a local-file origin for automatic identity.
2. Remove credentials, query, fragment, the default port, a trailing slash, and one trailing `.git`.
3. Lowercase the hostname. Preserve path case and nondefault ports. Decode only unreserved percent escapes.
4. Treat HTTPS and SSH on their default ports as the same Git origin. Serialize `host[:port]/path` as UTF-8.
5. Use `origin:` plus the lowercase SHA-256 digest of those bytes.

Without a usable origin, sort the output of `git rev-list --max-parents=0 --all` and hash its newline-separated object IDs. Prefix the result with `root:`. Multiple roots are included rather than choosing an arbitrary first root. An unborn repository cannot enroll until it has a commit or an explicit key.

`spider roam repo map <repo-key> <path>` can pin an identity when URL aliases, mirrors, or disconnected histories differ. A changed origin never silently rekeys existing data. Doctor reports the mismatch and asks for an explicit mapping. The protocol carries the hash, not the credential-bearing URL.

### Workspace identity

The hub assigns a workspace UUID at first enrollment and records it in each machine's local map. A worktree gets a distinct UUID from the main checkout. Two existing independent workspaces are not merged merely because their branch names match. Discovery under configured roots proposes repo matches, but an ambiguous result blocks a move.

Store keys are `global`, `repo:<repo-key>`, and `worktree:<repo-key>:<workspace-id>`. Wire rows always carry the store key, portable repo key, and workspace ID where applicable. These envelope fields replace absolute placement keys. A mapped row lands in the machine's canonical DB path, and the registry derives its local path keys.

Unmapped stores remain in `<globalRoot>/roam/stores/<sha256-store-key>.db`. They receive replication without creating a checkout or a false `projects` row. Mapping later merges the retained versions into the mapped DB, preserving revision and tombstone identity. The old store becomes a read-only redirect only after verification. This avoids making repo availability a condition of memory sync.

Non-Git directories need an explicit repo key and destination directory map. Version 1 can sync their rows, but automatic workspace transfer requires Git. A move refuses when a separate `/bind` target has no destination mapping. It records that target's portable identity in the move manifest and rebuilds the destination binding locally.

## Data model changes

### Migration contract

Core schema version becomes 14. Append version-14 entries to the three migration maps and put fresh DDL in the three schema strings. Use conditional column helpers and TypeScript backfills inside the migration transaction, as the existing child-column repairs do. Do not edit shipped version-13 SQL.

Read `user_version` inside an IMMEDIATE transaction. Reject a value greater than the supported version before preparing application queries. Validate the required version-14 columns, indexes, and capture triggers on every writable open. A matching version with a missing owned object is an error, not permission to stamp it again. Legacy tables outside the canonical tier remain local and are not exported.

Migration creates no network activity and enrolls no session. Machine identity comes from `<globalRoot>/roam/machine.json`, created with exclusive create and mode 0600. A database's stream UUID is independent of its path. Migration creates metadata with capture disabled. Explicit enrollment seeds the log in the same transaction that enables capture. Worktree capture is additionally limited to session IDs with a local `roam_write_grants` entry. Enrolling one session in a shared worktree must not capture or block unrelated non-roaming sessions.

Use a SQLite backup API or `VACUUM INTO` for a local pre-migration backup. Never copy a live `.db` file alone. Keep backups private and local. The WAL behavior cited above makes a byte copy unsuitable for replication or rollback.

### Common replication tables

The following exact DDL is added to each canonical core DB, not to `usage.db`. `roam_meta` has one row. `store_key` remains null until enrollment.

```sql
CREATE TABLE roam_meta (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	machine_id TEXT NOT NULL,
	stream_id TEXT NOT NULL UNIQUE,
	store_key TEXT,
	hlc_ms INTEGER NOT NULL DEFAULT 0 CHECK (hlc_ms >= 0),
	hlc_count INTEGER NOT NULL DEFAULT 0 CHECK (hlc_count >= 0),
	capture_enabled INTEGER NOT NULL DEFAULT 0 CHECK (capture_enabled IN (0, 1))
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
	body_json TEXT CHECK (body_json IS NULL OR json_valid(body_json)),
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
	deleted INTEGER NOT NULL CHECK (deleted IN (0, 1)),
	PRIMARY KEY (entity, row_key)
);
CREATE TABLE roam_cursors (
	peer_machine TEXT NOT NULL,
	peer_stream TEXT NOT NULL,
	last_seq INTEGER NOT NULL CHECK (last_seq >= 0),
	updated_at INTEGER NOT NULL,
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
CREATE TABLE roam_dirty (
	entity TEXT NOT NULL,
	row_key TEXT NOT NULL,
	change_id TEXT NOT NULL,
	PRIMARY KEY (entity, row_key)
);
```

`seq` orders this replica's export stream, including changes received from peers. `change_id` identifies the original mutation. Forwarding preserves it. A new local mutation gets a random UUID even when the previous row was a tombstone. The unique constraint is also the persistent seen-change set. Version 1 retains logs and tombstones indefinitely, so offline peers cannot resurrect deletions after a retention deadline.

### Global tables

Add these tables to the global schema. Only `session_homes`, `roam_move_requests`, and `roam_move_results` are portable. The rest are local placement, history derived from home changes, or service journals.

```sql
CREATE TABLE session_homes (
	session_id TEXT PRIMARY KEY,
	machine_id TEXT NOT NULL,
	epoch INTEGER NOT NULL CHECK (epoch > 0),
	move_id TEXT,
	updated_at INTEGER NOT NULL
);
CREATE TABLE session_home_epochs (
	session_id TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	machine_id TEXT NOT NULL,
	move_id TEXT,
	PRIMARY KEY (session_id, epoch)
);
CREATE TABLE roam_move_requests (
	request_id TEXT PRIMARY KEY,
	session_id TEXT NOT NULL,
	from_machine TEXT NOT NULL,
	to_machine TEXT NOT NULL,
	expected_epoch INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE TABLE roam_move_results (
	request_id TEXT PRIMARY KEY,
	state TEXT NOT NULL CHECK (state IN ('accepted', 'done', 'failed', 'cancelled')),
	move_id TEXT,
	epoch INTEGER,
	message TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE roam_repo_map (
	repo_key TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	checkout_path TEXT NOT NULL UNIQUE,
	git_common_dir TEXT,
	repo_db_path TEXT NOT NULL,
	worktree_db_path TEXT NOT NULL,
	PRIMARY KEY (repo_key, workspace_id)
);
CREATE TABLE roam_locations (
	session_id TEXT PRIMARY KEY,
	session_file TEXT NOT NULL UNIQUE,
	cwd TEXT NOT NULL,
	repo_key TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	binding_repo_key TEXT,
	binding_workspace_id TEXT,
	observed_epoch INTEGER NOT NULL,
	desired_state TEXT NOT NULL CHECK (desired_state IN ('running', 'stopped', 'suspended')),
	launch_json TEXT NOT NULL CHECK (json_valid(launch_json)),
	failure_count INTEGER NOT NULL DEFAULT 0,
	failure_window_at INTEGER,
	next_restart_at INTEGER,
	last_error TEXT
);
CREATE TABLE roam_holds (
	session_id TEXT PRIMARY KEY,
	move_id TEXT,
	epoch INTEGER NOT NULL,
	mode TEXT NOT NULL CHECK (mode IN ('active', 'frozen', 'armed', 'retired')),
	token_hash TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE roam_moves (
	move_id TEXT PRIMARY KEY,
	request_id TEXT NOT NULL UNIQUE,
	session_id TEXT NOT NULL,
	from_machine TEXT NOT NULL,
	to_machine TEXT NOT NULL,
	source_epoch INTEGER NOT NULL,
	target_epoch INTEGER,
	state TEXT NOT NULL CHECK (state IN (
		'requested', 'checked', 'frozen', 'workspace-ready', 'data-ready',
		'session-ready', 'home-committed', 'destination-live', 'source-stopped',
		'active', 'done', 'rollback-fencing', 'rollback-home', 'rollback-source',
		'rolled-back', 'aborting', 'cancelled', 'failed'
	)),
	details_json TEXT NOT NULL CHECK (json_valid(details_json)),
	last_error TEXT,
	updated_at INTEGER NOT NULL
);
```

`launch_json` contains validated nonsecret argv, resource mappings, pi agent directory, and project-trust choice. It never contains an auth environment or inherited HC variables. `details_json` has `version: 1`, `nextAction: {id, kind, argumentsSha256} | null`, `source`, `destination`, `workspace`, `transcript`, `barriers`, and nullable `cancellationProof`. The source and destination records hold observed process, core, terminal, session-file, cwd, epoch, capability-file, and hold-proof references. Workspace and transcript records hold their manifest paths and SHA-256 digests, or null before preparation. Each barrier is `{storeKey, senderStream, through}`. Fields required by a transition must be present before entering that state. Capabilities are referenced by private file path, not embedded. This local journal is not executable code. The move states are enumerated in the move section.

A box can insert an immutable move request only for a session homed there at `expected_epoch`. Requests expire after 24 hours. Only the hub writes results. Only the hub writes homes. `session_home_epochs` derives from authenticated home changes, including epoch 1, and proves who could write historical session records. Home changes cannot be deleted in version 1.

### Existing portable rows

These are the complete version-1 projections. Keep all existing columns not explicitly excluded. Integer primary keys and local-only columns are allocated locally and never appear in wire bodies.

| Entity | Portable row key and projection | Schema changes |
| --- | --- | --- |
| `global_memory` | `uuid`. All columns except `id`. | No source-table columns. |
| `memory` | `uuid` within the repo store. All columns except `id`. | No source-table columns. |
| `sessions` | `id` within the worktree store. Existing columns except `imported_from`, plus the new search fields and provenance below. | Add `search_name TEXT`, `search_content TEXT NOT NULL DEFAULT ''`, `imported_ref TEXT`, `origin_machine TEXT NOT NULL DEFAULT ''`, and `home_epoch INTEGER NOT NULL DEFAULT 0`. Keep `imported_from` as a local locator. |
| `todos` | New `uuid` within the worktree store. Existing columns except `id`, plus provenance. | Add `uuid TEXT`, `origin_machine TEXT NOT NULL DEFAULT ''`, and `home_epoch INTEGER NOT NULL DEFAULT 0`. |
| `runs` | Existing UUID `id` within the worktree store. Exclude `pid`, `host_pid`, `pid_start_time`, `intercom_session`, and the local `historical_only` flag. Include provenance. | Add `origin_machine TEXT NOT NULL DEFAULT ''`, `home_epoch INTEGER NOT NULL DEFAULT 0`, and `historical_only INTEGER NOT NULL DEFAULT 0 CHECK (historical_only IN (0, 1))`. |
| `run_events` | New `uuid` within the worktree store. Existing columns except `id`, with the payload rules below and provenance. | Add `uuid TEXT`, `origin_machine TEXT NOT NULL DEFAULT ''`, `home_epoch INTEGER NOT NULL DEFAULT 0`, `origin_seq INTEGER NOT NULL DEFAULT 0`, and `historical_only INTEGER NOT NULL DEFAULT 0 CHECK (historical_only IN (0, 1))`. `historical_only` is local and is not exported. |

Epoch zero means not enrolled and never appears in a portable batch. During enrollment, the hub assigns an owner and positive epoch to every selected session identity, including imported historical records and session IDs found only on todos. A historical identity has no launch location and cannot activate pi. Enrollment selects one authoritative source when independent imports reuse the same identity. A child's run history uses its parent's session ID and epoch, not a separate home for the child.

For sessions and todos, provenance records the latest mutator. Their producers update `origin_machine` and `home_epoch` on each put. For runs and run events, provenance records execution origin and is immutable. Envelope `writer_session` and `writer_epoch` instead identify the grant authorizing the current mutation, including a delete of an older row. Never derive delete authority from the deleted row's old epoch.

Backfill `run_events.origin_seq` from its original integer ID. New native event producers set it to their allocated local event ID in the same transaction. Read-only historical viewers sort one run's events by execution origin and `origin_seq`, not by newly allocated replica rowids. Operational tailers continue to consume only local native events.

Version-14 backfill does the following inside its transaction:

1. Assign UUIDs to existing todos and run events. Use `lower(hex(randomblob(16)))` once per row. Preserve local integer IDs so FTS rowids and local event cursors do not change.
2. Create unique indexes `idx_todos_uuid ON todos(uuid)` and `idx_run_events_uuid ON run_events(uuid)`. Both fresh and upgraded schemas use the nullable declarations above plus the guards below.
3. Detect duplicate `(session_id, seq)` pairs before creating `CREATE UNIQUE INDEX idx_todos_session_seq ON todos(session_id, seq)`. On a duplicate, roll back the migration and list the local row IDs and ambiguous sequences. Do not delete or renumber records automatically. A preflight doctor can inspect the old schema read-only so the conflict can be repaired deliberately. Fresh and successfully upgraded schemas always have the same unique index.
4. Backfill `sessions.search_name` and `search_content` from FTS before rebuilding FTS. For duplicate FTS rows, use the last nonempty name by rowid and concatenate distinct nonempty excerpts in rowid order with a newline. Keep `sessions.name` authoritative when present.
5. Set local machine provenance for existing native rows. Keep epoch zero until explicit hub enrollment selects the authoritative source and assigns the session's positive epoch. Prove a live session's owner before enrollment.
6. Convert `imported_from` to an opaque `imported_ref` with `{machineId, sha256CanonicalPath, sessionId}` JSON. Retain the original path only locally. Import duplicate checks use the embedded original session ID and its logical imported-session row, not the current path or machine-specific locator. Parse the source header before candidate writes so importing a moved file cannot create another set of todos.

New and updated UUIDs must be nonempty and immutable. Generate UUIDs in every producer, including todo import, run-event append, completion claims, and usage claims. For each of `todos` and `run_events`, install the following guards with `{entity}` replaced by that literal table name. These guards run even when capture is disabled. They allow additive migration without rebuilding the external-content todo index.

```sql
CREATE TRIGGER roam_{entity}_uuid_bi BEFORE INSERT ON {entity}
WHEN NEW.uuid IS NULL OR NEW.uuid = ''
BEGIN
	SELECT RAISE(ABORT, 'roaming UUID is required');
END;
CREATE TRIGGER roam_{entity}_uuid_bu BEFORE UPDATE ON {entity}
WHEN NEW.uuid IS NULL OR NEW.uuid = '' OR NEW.uuid IS NOT OLD.uuid
BEGIN
	SELECT RAISE(ABORT, 'roaming UUID cannot change');
END;
```

A native run-event insert can allocate its integer ID first, then set `origin_seq` to that ID before the surrounding transaction commits. For this insert only, the codec projects a zero `origin_seq` as the new row's allocated `id`. The subsequent metadata update therefore has an unchanged portable projection and creates no second change. Imported events retain their supplied positive origin sequence.

Add a worktree-local admission table:

```sql
CREATE TABLE roam_write_grants (
	session_id TEXT PRIMARY KEY,
	machine_id TEXT NOT NULL,
	epoch INTEGER NOT NULL,
	mode TEXT NOT NULL CHECK (mode IN ('active', 'frozen', 'history'))
);
```

A grant is not portable. Enrollment installs one for every selected session identity. Apply creates a history grant for an incoming session identity, with its current home machine and epoch, even if no local session row exists. A foreign history grant authorizes no local mutation. A local history grant permits only the explicitly enrolled importer, not a pi launch. The source freeze changes its active grant before acknowledging quiescence. Grants cover session rows, todos, runs, and run events, including writes from a supervisor or background organism task. Todo allocation and toggles use IMMEDIATE transactions. Update and delete by UUID after resolving the display sequence. Todo import uses the same store operations instead of a separate `MAX(seq)` allocation path. Mutations of another session's replicated todos are refused outside that session's home. Read-only cross-session listings remain available. This restriction makes the single-writer rule real rather than assuming that `/todos` always edits the current session.

### Exact capture trigger contract

Use SQLite triggers, not a best-effort bus subscriber. This covers direct SQL producers and supervised child writers. Every writable db-core connection registers `roam_uuid()`, `roam_wall_ms()`, `roam_importing()`, `roam_authorize(entity, oldJson, newJson)`, and `roam_pack(entity, rowJson)`. Read-only opens register no write functions.

`roam_pack` is a pure, versioned codec. Its argument is `json_object` over every source column. It returns canonical JSON for exactly the projection above. It removes local capabilities and converts declared path fields to artifact references. It never substitutes strings inside arbitrary prose. The descriptor registry generates that argument list and the trigger SQL. Unknown entities or payload versions fail closed at export.

For each portable entity, generate triggers named `roam_<entity>_bi`, `_bu`, `_bd`, `_ai`, `_au`, and `_ad`. The global set is `global_memory`, `session_homes`, `roam_move_requests`, and `roam_move_results`. The repo set is `memory`. The worktree set is `sessions`, `todos`, `runs`, and `run_events`.

The three before triggers call `roam_authorize` when capture is enabled, the managed-row predicate below matches, and `roam_importing() = 0`. It raises `ABORT` for a wrong machine, wrong epoch, missing grant, frozen writer, changed primary identity, non-hub home or result mutation, or mutable request. It reads the local grant on the triggering connection and uses its validated writer context. It opens no second DB and writes no state from inside the function. Child supervisor requests carry the parent session ID, machine ID, and epoch so their direct SQL uses the same grant. The session-ID home check is independent of a filename. Source-table guards still run when the caller uses raw SQL.

The following is the exact after-trigger template for a put. `{entity}`, `{key}`, and `{row}` are generated SQL identifiers or expressions, never user text. For insert, use `NEW`. For update, use `NEW` and run only when the old and new portable projections differ. Import disables capture through a connection-local flag, never a persisted global switch.

```sql
CREATE TRIGGER roam_{entity}_{suffix} AFTER {operation} ON {entity}
WHEN (SELECT capture_enabled FROM roam_meta WHERE id = 1) = 1
	AND roam_importing() = 0
	{managed_row_predicate}
	{portable_change_predicate}
BEGIN
	UPDATE roam_meta SET (hlc_ms, hlc_count) = (
		WITH sample(ms) AS MATERIALIZED (SELECT roam_wall_ms())
		SELECT max(roam_meta.hlc_ms, sample.ms),
			CASE WHEN sample.ms > roam_meta.hlc_ms THEN 0 ELSE roam_meta.hlc_count + 1 END
		FROM sample
	) WHERE id = 1;
	INSERT INTO roam_changes (
		change_id, entity, row_key, op, hlc_ms, hlc_count,
		origin_machine, origin_stream, writer_session, writer_epoch,
		schema_version, body_json
	)
	SELECT roam_uuid(), '{entity}', {key}, 'put', hlc_ms, hlc_count,
		machine_id, stream_id, {writer_session}, {writer_epoch}, 14,
		roam_pack('{entity}', {row})
	FROM roam_meta WHERE id = 1;
	INSERT INTO roam_versions (
		entity, row_key, change_id, hlc_ms, hlc_count,
		origin_machine, origin_stream, deleted
	)
	SELECT entity, row_key, change_id, hlc_ms, hlc_count,
		origin_machine, origin_stream, 0
	FROM roam_changes WHERE seq = last_insert_rowid()
	ON CONFLICT(entity, row_key) DO UPDATE SET
		change_id = excluded.change_id, hlc_ms = excluded.hlc_ms,
		hlc_count = excluded.hlc_count, origin_machine = excluded.origin_machine,
		origin_stream = excluded.origin_stream, deleted = excluded.deleted;
END;
```

The substitutions are fixed as follows:

- Insert uses suffix `ai`, operation `INSERT`, and no portable-change predicate. The managed-row predicate still applies. Update uses `au`, `UPDATE`, and `AND roam_pack(entity, oldRow) IS NOT roam_pack(entity, newRow)` with the entity as a SQL string literal.
- Delete uses suffix `ad`, operation `DELETE`, and `OLD` keys. Its insert has `op = 'delete'`, `body_json = NULL`, and the version upsert has `deleted = 1`. All other SQL is the same.
- Row keys are `NEW.uuid` for memory, todos, and run events, `NEW.id` for sessions and runs, `NEW.session_id` for homes, and `NEW.request_id` for requests and results. Delete uses the corresponding `OLD` value.
- `writer_session` is the row's session ID for sessions, todos, runs, and run events. `writer_epoch` is `(SELECT epoch FROM roam_write_grants WHERE session_id = <that-session-id>)`. Use `NEW` for puts and `OLD` for deletes. Other entities use SQL `NULL` for both.
- For worktree entities, `{managed_row_predicate}` is `AND EXISTS (SELECT 1 FROM roam_write_grants WHERE session_id = <that-session-id>)`. Other entities use no extra predicate. Use that same predicate on the before triggers. Grant presence decides participation, while grant state and writer context decide permission. A frozen grant must cause an authorization error, not silently disable capture.
- Before triggers use `BEFORE INSERT`, `BEFORE UPDATE`, or `BEFORE DELETE`, the same enable predicate, and `SELECT roam_authorize(...)`. Insert passes SQL `NULL` for the old row. Delete passes SQL `NULL` for the new row.

The materialized clock subquery samples wall time once per captured row, even if the wall clock changes during a statement. A capture clock update and both inserts share the source mutation's transaction. A capture failure rolls the mutation back. PID-only changes to runs produce no portable change. A replay writes its original envelope to `roam_changes` explicitly, updates the version, and applies the row with capture suppressed. No imported change is restamped as a local edit.

### Usage remains local

Do not install common roaming tables or triggers in `usage.db`. The existing complete-layout gate would reject them. Instead, append a shipped usage migration at version 7 with this exact SQL:

```sql
ALTER TABLE calls ADD COLUMN execution_machine TEXT;
CREATE UNIQUE INDEX idx_calls_execution_entry
	ON calls(execution_machine, session_id, entry_id)
	WHERE execution_machine IS NOT NULL AND source_kind = 'transcript';
```

Update the expected layout and fresh creation path by applying the same migration sequence. Other usage tables, totals, and proof rules remain local.

Each move appends a non-context `spider-roam-segment` custom entry to the destination copy before pi opens it. Its version-1 data is `{version: 1, moveId, epoch, previousMachine, nextMachine, historyMachine}`. The first marker's `historyMachine` identifies entries before that marker. Later markers must retain that same initial history machine. Entries after each marker belong to its `nextMachine`. Rollback adds no marker to the untouched source. A later successful move carries all earlier markers. Segment ownership follows physical file order, independently of the active conversation branch.

Before the first local move or enrollment of an existing source, usage completes ingestion and stamps its existing transcript calls with the local execution machine. It rekeys managed transcript call IDs to the SHA-256 of `[executionMachine, sessionId, entryId]` and updates dependent call references in the same ledger transaction. Existing prices and coverage evidence survive. The worker must stop its ingest lease during this conversion.

For managed transcripts, ingestion reads the marker index before billing entries. It retains only locally executed usage, including compaction and cache warming. Source relocation, an inode change, or a rewritten header resets parser caches, not durable managed call facts. Stable execution keys make a round trip idempotent. Conflicting bytes for an already-known execution entry report corruption rather than replace the bill. Unmanaged sources keep their current reset behavior.

Usage discovery also reads exact managed session paths from local `roam_locations`, including flat custom session directories. It does not derive additional scan roots from a transcript's header or from foreign rows. The compact usage parser retains roaming marker data so chunked ingestion can recover the execution segment after restart.

Native run discovery and run-event accounting require local `origin_machine` and `historical_only = 0` on both runs and events. Imported `spider_usage` facts and `spider_usage_reported` sentinels never generate local charges. A history view can display recorded tokens without counting them in the machine's ledger. The Mac does not add box totals to its own account counter.

## Sync protocol

### Enrollment and scheduling

`spider roam enable` creates the hub identity, installs its user service, and records the enrolled machine set. `spider roam provision` adds a box only after its identity, pinned build, and private storage pass doctor. A machine identity file is not copied from another machine. A machine-ID mismatch stops sync before data import. Bind each operation to the current hc core identity. A core replacement during an operation invalidates that operation's observations and requires a fresh handshake. A proved restart with the same enrolled machine UUID is allowed. Core identity is not pinned forever, since normal restarts must recover.

The hub polls each connected machine every 120 seconds and offers `spider roam sync [machine]`. It starts the first sync immediately after service startup. Use one task per peer and one writer per store. A slow peer cannot block another peer. There are at most two concurrent transfers, with no overlapping transfer to the same peer. Disconnected peers retry after 30, 60, and then 120 seconds, capped there. Timer delays do not change a cursor.

Enrollment chooses one existing replica as the initial source for each session. It refuses duplicate live copies or conflicting histories. Session IDs must be unique across the enrolled catalog, including custom pi IDs in different workspaces. A collision must be resolved before enrollment, not merged by name. Existing independent memories can merge by UUID. Existing todo histories are not guessed to be identical from matching text or sequence numbers. Before a box is offline, every hosted session must have a hub-issued home and local admission. New unenrolled top-level sessions cannot join roaming while the hub is absent. Ordinary non-roaming sessions are unchanged.

For initial admission, selected live sessions must run the guard-capable build and reach the same settled state required by a move. Freeze their delivery gates and local writers under an enrollment operation with expected epoch zero. The hub creates epoch 1, the source stamps and seeds its selected rows through the canonical codecs, and the source acknowledges its new grants before release. A failed initialization stays explicitly frozen until reconciliation or a proved cancellation. Journal it at `<globalRoot>/roam/enrollments/<id>.json` with `{version: 1, id, sessionId, storeKeys, stage, capabilityFile, seedReceipts}`. Stages are `freezing`, `home-published`, `seeding`, `active`, and `cancelled`. Each store writes a self-addressed `roam_receipts` entry with batch ID `enroll:<id>:<storeKey>` atomically with its seed log and grant updates; retry skips a receipt already present. Rerunning the initiating command reconciles those receipts. Cancellation is allowed only before epoch 1 is published. After that, recovery completes admission on the assigned source. Never seed a live unguarded writer or infer ownership from a transcript filename.

A selected imported historical identity uses the same home-publication and seed receipts, but freezes only its database writers. It creates a history grant, not an active hold or launch location. If inventory finds a possible live owner, require the live admission procedure instead. Importing history is not permission to launch its original session file.

### Batch and cursor

A batch is uncompressed UTF-8 NDJSON. The first line is a version-1 header:

```json
{"type":"batch","protocol":1,"schema":14,"batchId":"uuid","senderMachine":"uuid","senderStream":"uuid","storeKey":"global","after":0,"through":17,"count":17}
```

Each later line is `{seq, changeId, entity, rowKey, op, hlc: {ms, counter, machine, stream}, writerSession, writerEpoch, schema, body}`. The HLC machine and stream are the original writer, not the forwarder. The header's stream and `seq` identify this sender's export ordering. A transport manifest records the byte length and SHA-256 of the entire batch.

`after` is an exclusive cursor. The sender takes one SQLite read snapshot, records its high sequence, and exports consecutive available rows up to that high sequence within the batch limits. `through` is the last included sequence, or `after` for an empty batch. Version 1 does not prune logs, so a sequence gap is corruption. Export never holds a write transaction across transport.

A batch contains at most 256 records and 32 MiB. One row body is at most 16 MiB. Oversized existing rows stop that store with the entity and key. They are never trimmed. Split later records into another batch. Validate the entire batch before applying any row.

The receiver commits a store's row changes, tombstones, log inserts, clock observation, dirty owners, `roam_cursors` update, and digest-bound `roam_receipts` row in one IMMEDIATE transaction. It accepts a replay whose `through` is already committed only if the corresponding change IDs and canonical contents match. A partially overlapping batch must have the same committed prefix and a consecutive suffix. Reject a skipped cursor or conflicting ID.

The receiver returns `{batchId, senderStream, through, sha256}` after commit. Its receipt remains durable after transfer files are cleaned. Empty exports need no import or new receipt. If the reply is lost, the hub queries `sync cursor` and compares the digest-bound receipt before resending. A resend uses the same artifact. A store can commit even if another store fails. Move barriers wait for every required store, so partial cross-store sync never authorizes a move.

### Ordering and merge

Compare versions lexicographically by `(hlc.ms, hlc.counter, hlc.machine, hlc.stream)`. Node identity includes the concrete database stream because separate DBs cannot share an atomic clock. This is a per-node HLC, not a claim that one machine serializes every database write.

On receive, set `m = max(local.ms, remote.ms, wallNow)`. If both clocks have `m`, use `max(local.counter, remote.counter) + 1`. If only one has `m`, use that clock's counter plus one. Otherwise use zero. The next local capture advances from that durable clock. Equal clocks with different bodies or change IDs for the same row are corruption. Clock arithmetic must stay within safe integer bounds.

Reject a remote physical component more than five minutes ahead of the receiver's wall clock. Keep the batch and cursor unchanged and name the clock that needs repair. Backward local clock jumps use the durable logical counter. This bounds damage from a misconfigured clock without changing last-writer-wins semantics.

For a valid unseen change:

1. Verify the origin is enrolled and authorized for this entity. Session provenance must match a hub-issued entry in `session_home_epochs`. A request must come from its source home or the hub's human-command entry. Homes and results must come from the hub.
2. Insert the unchanged envelope into the local log, even if a newer row version already exists. This records the seen ID and permits forwarding.
3. Compare it with `roam_versions`. A newer put replaces the whole portable row. A newer delete removes the materialized row and records a tombstone. An older version changes neither.
4. Allocate local integer IDs for puts. Null the local process columns on foreign runs. Set newly imported runs and events to `historical_only = 1`. An update of an existing native row preserves its local flag. A newly reconstructed same-machine replica remains history-only even when its execution origin matches this machine.
5. Rebuild lexical companions and mark changed embedding owners dirty before committing.

Session homes also require contiguous epochs and the recorded move ID. Equal epochs must have the same owner. A home update cannot be authorized by HLC alone. The hub's sole writer makes its valid HLC order agree with epoch order. Apply required home history before session-scoped changes. A row whose home history has not arrived stays in the unapplied batch until the hub supplies it.

The hub pulls all available peer changes before pushing its merged changes to that peer. Imported envelopes circulate unchanged. The unique change ID prevents echo loops. Concurrent memory changes use row-level LWW, including approval and archive state. This does not merge text fields or preserve both conflicting edits. Imported accepted memory does not rerun review or local admission. Report a merged memory-cap overflow for explicit cleanup instead of silently discarding rows. A hard delete wins over older puts, but a genuinely newer put can recreate a row.

### Schema and derived data

Every handshake and envelope carries protocol and core schema versions. Version 1 requires protocol 1 and core schema 14 at both ends. Refuse a newer version before mutation and report which machine needs an upgrade. An older version also needs an upgrade before participating. There is no field-dropping downgrade path. A changed portable layout requires a new core version and descriptor set.

Maintain `sessions_fts` from `COALESCE(sessions.name, sessions.search_name)`, `summary`, and `search_content`. Import and organism writers must update source columns first. Todo FTS uses the new local integer rowid. Memory FTS includes active rows only. These lexical updates share the apply transaction, so acknowledged rows are searchable immediately.

A winning text or status change removes stale owner vectors and enqueues fresh local embedding work. `roam_dirty` survives a crash between apply and queue drainage. Queue creation and dirty-row deletion share a transaction and compare `change_id`, so an older rebuild cannot clear a newer task. A machine without an embedding provider still has lexical search. No vector dimension, provider availability, retry count, or native index file crosses machines.

Apply publishes a new read-only `replica_applied` invalidation after commit. It never emits operational run-completion events through the existing bus. Existing append helpers publish committed run events through that bus, so replaying those events would be unsafe. See `packages/db-core/src/events.ts:28-43`.

### What never syncs

| Data | Reason and retained behavior |
| --- | --- |
| `projects`, `session_bindings`, `run_routes`, repo maps, locations, grants, holds, and move journals | They name local files or live ownership. A move rebuilds its destination placement and binding. Routes remain on the run's origin. |
| PIDs, PID start times, intercom identities, leases, IPC sockets, capabilities, terminal maps, Herdr feed files, and job journals | They authorize local processes or address one core. Copying them cannot move the process. Rebuild them locally. |
| Message mirror and broker queues | Delivery is machine-local and has no cross-machine acknowledgement protocol. Pending asks block a move rather than disappear. |
| Usage DB, source cursors, leases, account counters, and model timing stats | Each machine accounts for what it ran. The provenance adapter prevents copied history from becoming a new charge. |
| Skills, review queues, review leases, and curator state | Filesystem materialization and counters need a separate protocol. Provisioning can copy a selected skill snapshot, but that is not ongoing sync. |
| `content`, routing `events`, fetched text, large-output indexes, and upstream-watch state | They are outside the agreed portable units. Reindex available files locally. Arbitrary inline content and old tool-output files remain on their origin. |
| FTS tables, vector tables, embedding queues, and graph insights | They are local derived data. Preserve FTS-only session source fields first. |
| SQLite migration backups, WAL, SHM, and lock files | They belong to one local SQLite instance and are not merge units. |

Memory text, todo text, and historical tool text may contain old absolute paths. Treat them as content, not local file authority. Declared locator fields use `{machineId, repoKey, workspaceId, relativePath}` when inside a mapped workspace, or an origin-qualified opaque artifact reference otherwise. Imported history displays "Saved on another machine" for an unavailable artifact. It never opens a coincidentally matching local absolute path.

`run_events` keeps completion and usage sentinels as history with stable UUIDs and origin. Reaper, durable adoption, kill, completion delivery, run-status mutation, and accounting consumers require local origin, local admission, and `historical_only = 0` before acting on a run or event. Read-only history queries include both classes. Known supervisor payloads export only their run identity, outcome, and origin-qualified artifact reference. Remove endpoint paths and capabilities. Unknown event types or payload versions block export rather than leak a token or replay executable continuation state. A move also requires all completed child notices to be observed and local usage reports to be settled.

The event descriptor registry assigns every producer type one of these policies. Coverage fixtures must include each current emitted type, including dynamic child protocol events. The existing named history helpers are at `packages/subagents/src/run-events.ts:4-30`, and source control events are emitted at `packages/subagents/src/runner.ts:87-88`, `packages/subagents/src/runner.ts:124-125`, and `packages/subagents/src/supervisor-main.ts:77`.

| Event policy | Portable payload and consumer rule |
| --- | --- |
| History | Tool intent and result, status, handoff, escalation, message, log, warning, and registered child message and tool events retain their data for read-only display. Typed locators become artifact references. No payload dispatches a tool or continuation. |
| Local control | `child_transcript` and `child_supervisor` become version-1 records with an origin-qualified artifact reference and no directory, endpoint, or token. `chain_steps` becomes a count and origin-qualified history reference, never executable remaining steps. |
| Delivery claim | `completion_delivered` retains its event identity and claim as inert history. A foreign claim cannot claim or suppress a local operation. |
| Accounting | `spider_usage`, `spider_usage_reported`, and `spider_compaction` retain recorded history but do not enter another machine's accounting or report sink. |

## Herdr transport

The hub invokes a pinned remote CLI by argv, not shell interpolation. Short commands use `hc exec --on <alias> -- <node> <cli> ...`. Commands that may exceed direct-exec limits use a labelled `hc run --bg --no-notify --outlive-parent --no-parent --on <alias> -- <node> <cli> ...` and a private receipt. No new SSH route or TCP service is introduced.

The remote command set is:

| Command suffix after `spider roam` | Result |
| --- | --- |
| `sync inventory --json` | Machine identity, supported schema, stores, stream IDs, high sequences, and admitted homes. |
| `sync export --store <key> --after <seq> --request <id>` | Immutable batch and transfer manifest paths, or an empty receipt. |
| `sync import --manifest <file> --request <id>` | Validates and applies a complete artifact. Returns its committed cursor receipt. |
| `sync cursor --store <key> --stream <id> --json` | Durable receive cursor and last receipt. |
| `artifact split`, `artifact assemble`, and `artifact inspect` | Bounded chunk files, verified reconstruction, and local metadata. No arbitrary command execution. |
| `session inspect`, `freeze`, `arm`, `start`, `release`, `retire`, and `unfreeze` | Idempotent move-control operations bound to a move ID and expected epoch. |

Internal commands require a private request file under the enrolled roaming root, with the hub identity, operation ID, expected machine identity, and random operation capability. They are not model tools. The capability is sent through private file transfer, never an argv, label, transcript, or log line. Local CLI requests use a same-user Unix socket with a mode-0600 capability file. A box request reaches the hub only through its portable request row.

Use 384 KiB raw chunks encoded as base64 in immutable text files. A chunk contains artifact ID, index, raw length, and SHA-256. Its encoded representation and hc JSON reply stay below 1 MiB. `hc file write --on <alias> <chunk-path>` uploads a chunk through stdin. `hc file read --on <alias> <chunk-path> --json` downloads text. A manifest lists ordered chunk hashes, total bytes, artifact hash, and format version. Manifest pages are bounded to 512 KiB and linked by digest when necessary.

The receiver writes a private staging file with exclusive create, verifies each decoded chunk, streams the whole hash, fsyncs, and atomically renames only after verification. Existing chunks with the same digest are reusable. An existing final artifact with a different digest is a conflict. A missing chunk, short write, digest mismatch, or unknown format cannot advance an apply cursor.

Default limits are 1 GiB for a session file, 8 GiB for a workspace transfer, and 32 GiB of staging per peer. The staging allowance includes base64 chunks and their reconstructed file. Only one artifact transfer per peer runs at once. The machine config can lower limits or explicitly raise them before a move. The transport does not use the model-facing single-file copy action or its 64 MiB limit. It does not send base64 through model context. Files larger than a batch or reply limit are streamed through chunks, not loaded into one process buffer.

Each hc call has a 15-second deadline. Retry file chunks three times with delays of 1, 2, and 4 seconds. A transfer has a 30-minute deadline by default. A direct command with a lost result is reconciled by request ID before retry. A timed-out job with no receipt has an unknown outcome, not success. There is no local fallback on a failed box command.

Committed batch artifacts can be removed after their receipt is verified. Incomplete transfer staging survives service restart and expires after seven days only when no active move or unapplied batch references it. A quota failure stops new transfers and names the directory. It never removes logs, tombstones, source workspaces, or caller-owned artifacts to make room.

## Box provisioning

### Installation and consent

`spider roam provision box-1.invalid` runs from the Mac. It inventories the selected hc machine, shows the exact files and destinations, and reconciles this installation:

1. Verify Linux, systemd user services, a reachable existing hc core, Git, and Node `>=22.19.0`. That Node floor comes from the pinned pi package at `pi/package.json:94-96`. Record resolved executable paths. Prefer an existing supported system Node. Do not install inside a versioned Node directory.
2. Install pi 1.2.0 and pi-intercom 0.13.0 in a private release-specific npm prefix under `~/.local/share/spider-roam/releases/<release-id>/prefix`. Use the destination's public npm registry. Later releases must name tested exact versions and tarball hashes in the release manifest, not floating tags.
3. Copy spider's release tarball from the Mac in chunks. Verify its release digest and install it under the same prefix. Build native SQLite dependencies on Linux with that Node. Never copy Mac `node_modules`. If a compiler or native prerequisite is missing, stop with the package prerequisite list. Do not silently use sudo.
4. Copy the selected agent-file snapshot into a staged agent directory. The default selection is settings, model definitions, keybindings, themes, AGENTS.md, and explicitly selected skill directories with their support files. Prompts, extra extensions, MCP config, and system-prompt files require explicit selection in the provision manifest.
5. Adapt typed configuration paths, extension package paths, shell commands, resource roots, and localhost endpoints. Preserve destination overrides. Reject unresolved Mac-only commands and absolute paths rather than text-replacing arbitrary file bodies. Do not copy trust decisions, intercom state, session directories, or caches.
6. Write a core-only Herdr config using the box's own core binary, config, agent directory, global root, runtime root, and namespace. Do not inherit the Mac's HC environment or app paths.
7. Install the user service, limits, and supervisor manifest. Run native-module, auth-readiness, core-ownership, schema, file-mode, and exact-session launch probes before enabling hosting.
8. Atomically select the verified release through `~/.local/share/spider-roam/current`. Enable the supervisor only after the machine has enrolled with the hub.

Provisioning does not copy authentication by default. `--include-auth` is a human-only option. On each target machine, it requires explicit confirmation of the provider names and destination, with no secret values displayed. A model tool, config default, unattended rerun, or another agent's approval cannot supply that consent. Without consent, setup finishes as `installed, sign-in needed`, with hosting disabled until a private sign-in succeeds.

Credential-bearing fields inside selected settings, model definitions, or MCP config count as auth too. Secret commands are not executed to collect their output. Ambient credentials must be configured on the destination separately. An unsupported credential command fails adaptation. Credentials travel only in a dedicated private artifact and are removed from transfer staging after install. Auth refreshes are machine-local and never sync back.

Provisioning writes a private ownership manifest with previous and installed digests. A second run with unchanged inputs has zero managed-file changes and starts no second service or agent. A concurrent or unowned edit is a conflict. The provisioner records every completed action before proceeding, so reruns reconcile rather than repeat an uncertain install.

### Service units and limits

The Mac gets `~/Library/LaunchAgents/io.spider.roam-hub.plist`. It runs the absolute pinned Node and CLI paths with `roam hub run`, `RunAtLoad = true`, `KeepAlive = true`, a ten-second throttle, and private log paths under the global root. The hub holds a PID-and-start-identity process lock. A second invocation exits without running sync or moves. The local socket is under `<globalRoot>/roam`, not a system temporary directory.

The box gets this systemd user unit. Provisioning substitutes verified absolute paths and the detected existing core service name.

```ini
[Unit]
Description=Spider roaming session supervisor
After=herdr-core.service
Requires=herdr-core.service
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=<node> <installed-package>/dist/roam/supervisor.mjs run
Restart=on-failure
RestartSec=10
UMask=0077
LimitNOFILE=65536
Environment=SPIDER_GLOBAL_ROOT=<global-root>
Environment=PI_CODING_AGENT_DIR=<agent-directory>

[Install]
WantedBy=default.target
```

The core unit must have the same `LimitNOFILE=65536`, because it owns the spawned terminal process. A managed drop-in sets that limit and adds `Wants=spider-roam-supervisor.service` in its Unit section. Add `PartOf=herdr-core.service` to the supervisor's Unit section, substituting the detected name there too. This restarts the supervisor with the core and starts it again after a later core start. Keep the existing core startup command and lifetime policy. Enable user lingering only after showing that host-level change and obtaining any required administrative permission. A box that cannot sustain user services after disconnection is not eligible for unattended hosting.

Request `fs.inotify.max_user_instances >= 1024` and `fs.inotify.max_user_watches >= 524288`. These are floors, not instructions to lower existing values. A managed sysctl file is optional and needs administrative permission. Without it, doctor checks the current values and refuses unattended hosting when they are below the floors. The provisioner can prepare the command for a human without executing it.

No hard CPU or memory quota is set by default. The release probes one native SQLite open and one representative resource load under the inherited limits. A low disk-space warning appears at less than 1 GiB free under the roaming root. Writes still fail transactionally if the filesystem fills. It is not acceptable to run without capture because the log is large.

### Core-only Herdr mode

Add `mode: "full" | "core-only"` to the Herdr config. The default is `full`. Make `app` a required field only for `full` mode in both parser and types. Core-only mode establishes the same local core, terminal, ancestry, session, and generation ownership. It retains status, local process presence, local IPC, child execution, and job monitoring where a configured destination exists.

It does not instantiate AppClient, install app mods, arrange panes, generate app repair warnings, or call focus and layout operations. App-dependent actions return `This view is available on the Mac.` An absent app is not an activation warning. With no configured outbound machines, a box's `on` call says that the destination is unavailable there. It never relays through the Mac or runs locally instead.

The Mac app uses Herdr's native remote terminal status. The hub creates or reuses one owned space per configured machine and places the returned remote terminal there using the machine-qualified app identity. Boxes never call the Mac app. A stopped app delays placement but does not stop the terminal or make a successful session launch fail. Rich spider feed rows for remote todos and children are not part of this design.

### Upgrade and uninstall

`spider roam upgrade <machine>` stages and probes a complete pinned release beside the current one. It suspends new launches, waits for hosted agents to be idle without blockers, and restarts them one at a time under their existing homes. It migrates local DBs only after private backups. Upgrade the hub first, then boxes. A schema mismatch pauses sync until both sides support the new version.

An interrupted upgrade keeps its journal and either the old verified binary or the new verified binary selected. Do not downgrade a binary across an applied incompatible DB migration. Restore a backup only with separate human approval after proving that it would not discard later work. Retain the previous release for binary rollback when the schema permits it.

`spider roam uninstall <machine>` refuses while a launchable session is homed there, a live process uses the owned release, or a move references it. A stopped native session is still launchable and must move first. A historical identity alone does not block uninstall only when its grant is history-only and no active or armed hold or launch location exists. If that distinction cannot be proved, refuse. Keep historical home records and their data unchanged. Uninstall disables the peer's scheduled sync and owned service, removes only unchanged managed artifacts, and restores owned config fragments whose digests still match. It keeps data, session files, workspace files, and credentials by default. `--remove-auth` requires separate consent and removes only credentials installed by this provisioner. Removing a local credential does not revoke it at its provider. Uninstall never stops or uninstalls an independently managed hc core.

## Hosting and the box supervisor

The supervisor starts after the box's existing Herdr core. It does not depend on a Mac connection or on the app. It reconciles at startup, on hc events, on home or hold changes, and every ten seconds as a missed-event check.

For each locally homed session with `desired_state = running`, it checks all of the following before launch:

- The home machine and epoch match local enrollment.
- The durable hold is active, or it is armed for the exact pending move. No unresolved local freeze journal contradicts that hold. Every affected write grant agrees with it.
- The expected session file exists, is regular, has a complete supported header, and has the expected session ID and cwd.
- The session-ID process lock and canonical-file lease prove that no live or uncertain local writer owns the session.
- The configured release, authentication, resource mapping, project-trust choice, and local usage schema pass preflight.

Launch a fresh terminal on the local core with `--bg --no-notify --outlive-parent --no-parent`. Its command is the leased launcher with exact `pi --session <file>` in the mapped cwd. The terminal inherits only destination HC values set by that core. Labels contain session, machine, epoch, and move IDs, not paths or credentials.

Readiness requires a private nonce reply from the new host adapter with session ID, epoch, machine ID, actual runtime cwd, actual session file, core identity, terminal identity, and admission state. A heartbeat or a live shell is insufficient. Verify the header again immediately before spawn and verify the actual session ID afterward. This prevents pi's missing-path behavior from silently creating another session.

A crash restarts that session after 5, 15, 60, and 300 seconds. Five failed starts or crashes in ten minutes set `desired_state = suspended` with `This session keeps stopping. Run spider roam resume <session> after fixing the reported problem.` A stable ten-minute run clears the count. This bounds unattended crash loops without treating a disconnected Mac as a crash. Missing auth, a wrong home, a missing session file, and an uncertain owner suspend immediately. A disconnect from the Mac is not a failure and triggers no restart.

`spider roam stop <session>` sets `desired_state = stopped` before requesting orderly shutdown. `spider roam resume <session>` clears the crash suspension after doctor passes and sets it to running. These host-intent operations do not change the home. A user quitting a hosted pi session sets stopped unless shutdown is tagged as a move, upgrade, crash recovery, or reload. `/reload` keeps the lease and does not create another terminal.

After a Linux subsystem or core restart, stale process identities must be proved absent before leases are reclaimed. The supervisor uses the saved exact file in a fresh terminal, not the interactive shell's optional resume offer. It retires any owned restored shell for that session only after proving the new owner. A file with an uncertain owner remains blocked.

A machine that has stopped or rebooted and requires a host sign-in remains down until someone starts it and signs in. A box-side service cannot power on its own host. Select machines whose disconnect policy permits unattended work. The hub reports a disconnected machine but does not promise to wake it while the Mac is off.

## Move procedure

### Entry conditions and request lifetime

The Mac CLI accepts an exact session ID, an unambiguous prefix, or an unambiguous latest name from its synced session catalog. `/move <machine>` targets the current persistent top-level session. A box `/move` inserts an immutable request and says `Move requested. The Mac will pick this up when it reconnects.` It does not change ownership locally.

The hub serializes moves for a session. A second identical request returns the existing move ID. A different destination returns the current move and a conflict. A same-home move is a verified no-op. An expired request, changed epoch, unknown machine, or unenrolled session fails without staging a move. Cancellation is allowed before home commit. Later cancellation runs the rollback procedure rather than erasing a journal.

Both machines must be reachable and compatible. The destination must be installed, authenticated, and able to host the mapped resources. The source must have a live managed owner at the expected epoch. Closed sessions can be resumed on their current home first, but the move command does not guess whether their last unfinished tool is safe.

The session must be settled, with no model request, retry, compaction, queued prompt, unsubmitted editor draft, direct shell command, or pending intercom ask. Its local usage worker must have completed the managed-source conversion and reached the frozen transcript's end before transfer. Missing or incompatible local usage accounting blocks a move rather than permitting duplicate history charges. It must have no queued, running, or paused child, detached durable child, later pipeline stage, local background exec, or unsettled remote job. Finished jobs must have complete collected output and observed notices. Inspect the owning run DB and every local route for that session, plus top-level and child job journals. A stale PID or unknown receipt is a blocker, not proof of completion. Return blocker IDs and plain descriptions without stopping them.

### Durable states and recovery

The hub writes its next intended action to `roam_moves` before executing it. Each source and destination command records its operation ID and result in a private local move journal. Repeating an operation with the same ID returns the same result or reconciles existing state. A different payload under that ID is an error.

The following table defines every forward state. The state name records the completed step. The initial state is `requested`.

| Transition | Preconditions and action | Failure and rollback |
| --- | --- | --- |
| `requested` to `checked` | Resolve session and machines. Verify reachability, homes, versions, destination readiness, paths, and all blocker inventories. Reserve the destination session ID and staging quota. | Report the blocker. Release reservations. The source remains active and its files are unchanged. |
| `checked` to `frozen` | Source acquires its session-ID control lock, closes input and async-delivery gates, drains already-started local DB writers, then rechecks idle and blockers. Set the global hold and every affected worktree write grant to frozen. Record a quiescence proof with move ID, epoch, process identity, session size, last entry, and DB high sequences. | If any check fails, restore the active grants and gates. A partial freeze is reconciled from both local journals before unfreeze. It cannot expire by elapsed time. |
| `frozen` to `workspace-ready` | Transfer and verify the workspace as specified below. Reserve destination cwd and write destination repo and workspace maps. Recheck the frozen source manifest. | Discard only move-owned staging. Keep the source workspace unchanged. Use the precommit abort proof below. Destination cleanup can remain pending. |
| `workspace-ready` to `data-ready` | Pull the frozen session's final changes and required repo and global memory. Push them to the destination. Verify destination cursors reach every recorded barrier and its home-history dependencies. Derive its local binding and registry paths. | Retry sync with the same cursors. No home changes. If cancelled, use the precommit abort proof and queue reservation cleanup. Never undo unrelated replicated memory. |
| `data-ready` to `session-ready` | Snapshot the frozen source JSONL, copy it, rewrite its header cwd, append the destination provenance marker, and verify it as specified below. Set a destination hold to armed, with the future epoch and move capability. Do not launch pi. | Keep the original file and source process. Remove only the new staged copy, or restore a destination backup that still matches the move's installed digest. Then unfreeze under the precommit abort proof. |
| `session-ready` to `home-committed` | Recheck both identities, both durable holds, source quiescence proof, workspace and transcript hashes, and all barriers. In one hub transaction, compare-and-swap home epoch `e` to destination epoch `e + 1`, append its history, and journal the commit. Deliver that exact home to both machines and obtain source-fenced and destination-armed acknowledgements. | Before the hub transaction commits, abort normally. After commit, never infer failure from a timeout. Reconcile home and holds. The source stays frozen until a proved rollback or success. |
| `home-committed` to `destination-live` | Start through the destination launch adapter, with the move ID and committed epoch. A box uses its supervisor. The Mac hub uses the same leased launcher directly. It opens the verified file but keeps turns, timers, messages, organism work, and cache warming gated. Wait up to 60 seconds for the nonce-bound readiness reply and verify its actual cwd and session ID. | If launch is proved failed, disarm and stop any destination owner, then roll back with a new epoch. If launch outcome is unknown, stay frozen and reconcile. Never launch another copy. |
| `destination-live` to `source-stopped` | Ask the verified source adapter to shut down with reason move. Wait for its PID-and-start identity to be absent and release its file lease. Close only its recorded pane after process exit. Leave the source hold retired and its original files intact. | Do not release the destination while source shutdown is uncertain. Retry the same shutdown. A proved unresponsive but still-live source leaves the move paused for repair. Do not kill another process or claim success. |
| `source-stopped` to `active` | In one destination transaction, commit its active hold, desired state running, and release receipt. Verify the current home and epoch again before enabling normal lifecycle work, then reply with the active admission nonce. Set source desired state to stopped. | Reconcile a lost release reply. Committing the destination's active hold is the no-rollback boundary, even if its first turn has not started. Recover it as the sole owner there. Do not return ownership to the source blindly. |
| `active` to `done` | Confirm the one live owner, then place or reuse its native remote terminal in the machine's Mac space. Persist result and clean unused move staging. | App or cleanup failure records pending placement or cleanup but does not roll back execution. Print the machine and terminal so the session remains reachable. |

A move that pauses after home commit remains visible in hub status with the exact recovery command `spider roam recover <move-id>`. Hub startup reconciles all nonterminal moves before accepting another move for those sessions. There is no automatic timeout that unfreezes an old source.

Before home commit, an abort enters `aborting`. Under the session lock, the hub verifies that the home is still the source at epoch `e`, records `{moveId, sessionId, sourceEpoch, homeChangeId, cancelledAt}` as its cancellation proof, and permanently disables that move's home-commit action. Send the proof over its capability-bound source channel. The source records cancellation before restoring its active grants and gates. Only after its acknowledgement does the hub enter `cancelled` or `failed` and allow another move. The destination need not be reachable for this precommit recovery because its armed future epoch has never been published. Its staging and old capability are retired when it reconnects, before another reservation can replace them. A late old action cannot overwrite a newer hold. If the hub cannot prove the old home unchanged, do not use this path.

Rollback states after home commit are `rollback-fencing`, `rollback-home`, `rollback-source`, and terminal `rolled-back`. They obey this sequence:

1. Prove that the destination never committed its active hold. Disarm it and stop any identity-matched armed owner. Obtain a durable retired hold for the failed destination epoch. A disconnected destination cannot supply this proof. Wait rather than risk two owners.
2. Compare-and-swap the current home back to the source with the next unused epoch. If the forward home was `e + 1`, rollback uses `e + 2`. Replicate the rollback home and obtain both machines' acknowledgements.
3. Restore the source's grants and admission at the new epoch. If its frozen pi is alive, reuse it. If source shutdown had already completed, resume its original exact file under a new lease. Update the source epoch in future writes without rewriting historical entries.
4. Verify one live source owner, mark the destination retired, and record `rolled-back`. Keep failed destination artifacts for diagnosis. Do not delete a checkout that acquired unrelated files.

Once the destination's active hold commits, ordinary rollback is forbidden. Complete recovery there, or perform a new normal move with its current transcript and workspace. This distinguishes failure to start from a later crash and preserves completed work.

### Workspace transfer

The hub coordinates both directions, including box-to-box. It first resolves the portable repo and workspace maps. It never assumes the same home directory, branch name, or absolute checkout path exists on both machines.

For Git workspaces, freeze covers agent-origin writes, not arbitrary external editors. Refuse another known agent writer in that workspace. Take and recheck a content manifest before home commit. An observed external edit invalidates the snapshot and restarts preparation while the source remains frozen.

The source manifest records the object format, HEAD commit and symbolic branch, Git index entries, relative cwd, staged patch digest, unstaged patch digest, and a sorted working-file list. Each file entry includes its raw relative pathname encoded in base64, type, executable bit, byte length, and SHA-256. Symlinks record their target bytes instead of following them. Include tracked files and nonignored untracked files. Do not include `.git`, `.spider`, sockets, devices, or ignored dependency trees.

Use `git diff --cached --binary --full-index` for the staged patch and `git diff --binary --full-index` for the unstaged patch, both relative to the source root. Carry untracked files in a manifest-driven archive. Deletions, renames, executable bits, staged-only changes, and partially staged files must survive. Refuse unresolved merge indexes, active rebase or merge operations, initialized submodules, unsupported object formats, and symlinks whose targets escape the workspace. Report unsupported repository features before home commit.

The destination advertises object IDs it has. Create a Git bundle containing HEAD and required refs, excluding only verified advertised prerequisites. Run `git bundle verify` on the destination. If prerequisites are missing or ancestry negotiation fails, create a self-contained bundle of the required refs. Never assume that a same-named branch has the same commits. Keep imported refs under `refs/spider-roam/<move-id>/` until verification finishes.

If the source is a linked worktree, use the destination's mapped common repository and create a new linked worktree. Otherwise create a dedicated checkout. Prefer a detached HEAD when the branch is already checked out elsewhere. Record the original branch identity in the move manifest rather than altering another worktree. An existing matching, dormant roaming workspace can be reused only after proving no writer, retaining a backup, and verifying its previous manifest. Never reset an unrelated dirty checkout.

Apply the staged patch with `git apply --index`, then the unstaged patch without changing the index. Extract untracked files with exclusive create and path validation. Reject absolute names, `..` components, path traversal through symlinks, case-fold collisions, and unsupported file types. Recompute the file and index manifests on the destination. They must match the source, excluding only explicitly declared ignored files and local metadata.

Git filters can transform bytes, so equality of Git status is insufficient. Verify actual file bytes and executable modes. Tracked external large-file content must either materialize identically through destination setup or fail verification. Version 1 does not fetch external large-file or submodule data on the user's behalf. Ignored build output is rebuilt locally. Required ignored resources need an explicit additional-file selection in the machine's move policy, with the same transfer checks. Do not claim that every external file mentioned in a transcript moved.

The destination cwd is `destinationWorkspaceRoot + sourceRelativeCwd`, after containment and existence checks. A successful move retains both workspaces. Source cleanup is a separate human operation, not part of the transfer.

### Session file transfer

Freeze stops all transcript append sources, including timers, notices, cache warming, and organism reports. Record the source adapter's actual runtime cwd and `sessionManager.getLeafId()` in the quiescence proof. The public leaf accessor is declared at `pi/dist/core/session-manager.d.ts:289-290`. Read through the last complete newline and require that it equals the file length. A partial trailing entry blocks the move and retains the source file for repair.

Validate the complete JSONL structure without opening it through SessionManager. Require a current version-3 header, the expected session ID, unique entry IDs, valid parent links, and valid compaction boundaries. Older sessions must complete their normal pinned-pi format upgrade on the source before freezing. Unknown extension entries remain opaque. Stream the full file through the artifact transport and compare its source digest before modification.

On the destination, preserve every entry after the header byte-for-byte, including branch IDs, messages, compaction, usage, names, and trigger snapshots. Rewrite only `header.cwd` to the mapped cwd. If `parentSession` maps to a known destination session file, rewrite that header field too. Otherwise remove the stale locator from the header and record its origin-qualified reference in a non-context `spider-roam-parent` custom entry. Do not rewrite historical paths in message text, tool arguments, system prompt entries, or compaction file lists.

Append the provenance marker after the copied history with a fresh entry ID and `parentId` equal to the captured active leaf. If a parent-reference entry is needed, chain the marker after that entry. This preserves a branch selected by tree navigation even when it is not the last physical history entry. Pi otherwise chooses the last loaded entry as its leaf, as checked at `pi/dist/core/session-manager.js:732-741`. The transfer manifest records the source digest, rewritten-header digest, unchanged history digest, captured leaf, added entry IDs, destination digest, destination cwd, and target epoch. Fsync the file and its directory. Install it by same-directory atomic rename only after validation.

Store it in the destination's effective pi session directory using the destination cwd encoding. Respect the configured session directory after adapting it to the destination. Record the exact canonical path in `roam_locations`. If a file already exists for that session ID, require a dormant owner and prove that its nonheader history is a prefix of the incoming history. Back it up privately before replacement. Divergent history blocks the move.

Before launch, require the installed file to be nonempty, regular, owned by the user, and unchanged from the manifest. Require its header ID and cwd to match the request. Start pi in that cwd and pass the exact file path. Do not use an ID prefix, `--continue`, `--fork`, a cwd override, or an initial prompt. The readiness reply must confirm both header-derived runtime cwd and actual session ID. A new filename or live pi process is not sufficient evidence.

## Fencing and lifecycle integration

Register one admission coordinator before spider's existing lifecycle consumers. Every existing `session_start` consumer must await its activation result before writing session rows, starting the reaper, adopting children, restoring triggers, publishing a feed, starting usage publication, or scheduling organism work. The current host registers multiple independent startup handlers, so merely adding another late listener is insufficient. See `packages/host/src/extension.ts:1213-1246` and `packages/host/src/hooks.ts:148-163`.

An enrolled session with no home, a foreign home, a retired hold, an unexpected epoch, or an uncertain session-ID owner activates no spider session work. For a known foreign home, it prints `This session lives on box-1.invalid. Open it there, or move it from the Mac.`, using the actual enrolled machine alias. An unfinished enrollment instead says to rerun `spider roam enroll <session>` on the Mac. An uncertain local owner says `Another copy may be running. Run spider roam doctor before opening this session again.` It aborts pending agent startup and requests orderly shutdown. Read-only move status remains available through the CLI.

A source with a durable freeze hold for the current move or recorded enrollment is the exception to automatic shutdown. It remains alive but paused when the home changes, so startup failure can return ownership without losing its process. Only the hub's recorded final source-stop action ends it. Frozen and armed activations expose only readiness, process presence, lease bookkeeping, and move-control IPC. They do not initialize ordinary session consumers. Reload preserves this control-only state.

At activation, acquire a session-ID lock in addition to the existing canonical-file lease. This catches two copied files with the same session ID on one machine. Locks use PID plus process start identity. A stale heartbeat cannot authorize takeover. Never sync either lock.

Recheck admission at `input`, `before_agent_start`, `turn_start`, `tool_call`, `user_bash`, scheduler delivery, notice delivery, and cache-warming decisions. Input can return handled with the home message. A disallowed agent start or turn calls `ctx.abort()` and disables further delivery. Tool calls return an explicit block. Direct shell input returns a failure instead of falling through. Set cache-warming decisions to stop while gated. Do not depend on an exception from a notification hook to stop a provider request.

A guard error is a refusal, not ordinary spider fallback. Suppress normal shutdown consolidation and row writes during a move freeze. After rollback, replace activation-local epoch and writer contexts before reopening gates. The Mac hub launches local sessions only for an explicit resume or pending move. It does not replace the existing Mac reboot-resume workflow. Verify the abort-before-provider contract against the installed pi version. If that contract changes, roaming doctor disables hosting and moves until the adapter is updated. The guard does not change unrelated non-roaming sessions.

Control IPC can inspect, freeze, arm, release, retire, and shut down only the exact session, move ID, and epoch for its private capability. Freeze closes gates before returning its proof. Background DB writers use the same local grant. On reload, a frozen or armed activation remains frozen or armed. A process restart cannot remove that state.

An offline home may continue with its last acknowledged active admission because the hub cannot move it without a fresh durable freeze acknowledgement from that machine. Once frozen or retired, it cannot regain permission from an old cached home. This is the cross-machine exclusion argument. A synced table alone, or a wall-clock lease that expires during a partition, would not provide it.

Enrollment identities, home records, and retirement holds must not be restored independently from an old disk snapshot. Restoring or cloning a machine requires a new identity and hub reconciliation before hosting. External pi launches that disable spider or bypass managed admission remain outside the cooperative ownership guarantee.

## User commands and messages

| Command | Behavior |
| --- | --- |
| `spider move <session> <machine>` | Ask the local Mac hub to perform or reconcile one move. Machine `mac` names the enrolled Mac. Return the move ID immediately, then stream bounded progress when attached. |
| `/move <machine>` | Request a move of the current session. On a box, store the request for the next sync. Never paste input into another pi terminal. |
| `spider roam status [--json]` | Show hub health, each machine's connection and last successful sync, pending rows, schema mismatch, homed sessions, crash suspensions, and incomplete moves. Distinguish stale status from a current observation. Bare `spider roam` is the same command. |
| `spider roam sync [machine]` | Request immediate sync and report committed cursors or the machine needing repair. |
| `spider roam enable` and `spider roam disable` | Install or stop hub scheduling. Disable refuses an in-progress home change. It does not stop box agents or erase homes. |
| `spider roam provision <machine>` | Reconcile installation, optional explicit auth consent, and readiness. |
| `spider roam enroll <session> [--machine <machine>]` | On the Mac, admit a proved existing source using the initial-admission journal. Default source is the Mac. Repeating the command reconciles incomplete admission. It never silently claims a competing live copy. |
| `spider roam doctor [machine]` | Read-only checks with repair commands. Unavailable checks are not passes. |
| `spider roam recover <move-id>` | Reconcile durable move observations and continue the safe next step. |
| `spider roam cancel <move-id>` | Cancel before commit, or run the proved rollback sequence before the destination's active hold commits. |
| `spider roam stop <session>` and `spider roam resume <session>` | Change desired hosting state without changing the home. The hub carries a box control request over Herdr. |
| `spider roam repo map <repo-key> <path>` | Register an explicit local checkout mapping after identity checks. Run it on the machine that owns the path. |
| `spider roam upgrade <machine>` and `spider roam uninstall <machine>` | Reconcile the owned release and service as specified above. |

Mac control commands use the local hub socket. `doctor`, `repo map`, and read-only local status can also run on the box without contacting the hub. Box status labels cached hub observations as stale. Other hub-only box-shell commands say to run them on the Mac. A box shell cannot control another machine directly. Its `/move` uses sync as described above. Version 1 exposes no model-callable operation that copies auth, provisions a machine, changes a home, or uninstalls software.

Use these messages rather than internal protocol terms:

- `Moved Build notes to box-1.invalid. It will keep running when the Mac disconnects.`
- `Cannot move yet. Two children are running: <ids>. One command still needs its result: <id>.`
- `Cannot move yet. Send or clear the draft in this session first.`
- `The Mac is offline. Your session is still running here. The move is waiting.`
- `Sync paused. Upgrade spider on box-1.invalid, then run spider roam sync box-1.invalid.`
- `The move stopped before ownership changed. Your session is still on the Mac.`
- `The new session did not start. Ownership returned to the Mac. Your original conversation and files are intact.`
- `The destination's state is unknown. The source is paused to avoid running two copies. Run spider roam recover <move-id>.`
- `Moved. The Mac app is closed, so its pane will appear when the app returns.`

CLI exit codes are 0 for a verified completed or no-op operation, 1 for a refused or failed operation, 2 for invalid arguments, and 3 for a durable pending or uncertain operation. `--json` includes a stable reason code, operation ID, current home and epoch when known, and a repair command. Progress never prints secrets, transcript bodies, or uncommitted file contents.

## Security and privacy

Enrollment trusts the same user's Mac and selected boxes. Herdr supplies authenticated transport. Random machine IDs prevent accidental identity reuse, not a hostile machine from forging data. A compromised enrolled box can disclose data it receives and submit false memory. This design is not a sandbox against the account running pi.

Sync includes global memory and every enrolled repo's portable units on every enrolled machine by default. Enrollment shows that scope before enabling it. An explicit store allowlist can reduce it. A move fails if the destination policy excludes a required store. Repo content must be permitted on the destination under the user's own data policy. No automatic transfer to a machine outside that enrollment set is allowed.

Directories are mode 0700. Session files, databases, manifests, auth files, journals, capability files, and logs are mode 0600. Executable files are mode 0700. Reject symlink destinations and files owned by another user. Use random private staging names, bounded parsers, digest checks, and same-directory atomic replacement. Never use a shared temporary directory for credentials or move state.

Workspace transfer includes selected source files and uncommitted files. Session transfer includes prompts, responses, tool output, inline images, extension state, and possibly secrets already present in that history. A move is consent to transfer those selected artifacts between enrolled machines. It is not consent to copy additional credentials. Credential artifacts remain separate from work artifacts and are never included in a Git bundle.

Copy neither Git credential stores nor a machine's Git identity. Ordinary Git commits and executable bits travel in the bundle, but destination Git policy remains local. The provisioner does not embed private registry settings in a public release or retain credential values in its journal.

Only trusted local config can set executable paths, discovery roots, core unit names, resource overrides, and file selections. Batch data cannot select an arbitrary DB path, execute a command, or modify service configuration. An origin-qualified artifact reference never grants a file read by itself. Public tests use synthetic sessions and reserved machine names.

## Testing strategy and acceptance

### Test layers

Unit tests exercise identity normalization, branded parsers, HLC comparison and observation, canonical row projections, trigger generation, home authorization, move transitions, path containment, manifest hashing, and user messages. Use injected clocks, transport, process probes, and filesystem ports. Tests assert observable outcomes, not private helper call counts.

Multi-DB simulation uses real disposable SQLite files and three independent machine roots. Every root has its own global, repo, worktree, and usage DBs. Run the actual migrations, triggers, export, and apply code. Permute batches, interrupt transactions, duplicate delivery, skew clocks, and restart services. Do not substitute an in-memory object merge for SQLite behavior.

Fake hc tests use the shared isolated Herdr fake and record every argv. Add files, delayed or lost replies, partial chunks, core restarts, reused terminal IDs, remote addresses, and persistent operation receipts. The fake must reject an accidental local launch for a remote request. No test sends terminal input to pi.

Isolated Herdr e2e runs two test-owned cores with a synthetic remote machine and a private Mac-style hub root. Prove their socket and core identities before mutation. Use isolated XDG, pi-agent, and spider roots, retain the real home only where the harness needs platform services, and close only owned terminals and windows. Parent-only tests explicitly clear the inherited child flag. A requested real mode without provable isolation fails rather than skips.

One real Linux box run is required before enabling ordinary hosting. Use a disposable repository, synthetic nonsecret session, selected test credentials with explicit consent, and a dedicated private data root. Run the hub, provisioner, supervisor, and real transport. Record checks and receipts outside the repository. Do not use a production conversation as the first move test.

### Exact acceptance scenarios

| ID | Scenario and required result |
| --- | --- |
| A1 | Normalize equivalent default-port HTTPS and SSH origins to one key. Preserve case-sensitive repo paths and nondefault ports. Credential text never appears in the key or protocol. Root fallback is stable across clones with multiple roots. |
| A2 | Upgrade fresh and existing version-13 DBs in every core scope. UUIDs remain stable on reopen, local rowids remain unchanged, and FTS-only names and excerpts survive. A future core version fails before mutation. Duplicate todo sequences roll back migration without losing a row. |
| A3 | Insert, update, and delete each portable entity through real SQL. The row, log, and version commit together. Force a trigger failure and a transaction rollback. Neither the source mutation nor a change survives. PID-only run updates emit no change. An unrelated non-roaming session in the same DB still writes normally and emits no session-scoped changes. |
| A4 | Edit memory independently on all three disconnected machines. Reconnect in every peer order, including repeated and out-of-order batches. Every final row and tombstone version converges to the same LWW result, with no echo growth after a full idle sync. |
| A5 | Delete a todo, disconnect its old replica, and reconnect it after several service restarts. The old put cannot resurrect it. A new UUID can reuse a deleted display sequence without colliding with the tombstone. |
| A6 | Lose an import acknowledgement after commit and resend the same batch. Rows, local integer IDs, notifications, and usage charges do not duplicate. A skipped cursor, changed body under a known change ID, malformed schema, or newer schema leaves the cursor unchanged. |
| A7 | Move a clock backward and then receive a later HLC. A subsequent local mutation sorts after the observed version. A clock more than five minutes ahead pauses sync without a partial apply. |
| A8 | Receive session records, todos, and run events into an unmapped store. Search works after mapping and local rebuild. No foreign absolute path creates a registry entry or authorizes a file read. |
| A9 | Replicate a running run with PIDs matching unrelated live local processes and with a supervisor path matching a local fixture. Reaper, adoption, kill, completion delivery, and accounting do nothing to those processes or events. The history still shows its last known state. Recreate an empty local store and import that machine's own prior running history; it remains history-only and cannot be adopted. |
| A10 | Replicate `completion_delivered`, `spider_usage`, and `spider_usage_reported` events, then reload both machines repeatedly. No completion or accounting report replays. A locally produced native completion still delivers once through its existing claim path. |
| A11 | Rebuild session, todo, and active-memory FTS after apply. Preserve imported search names and excerpts. Change memory text twice during embedding rebuild. Only the latest revision clears dirty state, and no stale vector remains searchable. |
| A12 | Transfer a binary artifact over 64 MiB and a session over 64 MiB through real chunking. Every hc payload and reply is below 1 MiB. Missing, reordered, truncated, or corrupt chunks cannot install the final file or advance a cursor. Resume uses verified existing chunks. |
| A13 | Provision without auth consent. No auth file or embedded secret field crosses machines, and hosting stays disabled. Supply explicit consent, complete sign-in, and rerun. Doctor passes. An unchanged third run has zero managed-file writes and no duplicate service. |
| A14 | Run core-only mode with no app binary or app config. Activation, local children, status, and supervisor readiness succeed. App operations return their plain unavailable message without warning loops. No box process tries to contact the Mac app. |
| A15 | Start a hosted session with a trigger, disconnect and stop the hub, and close the Mac-side connection. The box keeps the same pi process, executes the scheduled synthetic action once, and records local portable changes. Reconnect the hub and verify convergence. |
| A16 | Restart the isolated box core or Linux subsystem. The supervisor proves old owners absent, resumes the exact session in its correct cwd once, restores triggers, and leaves one live owner and one lease. Repeat a crash five times in ten minutes and verify suspension. Deliberate stop does not restart. |
| A17 | Move Mac to box, box to Mac, and box to box with a linked worktree containing commits absent at the destination, a staged binary edit, an unstaged edit to the same file, a deletion, an executable-bit change, and an untracked file. HEAD, index, working bytes, cwd, todos, and session ID match. Source files remain. |
| A18 | Give the destination an existing dirty unrelated checkout, a divergent same-ID transcript, an escaping symlink, a case collision, or a missing bundle prerequisite. The move either uses a safe dedicated workspace or refuses before home commit. No unrelated file is overwritten. |
| A19 | Put a sentinel directory at the old header cwd on the destination and navigate the source to an older branch without appending a message. Move the session. Pi runs in the new mapped cwd on that selected branch, never the sentinel or the last physical branch. Remove or empty the transferred JSONL before launch. The launcher refuses and cannot allocate a replacement session. |
| A20 | Attempt a move with a busy request, draft, pending prompt, child, detached child, later pipeline stage, local background job, unobserved completion, or unsettled remote receipt. Return the exact blocker IDs and leave source ownership unchanged. |
| A21 | Inject a failure after each forward transition, including after an effect but before its acknowledgement. Restart the hub and both services. Recovery reaches done or a proved rollback, or remains explicitly paused when evidence is unavailable. At no point can two sessions run a turn. |
| A22 | Fail destination startup after home commit. Fence it, restore the source with a higher epoch, and reuse the original source conversation. Repeat with a lost launch reply and a disconnected destination. Do not roll back until its state is proved safe. |
| A23 | Copy a session file twice locally and once to another machine. Attempt activation, reload, manual input, a trigger, a custom-message turn, and a tool call on every nonowner. Zero provider requests and zero session work occur there. An offline valid home continues, but a previously retired source stays fenced. Crash initial enrollment after home publication and between per-store seeds; it stays frozen until its durable receipts reconcile once. |
| A24 | Move a session away and back after it accrues parent, child, compaction, and warmer usage on both machines. Relocate its session file and force parser-generation resets. Each local ledger counts only that machine's entries once and preserves its prior prices and proof. Future usage layout still refuses unknown durable objects. |
| A25 | Queue `/move` on an offline box. It remains at its old home. Reconnect the Mac, sync the request, and complete one move. A duplicate request reuses the result, an expired request fails, and a stale-epoch request cannot move the new home. |
| A26 | Close the Mac app during a move. The destination still becomes the sole active owner. Reopen the app and reconcile one native terminal in the machine's space, without a duplicate agent or a box-side app call. |
| A27 | Attempt uninstall while a live or stopped launchable session is homed on the box. Refuse. After moving it away, permit retained history-only identities but preserve their homes and data. Uninstall only owned matching files, disable scheduled sync, and leave workspaces, sessions, data, and unrequested credentials intact. |

The real box run must pass A12 through A19, A22, A24, and A26 using synthetic data. Use a deliberate supervisor or subsystem restart only on the dedicated test environment. Prove default cores and unrelated data roots unchanged afterward. The standard gate remains typecheck, unit and fake tests, build, and packaged-entry checks. Release acceptance additionally requires the isolated e2e and real-box receipts.

## Delivery order and rollout

The feature is off by default until the final acceptance phase. One implementation plan covers these ordered phases. Each phase ends with a complete checkable contract rather than a partially active ownership scheme.

1. Add portable types, entity descriptors, fake transport extensions, disposable multi-machine fixtures, core version guards, and migration fixtures. End with A1 and A2 passing and no enabled replication.
2. Add capture, HLC, export, apply, tombstones, unmapped stores, FTS source preservation, and rebuild invalidation. End with A3 through A8 and A11 passing entirely locally.
3. Add run-origin filtering, history-only consumers, session-ID admission, durable holds, and usage provenance with shipped usage migration 7. End with A9, A10, A23, and A24 passing before remote hosting can start.
4. Add chunk transport, private command receipts, the Mac hub service, periodic sync, schema diagnostics, and status commands. End with A4 through A8 and A12 passing through fake hc and isolated real cores.
5. Add manifest-driven provisioning, explicit auth consent, core-only Herdr mode, service units, limits, exact-file supervisor launch, and crash policy. End with A13 through A16 and A27 passing in isolation. Box hosting remains opt-in under a test root.
6. Add the move state machine, workspace and JSONL transfer, sync barriers, source shutdown, release, rollback, request/result rows, and user commands. End with A17 through A22, A25, and A26 passing with fault injection at every durable boundary.
7. Run the real-box acceptance, inspect actual session IDs, cwds, leases, manifests, ledgers, and terminal identities, then enable the feature for selected enrolled sessions. End with the required receipts, no duplicate owners, green package checks, and a documented disable and recovery path.

Deploy the hub and boxes at the same schema generation before enrolling ordinary sessions. Existing non-roaming workflows keep their current behavior. A rollout that stops between phases must leave hosting disabled or preserve all admission and history filters already installed. No intermediate release may replicate foreign active runs into an unguarded reaper.

## Known limits and follow-ups

- The hub is a single Mac and must be awake for sync and moves. There is no hub election or automatic ownership takeover during a partition.
- The system promises one admitted cooperative owner, not exclusion against a process that disables spider or restores old machine state outside enrollment.
- Restart resumes conversation and triggers. It cannot resume an in-flight model call, editor draft, pipeline coordinator, shell process, or arbitrary extension runtime state.
- Workspaces exclude ignored build products and unsupported Git features unless explicitly provisioned. Old absolute paths in historical text remain old text.
- Completed child transcripts, saved remote output, and arbitrary indexed source material remain on the machine that produced them. Portable history can contain unavailable artifact references.
- LWW can lose a concurrent memory edit. There is no field-level merge or semantic duplicate detection.
- Change logs and tombstones grow without automatic compaction in version 1. Status reports their sizes. Safe compaction needs explicit peer retirement and acknowledgement rules.
- Box usage stays on the box. Cross-machine totals require a separate accounting design, not addition of account counters.
- Skill snapshots copied during provisioning do not receive ongoing changes. Skills sync must pair DB state with files and review intent.
- Cross-machine intercom, remote spider feed enrichment, and a sidebar move action are later work. Herdr's native remote terminal remains the version-1 interaction path.
- A stopped host that needs sign-in cannot restart itself. Availability depends on the selected machine's lifetime policy.
