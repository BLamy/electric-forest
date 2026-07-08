export function taskBadge(openTasks: number): string {
  if (!Number.isInteger(openTasks) || openTasks < 0) {
    throw new RangeError("openTasks must be a non-negative integer");
  }

  return openTasks === 0 ? "all-clear" : `open-${openTasks}`;
}
