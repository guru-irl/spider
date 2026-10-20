# Source playbooks

The why skill spawns one investigator per reachable evidence category. Each one reads the playbook for its category below. Source control has a full guide of its own.

| Category | Playbook | Tools |
|---|---|---|
| Source control history and the codebase | [`code-archaeology.md`](./sources/code-archaeology.md) | `git`, `gh pr`, `rg`, through `spider exec` |
| Issue tracker on GitHub | [Issue tracker on GitHub](#issue-tracker-on-github) | `gh issue`, `gh search issues`, `gh api`, through `spider exec` |
| Past agent sessions and memory | [Past agent sessions and memory](#past-agent-sessions-and-memory) | `spider search`, `spider recall` |
| Web pages and external docs | [Web pages and external docs](#web-pages-and-external-docs) | `spider fetch` |

Cross-cutting:

- [`incident-postmortem.md`](./sources/incident-postmortem.md). Add this if the target code looks defensive (null checks, retry, timeout, rate limit, feature flag, egress guard, OOM handler).

## Issue tracker on GitHub

Issues hold the product or business context: the "we're doing this because a user asked" layer.

1. **Start with linked issues.** Fetch every issue the seed commits or PRs reference (`#123`, `Fixes #123`, `closingIssuesReferences`) with `gh issue view <n> --comments`. Read the whole thread.
2. **Search by keyword.** `gh search issues --repo <owner/repo> "<feature or symbol>"`, with several phrasings, open and closed.
3. **Walk the links.** Follow duplicate-of, parent and tracking issues back to the canonical one. Parents often carry the why.
4. **Check labels and milestones.** Labels such as `customer-request`, `incident`, or `perf` name the kind of motivation. Milestones tie work to deadlines.

Pitfalls: an issue closed and reopened with a different scope, boilerplate "why" sections, and stale plans. Check dates against the code's ship date. An issue you cannot open is a gap, not a guess.

## Past agent sessions and memory

Earlier agent sessions hold decisions talked through with an agent that never reached a commit message or PR. Memory holds the rules and corrections that survived them.

1. **Search by target.** `spider search` for the file, symbol, feature name, and PR or issue numbers, with several phrasings. Restrict to `kinds: ["session"]` or `["memory"]` when the mix is noisy.
2. **Recall rules.** `spider recall` for stored preferences, conventions, and corrections that touch the target.
3. **Read the surrounding turns.** A hit is one message. Read enough of the session around it to see who said it and what it was answering.

Pitfalls: an agent's summary is not the person's words. Quote the user's original turn when the scope of a ruling matters, and label agent interpretations as such (see [Claims about human decisions](epistemics.md#claims-about-human-decisions)). Several memories that copy one summary are one evidence chain.

## Web pages and external docs

External pages explain constraints that come from outside the codebase: an upstream API's limits, a spec, a changelog, a published design doc.

1. **Fetch what the anchor names.** URLs in code comments, commit messages, PR bodies, and docs come first. `spider fetch` indexes each page for `spider search`.
2. **Fetch the upstream record.** For a dependency or protocol the target works around, fetch the version's changelog, release notes, or the issue it links.
3. **Pin the version.** Quote the page as it applied when the code was written. Prefer versioned docs and release notes over the current page.

Pitfalls: a page that changed since the code shipped, and a general page used as evidence for a specific choice. A page that fails to load or needs a login is a gap.
