import {
  CERTAINTY_POLICY,
  SECTION_ORDER,
  SECTION_TITLES,
  type AnalysisResult,
  type Certainty,
  type Contribution,
  type Section,
  type StepOutcome,
} from './model.js';

export interface AssembleInput {
  analysisId: string;
  projectId: string;
  projectName: string;
  status: string;
  profile: { id: string; title: string };
  target: AnalysisResult['target'];
  rea: AnalysisResult['rea'];
  steps: StepOutcome[];
  contributions: { stepKey: string; contribution: Contribution }[];
  extraLimitations: { source: string; text: string }[];
}

export function assembleResult(input: AssembleInput): AnalysisResult {
  const sections = new Map<string, Section>();
  for (const id of SECTION_ORDER) sections.set(id, { id, title: SECTION_TITLES[id], facts: [], tables: [], findings: [] });

  const limitations: { source: string; text: string }[] = [...input.extraLimitations];
  for (const { stepKey, contribution } of input.contributions) {
    for (const [id, part] of Object.entries(contribution.sections)) {
      const section = sections.get(id)!;
      if (!part) continue;
      for (const fact of part.facts ?? []) {
        // The same label can be reported by several steps (e.g. SHA-256); keep the first.
        if (!section.facts.some((f) => f.label === fact.label && f.value === fact.value)) section.facts.push(fact);
      }
      section.tables.push(...(part.tables ?? []));
      section.findings.push(...(part.findings ?? []));
    }
    for (const text of contribution.limitations) {
      if (!limitations.some((l) => l.text === text)) limitations.push({ source: stepKey, text });
    }
  }

  const counts: Record<Certainty, number> = { confirmed: 0, inferred: 0, hypothesis: 0 };
  const ordered = [...sections.values()].filter((s) => s.facts.length + s.tables.length + s.findings.length > 0);
  for (const s of ordered) {
    for (const f of s.facts) counts[f.certainty] += 1;
    for (const f of s.findings) counts[f.certainty] += 1;
    for (const t of s.tables) counts[t.certainty] += t.total;
  }

  return {
    schemaVersion: 1,
    analysisId: input.analysisId,
    projectId: input.projectId,
    projectName: input.projectName,
    generatedAt: new Date().toISOString(),
    status: input.status,
    profile: input.profile,
    target: input.target,
    rea: input.rea,
    steps: input.steps,
    sections: ordered,
    counts,
    limitations,
    certaintyPolicy: CERTAINTY_POLICY,
  };
}
