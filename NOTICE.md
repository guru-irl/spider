# Upstream notices

Spider includes code, assets, and skills from the following projects.
Context-mode uses Elastic License 2.0, the bundled fonts use OFL-1.1, and the
modified Herdr excerpts use Apache-2.0. The remaining upstreams use MIT.

## Herdr fonts and themes

- `packages/herdr/assets/fonts/GoogleSansFlex.ttf` is Google Sans Flex.
- `packages/herdr/assets/fonts/GlassLabel-Bold.ttf` is a renamed, bold condensed
  derivative of Google Sans Flex. Its font name table records that provenance.
- Copyright 2015 The Google Sans Flex Authors
  (<https://github.com/googlefonts/googlesans-flex>).
- Both fonts are licensed under the SIL Open Font License 1.1, not MIT.
  The complete notice is shipped as `GoogleSansFlex-OFL.txt` beside the fonts.
  `GoogleSansFlex-TRADEMARKS.md` retains the upstream trademark terms.
- The Dracula+ ANSI palette used by `dracula-plus-glass.json` and
  `spider-glass.json` comes from the MIT-licensed iTerm2 Color Schemes collection:
  <https://github.com/mbadolato/iTerm2-Color-Schemes/blob/master/ghostty/Dracula%2B>.
  Spider supplies the neutral glass surfaces and theme mappings.
- Current Herdr built-in mods are cloned during explicit setup. No frozen
  built-in mods, icons, or spinner assets are redistributed in this package.

### Herdr built-in mod excerpts

Portions of `packages/herdr/assets/look/patches.json` are derived from the
built-in mods of Herdr 0.1.11 by the Herdr authors, licensed under the Apache
License, Version 2.0, and were modified for spider.

The complete licence is shipped at [licenses/herdr-apache-2.0.txt](licenses/herdr-apache-2.0.txt).
The adjacent `packages/herdr/assets/look/NOTICE` prominently identifies the
modified portions; the JSON patch anchors and replacements are unchanged.

### iTerm2 Color Schemes

```text
MIT License

Copyright (c) 2011 to Present Mark Badolato

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pstack

- Repository: <https://github.com/cursor/plugins>, in `pstack`.
- Author: Lauren Tan.
- License: MIT.
- Copyright (c) 2026 Lauren Tan.
- Spider takes the original text of the 31 adopted skills through pstack-claude.

```text
MIT License

Copyright (c) 2026 Lauren Tan

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pstack-claude

- Repository: <https://github.com/michael-denyer/pstack-claude>.
- Author: Michael Denyer.
- License: MIT.
- Copyright (c) 2026 Michael Denyer. Its license also retains Lauren Tan's copyright above.
- Spider takes the port's 31 skills and ports the scheduler from
  `plugins/pstack/pi/schedule.ts` and `plugins/pstack/pi/one-shot.ts` into
  `packages/host/src/loop/` for `spider loop` and `spider schedule`.
- Spider ports the sleep guard from `plugins/pstack/pi/sleep-wait.ts` into
  `packages/host/src/routing/sleep-wait.ts`.

```text
MIT License

Copyright (c) 2026 Lauren Tan
Copyright (c) 2026 Michael Denyer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## superpowers

- Repository: <https://github.com/obra/superpowers>.
- Author: Jesse Vincent.
- License: MIT.
- Copyright (c) 2025 Jesse Vincent.
- Spider vendors 14 skills in `packages/superpowers/skills/`.
  The upstream-watch skill is spider's own.

```text
MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## context-mode

- Repository: <https://github.com/mksglu/context-mode>.
- Watched mirror: <https://github.com/guru-irl/context-mode>.
- Author: Mert Koseoglu.
- License: Elastic License 2.0. See [packages/context/LICENSE](packages/context/LICENSE).
- Copyright 2026 Mert Koseoglu.
- Spider derives code in `packages/context` from context-mode and modifies it for
  spider. The code is also bundled into `dist/extension.js`.
- Spider's port on 2026-07-03 postdates context-mode's switch to ELv2 at
  `a4829808` on 2026-03-03, so ELv2 applies.

## pi-hermes-memory

- Repository: <https://github.com/chandra447/pi-hermes-memory>.
- Watched mirror: <https://github.com/guru-irl/pi-hermes-memory>.
- Author: Chandra Teja.
- License: MIT.
- Copyright (c) 2025 Chandra Teja.
- Spider takes code in `packages/memory`.

```text
MIT License

Copyright (c) 2025 Chandra Teja

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pi-subagents

- Repository: <https://github.com/nicobailon/pi-subagents>.
- Watched mirror: <https://github.com/guru-irl/pi-subagents>.
- Author: Nico Bailon.
- License: MIT.
- Copyright (c) 2026 Nico Bailon.
- Spider takes code in `packages/subagents`.

```text
MIT License

Copyright (c) 2026 Nico Bailon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## pi-todo-sqlite

- Repository: <https://github.com/guru-irl/pi-todo-sqlite>.
- Author: guru-irl, the spider author.
- License: MIT.
- Copyright (c) 2026 guru-irl.
- Spider takes code in `packages/todo`.

```text
MIT License

Copyright (c) 2026 guru-irl

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
