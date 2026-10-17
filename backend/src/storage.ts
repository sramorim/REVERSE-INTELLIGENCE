import fs from 'node:fs';
import path from 'node:path';

/**
 * On-disk layout under RI_DATA_DIR. File names are generated identifiers;
 * user-supplied names are never used as paths.
 *
 *   uploads/<uploadId>.part          in-progress resumable uploads
 *   artifacts/<artifactId>/target.ext stored artifacts (read-only for analyses)
 *   analyses/<analysisId>/steps/      raw REA Evidence per step
 *   analyses/<analysisId>/work/       scratch space (deleted after the run)
 *   analyses/<analysisId>/result.json normalized result
 *   analyses/<analysisId>/reports/    generated reports
 */
export class Storage {
  constructor(readonly root: string) {
    for (const dir of ['uploads', 'artifacts', 'analyses', 'probe']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true, mode: 0o700 });
    }
  }

  uploadPath(uploadId: string): string {
    return path.join(this.root, 'uploads', `${uploadId}.part`);
  }

  artifactDir(artifactId: string): string {
    return path.join(this.root, 'artifacts', artifactId);
  }

  artifactPath(artifactId: string, fileName: string): string {
    const ext = /\.([A-Za-z0-9]{1,10})$/.exec(fileName)?.[1]?.toLowerCase();
    return path.join(this.artifactDir(artifactId), ext ? `target.${ext}` : 'target');
  }

  analysisDir(analysisId: string): string {
    return path.join(this.root, 'analyses', analysisId);
  }

  stepsDir(analysisId: string): string {
    return path.join(this.analysisDir(analysisId), 'steps');
  }

  workDir(analysisId: string): string {
    return path.join(this.analysisDir(analysisId), 'work');
  }

  resultPath(analysisId: string): string {
    return path.join(this.analysisDir(analysisId), 'result.json');
  }

  reportsDir(analysisId: string): string {
    return path.join(this.analysisDir(analysisId), 'reports');
  }

  probeDir(): string {
    return path.join(this.root, 'probe');
  }

  /** Bytes used under the data root (best effort, bounded walk). */
  usage(): { bytes: number; files: number } {
    let bytes = 0;
    let files = 0;
    const stack = [this.root];
    while (stack.length > 0 && files < 500_000) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) stack.push(p);
        else if (e.isFile()) {
          try {
            bytes += fs.statSync(p).size;
            files += 1;
          } catch {
            /* raced with deletion */
          }
        }
      }
    }
    return { bytes, files };
  }

  removeTree(p: string): void {
    fs.rmSync(p, { recursive: true, force: true });
  }
}
