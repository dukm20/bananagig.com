export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { initObservability, log } = await import('@bananagig/observability');
  const { serverConfig } = await import('./lib/server');
  const cfg = serverConfig();
  initObservability(cfg);
  log('info', 'web started', { port: cfg.port });
}
