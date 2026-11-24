import { describe, expect, it } from "vitest";
import { Lexer } from "marked";
import { blocksToPlain } from "./plain.js";

const plain = (markdown: string) => blocksToPlain(Lexer.lex(markdown));

describe("Markdown to plain text", () => {
  it("removes syntax and retains source line breaks", () => {
    expect(plain("# Hi team\nQuick **one** on `X-1`, _see_ [the doc](https://d.e) or <https://u.rl>.\n\n\nBye"))
      .toBe("Hi team\nQuick one on X-1, see the doc (https://d.e) or https://u.rl.\n\n\nBye");
    expect(plain("- [x] done\n- two\n  3. three\n\n| a | b |\n|---|---|\n| 1 | **2** |"))
      .toBe("- [x] done\n- two\n  3. three\n\na | b\n1 | 2");
  });

  it("preserves blank lines and list gaps", () => {
    expect(plain("first\n \nsecond")).toBe("first\n\nsecond");
    expect(plain("- one\n\n- two\n- three\n\nafter")).toBe("- one\n\n- two\n- three\n\nafter");
  });

  it("keeps code content and fenced trailing blank lines", () => {
    expect(plain("```\nalpha\n\n```\nbeta")).toBe("alpha\n\nbeta");
    expect(plain("para\n\n    indented\nnext")).toBe("para\n\nindented\nnext");
    expect(plain("> ```\n> alpha\n>\n> ```\n> beta")).toBe("alpha\n\nbeta");
  });
});
