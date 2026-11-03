/** Optional runtime loader: typecheck/build must work when Playwright is unavailable. */
export async function loadPlaywright<T = unknown>(): Promise<T | null> {
  try {
    const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
    const loaded = await dynamicImport("playwright") as { default?: T } & T;
    return loaded.default ?? loaded;
  } catch {
    // VM/test 运行时可能禁用 Function 构造的 dynamic import；回退到静态分析可见的 import。
    try {
      const loaded = await import("playwright") as unknown as { default?: T } & T;
      return loaded.default ?? loaded;
    } catch {
      return null;
    }
  }
}
