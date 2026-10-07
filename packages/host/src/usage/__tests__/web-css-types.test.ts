import { describe, expect, it } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
describe("web stylesheet types", () => {
  it("the web declaration does not globally admit missing host CSS", () => {
    // Break caught: an ambient wildcard silently authorizes arbitrary host CSS imports.
    const fixture = fileURLToPath(new URL("../css-import-typecheck-fixture.ts", import.meta.url));
    const declaration = fileURLToPath(new URL("../web/theme.css.d.ts", import.meta.url));
    const options: ts.CompilerOptions = { noEmit: true, noUncheckedSideEffectImports: true, skipLibCheck: true, module: ts.ModuleKind.Preserve, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2022, types: [] };
    const host = ts.createCompilerHost(options), original = host.getSourceFile.bind(host);
    host.getSourceFile = (name, languageVersion, onError, shouldCreateNewSourceFile) => name === fixture ? ts.createSourceFile(name, 'import "./web/theme.css"; import "./missing-host.css";', options.target!) : original(name, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([fixture, declaration], options, host);
    const diagnostics = program.getSemanticDiagnostics().map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    expect(diagnostics).toHaveLength(1); expect(diagnostics[0]).toContain("./missing-host.css");
  });
});
