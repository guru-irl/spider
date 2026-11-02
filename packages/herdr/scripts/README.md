# Mod API fixture

`generate-mod-api.mjs` extracts runtime export names and element method names from explicitly supplied Herdr declarations. It follows module re-exports and inherited element methods with the TypeScript checker. The JSON fixture contains names only, not declaration text.

Set `HERDR_TYPES` and `GPUI_TYPES` to the declaration files to inspect. Check the committed fixture:

```sh
node packages/herdr/scripts/generate-mod-api.mjs \
  "$HERDR_TYPES" "$GPUI_TYPES" \
  packages/herdr/src/__tests__/fixtures/mod-api.json --check
```

A missing input or mismatch fails the command. To regenerate the fixture, run the same command without `--check`, then review the name changes.

Unit tests never read an app installation. They use the committed JSON and small authored declarations that test extraction and drift detection. The shared scene fakes expose exactly the fixture's runtime exports and native element methods. An unused export has a throwing stub until a test supplies its behavior.

Do not commit the declaration files. Keep them outside the repository's tracked files.
