import { createApp } from './app.js';
import { config, isProduction } from './config.js';
import { log } from './logger.js';
import { failInterruptedJobs, purgeOldUploads } from './services/gisJobs.js';

if (isProduction) {
  console.warn('LAIS prototype: production mode still requires HTTPS termination, managed secrets and an approved hosting environment.');
}

// GIS jobs run inside the API process: any left unfinished by a stop are marked failed (nothing half-staged).
await failInterruptedJobs().catch((err) => log('error', 'could not check interrupted GIS jobs', { error: (err as Error).message }));
await purgeOldUploads();
setInterval(() => { purgeOldUploads().catch(() => undefined); }, 3_600_000).unref();

createApp().listen(config.port, () => {
  console.log(`LAIS API listening on http://localhost:${config.port} (${config.env})`);
  log('info', 'api started', { port: config.port, env: config.env });
});
