import type { ArtifactKind } from '../detect.js';

/**
 * Analysis profiles: which REA commands run for each artifact kind.
 * Every step maps to a documented, static (non-executing) REA CLI command.
 */

export type Requirement = 'jadx' | 'node24-sqlite';

export interface StepSpec {
  key: string;
  title: string;
  command: string;
  /** Builds the argv after the command name. `target` is the absolute path REA reads. */
  args: (target: string) => string[];
  /** Which file the step reads: the uploaded artifact or the extracted app root. */
  input: 'artifact' | 'extracted-root';
  requires?: Requirement[];
  /** Step failure does not fail the analysis when other steps succeed. */
  optional?: boolean;
  /** Only meaningful for some sub-formats; the check runs against detection detail. */
  appliesTo?: (detail: string) => boolean;
}

export interface Profile {
  id: string;
  title: string;
  description: string;
  kinds: ArtifactKind[];
  /** Extract the uploaded archive (via REA extract-artifact) before the steps. */
  extract?: boolean;
  steps: StepSpec[];
}

const inventory: StepSpec = {
  key: 'inventory',
  title: 'Inventário do artefato',
  command: 'inspect-artifact',
  args: (t) => [t],
  input: 'artifact',
};

export const PROFILES: Profile[] = [
  {
    id: 'android-apk',
    title: 'APK Android',
    description:
      'Manifesto decodificado, permissões, componentes, inventário de classes (JADX), identificação Flutter e inventário de arquivos.',
    kinds: ['android-apk'],
    steps: [
      inventory,
      {
        key: 'android-package',
        title: 'Manifesto e declarações (JADX)',
        command: 'inspect-android-package',
        args: (t) => [t],
        input: 'artifact',
        requires: ['jadx'],
      },
      {
        key: 'android-classes',
        title: 'Inventário de classes (JADX)',
        command: 'search-android-classes',
        args: (t) => [t, ''],
        input: 'artifact',
        requires: ['jadx'],
        optional: true,
      },
      {
        key: 'flutter',
        title: 'Identificação de build Flutter',
        command: 'identify-flutter-build',
        args: (t) => [t],
        input: 'artifact',
        optional: true,
      },
    ],
  },
  {
    id: 'javascript-application',
    title: 'Aplicação JavaScript / Web / Electron',
    description:
      'Extração segura do pacote e reconstrução estática: módulos, importações, dependências externas, janelas, preload, IPC e APIs expostas do Electron.',
    kinds: ['javascript-archive'],
    extract: true,
    steps: [
      inventory,
      {
        key: 'javascript-app',
        title: 'Reconstrução estática JavaScript/Electron',
        command: 'analyze-javascript-application',
        args: (t) => [t],
        input: 'extracted-root',
      },
    ],
  },
  {
    id: 'electron-asar',
    title: 'Pacote ASAR do Electron',
    description: 'Reconstrução estática do conteúdo ASAR: módulos, IPC, preload e APIs expostas.',
    kinds: ['electron-asar'],
    steps: [
      inventory,
      {
        key: 'javascript-app',
        title: 'Reconstrução estática JavaScript/Electron',
        command: 'analyze-javascript-application',
        args: (t) => [t],
        input: 'artifact',
      },
    ],
  },
  {
    id: 'dotnet-assembly',
    title: 'Assembly .NET',
    description: 'Identidade PE/CLI, fronteiras nativas (P/Invoke) e membros com âncoras CIL, sem carregar o assembly.',
    kinds: ['dotnet-assembly'],
    steps: [
      inventory,
      {
        key: 'managed-artifact',
        title: 'Identidade do assembly',
        command: 'inspect-managed-artifact',
        args: (t) => [t],
        input: 'artifact',
      },
      {
        key: 'managed-native',
        title: 'Fronteiras nativas (P/Invoke)',
        command: 'inspect-managed-native-boundaries',
        args: (t) => [t],
        input: 'artifact',
        optional: true,
      },
      {
        key: 'managed-members',
        title: 'Membros e assinaturas',
        command: 'inspect-managed-members',
        args: (t) => [t],
        input: 'artifact',
        optional: true,
      },
    ],
  },
  {
    id: 'native-binary',
    title: 'Binário nativo (ELF / PE / Mach-O)',
    description:
      'Inventário e metadados embutidos de Go e Rust (cargo-auditable) e recursos PE. Decompilação nativa exige Ghidra/Hopper/IDA, não configurados.',
    kinds: ['native-elf', 'native-pe', 'native-macho'],
    steps: [
      inventory,
      {
        key: 'go-binary',
        title: 'Metadados de build Go',
        command: 'inspect-go-binary',
        args: (t) => [t],
        input: 'artifact',
        optional: true,
      },
      {
        key: 'rust-binary',
        title: 'Dependências Rust (cargo-auditable)',
        command: 'inspect-rust-binary',
        args: (t) => [t],
        input: 'artifact',
        optional: true,
      },
      {
        key: 'pe-resources',
        title: 'Recursos PE',
        command: 'inspect-pe-resources',
        args: (t) => [t],
        input: 'artifact',
        optional: true,
        appliesTo: (detail) => detail.startsWith('Executável PE'),
      },
    ],
  },
  {
    id: 'sqlite-database',
    title: 'Banco SQLite',
    description: 'Esquema (tabelas, colunas, índices, gatilhos) de um snapshot SQLite.',
    kinds: ['sqlite'],
    steps: [
      inventory,
      {
        key: 'sqlite',
        title: 'Esquema SQLite',
        command: 'inspect-sqlite-database',
        args: (t) => [t],
        input: 'artifact',
        requires: ['node24-sqlite'],
      },
    ],
  },
  {
    id: 'generic-artifact',
    title: 'Inventário genérico',
    description: 'Inventário seguro de conteúdo, digests e próximas sondagens sugeridas pelo REA.',
    kinds: ['archive', 'android-bundle', 'wasm', 'unknown'],
    steps: [inventory],
  },
];

export function profileForKind(kind: ArtifactKind): Profile {
  return PROFILES.find((p) => p.kinds.includes(kind)) ?? PROFILES[PROFILES.length - 1];
}

export function profileById(id: string): Profile | undefined {
  return PROFILES.find((p) => p.id === id);
}
