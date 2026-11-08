/**
 * The call convention every bundle shares: modules are exposed by name on
 * `globalThis.ArtsnackShared`, `__get(path)` reads a value and `__call(path,
 * argsJson)` calls a function with the arguments array. Values cross as JSON.
 */
export function expose(modules: Record<string, Record<string, unknown>>): void {
  function resolve(path: string): unknown {
    const [module, ...rest] = path.split(".");
    let value: unknown = modules[module];
    for (const key of rest) {
      if (value === undefined || value === null) break;
      value = (value as Record<string, unknown>)[key];
    }
    if (value === undefined) throw new Error(`no export ${path}`);
    return value;
  }

  (globalThis as Record<string, unknown>).ArtsnackShared = {
    __get(path: string): string {
      return JSON.stringify(resolve(path));
    },
    __call(path: string, argsJson: string): string {
      const fn = resolve(path);
      if (typeof fn !== "function") throw new Error(`${path} is not a function`);
      const result = (fn as (...args: unknown[]) => unknown)(
        ...(JSON.parse(argsJson) as unknown[]),
      );
      return JSON.stringify(result === undefined ? null : result);
    },
  };
}
