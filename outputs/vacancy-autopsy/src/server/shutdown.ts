/** Attempt every close without leaking dependency error objects into logs. */
export async function settleCleanup(closers: Array<() => Promise<unknown>>): Promise<boolean> {
  const results = await Promise.allSettled(closers.map((close) => Promise.resolve().then(close)));
  return results.every((result) => result.status === 'fulfilled');
}
export function onceCleanup(close: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => closing ??= Promise.resolve().then(close);
}
