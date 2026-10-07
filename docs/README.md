# Documentation

Documentation for the spider pi extension.

## Start here

- [Root README](../README.md): requirements, installation, quickstart, actions, and troubleshooting.
- [Contributing](../CONTRIBUTING.md): development setup, validation, package boundaries, and PR requirements.
- [Using spider](guide/using-spider.md): skills, execution, indexing, todos, and project setup.
- [Configuration](guide/configuration.md): layers, defaults, provenance, unset behavior, and role models.
- [Usage and AI Credits](guide/usage.md): AIC footer, local ledger, read-only counter, dashboard calibration, global switches and doctor diagnostics.
- [Subagents](guide/subagents.md): dispatch, thinking, shutdown, reload survival, escalation, and messaging.
- [Memory and learning](guide/memory-and-learning.md): review, caps, background models, skill validation, and the review queue.

## Architecture

- [Overview](architecture/README.md): the one-tool model, the layered packages, the shared database, and how one call flows. Includes the master interaction diagram.
- [Data model](architecture/data-model.md): global, repository, and worktree databases, tables, migrations, bindings, and the `run_events` bus.
- [Feedback and learning loops](architecture/feedback-and-learning-loops.md): the routing loop, the memory lifecycle, the organism feedback and learning loop, and the subagent loop, each with a diagram.
- [Runtime lifecycle](architecture/runtime-lifecycle.md): build identity, linked shims, caches, shutdown cleanup, and fixture probes.

## Package reference

- The [package map](../CONTRIBUTING.md#package-map-and-dependency-rules) lists responsibilities, dependencies, and links to each package README.

## Contributor notes

- [Release process](release-process.md): tagged builds and publishing.
- [Output UI guidelines](output-ui-guidelines.md): the body-only, glyph-free, width-safe renderer contract.
- [Dev UI testing](dev-ui-testing.md): how to exercise the TUI surfaces during development.
- [Superpowers plans and specs](superpowers/): the phase plans and specs the project was built from.
