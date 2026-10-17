import fs from 'node:fs';
import path from 'node:path';
import type { ReaRunner } from './runner.js';
import { readJsonFile } from './runner.js';
import { PROFILES, type Requirement } from './profiles.js';

/**
 * Live readiness of REA and the engines each profile needs, measured by
 * running REA's own `capabilities` and `doctor` commands (never assumed).
 */

export interface RequirementStatus {
  id: Requirement;
  available: boolean;
  detail: string;
}

export interface CapabilityReport {
  checkedAt: string;
  reaVersion: string;
  reaReachable: boolean;
  reaError: string | null;
  requirements: RequirementStatus[];
  profiles: { id: string; title: string; description: string; available: boolean; partial: boolean; notes: string[] }[];
}

const CACHE_MS = 5 * 60 * 1000;

export class CapabilityProbe {
  private cached: CapabilityReport | null = null;
  private inflight: Promise<CapabilityReport> | null = null;

  constructor(
    private readonly runner: ReaRunner,
    private readonly workDir: string,
  ) {}

  async get(force = false): Promise<CapabilityReport> {
    if (!force && this.cached && Date.now() - Date.parse(this.cached.checkedAt) < CACHE_MS) return this.cached;
    if (!this.inflight) {
      this.inflight = this.probe().finally(() => {
        this.inflight = null;
      });
    }
    this.cached = await this.inflight;
    return this.cached;
  }

  private async runJson(command: string, args: string[]): Promise<{ ok: boolean; json: unknown; error: string | null }> {
    fs.mkdirSync(this.workDir, { recursive: true });
    const out = path.join(this.workDir, `${command}.json`);
    try {
      const result = await this.runner.run({ command, args, workDir: this.workDir, outputPath: out, timeoutMs: 60_000 });
      let json: unknown = null;
      try {
        json = readJsonFile(out, 16 * 1024 * 1024);
      } catch {
        json = null;
      }
      return { ok: result.exitCode === 0, json, error: result.exitCode === 0 ? null : result.stderrTail.slice(-500) };
    } catch (error) {
      return { ok: false, json: null, error: (error as Error).message };
    }
  }

  private async probe(): Promise<CapabilityReport> {
    const caps = await this.runJson('capabilities', []);
    const requirements: RequirementStatus[] = [];

    const doctor = await this.runJson('doctor', ['--provider', 'jadx']);
    const checks = ((doctor.json as { scope_checks?: { name: string; ok: boolean; detail?: string; remediation?: string }[] })
      ?.scope_checks ?? []) as { name: string; ok: boolean; detail?: string; remediation?: string }[];
    const jadx = checks.find((c) => c.name === 'jadx');
    requirements.push({
      id: 'jadx',
      available: Boolean(jadx?.ok),
      detail: jadx
        ? jadx.ok
          ? 'JADX headless validado pelo REA doctor.'
          : (jadx.remediation ?? jadx.detail ?? 'JADX indisponível.')
        : 'Não foi possível consultar o REA doctor para o JADX.',
    });

    let sqliteAvailable = false;
    let sqliteDetail = 'Capacidade não reportada pelo REA.';
    const capList = (caps.json as { capabilities?: { groups: { operations: string[]; available: boolean; reason: string | null }[] }[] })
      ?.capabilities;
    for (const provider of capList ?? []) {
      for (const group of provider.groups) {
        if (group.operations.includes('inspect_sqlite_database')) {
          sqliteAvailable = group.available;
          sqliteDetail = group.available ? 'Disponível.' : (group.reason ?? 'Indisponível.');
        }
      }
    }
    requirements.push({ id: 'node24-sqlite', available: sqliteAvailable, detail: sqliteDetail });

    const reqMap = new Map(requirements.map((r) => [r.id, r]));
    const profiles = PROFILES.map((profile) => {
      const notes: string[] = [];
      let requiredMissing = false;
      let optionalMissing = false;
      for (const step of profile.steps) {
        for (const req of step.requires ?? []) {
          const status = reqMap.get(req);
          if (!status?.available) {
            notes.push(`${step.title}: ${status?.detail ?? 'requisito indisponível'}`);
            if (step.optional) optionalMissing = true;
            else requiredMissing = true;
          }
        }
      }
      return {
        id: profile.id,
        title: profile.title,
        description: profile.description,
        available: caps.ok && !requiredMissing,
        partial: caps.ok && (requiredMissing || optionalMissing),
        notes,
      };
    });

    return {
      checkedAt: new Date().toISOString(),
      reaVersion: this.runner.version,
      reaReachable: caps.ok,
      reaError: caps.ok ? null : caps.error,
      requirements,
      profiles,
    };
  }
}
