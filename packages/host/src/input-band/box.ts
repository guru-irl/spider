import { Box, truncateToWidth } from "@earendil-works/pi-tui";
import { bindHalfBox, isImageRow } from "@spider/ui";

export function createHalfBox(paddingX: number, bg: (text: string) => string): Box {
  const box = new Box(paddingX, 1, bg);
  bindHalfBox(box, () => true);
  const render = box.render;
  let cache: { rows: string[]; width: number; output: string[] } | undefined;
  box.render = width => {
    const rows = render.call(box, width);
    if (cache?.rows === rows && cache.width === width) return cache.output;
    const output = rows.map(row => isImageRow(row) ? row : truncateToWidth(row, width, ""));
    cache = { rows, width, output };
    return output;
  };
  return box;
}
