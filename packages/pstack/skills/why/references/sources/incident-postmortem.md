# Incident & Postmortem Context

- **GitHub issues**: look for issues labeled `incident`, `sev-*`, `postmortem`, `reliability`, opened around the dates the target code was added
- **Past sessions**: `spider search` for incident, outage, or revert discussions that name the target around those dates
- **Git**: commits with messages like "fix for incident", "add defensive check", "revert" followed by "re-apply with..." are strong signals
