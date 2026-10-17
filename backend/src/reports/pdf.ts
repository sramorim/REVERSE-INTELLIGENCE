import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import type { AnalysisResult, Certainty } from '../rea/model.js';
import { formatBytes } from '../rea/normalize.js';

const COLORS = {
  ink: '#111820',
  muted: '#5b6b7d',
  line: '#d5dce4',
  accent: '#0f9e90',
  confirmed: '#1f883d',
  inferred: '#9a6700',
  hypothesis: '#8250df',
};

const LABEL: Record<Certainty, string> = { confirmed: 'CONFIRMADO', inferred: 'INFERIDO', hypothesis: 'HIPÓTESE' };
const MAX_PDF_ROWS = 150;
const STATUS: Record<string, string> = { succeeded: 'concluída', partial: 'parcial', failed: 'falhou', cancelled: 'cancelada', skipped: 'não executada', pending: 'pendente', running: 'em execução' };

interface Fonts {
  regular: string;
  bold: string;
  mono: string;
  unicode: boolean;
}

function resolveFonts(): Fonts {
  const dir = process.env.RI_PDF_FONT_DIR ?? '/usr/share/fonts/truetype/dejavu';
  const regular = path.join(dir, 'DejaVuSans.ttf');
  const bold = path.join(dir, 'DejaVuSans-Bold.ttf');
  const mono = path.join(dir, 'DejaVuSansMono.ttf');
  if ([regular, bold, mono].every((f) => fs.existsSync(f))) return { regular, bold, mono, unicode: true };
  return { regular: 'Helvetica', bold: 'Helvetica-Bold', mono: 'Courier', unicode: false };
}

/** Renders the normalized result as a paginated A4 PDF. Resolves with the bytes. */
export function renderPdfReport(result: AnalysisResult): Promise<Buffer> {
  const fonts = resolveFonts();
  // Built-in PDF fonts only cover WinAnsi; replace other code points.
  const t = (value: unknown) => {
    const s = String(value ?? '');
    return fonts.unicode ? s : s.replace(/[^\x20-\x7e -ÿ]/g, '?');
  };

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: `REVERSE INTELLIGENCE — ${result.target.fileName}`, Producer: 'REVERSE INTELLIGENCE' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.registerFont('R', fonts.regular);
    doc.registerFont('B', fonts.bold);
    doc.registerFont('M', fonts.mono);
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const left = doc.page.margins.left;

    const ensure = (h: number) => {
      if (doc.y + h > doc.page.height - doc.page.margins.bottom) doc.addPage();
    };
    const heading = (text: string) => {
      ensure(40);
      doc.moveDown(0.6).font('B').fontSize(13).fillColor(COLORS.ink).text(t(text), left, doc.y, { width });
      doc.moveTo(left, doc.y + 2).lineTo(left + width, doc.y + 2).strokeColor(COLORS.line).lineWidth(0.6).stroke();
      doc.moveDown(0.5);
    };
    const tag = (c: Certainty) => `[${LABEL[c]}]`;

    // Header
    doc.font('B').fontSize(9).fillColor(COLORS.accent).text('REVERSE INTELLIGENCE', { characterSpacing: 2 });
    doc.moveDown(0.3).font('B').fontSize(18).fillColor(COLORS.ink).text(t(result.target.fileName), { width });
    doc.moveDown(0.3).font('R').fontSize(9).fillColor(COLORS.muted);
    const meta: [string, string][] = [
      ['Projeto', result.projectName],
      ['Perfil', result.profile.title],
      ['Status', STATUS[result.status] ?? result.status],
      ['Tipo detectado', result.target.kindDetail],
      ['Tamanho', formatBytes(result.target.size)],
      ['Gerado em', result.generatedAt],
      ['Motor', `REA ${result.rea.version} (isolamento: ${result.rea.sandbox})`],
    ];
    for (const [k, v] of meta) doc.text(t(`${k}: ${v}`));
    doc.font('M').fontSize(8).text(t(`SHA-256 ${result.target.sha256}`));
    doc.moveDown(0.4).font('B').fontSize(9);
    doc.fillColor(COLORS.confirmed).text(`Confirmados: ${result.counts.confirmed}`, { continued: true });
    doc.fillColor(COLORS.inferred).text(`    Inferidos: ${result.counts.inferred}`, { continued: true });
    doc.fillColor(COLORS.hypothesis).text(`    Hipóteses: ${result.counts.hypothesis}`);

    heading('Execução');
    doc.font('R').fontSize(9).fillColor(COLORS.ink);
    for (const s of result.steps) {
      ensure(24);
      const note = s.errorMessage ?? s.skipReason ?? '';
      doc.font('B').text(t(`${s.title} — ${STATUS[s.status] ?? s.status}${s.durationMs != null ? ` (${(s.durationMs / 1000).toFixed(1)} s)` : ''}`), { width });
      doc.font('M').fontSize(8).fillColor(COLORS.muted).text(t(`rea ${s.command}`));
      if (note) doc.font('R').fontSize(8).text(t(note), { width });
      doc.fontSize(9).fillColor(COLORS.ink).moveDown(0.2);
    }

    for (const section of result.sections) {
      heading(section.title);
      for (const f of section.facts) {
        ensure(16);
        doc.font('B').fontSize(9).fillColor(COLORS.ink).text(t(`${f.label}: `), left, doc.y, { continued: true, width });
        doc.font('R').text(t(f.value), { continued: true });
        doc.fillColor(COLORS[f.certainty]).fontSize(7).text(`  ${tag(f.certainty)}`);
        doc.moveDown(0.2);
      }
      for (const table of section.tables) {
        ensure(40);
        doc.moveDown(0.4).font('B').fontSize(10).fillColor(COLORS.ink).text(t(table.title), left, doc.y, { continued: true, width });
        doc.fillColor(COLORS[table.certainty]).fontSize(7).text(`  ${tag(table.certainty)}`);
        doc.moveDown(0.1).font('R').fontSize(7.5).fillColor(COLORS.muted).text(t(table.basis), { width });
        const rows = table.rows.slice(0, MAX_PDF_ROWS);
        const colWidth = width / table.columns.length;
        const drawRow = (cells: string[], bold: boolean) => {
          const texts = cells.map((c) => t(c.length > 300 ? `${c.slice(0, 300)}…` : c));
          doc.font(bold ? 'B' : 'R').fontSize(7.5);
          const h = Math.max(...texts.map((c) => doc.heightOfString(c, { width: colWidth - 6 }))) + 4;
          ensure(h);
          const y = doc.y;
          texts.forEach((c, i) => doc.fillColor(bold ? COLORS.muted : COLORS.ink).text(c, left + i * colWidth, y + 2, { width: colWidth - 6 }));
          doc.y = y + h;
          doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor(COLORS.line).lineWidth(0.3).stroke();
        };
        doc.moveDown(0.2);
        drawRow(table.columns, true);
        for (const r of rows) drawRow(r, false);
        doc.x = left;
        if (table.total > rows.length) {
          doc.moveDown(0.2).font('R').fontSize(7.5).fillColor(COLORS.muted).text(t(`Exibindo ${rows.length} de ${table.total} linhas. A lista completa está no relatório HTML/JSON e na Evidence.`), { width });
        }
      }
      for (const f of section.findings) {
        ensure(30);
        doc.moveDown(0.3).fillColor(COLORS[f.certainty]).font('B').fontSize(7).text(tag(f.certainty), left, doc.y, { continued: true });
        doc.fillColor(COLORS.ink).fontSize(9).text(t(`  ${f.title}`), { width });
        if (f.location) doc.font('M').fontSize(7.5).fillColor(COLORS.muted).text(t(f.location));
        if (f.detail) doc.font('R').fontSize(8.5).fillColor(COLORS.ink).text(t(f.detail), { width });
        doc.font('R').fontSize(7.5).fillColor(COLORS.muted).text(t(f.basis), { width });
      }
    }

    heading('Critério de classificação');
    doc.font('R').fontSize(8.5).fillColor(COLORS.ink).text(t(result.certaintyPolicy), { width });
    heading('Limitações declaradas');
    for (const l of result.limitations) {
      ensure(20);
      doc.font('R').fontSize(8).fillColor(COLORS.ink).text(t(`• ${l.text} [${l.source}]`), { width });
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      // Writing inside the bottom margin would otherwise trigger an automatic page break.
      doc.page.margins.bottom = 0;
      doc.font('R').fontSize(7).fillColor(COLORS.muted);
      doc.text(`REVERSE INTELLIGENCE · ${i + 1}/${range.count}`, left, doc.page.height - 30, { width, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}
