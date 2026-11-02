/*
 * Derived from context-mode by Mert Koseoglu.
 * Copyright 2026 Mert Koseoglu. Licensed under the Elastic License 2.0.
 * Modified for spider. See ../LICENSE for the license terms.
 */
import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import type { Language } from "./runtime.js";
import type { RemoteSource, RuntimeTarget, PreparedProgram } from "../../herdr/src/contracts.js";
import { buildScriptFilename } from "./executor.js";
import { scrubSecrets } from "@spider/memory";

export function wrapWithFileContent(
    absolutePath: string,
    language: Language,
    code: string,
  ): string {
    const escaped = JSON.stringify(absolutePath);
    switch (language) {
      case "javascript":
      case "typescript":
        return `const FILE_CONTENT_PATH = ${escaped};\nconst file_path = FILE_CONTENT_PATH;\nconst FILE_CONTENT = require("fs").readFileSync(FILE_CONTENT_PATH, "utf-8");\n${code}`;
      case "python":
        return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nwith open(FILE_CONTENT_PATH, "r", encoding="utf-8") as _f:\n    FILE_CONTENT = _f.read()\n${code}`;
      case "shell": {
        // Single-quote the path to prevent $, backtick, and ! expansion
        const sq = "'" + absolutePath.replace(/'/g, "'\\''") + "'";
        return `FILE_CONTENT_PATH=${sq}\nfile_path=${sq}\nFILE_CONTENT=$(cat ${sq})\n${code}`;
      }
      case "ruby":
        return `FILE_CONTENT_PATH = ${escaped}\nfile_path = FILE_CONTENT_PATH\nFILE_CONTENT = File.read(FILE_CONTENT_PATH, encoding: "utf-8")\n${code}`;
      case "go":
        return `package main\n\nimport (\n\t"fmt"\n\t"os"\n)\n\nvar FILE_CONTENT_PATH = ${escaped}\nvar file_path = FILE_CONTENT_PATH\n\nfunc main() {\n\tb, _ := os.ReadFile(FILE_CONTENT_PATH)\n\tFILE_CONTENT := string(b)\n\t_ = FILE_CONTENT\n\t_ = fmt.Sprint()\n${code}\n}\n`;
      case "rust":
        return `#![allow(unused_variables)]\nuse std::fs;\n\nfn main() {\n    let file_content_path = ${escaped};\n    let file_path = file_content_path;\n    let file_content = fs::read_to_string(file_content_path).unwrap();\n${code}\n}\n`;
      case "php":
        return `<?php\n$FILE_CONTENT_PATH = ${escaped};\n$file_path = $FILE_CONTENT_PATH;\n$FILE_CONTENT = file_get_contents($FILE_CONTENT_PATH);\n${code}`;
      case "perl":
        return `my $FILE_CONTENT_PATH = ${escaped};\nmy $file_path = $FILE_CONTENT_PATH;\nopen(my $fh, '<:encoding(UTF-8)', $FILE_CONTENT_PATH) or die "Cannot open: $!";\nmy $FILE_CONTENT = do { local $/; <$fh> };\nclose($fh);\n${code}`;
      case "r":
        return `FILE_CONTENT_PATH <- ${escaped}\nfile_path <- FILE_CONTENT_PATH\nFILE_CONTENT <- readLines(FILE_CONTENT_PATH, warn=FALSE, encoding="UTF-8")\nFILE_CONTENT <- paste(FILE_CONTENT, collapse="\\n")\n${code}`;
      case "elixir":
        return `file_content_path = ${escaped}\nfile_path = file_content_path\nfile_content = File.read!(file_content_path)\n${code}`;
      case "csharp":
        // .csx forbids `using` directives after any other top-level statement
        // (CS1529). User code inside executeFile must use fully-qualified type
        // names (e.g. `System.Text.Json.JsonDocument`) instead of `using`.
        return `var FILE_CONTENT_PATH = ${escaped};\nvar file_path = FILE_CONTENT_PATH;\nvar FILE_CONTENT = System.IO.File.ReadAllText(FILE_CONTENT_PATH);\n${code}`;
    }
  }


export async function prepareRemoteProgram(input: RemoteSource, target: RuntimeTarget): Promise<PreparedProgram> {
  if (!posix.isAbsolute(target.directory)) throw Object.assign(new Error("Upload directory must be absolute"), { code: "remote-directory-invalid" });
  if (input.kind === "file" && !posix.isAbsolute(input.path) && target.cwd === null) {
    throw Object.assign(new Error("Relative destination files need a configured cwd"), { code: "remote-cwd-required" });
  }
  const language = input.language;
  let code = input.kind === "file" ? wrapWithFileContent(input.path, input.language, input.code) : input.code;
  if (language === "go" && !code.includes("package ")) code = `package main\nimport "fmt"\nfunc main() {\n${code}\n}\n`;
  if (language === "php" && !code.trimStart().startsWith("<?")) code = `<?php\n${code}`;
  const directory = posix.join(target.directory, randomBytes(16).toString("hex"));
  const programNonce = randomBytes(16).toString("hex");
  const file = posix.join(directory, language === "typescript" ? "script.cts" : buildScriptFilename(language, "linux"));
  const upload = (path: string, source: string) => { const bytes = Buffer.from(source); return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") }; };
  const defaults: Record<Language, readonly string[]> = {
    javascript: [target.nodePath || "node"], typescript: [target.nodePath || "node"], python: ["python3"], shell: ["/bin/sh"],
    ruby: ["ruby"], go: ["go", "run"], rust: ["rustc"], php: ["php"], perl: ["perl"],
    r: ["Rscript"], elixir: ["elixir"], csharp: ["dotnet-script"],
  };
  const command = target.commands[language] ?? defaults[language];
  if (!command?.length) throw Object.assign(new Error("Unknown destination language"), { code: "remote-language-unsupported" });
  const files = [upload(posix.join(directory, ".spider-program"), programNonce), upload(file, code)];
  let argv = [...command, file];
  if (language === "rust") {
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const binary = posix.join(directory, "program");
    const driver = posix.join(directory, "compile.sh");
    files.push(upload(driver, `${[...command, file, "-o", binary].map(quote).join(" ")} || exit $?\nexec ${quote(binary)}\n`));
    argv = ["/bin/sh", driver];
  }
  const commandPreview = scrubSecrets(input.code).text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim().slice(0, 180);
  return { directory, argv, cwd: target.cwd, files, env: { ...target.environment }, commandPreview };
}
