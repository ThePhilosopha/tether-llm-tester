'use strict';
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const resources = process.env.LLM_TESTER_RESOURCES || join(__dirname, '..');

(async () => {
  let createApp;
  try {
    ({ createApp } = await import(pathToFileURL(join(resources, 'server.mjs')).href));
  } catch (caught) {
    console.error(`Failed to load ${join(resources, 'server.mjs')}: ${caught.message}`);
    process.exit(1);
  }
  const app = createApp({ clientDir: join(resources, 'client', 'dist') });
  const address = await app.start();
  console.log(`READY ${address.port}`);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch(caught => {
  console.error(caught.message);
  process.exit(1);
});
