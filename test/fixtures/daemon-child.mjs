import { loadConfig } from "../../src/config.mjs";
import { openDb } from "../../src/db.mjs";
import { createAdapterRegistry } from "../../src/adapters/index.mjs";
import { Daemon } from "../../src/daemon.mjs";

const config = loadConfig({
  dataDir: process.env.TEST_DATA_DIR,
  projectPath: process.env.TEST_PROJECT,
  adapter: "mock",
  tickMs: 100,
  concurrency: 3,
  leaderMode: "rule",
});
const db = openDb(config.dbPath);
const quiet = { info() {}, warn() {}, error() {} };
const daemon = new Daemon({
  db,
  config,
  adapters: createAdapterRegistry(config),
  logger: quiet,
});

await daemon.start();

const shutdown = async () => {
  await daemon.stop();
  db.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
setInterval(() => {}, 1000);
