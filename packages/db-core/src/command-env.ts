/** A command is not the subagent running it, but nested pi must stay in child mode. */
export function commandEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (["PI_SUBAGENT_RUN_ID", "PI_SUBAGENT_CHILD_AGENT", "PI_SUBAGENT_CHILD_INDEX", "PI_SPIDER_DB_PATH", "PI_SPIDER_SESSION_ID", "PI_SUBAGENT_INTERCOM_SESSION_NAME", "PI_INTERCOM_SESSION_ID", "PI_INTERCOM_STABLE_ID"].includes(key)
      || key.startsWith("PI_SUBAGENT_ORCHESTRATOR_") || key.startsWith("PI_SUBAGENT_SUPERVISOR_")) {
      delete env[key];
    }
  }
  return env;
}
