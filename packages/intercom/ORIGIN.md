# Intercom origin

Clean fork of pi-intercom 0.13.0. Copyright (c) 2026 Nico Bailon, MIT.

The public [v0.13.0 release](https://github.com/nicobailon/pi-intercom/releases/tag/v0.13.0) resolves to commit `199279ae861bf53ce014809fb2a03337538ae13e`. Source was recovered from the installed npm package and missing files were fetched from that immutable commit using spider fetch. The local installation contains the npm 0.13.0 payload, not its original compressed archive. No npm archive bytes were used or reconstructed. The hashes below identify the exact input bytes.

## Installed npm payload

`https://registry.npmjs.org/pi-intercom/-/pi-intercom-0.13.0.tgz` is the payload provenance, not a fetched artifact. The manifest SHA-256 is `2961a24802d28206523724ce147adf6a2200f7684366cde79dc1134bed1a4abf`. Each row is a relative path and SHA-256.

| Path | SHA-256 |
| --- | --- |
| `LICENSE` | `2d20dfacd9742706e564470dc77438608a1e54b0ed46959f080709389209093c` |
| `README.md` | `a476f24ed9e72cb9b7f50ae6a4fda41c50b8ea1e2713391d05a5a6851224fbdc` |
| `broker/broker.ts` | `65d9ec1dbed5368ea952a1c7c3f978c83b44cd092e1922509085aa070f06829b` |
| `broker/client-liveness.test.ts` | `ae160bb4476f8a1482d70e771ecdc33a82bd41e0bed6ec7949dd3f7c44c75c4b` |
| `broker/client.test.ts` | `1908d5a05156d973d6b740f8450de0e45b22a1ca94e492391ee66bbb65274677` |
| `broker/client.ts` | `c810c80fdc0147dc9d7b636f071b82db7a50383dee6b860a6fe6cc0946f6212d` |
| `broker/extension-state.ts` | `2b9856b9eb1edf375e5338f1ba4de4e8d3c873b933d2f7e1776de505585b787a` |
| `broker/extension.test.ts` | `ee68f4a658f45c02f1ce36f828c230b2ceb1dff4b16d580140479c715b39704d` |
| `broker/framing.test.ts` | `95b208381b18395d4e503b0ed9296947cc123bdee5286a6a580c25784c34fdf5` |
| `broker/framing.ts` | `fde128944099fa0ce9a808ca571df0736f22447eea149ab08eef8711882bf0d5` |
| `broker/paths.test.ts` | `741e8e064108f02722aadc76513914dce9e0cd2a5572f8ac9ec155336cdf93dd` |
| `broker/paths.ts` | `a6d5387de9fae0d206987e2ba5041d544ba1d6c02495b6ac841215f4a618e3d2` |
| `broker/protocol.ts` | `4f97b280ff3e4abc5f622db5e039b57ecda2aba4b93425b20a1aea3f4fec2943` |
| `broker/runtime-claim.test.ts` | `ee915a572201eab993de2c3830f66e56da36d8f8cf0aa8449c43dc471eca5c78` |
| `broker/runtime-claim.ts` | `e2290bba58d88f4b0ba5310c76fc1575d62cea70139358f741ac59777aac9e51` |
| `broker/spawn.test.ts` | `676bc98fccca4b3ead0bc2564617e87b1e0245a186ebd19c0d38345344459fce` |
| `broker/spawn.ts` | `63b22e961bf23c5ead19084be6defe4a8c63ee4e614eebf2cb79897b16bfd673` |
| `config.ts` | `417327a3d3c8da26f10a6516e74f397ba26664115f1323c3752ccabc19ab678f` |
| `cwd.ts` | `a33e211d0e5ad1b12297ff6c683115436e885eaf658700754928065de750cb4c` |
| `extension-api.ts` | `2a8f8740640368e911f4ae5f020cf7428d8f85c7a173489ca3d1d9f840825235` |
| `format-context.ts` | `7d5bfbaf95c2cbcd620fa5f61c6f48a6b4f926bb24eb9388532a8ffdf36de2ed` |
| `index.ts` | `b99325cd8cb80b4ed41ac4f1427791eb1df916a303ba5ce5b35197eba8972f1c` |
| `package.json` | `5d172bbaa74bfc37c87c644fdd00ef272aab3455cb7fd50e4b395ae6883344ff` |
| `project-agent.ts` | `53c1ee6deff93ee3cac5b485b3a2aa3d26d17ea85fcb6cc0303a4bd17696dc90` |
| `reply-tracker.ts` | `3782886bdb143ae11bbf68c87803153078d66d321858cc4d53c4e39b9704dbc2` |
| `skills/pi-intercom/SKILL.md` | `b2106f239d3951bc83faf33ebb613b54a966c7cf42b8dac0d1a34446b1e6d76d` |
| `types.ts` | `7796cf45d8608956601c7ec14322a94fa9448a390c7239d84e24d43de1ba6d5f` |
| `ui/compose.ts` | `ab597d6d545bd527bb516c6039af9d54264c6667bc24826cc5789dd9a9178f4e` |
| `ui/inline-message.ts` | `cffbc108038756ecda7aa5643f33d6a1169cba1c01f00b773fc336b70495d03b` |
| `ui/session-list.ts` | `38433b22225acb18b24a3290678c6df161d03e218dc036c8023781cb41d6601a` |

## Public source inputs

These URLs were fetched as text without conversion. The package and licence match the installed payload. The seven broker tests also match the installed payload. All 15 test files named in the upstream test script are retained.

| URL | SHA-256 |
| --- | --- |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/LICENSE | `2d20dfacd9742706e564470dc77438608a1e54b0ed46959f080709389209093c` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/broker/client-liveness.test.ts | `ae160bb4476f8a1482d70e771ecdc33a82bd41e0bed6ec7949dd3f7c44c75c4b` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/broker/client.test.ts | `1908d5a05156d973d6b740f8450de0e45b22a1ca94e492391ee66bbb65274677` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/broker/extension.test.ts | `ee68f4a658f45c02f1ce36f828c230b2ceb1dff4b16d580140479c715b39704d` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/broker/framing.test.ts | `95b208381b18395d4e503b0ed9296947cc123bdee5286a6a580c25784c34fdf5` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/broker/paths.test.ts | `741e8e064108f02722aadc76513914dce9e0cd2a5572f8ac9ec155336cdf93dd` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/broker/runtime-claim.test.ts | `ee915a572201eab993de2c3830f66e56da36d8f8cf0aa8449c43dc471eca5c78` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/broker/spawn.test.ts | `676bc98fccca4b3ead0bc2564617e87b1e0245a186ebd19c0d38345344459fce` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/config.test.ts | `6bb140dd5d3247ce991de0bc50452474251a025b37e7f077de543e2167035f85` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/cwd.test.ts | `d37839f4110844994f435a7899207e43ec4391b04adf29ddc907e1fbd300860c` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/format-context.test.ts | `d4fb29248505f9fc90013fcaa250cfb3ab6983dc86e81ece6b0a93b8afa0f388` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/intercom.integration.test.ts | `dfe7593d2d778e0964e17b855e4f063369aa1da2702a0d8a0697c85a6b973f87` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/package.json | `5d172bbaa74bfc37c87c644fdd00ef272aab3455cb7fd50e4b395ae6883344ff` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/project-agent.test.ts | `a0588911db670a2777e73491fc2e4ddb508b2748c9caf250e5916002483d8d23` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/reply-tracker.test.ts | `8d9f0087fca133965a6691768eadc6e6267cb8103e067dc15bde45fdaabbb68b` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/test/inline-message.test.ts | `9d8c482f494a15012f75304fb93b79ca9c737ffbedc5a4d9cc872f63324a9dba` |
| https://raw.githubusercontent.com/nicobailon/pi-intercom/199279ae861bf53ce014809fb2a03337538ae13e/test/overlay-width.test.ts | `07eb8c691181c878c39ff338048308a729a158fe5315ac68230710f416b89278` |

## Adoption changes

`index.ts` becomes `src/local.ts`; the guarded factory is `src/index.ts`. Only loading, duplicate protection, broker build/spawn plumbing and test-runner adaptation change. The protocol, client, broker routing, configuration and persisted state remain local 0.13.0 behavior. Tests retain upstream assertions, use Vitest and isolated fixtures, and start compiled brokers without tsx. The skill ships once. The optional broker connection port forwards the original spawn/connect action by default. Host unit fixtures inject a no-connection port. No federation or new receipt semantics are included.

## Parity snapshot

`upstream-assertions.json` records normalized assertion text and hashes for all 15 upstream test files. It also records normalized implementation hashes, including `broker/spawn.ts`. Seven test files come from the installed payload. The remaining eight come from the public source inputs above. The snapshot lists the permitted adaptations and their reasons.

The repository test runs `node scripts/check-intercom-parity.mjs --manifest`. To regenerate the snapshot, provide a source directory containing the files above and an installed payload directory:

```sh
node scripts/check-intercom-parity.mjs --generate <source-directory> <installed-directory>
```

The generator checks the input hashes against this document before writing the snapshot. It reads, but does not modify, the installed payload.
