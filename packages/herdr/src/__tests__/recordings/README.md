# hc recordings

These fixtures preserve hc 0.1.16 JSON fields and value types. Paths, names, host identities and permanent core IDs are replaced with generic values. Process IDs and timestamps are synthetic. The tests in `harness.test.ts` parse the recordings and compare the fake's observable replies with them.

| File | Native command or stream |
| --- | --- |
| `core-status.json` | `hc server status --json` |
| `machines.json` | `hc machine ls --json` |
| `run.json` | `hc run --bg --no-notify --on remote -- program` |
| `get.json` | `hc get remote/t3 --json` |
| `read.json` | `hc read terminal --json` |
| `events.jsonl` | Initial snapshot and lifecycle notifications from `hc events --json` |
| `terminal-read-error.json` | Structured stderr after reading a removed terminal |
| `file-read-error.json` | Structured stderr after reading a missing file on an isolated core |

The first seven files derive from existing controlled native captures. The file-read error was captured by the dual-core test because the earlier captures contained terminal-read errors, not file-read errors. No default core or real remote machine supplied these recordings.

Refresh them when the supported hc version changes. Keep the field names and null values, replace private strings before writing a fixture, and rerun the recording tests.
