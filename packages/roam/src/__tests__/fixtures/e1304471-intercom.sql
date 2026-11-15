-- Exact initialization DDL from e130447197871c176d8e342bd254a966927dc3aa.
CREATE TABLE IF NOT EXISTS intercom_meta (
          id INTEGER PRIMARY KEY CHECK(id=1), machine_id TEXT NOT NULL, version INTEGER NOT NULL, last_clock INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intercom_messages (
          id TEXT PRIMARY KEY, from_key TEXT NOT NULL, to_key TEXT NOT NULL, digest TEXT NOT NULL,
          pair_sequence INTEGER NOT NULL, ask_id TEXT, identity_json TEXT NOT NULL,
          is_ask INTEGER NOT NULL, ask_state TEXT NOT NULL,
          UNIQUE(from_key,to_key,pair_sequence)
        );
        CREATE TABLE IF NOT EXISTS intercom_copies (
          direction TEXT NOT NULL, id TEXT NOT NULL REFERENCES intercom_messages(id), endpoint_json TEXT NOT NULL,
          peer TEXT NOT NULL, payload_json TEXT, payload_bytes INTEGER NOT NULL, state TEXT NOT NULL,
          unknown_outcome INTEGER NOT NULL DEFAULT 0, deadline_at INTEGER NOT NULL, remaining_ms INTEGER,
          last_clock INTEGER NOT NULL, ack_kind TEXT, sent_kind TEXT, transmitted INTEGER NOT NULL DEFAULT 0,
          readiness TEXT, attempt INTEGER NOT NULL DEFAULT 0, observed_attempt INTEGER NOT NULL DEFAULT 0,
          receipt_json TEXT, reconciliation_json TEXT, reconciliation_attempt INTEGER,
          pending_proof_json TEXT, pending_proof_attempt INTEGER, PRIMARY KEY(direction,id)
        );
        CREATE TABLE IF NOT EXISTS intercom_settled_receipts (
          peer TEXT NOT NULL, receipt_key TEXT NOT NULL, PRIMARY KEY(peer,receipt_key)
        );
        CREATE TABLE IF NOT EXISTS intercom_refused_slots (
          from_key TEXT NOT NULL, to_key TEXT NOT NULL, sequence INTEGER NOT NULL,
          PRIMARY KEY(from_key,to_key,sequence)
        );
        CREATE TABLE IF NOT EXISTS intercom_receipt_positions (
          peer TEXT NOT NULL, from_key TEXT NOT NULL, to_key TEXT NOT NULL, sequence INTEGER NOT NULL, receipt_key TEXT NOT NULL,
          PRIMARY KEY(peer,from_key,to_key,sequence)
        );
        CREATE TABLE IF NOT EXISTS intercom_settled_watermarks (
          peer TEXT NOT NULL, from_key TEXT NOT NULL, to_key TEXT NOT NULL, sequence INTEGER NOT NULL,
          PRIMARY KEY(peer,from_key,to_key)
        );
        CREATE TABLE IF NOT EXISTS intercom_cursors (
          direction TEXT NOT NULL, from_key TEXT NOT NULL, to_key TEXT NOT NULL, sequence INTEGER NOT NULL,
          PRIMARY KEY(direction,from_key,to_key)
        );
        CREATE TABLE IF NOT EXISTS intercom_receipts (
          receipt_key TEXT PRIMARY KEY, id TEXT NOT NULL REFERENCES intercom_messages(id), peer TEXT NOT NULL,
          frame_json TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS intercom_resumptions (
          from_key TEXT NOT NULL, to_key TEXT NOT NULL, peer TEXT NOT NULL, resume_json TEXT NOT NULL,
          PRIMARY KEY(from_key,to_key)
        );
        CREATE TABLE IF NOT EXISTS intercom_edge_state (
          peer TEXT NOT NULL, edge_epoch TEXT NOT NULL, state_json TEXT NOT NULL, PRIMARY KEY(peer,edge_epoch)
        );
        CREATE TABLE IF NOT EXISTS intercom_pair_fences (
          peer TEXT PRIMARY KEY, edge_epoch TEXT NOT NULL, fence_id TEXT NOT NULL, fenced_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intercom_pair_approvals (
          peer TEXT PRIMARY KEY, edge_epoch TEXT NOT NULL, operation_id TEXT NOT NULL, graph_digest TEXT NOT NULL, fence_id TEXT
        );
        CREATE TABLE IF NOT EXISTS intercom_revocation_notices (
          id TEXT PRIMARY KEY REFERENCES intercom_messages(id), frame_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intercom_topology (
          id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL, transition_json TEXT, switched TEXT
        );
        CREATE TABLE IF NOT EXISTS intercom_topology_refusals (
          id TEXT PRIMARY KEY REFERENCES intercom_messages(id), peer TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS intercom_topology_audit (
          id TEXT NOT NULL REFERENCES intercom_messages(id), transition_id TEXT NOT NULL,
          old_next_hop TEXT NOT NULL, new_next_hop TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(id,transition_id)
        );
        CREATE TABLE IF NOT EXISTS intercom_presence_claims (
          address_key TEXT PRIMARY KEY, machine_id TEXT NOT NULL, activation TEXT NOT NULL, home_epoch INTEGER, ambiguous INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS intercom_rejections (
          peer TEXT NOT NULL, id TEXT NOT NULL, reason TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(peer,id)
        );
        CREATE TABLE IF NOT EXISTS intercom_notices (id TEXT NOT NULL REFERENCES intercom_messages(id),kind TEXT NOT NULL,PRIMARY KEY(id,kind));
        CREATE INDEX IF NOT EXISTS intercom_message_recipient ON intercom_messages(to_key);
        CREATE TABLE IF NOT EXISTS intercom_endpoint_aliases (
          direction TEXT NOT NULL, id TEXT NOT NULL, endpoint_json TEXT NOT NULL,
          PRIMARY KEY(direction,id,endpoint_json), FOREIGN KEY(direction,id) REFERENCES intercom_copies(direction,id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS intercom_copy_expiry ON intercom_copies(deadline_at,state);
        CREATE INDEX IF NOT EXISTS intercom_message_origin ON intercom_messages(json_extract(identity_json,'$.originMachineId'));
        CREATE INDEX IF NOT EXISTS intercom_copy_peer ON intercom_copies(direction,peer,state);
        CREATE INDEX IF NOT EXISTS intercom_message_pair ON intercom_messages(from_key,to_key,pair_sequence);
        CREATE INDEX IF NOT EXISTS intercom_receipt_peer ON intercom_receipts(peer,acknowledged);
