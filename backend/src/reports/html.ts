import type { AnalysisResult, Certainty } from '../rea/model.js';
import { formatBytes } from '../rea/normalize.js';

const CERTAINTY_LABEL: Record<Certainty, string> = {
  confirmed: 'Confirmado',
  inferred: 'Inferido',
  hypothesis: 'Hipótese',
};

const STATUS_LABEL: Record<string, string> = {
  succeeded: 'Concluída',
  partial: 'Parcial',
  failed: 'Falhou',
  cancelled: 'Cancelada',
  skipped: 'Não executada',
  pending: 'Pendente',
  running: 'Em execução',
};

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function badge(c: Certainty): string {
  return `<span class="badge ${c}">${CERTAINTY_LABEL[c]}</span>`;
}

/** Self-contained HTML report (no external resources, no scripts). */
export function renderHtmlReport(result: AnalysisResult): string {
  const steps = result.steps
    .map(
      (s) => `<tr><td>${esc(s.title)}</td><td><code>rea ${esc(s.command)}</code></td><td class="st-${esc(s.status)}">${esc(STATUS_LABEL[s.status] ?? s.status)}</td>
      <td>${s.durationMs != null ? `${(s.durationMs / 1000).toFixed(1)} s` : ''}</td>
      <td>${esc(s.errorMessage ?? s.skipReason ?? '')}</td></tr>`,
    )
    .join('');

  const sections = result.sections
    .map((section) => {
      const facts = section.facts.length
        ? `<dl class="facts">${section.facts
            .map((f) => `<div><dt>${esc(f.label)}</dt><dd>${esc(f.value)} ${badge(f.certainty)}</dd></div>`)
            .join('')}</dl>`
        : '';
      const tables = section.tables
        .map(
          (t) => `<div class="table"><h3>${esc(t.title)} ${badge(t.certainty)}</h3>
          <p class="basis">${esc(t.basis)}${t.truncated ? ` Exibindo ${t.rows.length} de ${t.total} linhas; a lista completa está na Evidence JSON.` : ''}</p>
          <div class="scroll"><table><thead><tr>${t.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
          <tbody>${t.rows.map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`,
        )
        .join('');
      const findings = section.findings.length
        ? `<ul class="findings">${section.findings
            .map(
              (f) => `<li>${badge(f.certainty)} <strong>${esc(f.title)}</strong>${f.location ? ` <code>${esc(f.location)}</code>` : ''}
              <div>${esc(f.detail)}</div><div class="basis">${esc(f.basis)}</div></li>`,
            )
            .join('')}</ul>`
        : '';
      return `<section><h2>${esc(section.title)}</h2>${facts}${tables}${findings}</section>`;
    })
    .join('');

  const limitations = result.limitations.map((l) => `<li>${esc(l.text)} <span class="src">[${esc(l.source)}]</span></li>`).join('');

  return `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Relatório REVERSE INTELLIGENCE — ${esc(result.target.fileName)}</title>
<style>
:root{--bg:#0b0f14;--panel:#121821;--line:#223041;--text:#e6edf3;--muted:#8b9bb0;--accent:#3ad6c5;--ok:#3fb950;--inf:#d4a72c;--hyp:#a371f7;--err:#f0716e}
@media print{:root{--bg:#fff;--panel:#fff;--line:#ccd3db;--text:#111;--muted:#555}.scroll{overflow:visible!important}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 20px}header{border-bottom:1px solid var(--line);padding-bottom:20px;margin-bottom:24px}
.brand{letter-spacing:.24em;font-size:12px;color:var(--accent);font-weight:700}h1{font-size:24px;margin:8px 0 4px}h2{font-size:18px;margin:0 0 12px}
h3{font-size:14px;margin:16px 0 4px}section{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:18px;margin:16px 0}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px 24px;color:var(--muted)}.meta b{color:var(--text);font-weight:600}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:10px 24px;margin:0}.facts dt{color:var(--muted);font-size:12px}.facts dd{margin:0;word-break:break-word}
.badge{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:1px 6px;border-radius:4px;border:1px solid;vertical-align:middle}
.badge.confirmed{color:var(--ok);border-color:var(--ok)}.badge.inferred{color:var(--inf);border-color:var(--inf)}.badge.hypothesis{color:var(--hyp);border-color:var(--hyp)}
.scroll{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top;word-break:break-word}
th{color:var(--muted);font-weight:600}.basis{color:var(--muted);font-size:12px;margin:2px 0 6px}.findings{list-style:none;padding:0;margin:12px 0 0}.findings li{border-left:2px solid var(--line);padding:4px 0 8px 12px;margin-bottom:8px}
.st-succeeded{color:var(--ok)}.st-failed{color:var(--err)}.st-skipped,.st-cancelled{color:var(--muted)}.src{color:var(--muted);font-size:11px}.counts span{margin-right:16px}
footer{color:var(--muted);font-size:12px;margin-top:24px}
</style></head><body><main>
<header><div class="brand">REVERSE INTELLIGENCE</div><h1>${esc(result.target.fileName)}</h1>
<div class="meta">
<div>Projeto: <b>${esc(result.projectName)}</b></div><div>Perfil: <b>${esc(result.profile.title)}</b></div>
<div>Status: <b>${esc(STATUS_LABEL[result.status] ?? result.status)}</b></div><div>Tipo detectado: <b>${esc(result.target.kindDetail)}</b></div>
<div>Tamanho: <b>${esc(formatBytes(result.target.size))}</b></div><div>Gerado em: <b>${esc(result.generatedAt)}</b></div>
<div>Motor: <b>REA ${esc(result.rea.version)}</b></div><div>Isolamento: <b>${esc(result.rea.sandbox)}</b></div>
</div><p>SHA-256: <code>${esc(result.target.sha256)}</code></p>
<p class="counts"><span>${badge('confirmed')} ${result.counts.confirmed}</span><span>${badge('inferred')} ${result.counts.inferred}</span><span>${badge('hypothesis')} ${result.counts.hypothesis}</span></p>
</header>
<section><h2>Execução</h2><div class="scroll"><table><thead><tr><th>Etapa</th><th>Comando</th><th>Status</th><th>Duração</th><th>Observação</th></tr></thead><tbody>${steps}</tbody></table></div></section>
${sections}
<section><h2>Critério de classificação</h2><p>${esc(result.certaintyPolicy)}</p></section>
<section><h2>Limitações declaradas</h2><ul>${limitations}</ul></section>
<footer>Relatório gerado a partir da Evidence REA retida no servidor. Análise estática: o artefato não foi executado. Use apenas em software que você possui ou está autorizado a examinar.</footer>
</main></body></html>`;
}
