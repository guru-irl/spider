# Documentation

Documentation for the spider pi extension.

## Start here

- [Root README](../README.md): what spider is, install and build, and the package map.
- [Using spider](guide/using-spider.md): day-to-day habits and recommended global and per-project setup.

## Architecture

- [Overview](architecture/README.md): the one-tool model, the layered packages, the shared database, and how one call flows. Includes the master interaction diagram.
- [Data model](architecture/data-model.md): the global registry database and the per-project database, every table, migrations, and the `run_events` bus, with an entity diagram.
- [Feedback and learning loops](architecture/feedback-and-learning-loops.md): the routing loop, the memory lifecycle, the organism feedback and learning loop, and the subagent loop, each with a diagram.

## Package reference

One README per package, in dependency order (leaves first).

- [`@spider/db-core`](../packages/db-core/README.md): SQLite foundation.
- [`@spider/models`](../packages/models/README.md): model catalog and selection.
- [`@spider/ui`](../packages/ui/README.md): pure themed renderers.
- [`@spider/memory`](../packages/memory/README.md): structured memory and staging.
- [`@spider/todo`](../packages/todo/README.md): durable todos.
- [`@spider/context`](../packages/context/README.md): search, sandboxed exec, and indexing.
- [`@spider/subagents`](../packages/subagents/README.md): subagent dispatch.
- [`@spider/organism`](../packages/organism/README.md): the drain, passes, and curator.
- [`@spider/superpowers`](../packages/superpowers/README.md): the skills library and the managed `AGENTS.md` block.
- [`@spider/host`](../packages/host/README.md): the pi extension entry point.

## Contributor notes

- [Output UI guidelines](output-ui-guidelines.md): the body-only, glyph-free, width-safe renderer contract.
- [Dev UI testing](dev-ui-testing.md): how to exercise the TUI surfaces during development.
- [Superpowers plans and specs](superpowers/): the phase plans and specs the project was built from.
