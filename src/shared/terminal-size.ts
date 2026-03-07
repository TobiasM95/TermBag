export interface TerminalSize {
  cols: number;
  rows: number;
}

export function isSameTerminalSize(left: TerminalSize, right: TerminalSize): boolean {
  return left.cols === right.cols && left.rows === right.rows;
}
