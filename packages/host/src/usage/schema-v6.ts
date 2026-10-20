// Additive to the shipped v5 layout. Legacy timings and response effort remain unknown.
export const USAGE_SCHEMA_V6 = `
ALTER TABLE calls ADD COLUMN thinking_level TEXT;
ALTER TABLE calls ADD COLUMN provider_thinking_level TEXT;
ALTER TABLE calls ADD COLUMN tool_call_id TEXT;
ALTER TABLE calls ADD COLUMN tool_duration_ms REAL CHECK (tool_duration_ms >= 0);

-- Only top-level usage-bearing results populate this identity. Nested execution
-- events are not billing records. Repeated results across append scans count once.
CREATE UNIQUE INDEX calls_source_tool ON calls(source_file,tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE TRIGGER selection_revision_response_metadata_update
AFTER UPDATE OF thinking_level,provider_thinking_level,tool_call_id,tool_duration_ms ON calls
WHEN OLD.thinking_level IS NOT NEW.thinking_level OR OLD.provider_thinking_level IS NOT NEW.provider_thinking_level
  OR OLD.tool_call_id IS NOT NEW.tool_call_id OR OLD.tool_duration_ms IS NOT NEW.tool_duration_ms
BEGIN
  INSERT INTO ledger_metadata(key,value) VALUES ('call-selection-revision','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(ledger_metadata.value AS INTEGER)+1;
END;

-- Force the next transcript scan through its existing generation-reset path.
-- Calls survive until a replacement scan commits, including unavailable files.
-- DB-only auxiliary events have no transcript metadata to rebuild.
UPDATE import_state SET inode='usage-v6:' || inode WHERE inode IS NOT NULL AND path NOT LIKE '%#spider-aux';
`;
