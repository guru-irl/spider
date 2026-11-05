export interface Component {
  render(width: number): string[];
  handleInput?(key: string): boolean;
  invalidate?(): void;
}

/** Retain only the latest layout until its width, optional live key or content changes. */
export function cachedLines(compute: (width: number) => string[], invalidate?: () => void, contentKey?: () => unknown): Component {
  let cachedWidth: number | undefined;
  let cachedKey: unknown;
  let lines: string[] | undefined;
  return {
    render(width) {
      const key = contentKey?.();
      if (lines === undefined || cachedWidth !== width || !Object.is(cachedKey, key)) {
        lines = compute(width);
        cachedWidth = width;
        cachedKey = key;
      }
      return lines;
    },
    invalidate() {
      lines = undefined;
      invalidate?.();
    },
  };
}
