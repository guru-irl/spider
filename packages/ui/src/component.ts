export interface Component {
  render(width: number): string[];
  handleInput?(key: string): boolean;
  invalidate?(): void;
}
