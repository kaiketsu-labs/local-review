/** Quote an argument literally for Claude's POSIX terminal and command hooks. */
export function quotePosix(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
