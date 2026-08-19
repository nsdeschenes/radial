function isDuckDBBusyError(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null && !visited.has(current)) {
    visited.add(current);
    if (
      current instanceof Error &&
      /could not set lock on file|conflicting lock is held|database is locked/i.test(
        current.message
      )
    ) {
      return true;
    }

    if (typeof current !== 'object' || !('cause' in current)) {
      break;
    }

    current = current.cause;
  }

  return false;
}

export default isDuckDBBusyError;
