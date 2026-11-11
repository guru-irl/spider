// Existing calls remain unchanged. Only participating ingestion assigns keys.
export const USAGE_SCHEMA_V7 = `
ALTER TABLE calls ADD COLUMN execution_machine TEXT;
ALTER TABLE calls ADD COLUMN managed_entry_key TEXT;
CREATE UNIQUE INDEX idx_calls_managed_entry
  ON calls(managed_entry_key) WHERE managed_entry_key IS NOT NULL;
`;
