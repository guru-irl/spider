# Documentation

Documentation for the spider pi extension.

## Start here

- [Root README](../README.md): requirements, installation, quickstart, actions, and troubleshooting.
- [Contributing](../CONTRIBUTING.md): development setup, validation, package boundaries, and PR requirements.
- [Using spider](guide/using-spider.md): skills, execution, indexing, todos, and project setup.
- [Configuration](guide/configuration.md): config layers, defaults, where each value comes from, how unset works, and role models.
- [Usage dashboard](guide/usage.md): the Overview, Session, and Calibration & data pages. It covers the default credits view, the optional `usage.monthlyBudget`, the local ledger, the read-only counter and doctor diagnostics. The footer shows, separated by middle dots: context percentage and window size, session credits, cache-hit rate (`CH`), `month` as a whole percentage, input and output tokens, and cache read and write tokens. The `month` item uses the budget when one is set, and otherwise the allowance. If neither is available, the footer leaves it out.
- [Subagents](guide/subagents.md): dispatch, thinking, shutdown, which runs survive a reload, escalation, and messaging.
- [Loops and scheduled wakeups](guide/loop-and-schedule.md): timers for external work, `/loop`, checks the agent paces itself, cancellation, and how long they last in a session.
- [Memory and learning](guide/memory-and-learning.md): review, caps, background models, skill validation, and the review queue.

## Architecture

- [Overview](architecture/README.md): the single-tool design, the package layers, the shared database, and how one call flows through them. It includes the main interaction diagram.
- [Data model](architecture/data-model.md): the global, repository, and worktree databases, their tables, migrations, bindings, and the `run_events` bus.
- [Feedback and learning loops](architecture/feedback-and-learning-loops.md): the routing loop, the memory lifecycle, the organism's feedback and learning loop, and the subagent loop, each with a diagram.
- [Runtime lifecycle](architecture/runtime-lifecycle.md): build identity, linked shims, caches, cleanup at shutdown, and fixture probes.

## Package reference

- The [package map](../CONTRIBUTING.md#package-map-and-dependency-rules) lists what each package does, its dependencies, and a link to its README.

## Contributor notes

- [Release process](release-process.md): tagged builds and publishing.
- [Output UI guidelines](output-ui-guidelines.md): the rules every renderer follows. Output is body-only and safe for the terminal width. It uses status glyphs but does not repeat the title glyph.
- [Dev UI testing](dev-ui-testing.md): how to try out the parts of the TUI during development.
- [Superpowers plans and specs](superpowers/): the plans and specs, written phase by phase, that the project was built from.
