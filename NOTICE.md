# Upstream notices

Spider includes code and skills from the following projects. The context-mode
code is licensed under the Elastic License 2.0. The other upstreams listed here
are licensed under MIT.

## pstack

- Repository: <https://github.com/cursor/plugins>, in `pstack`.
- Author: Lauren Tan.
- License: MIT.
- Copyright (c) 2026 Lauren Tan.
- Spider takes the original text of the 31 adopted skills through pstack-claude.

## pstack-claude

- Repository: <https://github.com/michael-denyer/pstack-claude>.
- Author: Michael Denyer.
- License: MIT.
- Copyright (c) 2026 Michael Denyer. Its license also retains Lauren Tan's copyright above.
- Spider takes the port's 31 skills and ports the scheduler in
  `plugins/pstack/pi/schedule.ts` for `spider loop` and `spider schedule`.

## superpowers

- Repository: <https://github.com/obra/superpowers>.
- Author: Jesse Vincent.
- License: MIT.
- Copyright (c) 2025 Jesse Vincent.
- Spider vendors 14 skills in `packages/superpowers/skills/`.
  The upstream-watch skill is spider's own.

## context-mode

- Repository: <https://github.com/mksglu/context-mode>.
- Watched mirror: <https://github.com/guru-irl/context-mode>.
- Author: Mert Koseoglu.
- License: Elastic License 2.0. See [packages/context/LICENSE](packages/context/LICENSE).
- Copyright 2026 Mert Koseoglu.
- Spider derives code in `packages/context` from context-mode and modifies it for
  spider. The code is also bundled into `dist/extension.js`.

## pi-hermes-memory

- Repository: <https://github.com/chandra447/pi-hermes-memory>.
- Watched mirror: <https://github.com/guru-irl/pi-hermes-memory>.
- Author: Chandra Teja.
- License: MIT.
- Copyright (c) 2025 Chandra Teja.
- Spider takes code in `packages/memory`.

## pi-subagents

- Repository: <https://github.com/nicobailon/pi-subagents>.
- Watched mirror: <https://github.com/guru-irl/pi-subagents>.
- Author: Nico Bailon.
- License: MIT. The license text comes from the original repository; the watched
  fork has no LICENSE file.
- Copyright (c) 2026 Nico Bailon.
- Spider takes code in `packages/subagents`.

## pi-todo-sqlite

- Repository: <https://github.com/guru-irl/pi-todo-sqlite>.
- Author: guru-irl, the spider author.
- License: MIT.
- Copyright (c) 2026 guru-irl.
- Spider takes code in `packages/todo`.
