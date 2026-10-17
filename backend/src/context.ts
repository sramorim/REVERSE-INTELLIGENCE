import type { Config } from './config.js';
import type { Db } from './db.js';
import type { Storage } from './storage.js';
import type { ReaRunner } from './rea/runner.js';
import type { CapabilityProbe } from './rea/capabilities.js';
import type { AnalysisWorker } from './jobs/worker.js';

export interface AppContext {
  config: Config;
  db: Db;
  storage: Storage;
  runner: ReaRunner;
  capabilities: CapabilityProbe;
  worker: AnalysisWorker;
  startedAt: string;
  version: string;
}
