const SGR = /\x1b\[([0-9;]*)m/g;

/** A half-block uses the background's color as foreground ink on the glass. */
export function foregroundFromBackground(ansi: string): string | undefined {
  const extended = /^\x1b\[48;(2;\d+;\d+;\d+|5;\d+)m$/u.exec(ansi);
  if (extended) return `\x1b[38;${extended[1]}m`;
  const simple = /^\x1b\[(4[0-7]|10[0-7])m$/u.exec(ansi);
  return simple ? `\x1b[${Number(simple[1]) - 10}m` : undefined;
}

/** A blank-looking row can still paint another background (for example a swatch). */
export function hasOtherBackground(row: string, ansi: string): boolean {
  const boxColor = ansi.slice(2, -1);
  for (const [, params] of row.matchAll(/\x1b\[([0-9;:]*)m/g)) {
    const fields = params.split(";");
    for (let i = 0; i < fields.length; i++) {
      const [head, ...subfields] = fields[i].split(":");
      const code = Number(head);
      if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
        if (head !== boxColor) return true;
      } else if (code === 38 || code === 48 || code === 58) {
        let color = subfields;
        if (color.length === 0) {
          const count = fields[i + 1] === "2" ? 4 : fields[i + 1] === "5" ? 2 : 0;
          color = fields.slice(i + 1, i + 1 + count);
          i += count;
        } else if (color[0] === "2" && color.length === 5 && (color[1] === "" || color[1] === "0")) {
          color = [color[0], ...color.slice(2)]; // Default color space in colon-delimited RGB.
        }
        if (code === 48 && [head, ...color].join(";") !== boxColor) return true;
      }
    }
  }
  return false;
}

/** An explicit inner background still wins until the row resets it. */
export function reopenBackground(row: string, ansi: string): string {
  if (!ansi) return row;
  return row.replace(SGR, (sequence, parameters: string) => {
    const codes = parameters.split(";").map(part => Number(part || 0));
    let reopen = false;
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i];
      if (code === 0 || code === 49) reopen = true;
      else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) reopen = false;
      else if (code === 38 || code === 48 || code === 58) {
        if (code === 48) reopen = false;
        if (codes[i + 1] === 5) i += 2;
        else if (codes[i + 1] === 2) i += 4;
      }
    }
    return reopen ? sequence + ansi : sequence;
  });
}
