/**
 * Application result model. Every item is derived from REA Evidence and keeps
 * a pointer to the step that produced it. Nothing is synthesized without a
 * source; aggregations computed by this backend say so in `basis`.
 */

export type Certainty = 'confirmed' | 'inferred' | 'hypothesis';

export interface Fact {
  label: string;
  value: string;
  certainty: Certainty;
  source: string;
}

export interface Table {
  title: string;
  columns: string[];
  rows: string[][];
  certainty: Certainty;
  /** Total rows available in Evidence; rows may be a bounded prefix. */
  total: number;
  truncated: boolean;
  basis: string;
  source: string;
}

export interface Finding {
  title: string;
  detail: string;
  certainty: Certainty;
  basis: string;
  location: string | null;
  source: string;
}

export type SectionId =
  | 'identity'
  | 'components'
  | 'permissions'
  | 'dependencies'
  | 'electron'
  | 'structure'
  | 'build'
  | 'security'
  | 'unresolved';

export const SECTION_TITLES: Record<SectionId, string> = {
  identity: 'Identidade do alvo',
  components: 'Componentes identificados',
  permissions: 'Permissões',
  dependencies: 'Dependências e bibliotecas',
  electron: 'Electron, preload e IPC',
  structure: 'Estrutura e recursos',
  build: 'Build e toolchain',
  security: 'Declarações relevantes para segurança',
  unresolved: 'Hipóteses e pontos não resolvidos',
};

export const SECTION_ORDER: SectionId[] = [
  'identity',
  'components',
  'permissions',
  'security',
  'dependencies',
  'electron',
  'build',
  'structure',
  'unresolved',
];

export interface Section {
  id: SectionId;
  title: string;
  facts: Fact[];
  tables: Table[];
  findings: Finding[];
}

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

export interface StepOutcome {
  key: string;
  title: string;
  command: string;
  status: StepStatus;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  skipReason: string | null;
  evidenceBytes: number | null;
  evidenceSha256: string | null;
}

export interface AnalysisResult {
  schemaVersion: 1;
  analysisId: string;
  projectId: string;
  projectName: string;
  generatedAt: string;
  status: string;
  profile: { id: string; title: string };
  target: { fileName: string; size: number; sha256: string; kind: string; kindDetail: string };
  rea: { version: string; sandbox: string };
  steps: StepOutcome[];
  sections: Section[];
  counts: Record<Certainty, number>;
  limitations: { source: string; text: string }[];
  certaintyPolicy: string;
}

export const CERTAINTY_POLICY =
  'Confirmado: observado diretamente nos bytes do artefato ou declarado em metadados decodificados (REA state=observed, ' +
  'confidence exact/high). Inferido: relação derivada por análise estática (REA state=inferred/derived) ou agregação ' +
  'heurística feita por este backend, sempre identificada. Hipótese: pontos que o REA marca como hipótese, desconhecido ' +
  'ou não resolvido, ou inferências de baixa confiança. Ausência de achado não prova ausência de comportamento.';

export interface Contribution {
  sections: Partial<Record<SectionId, { facts?: Fact[]; tables?: Table[]; findings?: Finding[] }>>;
  limitations: string[];
}

export const MAX_TABLE_ROWS = 500;
