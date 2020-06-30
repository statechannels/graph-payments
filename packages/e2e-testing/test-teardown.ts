export default async function teardown(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (global as any).__GANACHE_SERVER__.close();
}
