import { createApp } from './app.js';
import { config, isProduction } from './config.js';

if (isProduction) {
  console.warn('LAIS prototype: production mode still requires HTTPS termination, managed secrets and an approved hosting environment.');
}

createApp().listen(config.port, () => {
  console.log(`LAIS API listening on http://localhost:${config.port} (${config.env})`);
});
