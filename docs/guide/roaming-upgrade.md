# Upgrading legacy roaming to v0

The v0 service cannot finish work left by the old roaming service. Do not
replace a service while that work is pending or its state cannot be verified.
This procedure does not authorize a rollout or a repair.

## Inspect every affected machine

1. Keep the Mac and affected peers reachable. Keep a copy of the pre-cut
   release and its configuration. Do not start the old hub for inspection.
2. On the Mac **and locally on each affected peer**, run the candidate release's
   `spider roam doctor --json`. Confirm that its diagnostics include one of:
   - `legacy-upgrade-ready`: the local inventory found no unfinished old work.
   - `legacy-upgrade-blocked`: identified old work still needs settlement.
   - `legacy-upgrade-unverified`: evidence is missing, corrupt, changing, or
     cannot be verified. This is not clearance.
3. Stop new legacy work and quiesce its writers. With the affected roots
   quiescent, take and verify a consistent backup of the global database,
   registered project and replica databases, operation journal, transcripts,
   configuration and machine identity, intents, locks, leases, and away-home
   fences. Use a consistent SQLite backup or a storage snapshot; do not copy
   live databases and WAL files piecemeal. Protect backups as private data.
4. After any approved repair, inspect every affected root again. Quiesce legacy
   work and repeat the inventory immediately before switching services. Do not
   treat an inventory that changes during inspection as clearance.

If doctor cannot read the local identity, JSON reports `enabled: null`. This
means **unknown**, not disabled. `spider roam status` reports unavailable in
that case. An `enabled` flag alone does not prove that a service is running.

If any affected root is blocked or unverified, defer the cut for that root and
its affected peers. Quarantine means exclude them from the cut, retain the old
release and evidence, and do not run the affected copies. It does not mean
moving data to a clean root, clearing flags, rewriting rows, or skipping a
fence. Do not use `spider roam disable` as a cleanup tool.

## Settle old work only after approval

Review the reported session, operation, and store IDs and obtain approval for
specific actions. Use the saved **pre-cut release** and its already-authorized
legacy hub; the old controls target `roam/hub.sock`, not the v0 socket. Do not
start the old hub just to inspect an operation: startup can resume mappings and
reconcile other moves. If the hub is not already authorized and running, defer
until the effects of starting it have been reviewed and approved.

- **Move or source cleanup:** On the Mac, use old
  `spider roam cancel <operation-id>` only for a proved pre-commit abort, or
  old `spider roam recover <operation-id>` to finish a committed move and its
  source cleanup. Do not guess the phase or start recovery for another move.
- **Pending box launch:** Verify the recorded PID, boot and process-start
  identity, terminal and core, and file lease. Shut down the owner and prove
  its exit. Only then run old `spider roam stop <session-id>` **on the Mac**.
  A missing or unreadable observation is not proof of exit.
- **Repository map:** On the machine that owns the map, retry old
  `spider roam repo map <repo-key> <same-path>`.
- **Workspace map:** Use the old operation that owns the map or the old hub's
  supported `resumePendingMappings` on its own database. Do not start the hub
  solely to make it resume mappings.

Do not hand-edit SQLite, intents, mappings, locks, or fences. Do not prescribe
`set-home --force` for a legacy claim. If the old path cannot prove completion,
leave the root and affected peers quarantined.

Before removing a quarantine, verify the authoritative home and confirm that no
competing owner exists. Check the terminal receipts, completed source cleanup,
and cleared map intents. Keep historical non-null move IDs. Repeat the local
inventories on the Mac and every affected peer; switch services only when all
are ready and the legacy writers remain quiescent.
