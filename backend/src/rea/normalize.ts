import {
  MAX_TABLE_ROWS,
  type Certainty,
  type Contribution,
  type Fact,
  type Finding,
  type SectionId,
  type Table,
} from './model.js';

/**
 * Converts REA Evidence (one CLI command result) into application sections.
 * Each normalizer reads only fields REA actually emits; the certainty of each
 * item follows REA's own `state` / `confidence` annotations.
 */

type Json = Record<string, any>;

export function certaintyFromEvidence(evidence: { state?: string; confidence?: string } | undefined | null): Certainty {
  if (!evidence) return 'inferred';
  const state = evidence.state ?? '';
  const confidence = evidence.confidence ?? '';
  if (state === 'observed') return confidence === 'low' ? 'inferred' : 'confirmed';
  if (state === 'inferred' || state === 'derived') return confidence === 'low' ? 'hypothesis' : 'inferred';
  if (state === 'unknown' || state === 'unresolved') return 'hypothesis';
  return 'inferred';
}

/** Top-level Evidence `confidence` (observed | derived | ...). */
export function certaintyFromTopLevel(confidence: unknown): Certainty {
  if (confidence === 'observed' || confidence === 'exact') return 'confirmed';
  return 'inferred';
}

class Builder {
  readonly contribution: Contribution = { sections: {}, limitations: [] };
  constructor(readonly source: string) {}

  private bucket(id: SectionId) {
    const existing = this.contribution.sections[id];
    if (existing) return existing;
    const created = { facts: [] as Fact[], tables: [] as Table[], findings: [] as Finding[] };
    this.contribution.sections[id] = created;
    return created;
  }

  fact(section: SectionId, label: string, value: unknown, certainty: Certainty): void {
    if (value === undefined || value === null || value === '') return;
    this.bucket(section).facts!.push({ label, value: display(value), certainty, source: this.source });
  }

  table(
    section: SectionId,
    title: string,
    columns: string[],
    rows: string[][],
    certainty: Certainty,
    basis: string,
    total = rows.length,
  ): void {
    if (rows.length === 0) return;
    this.bucket(section).tables!.push({
      title,
      columns,
      rows: rows.slice(0, MAX_TABLE_ROWS),
      certainty,
      total,
      truncated: rows.length > MAX_TABLE_ROWS || total > Math.min(rows.length, MAX_TABLE_ROWS),
      basis,
      source: this.source,
    });
  }

  finding(
    section: SectionId,
    title: string,
    detail: string,
    certainty: Certainty,
    basis: string,
    location: string | null = null,
  ): void {
    this.bucket(section).findings!.push({ title, detail, certainty, basis, location, source: this.source });
  }

  limitations(values: unknown): void {
    if (!Array.isArray(values)) return;
    for (const v of values) if (typeof v === 'string' && !this.contribution.limitations.includes(v)) this.contribution.limitations.push(v);
  }
}

function display(value: unknown): string {
  if (typeof value === 'string') return value.length > 2000 ? `${value.slice(0, 2000)}…` : value;
  if (typeof value === 'number' || typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (Array.isArray(value)) return value.map(display).join(', ');
  return JSON.stringify(value);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

function formatLocation(loc: any): string | null {
  const value = loc?.available ? loc.value : loc;
  if (!value || typeof value !== 'object') return null;
  if (value.source && value.start) return `${value.source}:${value.start.line}:${value.start.column}`;
  return null;
}

// ---------------------------------------------------------------- inventory

function normalizeInventory(b: Builder, evidence: Json, opts: { kind: string }): void {
  const nr = evidence.normalized_result ?? {};
  b.limitations(evidence.limitations);
  b.limitations(nr.limitations);
  const subject = nr.subject ?? {};
  b.fact('identity', 'Formato raiz (REA)', subject.root_format, 'confirmed');
  b.fact('identity', 'SHA-256', subject.root_sha256, 'confirmed');

  const inventoryStep = (nr.substeps ?? []).find((s: Json) => s.operation === 'inventory_artifact');
  const inv = inventoryStep?.evidence?.normalized_result;
  if (inv) {
    b.limitations(inv.limitations);
    const shaById = new Map<string, string>();
    for (const node of inv.nodes ?? []) shaById.set(node.artifact_id, node.sha256);
    const files = (inv.occurrences ?? []).filter((o: Json) => o.entry_kind === 'file' && o.logical_path !== '.');
    const totalBytes = files.reduce((acc: number, o: Json) => acc + (Number(o.declared_size) || 0), 0);
    b.fact('structure', 'Arquivos inventariados', files.length, 'confirmed');
    b.fact('structure', 'Tamanho declarado total', formatBytes(totalBytes), 'confirmed');
    b.fact('structure', 'Cobertura do inventário', inv.coverage_status ?? inv.coverage?.status, 'confirmed');

    // Aggregation by top-level directory (computed by this backend from REA rows).
    const groups = new Map<string, { count: number; bytes: number }>();
    for (const o of files) {
      const top = String(o.logical_path).includes('/') ? `${String(o.logical_path).split('/')[0]}/` : '(raiz)';
      const g = groups.get(top) ?? { count: 0, bytes: 0 };
      g.count += 1;
      g.bytes += Number(o.declared_size) || 0;
      groups.set(top, g);
    }
    b.table(
      'structure',
      'Distribuição por diretório de primeiro nível',
      ['Diretório', 'Arquivos', 'Tamanho'],
      [...groups.entries()].sort((a, b2) => b2[1].bytes - a[1].bytes).map(([k, g]) => [k, String(g.count), formatBytes(g.bytes)]),
      'confirmed',
      'Agregado por este backend a partir do inventário REA.',
    );
    const sorted = [...files].sort((a: Json, c: Json) => String(a.logical_path).localeCompare(String(c.logical_path)));
    b.table(
      'structure',
      'Inventário de arquivos',
      ['Caminho', 'Tamanho', 'Formato', 'Hash', 'SHA-256'],
      sorted.map((o: Json) => [
        String(o.logical_path),
        formatBytes(Number(o.declared_size)),
        String(o.artifact_format ?? o.artifact_kind ?? ''),
        String(o.hash_status ?? ''),
        shaById.get(o.artifact_id)?.slice(0, 16) ?? '',
      ]),
      'confirmed',
      'Entradas do diretório central / sistema de arquivos com hash verificado pelo REA.',
      files.length,
    );

    if (opts.kind === 'android-apk') {
      const dex = files.filter((o: Json) => /^classes\d*\.dex$/.test(o.logical_path));
      b.fact('structure', 'Arquivos DEX', dex.length, 'confirmed');
      const libs = files.filter((o: Json) => /^lib\/[^/]+\/[^/]+\.so$/.test(o.logical_path));
      b.table(
        'components',
        'Bibliotecas nativas empacotadas',
        ['ABI', 'Biblioteca', 'Tamanho'],
        libs.map((o: Json) => {
          const [, abi, name] = String(o.logical_path).split('/');
          return [abi, name, formatBytes(Number(o.declared_size))];
        }),
        'confirmed',
        'Arquivos lib/<abi>/*.so presentes no APK.',
      );
      const assets = files.filter((o: Json) => String(o.logical_path).startsWith('assets/'));
      b.fact('structure', 'Arquivos em assets/', assets.length, 'confirmed');
      const signing = files.filter((o: Json) => /^META-INF\/.*\.(RSA|DSA|EC|SF)$/i.test(o.logical_path));
      b.fact(
        'security',
        'Arquivos de assinatura v1 (META-INF)',
        signing.length > 0 ? signing.map((o: Json) => o.logical_path).join(', ') : 'nenhum',
        'confirmed',
      );
    }
    for (const c of inv.integrity_contradictions ?? []) {
      b.finding('structure', 'Contradição de integridade', display(c), 'confirmed', 'Reportado pelo inventário REA.');
    }
  }

  for (const h of nr.hypotheses ?? []) {
    b.finding('unresolved', String(h.kind ?? h.title ?? 'Hipótese do REA'), display(h.statement ?? h.summary ?? h.value ?? h), 'hypothesis', 'Hipótese estática gerada pelo REA inspect-artifact.');
  }
  for (const c of nr.contradictions ?? []) {
    b.finding('unresolved', 'Contradição observada', display(c), 'confirmed', 'Reportado pelo REA inspect-artifact.');
  }
  for (const p of nr.next_probes ?? []) {
    b.finding('unresolved', `Sondagem sugerida: ${p.operation ?? p.kind ?? 'próximo passo'}`, display(p.reason ?? p.rationale ?? p), 'hypothesis', 'Próxima sondagem sugerida pelo REA; ainda não executada.');
  }
  for (const u of nr.unexplored_branches ?? []) {
    b.finding('unresolved', 'Ramo não explorado', display(u), 'hypothesis', 'Reportado pelo REA inspect-artifact.');
  }
}

// ---------------------------------------------------------------- android

interface ManifestComponent {
  type: string;
  name: string;
  exported: string | null;
  permission: string | null;
  actions: string[];
}

const COMPONENT_TAGS = ['activity', 'activity-alias', 'service', 'receiver', 'provider'];

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`android:${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : null;
}

export function parseManifestComponents(xml: string): ManifestComponent[] {
  const out: ManifestComponent[] = [];
  const re = new RegExp(`<(${COMPONENT_TAGS.join('|')})\\b([^>]*?)(/?)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, tag, attrs, selfClosing] = m;
    let body = '';
    if (!selfClosing) {
      const end = xml.indexOf(`</${tag}>`, re.lastIndex);
      body = end >= 0 ? xml.slice(re.lastIndex, end) : '';
    }
    const actions = [...body.matchAll(/<action\b[^>]*android:name="([^"]*)"/g)].map((a) => a[1]);
    out.push({
      type: tag,
      name: attr(attrs, 'name') ?? '(sem nome)',
      exported: attr(attrs, 'exported'),
      permission: attr(attrs, 'permission'),
      actions,
    });
  }
  return out;
}

function applicationAttrs(xml: string): Record<string, string> {
  const m = /<application\b([^>]*)>/.exec(xml);
  const result: Record<string, string> = {};
  if (!m) return result;
  for (const a of m[1].matchAll(/android:(\w+)="([^"]*)"/g)) result[a[1]] = a[2];
  return result;
}

function normalizeAndroidPackage(b: Builder, evidence: Json): void {
  const nr = evidence.normalized_result ?? {};
  b.limitations(evidence.limitations);
  b.fact('identity', 'Pacote', nr.package_name, 'confirmed');
  b.fact('identity', 'Versão (versionName)', nr.version_name, 'confirmed');
  b.fact('identity', 'versionCode', nr.version_code, 'confirmed');
  b.fact('identity', 'minSdkVersion', nr.min_sdk, 'confirmed');
  b.fact('identity', 'targetSdkVersion', nr.target_sdk, 'confirmed');
  b.fact('structure', 'Classes (JADX)', nr.class_count, 'confirmed');
  b.fact('structure', 'Recursos (JADX)', nr.resource_count, 'confirmed');
  b.fact('build', 'Engine', nr.engine ? `${nr.engine.name} ${nr.engine.version}` : null, 'confirmed');
  b.fact(
    'security',
    'Verificação de assinatura APK',
    nr.signature_verification === 'not_performed' ? 'não realizada pelo provedor (autenticidade não verificada)' : nr.signature_verification,
    'confirmed',
  );
  const perms: string[] = Array.isArray(nr.permissions) ? nr.permissions : [];
  b.table(
    'permissions',
    'Permissões declaradas',
    ['Permissão'],
    perms.map((p) => [p]),
    'confirmed',
    'Declaradas no manifesto decodificado. Concessão em tempo de execução não verificada.',
  );

  const xml: string = nr.manifest?.text ?? '';
  if (xml) {
    if (nr.manifest?.status && nr.manifest.status !== 'complete') {
      b.finding('unresolved', 'Manifesto parcial', `Status do manifesto decodificado: ${nr.manifest.status}.`, 'confirmed', 'Reportado pelo REA.');
    }
    const components = parseManifestComponents(xml);
    b.table(
      'components',
      'Componentes declarados no manifesto',
      ['Tipo', 'Nome', 'exported', 'Permissão', 'Ações (intent-filter)'],
      components.map((c) => [c.type, c.name, c.exported ?? '(padrão)', c.permission ?? '', c.actions.join(', ')]),
      'confirmed',
      'Extraído pelo backend do XML do manifesto decodificado retido na Evidence REA.',
    );
    for (const c of components) {
      const implicitlyExported = c.exported === null && c.actions.length > 0;
      if ((c.exported === 'true' || implicitlyExported) && !c.permission && !c.actions.includes('android.intent.action.MAIN')) {
        b.finding(
          'security',
          `${c.type} exportado sem permissão: ${c.name}`,
          'O componente pode ser invocado por outros aplicativos. Avalie se isso é intencional; o comportamento real depende do código e não foi executado.',
          implicitlyExported ? 'inferred' : 'confirmed',
          implicitlyExported
            ? 'Exportação implícita inferida pela presença de intent-filter sem android:exported.'
            : 'Declaração android:exported="true" sem android:permission no manifesto.',
        );
      }
    }
    const app = applicationAttrs(xml);
    const flags: [string, string][] = [
      ['debuggable', 'Aplicativo depurável (android:debuggable)'],
      ['allowBackup', 'Backup permitido (android:allowBackup)'],
      ['usesCleartextTraffic', 'Tráfego em texto claro (android:usesCleartextTraffic)'],
      ['networkSecurityConfig', 'Configuração de segurança de rede'],
      ['name', 'Classe Application'],
    ];
    for (const [key, label] of flags) {
      if (app[key] !== undefined) b.fact('security', label, app[key], 'confirmed');
    }
    const features = [...xml.matchAll(/<uses-feature\b[^>]*android:name="([^"]*)"([^>]*)>/g)].map((f) => [
      f[1],
      attr(f[2], 'required') ?? '(padrão: true)',
    ]);
    b.table('components', 'Recursos de hardware/software declarados', ['Recurso', 'required'], features, 'confirmed', 'Elementos <uses-feature> do manifesto.');
  }
}

/** Well-known package prefixes -> library names. Used only for labeled inferences. */
const KNOWN_LIBRARIES: [string, string][] = [
  ['androidx.', 'AndroidX (Jetpack)'],
  ['android.support.', 'Android Support Library'],
  ['kotlin.', 'Kotlin stdlib'],
  ['kotlinx.coroutines.', 'Kotlin Coroutines'],
  ['kotlinx.serialization.', 'Kotlinx Serialization'],
  ['okhttp3.', 'OkHttp'],
  ['okio.', 'Okio'],
  ['retrofit2.', 'Retrofit'],
  ['com.squareup.moshi.', 'Moshi'],
  ['com.google.gson.', 'Gson'],
  ['com.google.firebase.', 'Firebase'],
  ['com.google.android.gms.', 'Google Play Services'],
  ['com.google.android.material.', 'Material Components'],
  ['com.google.protobuf.', 'Protocol Buffers'],
  ['dagger.', 'Dagger / Hilt'],
  ['io.reactivex.', 'RxJava'],
  ['com.bumptech.glide.', 'Glide'],
  ['coil.', 'Coil'],
  ['com.facebook.react.', 'React Native'],
  ['com.facebook.', 'Facebook SDK'],
  ['io.flutter.', 'Flutter embedding'],
  ['org.apache.cordova.', 'Apache Cordova'],
  ['com.getcapacitor.', 'Capacitor'],
  ['com.unity3d.', 'Unity'],
  ['io.sentry.', 'Sentry'],
  ['com.crashlytics.', 'Crashlytics'],
  ['org.json.', 'org.json'],
  ['net.sqlcipher.', 'SQLCipher'],
  ['io.realm.', 'Realm'],
];

function normalizeAndroidClasses(b: Builder, evidence: Json): void {
  const nr = evidence.normalized_result ?? {};
  b.limitations(evidence.limitations);
  const names: string[] = Array.isArray(nr.matches) ? nr.matches : [];
  b.fact('structure', 'Classes inventariadas', nr.total_classes ?? names.length, 'confirmed');
  b.fact('structure', 'Cobertura do inventário de classes', nr.coverage, 'confirmed');
  const packages = new Map<string, number>();
  for (const name of names) {
    const pkg = name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : '(pacote padrão)';
    packages.set(pkg, (packages.get(pkg) ?? 0) + 1);
  }
  b.table(
    'structure',
    'Pacotes Java/Kotlin',
    ['Pacote', 'Classes'],
    [...packages.entries()].sort((a, c) => c[1] - a[1]).map(([p, n]) => [p, String(n)]),
    'confirmed',
    'Agregado por este backend a partir dos nomes de classe do JADX (representações do decompilador).',
  );
  const libs = new Map<string, number>();
  for (const name of names) {
    const hit = KNOWN_LIBRARIES.find(([prefix]) => name.startsWith(prefix));
    if (hit) libs.set(hit[1], (libs.get(hit[1]) ?? 0) + 1);
  }
  b.table(
    'dependencies',
    'Bibliotecas reconhecidas por prefixo de pacote',
    ['Biblioteca', 'Classes correspondentes'],
    [...libs.entries()].sort((a, c) => c[1] - a[1]).map(([l, n]) => [l, String(n)]),
    'inferred',
    'Inferência deste backend por prefixo de nome de pacote; ofuscação ou repacotamento podem ocultar ou imitar bibliotecas. Versões não identificadas.',
  );
  if (Array.isArray(nr.duplicate_names) && nr.duplicate_names.length > 0) {
    b.finding('unresolved', 'Nomes de classe duplicados', `${nr.duplicate_names.length} nome(s) com múltiplas ocorrências.`, 'confirmed', 'Reportado pelo JADX via REA.');
  }
}

function normalizeFlutter(b: Builder, evidence: Json): void {
  const nr = evidence.normalized_result ?? {};
  b.limitations(evidence.limitations);
  if (nr.flutter_detected === false) {
    b.fact('build', 'Flutter', `não detectado (cobertura: ${nr.coverage ?? 'desconhecida'})`, 'confirmed');
    return;
  }
  b.fact('build', 'Flutter', 'detectado', 'confirmed');
  for (const [k, v] of Object.entries(nr)) {
    if (['target', 'flutter_detected', 'abis', 'coverage'].includes(k)) continue;
    if (v !== null && typeof v !== 'object') b.fact('build', `Flutter: ${k}`, v, 'confirmed');
  }
  const abis: Json[] = Array.isArray(nr.abis) ? nr.abis : [];
  b.table(
    'build',
    'Bibliotecas Flutter por ABI',
    ['ABI', 'Detalhes'],
    abis.map((a) => [String(a.abi ?? a.name ?? '?'), display(Object.fromEntries(Object.entries(a).filter(([k]) => k !== 'abi')))]),
    'confirmed',
    'Leitura estática das bibliotecas libflutter/libapp por ABI.',
  );
}

// ---------------------------------------------------------------- javascript

function obsOf(node: Json): { label: string; properties: Json; evidence: Json } {
  const o = (node.observations ?? [])[0] ?? {};
  return { label: o.label ?? '', properties: o.properties ?? {}, evidence: o.evidence ?? {} };
}

function normalizeJavascript(b: Builder, evidence: Json): void {
  const nr = evidence.normalized_result ?? {};
  b.limitations(evidence.limitations);
  b.limitations(nr.limitations);
  const graph = nr.graph ?? {};
  const nodes: Json[] = graph.nodes ?? [];
  const byKind = (kind: string) => nodes.filter((n) => n.kind === kind).map(obsOf);

  for (const pkg of byKind('package')) {
    const c = certaintyFromEvidence(pkg.evidence);
    b.fact('identity', 'Pacote (package.json)', pkg.properties.name, c);
    b.fact('identity', 'Versão', pkg.properties.version, c);
    b.fact('identity', 'Entrada principal (main)', pkg.properties.main, c);
  }
  b.fact('identity', 'Formato', nr.format, 'confirmed');
  b.fact('identity', 'SHA-256 do conteúdo', nr.root_artifact_sha256, 'confirmed');

  const stats = nr.statistics ?? {};
  b.fact('structure', 'Arquivos relevantes', stats.relevant_files, 'confirmed');
  b.fact('structure', 'Arquivos JavaScript analisados', stats.parsed_javascript_files, 'confirmed');
  b.fact('structure', 'Falhas de parsing', stats.parse_failures, 'confirmed');
  b.fact('structure', 'Contêineres ASAR aninhados', stats.nested_asar_containers, 'confirmed');
  b.fact('structure', 'Arquivos com UTF-8 inválido', stats.invalid_utf8_files, 'confirmed');
  b.fact('structure', 'Cobertura do grafo', graph.coverage?.status, 'confirmed');

  const modules = byKind('javascript-module').filter((m) => m.properties.semantic_role === 'source-module');
  b.table(
    'structure',
    'Módulos de código',
    ['Módulo', 'Formato', 'Importações', 'Exportações'],
    modules
      .sort((a, c) => String(a.properties.path).localeCompare(String(c.properties.path)))
      .map((m) => [
        String(m.properties.path ?? m.label),
        String(m.properties.module_format ?? ''),
        String(m.properties.import_relationships ?? ''),
        Array.isArray(m.properties.export_names) && m.properties.export_names.length > 0
          ? m.properties.export_names.join(', ')
          : String(m.properties.export_relationships ?? ''),
      ]),
    'confirmed',
    'Módulos com bytes inventariados e parseados pelo REA.',
  );

  const external = new Map<string, number>();
  for (const m of byKind('javascript-module')) {
    if (m.properties.semantic_role === 'module-reference' && m.properties.resolution_status === 'external') {
      const spec = String(m.properties.declared_specifier ?? m.label);
      external.set(spec, (external.get(spec) ?? 0) + 1);
    }
  }
  b.table(
    'dependencies',
    'Módulos externos referenciados',
    ['Especificador', 'Referências'],
    [...external.entries()].sort((a, c) => c[1] - a[1]).map(([s, n]) => [s, String(n)]),
    'inferred',
    'Especificadores de import/require não resolvidos dentro do artefato (dependências externas, builtins do Node ou Electron).',
  );

  const roleRows = (kind: string, label: string) =>
    byKind(kind).map((n) => [
      label,
      String(n.properties.resolved_path ?? n.properties.declared_path ?? n.label),
      String(n.properties.mechanism ?? ''),
      n.evidence.state ?? '',
    ]);
  const entrypoints = [
    ...roleRows('electron-main', 'Processo principal'),
    ...roleRows('electron-preload', 'Preload'),
    ...roleRows('electron-renderer', 'Renderer'),
  ];
  b.table(
    'electron',
    'Pontos de entrada Electron',
    ['Papel', 'Arquivo', 'Mecanismo', 'Estado REA'],
    entrypoints,
    'inferred',
    'Relações estáticas derivadas de sintaxe inerte (package.json main, webPreferences.preload, loadFile/HTML).',
  );

  const windows = byKind('browser-window');
  b.table(
    'electron',
    'Janelas (BrowserWindow) e webPreferences',
    ['Local', 'webPreferences'],
    windows.map((w) => [
      String(w.properties.source_path ?? w.label),
      (w.properties.web_preferences ?? [])
        .map((p: Json) => `${p.name}=${p.value?.status === 'literal' ? JSON.stringify(p.value.value) : (p.value?.status ?? '?')}`)
        .join('; '),
    ]),
    'confirmed',
    'Literais de objeto observados na chamada new BrowserWindow(...).',
  );
  for (const w of windows) {
    for (const p of w.properties.web_preferences ?? []) {
      const v = p.value?.status === 'literal' ? p.value.value : undefined;
      const risky =
        (p.name === 'nodeIntegration' && v === true) ||
        (p.name === 'contextIsolation' && v === false) ||
        (p.name === 'sandbox' && v === false) ||
        (p.name === 'webSecurity' && v === false);
      if (risky) {
        b.finding(
          'security',
          `webPreferences.${p.name}=${JSON.stringify(v)}`,
          `Configuração literal em ${w.properties.source_path ?? 'BrowserWindow'} que reduz o isolamento do renderer. O valor efetivo em tempo de execução não foi verificado.`,
          'confirmed',
          'Literal observado pelo REA no código-fonte.',
        );
      }
    }
  }

  const channels = byKind('ipc-channel');
  b.table(
    'electron',
    'Canais IPC',
    ['Canal', 'Lado', 'Operação', 'Resolução'],
    channels.map((c) => [String(c.properties.channel ?? c.properties.channel_expression ?? c.label), String(c.properties.side ?? ''), String(c.properties.operation ?? ''), String(c.properties.resolution ?? '')]),
    'confirmed',
    'Chamadas ipcMain/ipcRenderer observadas na AST.',
  );
  const handlers = byKind('ipc-handler');
  b.table(
    'electron',
    'Handlers IPC no processo principal',
    ['Canal', 'Modo', 'Tipo de handler', 'Linha'],
    handlers.map((h) => [String(h.properties.channel ?? h.label), String(h.properties.mode ?? ''), String(h.properties.handler_kind ?? ''), String(h.properties.handler_location?.start?.line ?? '')]),
    'confirmed',
    'Registros ipcMain.handle/on observados na AST.',
  );
  const bridges = byKind('context-bridge-api');
  b.table(
    'electron',
    'APIs expostas via contextBridge',
    ['API', 'Membros', 'Mundo'],
    bridges.map((x) => [String(x.properties.api_key ?? x.label), (x.properties.members ?? []).join(', '), String(x.properties.world ?? '')]),
    'confirmed',
    'Chamadas contextBridge.exposeInMainWorld observadas.',
  );
  const addons = nodes.filter((n) => String(n.kind).includes('native-addon')).map(obsOf);
  b.table(
    'dependencies',
    'Add-ons nativos',
    ['Add-on', 'Detalhe'],
    addons.map((a) => [a.label, display(a.properties)]),
    'inferred',
    'Relações estáticas com módulos .node.',
  );

  const summary = nr.summary ?? {};
  if (summary.ipc) {
    b.fact('electron', 'Operações IPC', summary.ipc.operations, 'inferred');
    b.fact('electron', 'Canais literais', summary.ipc.literal_channels, 'inferred');
    b.fact('electron', 'Operações com canal dinâmico', summary.ipc.dynamic_channel_operations, 'inferred');
    b.fact('electron', 'Transmissões do renderer sem par', summary.ipc.unpaired_literal_renderer_transmissions, 'inferred');
  }
  b.fact('electron', 'Observações de validação de remetente', summary.sender_validation_observations, 'inferred');
  b.fact('electron', 'Utility processes', summary.utility_processes, 'inferred');

  for (const c of nr.integrity_contradictions ?? []) {
    b.finding('unresolved', 'Contradição de integridade', display(c), 'confirmed', 'Reportado pelo REA.');
  }
  const unknowns: Json[] = nr.semantic_graph?.unknowns ?? [];
  const byReason = new Map<string, number>();
  for (const u of unknowns) byReason.set(`${u.family}/${u.reason}`, (byReason.get(`${u.family}/${u.reason}`) ?? 0) + 1);
  b.table(
    'unresolved',
    'Pontos não resolvidos do grafo semântico (por família/motivo)',
    ['Família / motivo', 'Ocorrências'],
    [...byReason.entries()].sort((a, c) => c[1] - a[1]).map(([k, n]) => [k, String(n)]),
    'hypothesis',
    'Unknowns reportados pelo grafo semântico do REA; não são falhas, e sim fluxos que a análise estática não pôde provar.',
  );
  for (const u of unknowns.slice(0, 40)) {
    b.finding('unresolved', `Não resolvido: ${u.family} (${u.reason})`, String(u.detail ?? ''), 'hypothesis', 'Unknown do grafo semântico REA.', formatLocation(u.evidence?.location));
  }
}

// ---------------------------------------------------------------- go / generic

function normalizeGo(b: Builder, evidence: Json): void {
  const nr = evidence.normalized_result ?? {};
  b.limitations(evidence.limitations);
  b.limitations(nr.limitations);
  b.fact('identity', 'Formato', nr.format, 'confirmed');
  b.fact('identity', 'Arquitetura', nr.architecture, 'confirmed');
  const info = nr.build_info;
  if (!info) {
    b.fact('build', 'Metadados de build Go', 'não encontrados (não prova que o binário não seja Go)', 'confirmed');
    return;
  }
  b.fact('build', 'Versão do compilador Go', info.go_version, 'confirmed');
  const lines = String(info.module_text ?? '').split('\n');
  const deps: string[][] = [];
  const settings: string[][] = [];
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts[0] === 'path') b.fact('build', 'Pacote principal', parts[1], 'confirmed');
    if (parts[0] === 'mod') b.fact('build', 'Módulo principal', `${parts[1]} ${parts[2] ?? ''}`.trim(), 'confirmed');
    if (parts[0] === 'dep') deps.push([parts[1] ?? '', parts[2] ?? '']);
    if (parts[0] === '=>') deps[deps.length - 1]?.push(`substituído por ${parts[1]} ${parts[2] ?? ''}`.trim());
    if (parts[0] === 'build') settings.push((parts[1] ?? '').split('=', 2) as string[]);
  }
  b.table('dependencies', 'Módulos Go embutidos', ['Módulo', 'Versão', 'Substituição'], deps.map((d) => [d[0], d[1], d[2] ?? '']), 'confirmed', 'Informação de build embutida pelo toolchain Go (runtime/debug.BuildInfo).');
  b.table('build', 'Configurações de build Go', ['Chave', 'Valor'], settings.map((s) => [s[0] ?? '', s[1] ?? '']), 'confirmed', 'Linhas "build" do BuildInfo embutido.');
}

function normalizeRust(b: Builder, evidence: Json): void {
  const nr = evidence.normalized_result ?? {};
  b.limitations(evidence.limitations);
  b.limitations(nr.limitations);
  b.fact('build', 'Commit do rustc', nr.rustc_commit, 'confirmed');
  const meta = nr.auditable_metadata;
  if (!meta) {
    b.fact('build', 'Lista cargo-auditable (.dep-v0)', 'ausente (não prova ausência de dependências Rust)', 'confirmed');
    return;
  }
  const packages: Json[] = Array.isArray(meta.packages) ? meta.packages : [];
  const root = typeof meta.root_package_index === 'number' ? packages[meta.root_package_index] : null;
  if (root) b.fact('build', 'Crate raiz', `${root.name} ${root.version}`, 'confirmed');
  b.table(
    'dependencies',
    'Crates Rust embutidos (cargo-auditable)',
    ['Crate', 'Versão', 'Origem', 'Tipo', 'Dependências'],
    packages.map((p) => [String(p.name), String(p.version), String(p.source ?? ''), String(p.kind ?? ''), String((p.dependencies ?? []).length)]),
    'confirmed',
    'Seção .dep-v0 embutida no binário. Conteúdo do arquivo: não autentica nomes, versões ou origens.',
  );
}

/** Fallback for commands without a dedicated mapping: scalar facts + object arrays as tables. */
function generic(b: Builder, evidence: Json, section: SectionId): void {
  const nr = evidence.normalized_result ?? {};
  b.limitations(evidence.limitations);
  const certainty = certaintyFromTopLevel(evidence.confidence);
  const walk = (obj: Json, prefix: string, depth: number) => {
    for (const [key, value] of Object.entries(obj)) {
      if (/base64|_bytes_hex|raw/i.test(key)) continue;
      const label = prefix ? `${prefix}.${key}` : key;
      if (value === null || value === undefined) continue;
      if (typeof value !== 'object') {
        b.fact(section, label, value, certainty);
      } else if (Array.isArray(value)) {
        if (value.length === 0) continue;
        if (value.every((v) => v === null || typeof v !== 'object')) {
          b.table(section, label, ['Valor'], value.map((v) => [display(v)]), certainty, `Campo ${label} da Evidence REA.`);
        } else {
          const cols = [...new Set(value.slice(0, 50).flatMap((v: Json) => Object.keys(v ?? {}).filter((k) => typeof v[k] !== 'object' || v[k] === null)))].slice(0, 6);
          if (cols.length > 0) {
            b.table(section, label, cols, value.map((v: Json) => cols.map((c) => display(v?.[c] ?? ''))), certainty, `Campo ${label} da Evidence REA.`);
          }
        }
      } else if (depth < 2) {
        walk(value as Json, label, depth + 1);
      }
    }
  };
  walk(nr, '', 0);
}

// ---------------------------------------------------------------- dispatcher

export function normalizeEvidence(command: string, stepKey: string, evidence: unknown, opts: { kind: string }): Contribution {
  const b = new Builder(stepKey);
  const ev = (evidence ?? {}) as Json;
  switch (command) {
    case 'inspect-artifact':
      normalizeInventory(b, ev, opts);
      break;
    case 'inspect-android-package':
      normalizeAndroidPackage(b, ev);
      break;
    case 'search-android-classes':
      normalizeAndroidClasses(b, ev);
      break;
    case 'identify-flutter-build':
      normalizeFlutter(b, ev);
      break;
    case 'analyze-javascript-application':
      normalizeJavascript(b, ev);
      break;
    case 'inspect-go-binary':
      normalizeGo(b, ev);
      break;
    case 'inspect-rust-binary':
      normalizeRust(b, ev);
      break;
    case 'inspect-managed-artifact':
      generic(b, ev, 'identity');
      break;
    case 'inspect-managed-native-boundaries':
      generic(b, ev, 'components');
      break;
    case 'inspect-managed-members':
      generic(b, ev, 'structure');
      break;
    default:
      generic(b, ev, 'structure');
  }
  return b.contribution;
}
