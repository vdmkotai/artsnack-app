export async function runGrokOperationsIndependently<T>(
  operations: Array<() => Promise<T>>,
): Promise<{ successes: T[]; failures: unknown[] }> {
  const results = await Promise.allSettled(
    operations.map((operation) => Promise.resolve().then(operation)),
  );
  const successes: T[] = [];
  const failures: unknown[] = [];

  for (const result of results) {
    if (result.status === "fulfilled") successes.push(result.value);
    else failures.push(result.reason);
  }

  return { successes, failures };
}
