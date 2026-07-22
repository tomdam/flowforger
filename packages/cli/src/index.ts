#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, extname, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { emitLogicAppsJson } from '@flowforger/emitter-logicapps';
import { validateFlowIR, validateLogicApps } from '@flowforger/validator';
import type { FlowIR, FlowForgerConfig, ChildFlowDefinition, ChildFlowParameter } from '@flowforger/ir';
import { parseConfigFromJson, DEFAULT_CONFIG } from '@flowforger/ir';
import { run as runEngine, WorkflowLoader, type FileArtifact } from '@flowforger/engine';
import { HttpConnector } from '@flowforger/connectors-http';
import { DataverseClient } from '@flowforger/dataverse-sdk';
import { parseLogicAppsToIR, generateNativeDslFromIR } from '@flowforger/dsl-native';
import { getDiagnostics, getDiagnosticCounts, type Diagnostic } from '@flowforger/dsl-language-service';
import { resolveRequiredScopes, acquireTokens, acquireFlowServiceToken, fetchTriggerCallbackUrl, flowUsesListCallbackUrl, type AuthConfig } from './auth.js';
import { checkParity, ParityTransformError } from './parity.js';

/**
 * Resolve the CLI's own package root (one level above dist/), working in both
 * the dev ESM build and the installed CJS bundle.
 *
 * Node resolves symlinks for both `__dirname` and `import.meta.url`, so this
 * points at the real file inside node_modules even when the `flowforger` bin is
 * a symlink on PATH. (process.argv[1] keeps the symlink path, which broke the
 * lookup on a global install and made `--version` report "unknown".)
 *
 * The installed CJS bundle provides `__dirname` natively; the ESM dev build does
 * not, so we fall back to `import.meta.url` there. esbuild empties `import.meta`
 * in the CJS bundle, but that branch is never taken when `__dirname` is defined.
 */
function moduleDir(): string {
  return typeof __dirname !== 'undefined'
    ? __dirname
    : dirname(fileURLToPath(import.meta.url));
}

function cliPackageRoot(): string {
  return resolve(moduleDir(), '..');
}

// Baked in at bundle time by esbuild (see esbuild.config.mjs). Undefined in the
// dev tsc build, where we fall back to reading package.json — the ESM entry
// always runs from its real path, so the lookup is reliable there.
declare const __CLI_VERSION__: string | undefined;

function cliVersion(): string {
  if (typeof __CLI_VERSION__ !== 'undefined') return __CLI_VERSION__;
  try {
    const pkg = JSON.parse(readFileSync(join(cliPackageRoot(), 'package.json'), 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Load FlowForger configuration from file.
 * Supports global/environments structure and applies environment overlay.
 */
function loadConfig(configPath: string, environment?: string): FlowForgerConfig {
  const raw = JSON.parse(readFileSync(resolve(configPath), 'utf-8'));
  return parseConfigFromJson(raw, environment);
}

/**
 * Build config from CLI flags.
 * CLI flags override values from config file.
 */
function buildConfigFromFlags(args: Record<string, any>, baseConfig?: FlowForgerConfig): FlowForgerConfig {
  const config: FlowForgerConfig = baseConfig ? { ...baseConfig } : { ...DEFAULT_CONFIG };

  // Generator flags
  if (args['multiline-preserve'] !== undefined) {
    config.generator = { ...config.generator, multilineExpressions: 'preserve' };
  }
  if (args['multiline-flatten'] !== undefined) {
    config.generator = { ...config.generator, multilineExpressions: 'flatten' };
  }
  if (args['whitespace-spaced'] !== undefined) {
    config.generator = { ...config.generator, argumentWhitespace: 'spaced' };
  }
  if (args['whitespace-compact'] !== undefined) {
    config.generator = { ...config.generator, argumentWhitespace: 'compact' };
  }
  if (args['description-jsdoc'] !== undefined) {
    config.generator = { ...config.generator, descriptionStyle: 'jsdoc' };
  }
  if (args['description-comment'] !== undefined) {
    config.generator = { ...config.generator, descriptionStyle: 'lineComment' };
  }

  // Parity flags
  if (args['ignore-whitespace'] !== undefined) {
    config.parity = { ...config.parity, ignoreWhitespace: true };
  }
  if (args['ignore-runafter'] !== undefined) {
    config.parity = { ...config.parity, ignoreEmptyRunAfter: true };
  }
  if (args['ignore-metadata'] !== undefined) {
    config.parity = { ...config.parity, ignoreMetadata: true };
  }

  // Parser flags
  if (args['skip-metadata-fields'] !== undefined) {
    // Accept comma-separated list of field names
    const fields = String(args['skip-metadata-fields']).split(',').map(s => s.trim()).filter(s => s);
    config.parser = { ...config.parser, skipMetadataFields: fields };
  }
  if (args['skip-action-names-for-kinds'] !== undefined) {
    // Accept comma-separated list of action kinds (lowercase)
    const kinds = String(args['skip-action-names-for-kinds']).split(',').map(s => s.trim().toLowerCase()).filter(s => s);
    config.parser = { ...config.parser, skipActionNamesForKinds: kinds };
  }

  return config;
}

/**
 * Resolve the emitter config object (global + environment overlay) consumed by
 * `emitLogicAppsJson`. Returns undefined when no config path is available.
 *
 * - With no `defaultPath`, a config is loaded only when `--config` is passed,
 *   and a missing file throws (compile semantics).
 * - With a `defaultPath`, a missing file is tolerated and yields undefined
 *   (push semantics, which falls back to flowforger.config.json).
 */
function loadEmitterConfig(args: Record<string, any>, defaultPath?: string): any {
  const configPath = (args.config as string) || defaultPath;
  if (!configPath) return undefined;
  const resolved = resolve(configPath);
  if (defaultPath && !existsSync(resolved)) return undefined;
  const raw = JSON.parse(readFileSync(resolved, 'utf-8'));
  if (raw && raw.environments && args['config-env']) {
    return { ...(raw.global || {}), ...(raw.environments[args['config-env'] as string] || {}) };
  }
  return raw.global || raw;
}

/**
 * Load and validate the `auth` section from the config file for `--auth`.
 * Throws a helpful message when the file or the `auth` section is missing.
 */
function loadAuthConfig(args: Record<string, any>): AuthConfig {
  const configPath = (args['config'] as string) || 'flowforger.config.json';
  let raw: any;
  try {
    raw = JSON.parse(readFileSync(resolve(configPath), 'utf-8'));
  } catch {
    throw new Error(`--auth requires a config file. Not found: ${configPath}`);
  }
  if (!raw.auth) {
    throw new Error(`--auth requires an 'auth' section in ${configPath}`);
  }
  return raw.auth as AuthConfig;
}

/**
 * Acquire a Dataverse token via `--auth` for the pull/push commands.
 * Resolves the Dataverse resource from `--url` or auth config, then acquires a
 * user_impersonation token when one isn't already supplied.
 */
async function acquireDataverseAuth(
  args: Record<string, any>,
  url: string | undefined,
  token: string,
  cmd: 'pull' | 'push',
): Promise<{ url: string; token: string }> {
  const authConfig = loadAuthConfig(args);
  // --url overrides config's dataverse resource for both URL and token scope
  const dvResource = url || authConfig.resources?.dataverse;
  if (!dvResource) {
    throw new Error(`--auth for ${cmd} requires --url or auth.resources.dataverse in config`);
  }
  if (!url) url = dvResource;
  // Ensure authConfig.resources.dataverse matches the target URL so
  // acquireTokens maps the token to the correct slot.
  if (!authConfig.resources) authConfig.resources = {};
  authConfig.resources.dataverse = dvResource;
  if (!token) {
    const scopes = new Map([[dvResource, [`${dvResource}/user_impersonation`]]]);
    const tokens = await acquireTokens(authConfig, scopes, (msg) => console.error(msg));
    if (tokens.dataverse) token = tokens.dataverse;
  }
  return { url, token };
}

function help() {
  console.log(`FlowForger CLI

Usage:
  flowforger compile <input.ff.ts|input.ir.json> --out <output> [--emit logicapps] [--config flowforger.config.json] [--config-env <envName>]
  flowforger validate <file.json|file.ff.ts>
  flowforger run <input.ir.json|input.ff.ts> [--in payload.json]
                    [--pretty | --json]  (default: pretty on a terminal, JSON when piped)
                    [--vars vars.json] [--var k=v] [--param k=v]
                    [--auth] [--config flowforger.config.json]
                    [--sp-token <sharepoint-token>]
                    [--dv-url <dataverse-url> --dv-token <dataverse-token>]
                    [--graph-token <graph-token>]
                    [--word-token <graph-token>]
                    [--excel-token <graph-token>]
                    [--onedrive-token <graph-token>]
                    [--flow-id <guid>] [--environment-id <guid>] [--trigger-name <name>] [--flow-token <token>]
                    [--workflows-config <config.json>]
                    [--workflows-dir <directory>]
                    [--strict-workflows]
                    [--cache-workflows]
  flowforger pull (--id <workflowid> | --name <flowName> | --all | --solution <uniqueName>) --url <dataverseUrl> [--token <token> | --auth]
                    [--out <path>] [--json] [--config <config.json>]
                    [--no-children]
  --token accepts a Dataverse AAD token (audience = the environment URL); DATAVERSE_TOKEN env var also works. --auth uses the config's auth section.
  flowforger push [--id <workflowid>] --file <flow.ff.ts|clientdata.json> --url <dataverseUrl> [--token <token>] [--auth] [--config flowforger.config.json]
  --id is optional when the DSL has \`workflowId\` in @Flow({...}); explicit --id always wins.
  flowforger activate --id <workflowid> --url <dataverseUrl> [--token <token>] --state <statecode> --status <statuscode>
  flowforger generate-dsl --in <clientdata.json> --out <flow.ff.ts> [--name <flowName>] [--config <config.json>]
  flowforger parity --in <clientdata.json> [--name <flowName>] [--config <config.json>] [--ignore-whitespace]
  flowforger sp-discover --token <graph-token> [--site <site-url>] [--list <list-name>]
  flowforger optimize <input.ff.ts> [--out <output.ff.ts>] [--report <report.json>]
  flowforger init --url <dataverseUrl> --client-id <azureAdClientId> [--tenant-id <id>] [--sp-url <sharepointUrl>] [--out <config.json>]
  flowforger skills install [--dir <targetDir>] [--bundled] [--repo <owner/repo>] [--ref <branch>] [--path <repoPath>]

Config Options:
  --config <file>           Path to flowforger.config.json (optional)
  --config-env <name>       Environment name to use from config (optional)

Generator Options (for generate-dsl, parity):
  --multiline-preserve      Preserve multiline expression formatting (default)
  --multiline-flatten       Flatten multiline expressions to single line
  --whitespace-spaced       Use spaces after commas: func(a, b) (default)
  --whitespace-compact      No spaces after commas: func(a,b)
  --description-comment     Render action descriptions as // line comments (default)
  --description-jsdoc       Render action descriptions as /** @description ... */ tags

Parity Options:
  --ignore-whitespace       Ignore whitespace differences in expressions
  --ignore-runafter         Ignore empty runAfter differences
  --ignore-metadata         Ignore metadata field differences (default: true)

Parser Options (for generate-dsl, parity):
  --skip-metadata-fields <fields>        Comma-separated metadata fields to skip (e.g., operationMetadataId)
  --skip-action-names-for-kinds <kinds>  Comma-separated action kinds to skip names for (e.g., initializevariable,setvariable)

Optimize Options:
  --out <file>                  Output file (default: input.optimized.ts)
  --report <file>               Write JSON optimization report to file
  --no-variable-to-compose      Disable single-set variable to compose optimization
  --no-loop-variable-to-compose Disable loop variable to compose optimization
  --no-append-to-select         Disable append-to-array to select optimization
  --no-parallelism-warnings     Disable parallelism warnings

Init Options (for init):
  --url <dataverseUrl>      Dataverse environment URL (required)
  --client-id <id>          Azure AD app registration client ID (required)
  --tenant-id <id>          Azure AD tenant ID (auto-discovered if omitted)
  --sp-url <url>            SharePoint root URL (e.g., https://tenant.sharepoint.com) (optional)
  --out <file>              Output file path (default: flowforger.config.json)
  --skip-discovery          Skip connection reference discovery (just generate template)

Skills Options (for skills install):
  --dir <targetDir>         Where to copy the agent skills (default: .claude/skills)
                            Use --dir skills for the agent-agnostic top-level layout
  --bundled                 Install the skills bundled with this CLI instead of
                            fetching the latest from GitHub (offline use)
  --repo <owner/repo>       GitHub repo to fetch skills from (default: tomdam/flowforger)
  --ref <branch>            Git ref to fetch (default: main)
  --path <repoPath>         Folder inside the repo containing the skills (default: skills)

Notes:
  - compile accepts .ff.ts (DSL) or .ir.json input. Default output is Flow IR — pass --emit logicapps for Power Automate clientdata.json.
  - validate auto-detects format: .ff.ts/.ts files run DSL diagnostics, .json auto-detects IR vs Logic Apps.
  - parity is strict only for supported constructs (http trigger/actions); control nodes are flattened, so parity is informational.
  - sp-discover discovers SharePoint sites and lists using Microsoft Graph API:
    * No --site: List all sites
    * With --site: List all lists in the site
    * With --site and --list: Search for specific list by name
  - --sp-token requires a SharePoint access token (resource: https://tenant.sharepoint.com)
    * NOT a Microsoft Graph token - must be specific to SharePoint REST API
    * Token is used for SharePoint connector operations (GetItems, CreateItem, etc.)
  - --graph-token requires a Microsoft Graph token (resource: https://graph.microsoft.com)
    * Used for Office 365 connector operations (SendEmail, GetEmails, CreateEvent, etc.)
    * Requires appropriate Graph API permissions (Mail.Send, Calendars.ReadWrite, etc.)
  - --word-token requires a Microsoft Graph token (resource: https://graph.microsoft.com)
    * Used for Word Online (Business) connector operations (PopulateWordTemplate, ConvertToPdf)
    * Requires appropriate Graph API permissions (Files.ReadWrite.All for OneDrive/SharePoint)
    * Can use the same token as --graph-token if both Office 365 and Word Online operations are needed
  - --excel-token requires a Microsoft Graph token (resource: https://graph.microsoft.com)
    * Used for Excel Online (Business) connector operations (ListRows, AddRow, UpdateRow, etc.)
    * Requires appropriate Graph API permissions (Files.ReadWrite.All for OneDrive/SharePoint)
    * Can use the same token as --graph-token if multiple Office connectors are needed
  - --onedrive-token requires a Microsoft Graph token (resource: https://graph.microsoft.com)
    * Used for OneDrive for Business connector operations (CreateFile, ConvertFile, DeleteFile, etc.)
    * Requires Graph API permissions (Files.ReadWrite)
    * Can use the same token as --graph-token if multiple Graph connectors are needed
  - Pull modes:
    * --id / --name: Pull a single flow (--out is a file path, default: <flowName>.ff.ts)
    * --all: Pull all flows from the environment (--out is a directory, default: cwd)
    * --solution <uniqueName>: Pull all flows in a solution (--out is a directory, default: cwd)
    * --json: Output raw clientdata JSON instead of DSL
    * --no-children: Skip child workflow resolution. In single-flow mode this also skips the recursive fetch; in --solution/--all mode callWorkflow actions keep raw GUIDs instead of names.
  - Child workflow execution (run command):
    * --workflows-config: Path to workflow mapping config (maps GUIDs to IR file paths)
    * --workflows-dir: Directory for convention-based lookup (default: ./flows/)
    * --strict-workflows: Fail on missing or erroring child workflows (default: false)
    * --cache-workflows: Save Dataverse-fetched workflows to disk cache
`);
}

const GITHUB_FETCH_TIMEOUT_MS = 15_000;

async function githubJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'flowforger-cli', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GitHub API returned ${res.status} for ${url}`);
  return res.json();
}

/**
 * Downloads every skill folder under `repoPath` in the given GitHub repo into
 * `targetRoot`. Returns the installed skill names. Throws on any network or
 * API error — the caller decides whether to fall back to bundled skills.
 *
 * Uses the git trees API (one rate-limited request for the whole file list)
 * plus raw.githubusercontent.com for file contents (not rate-limited).
 * Downloads are staged in a temp dir and only copied into `targetRoot` once
 * everything succeeded, so a failed fetch never leaves partial skills behind.
 */
async function installSkillsFromGitHub(
  repo: string,
  ref: string,
  repoPath: string,
  targetRoot: string
): Promise<string[]> {
  const data = (await githubJson(
    `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`
  )) as { tree?: Array<{ path: string; type: string }>; truncated?: boolean };
  if (!Array.isArray(data.tree)) throw new Error(`unexpected git tree response from ${repo}@${ref}`);
  if (data.truncated) throw new Error(`repo tree for ${repo}@${ref} is too large (truncated response)`);

  const prefix = repoPath.replace(/\/+$/, '') + '/';
  const files = data.tree.filter((e) => e.type === 'blob' && e.path.startsWith(prefix));
  if (files.length === 0) throw new Error(`no files found under '${repoPath}' in ${repo}@${ref}`);

  const staging = mkdtempSync(join(tmpdir(), 'flowforger-skills-'));
  try {
    const skillNames = new Set<string>();
    for (const file of files) {
      const rel = file.path.slice(prefix.length);
      const segments = rel.split('/');
      if (segments.length < 2) continue; // loose file directly under repoPath, not part of a skill folder
      skillNames.add(segments[0]);
      const dest = join(staging, rel);
      mkdirSync(dirname(dest), { recursive: true });
      const rawUrl = `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${file.path
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`;
      const res = await fetch(rawUrl, {
        headers: { 'User-Agent': 'flowforger-cli' },
        signal: AbortSignal.timeout(GITHUB_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`download failed (${res.status}) for ${file.path}`);
      writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
    }
    if (skillNames.size === 0) throw new Error(`no skill folders found under '${repoPath}' in ${repo}@${ref}`);

    mkdirSync(targetRoot, { recursive: true });
    for (const name of skillNames) {
      cpSync(join(staging, name), join(targetRoot, name), { recursive: true });
    }
    return [...skillNames].sort();
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function parseArgs(argv: string[]): Record<string, any> {
  const args: Record<string, any> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? (argv[++i] as string) : true;
      if (args[key] === undefined) args[key] = val;
      else if (Array.isArray(args[key])) (args[key] as any[]).push(val);
      else args[key] = [args[key], val];
    } else if (!args['_']) {
      args['_'] = a;
    }
  }
  return args;
}

// ── Pretty trace rendering for `run` ─────────────────────────────────────────

const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const clr = {
  green: paint('32'),
  red: paint('31'),
  yellow: paint('33'),
  cyan: paint('36'),
  dim: paint('2'),
  bold: paint('1'),
};

function summarizeValue(value: any, max = 100): string {
  if (value === undefined || value === null) return '';
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === '{}' || s === '[]') return '';
  if (s.length > max) s = s.slice(0, max - 1) + '…';
  return s;
}

function traceStatusIcon(status: string): string {
  if (status === 'Succeeded') return clr.green('✓');
  if (status === 'Failed') return clr.red('✗');
  if (status === 'Skipped') return clr.dim('↷');
  return ' ';
}

function printTraceEntry(entry: any, indent: number): void {
  const pad = '  '.repeat(indent);
  const kind = typeof entry.nodeId === 'string' ? entry.nodeId.split('_')[0] : '';

  if (kind === 'trg') {
    console.log(`${pad}${clr.yellow('⚡')} ${clr.bold(entry.name)} ${clr.dim('(trigger)')}`);
    return;
  }

  if (kind === 'if' && entry.outputs && 'conditionResult' in entry.outputs) {
    const branch = entry.outputs.branchTaken === 'elseActions' ? 'else' : 'then';
    console.log(
      `${pad}${traceStatusIcon(entry.status)} ${clr.bold(entry.name)} ${clr.dim(`condition → ${entry.outputs.conditionResult} (${branch} branch)`)}`
    );
    return;
  }

  if (Array.isArray(entry.iterations)) {
    const n = entry.iterations.length;
    console.log(
      `${pad}${traceStatusIcon(entry.status)} ${clr.bold(entry.name)} ${clr.dim(`— ${n} iteration${n === 1 ? '' : 's'}`)}`
    );
    for (const it of entry.iterations) {
      const label = it.item !== undefined ? summarizeValue(it.item, 40) : `#${it.index}`;
      console.log(`${pad}  ${clr.cyan(`[${it.index + 1}/${n}]`)} ${clr.dim(label)}`);
      for (const a of it.actions ?? []) printTraceEntry(a, indent + 2);
    }
    return;
  }

  const out = summarizeValue(entry.outputs);
  console.log(
    `${pad}${traceStatusIcon(entry.status)} ${clr.bold(entry.name)}${out ? ` ${clr.dim('→ ' + out)}` : ''}`
  );
  if (entry.status === 'Failed' && entry.error) {
    const msg =
      entry.error instanceof Error
        ? entry.error.message
        : typeof entry.error === 'string'
          ? entry.error
          : summarizeValue(entry.error, 200);
    console.log(`${pad}  ${clr.red(msg)}`);
  }
}

function countTraceActions(entries: any[]): number {
  let n = 0;
  for (const e of entries ?? []) {
    if (typeof e.nodeId === 'string' && e.nodeId.startsWith('trg_')) continue;
    n++;
    for (const it of e.iterations ?? []) n += countTraceActions(it.actions);
  }
  return n;
}

function printPrettyRunResult(flowName: string, result: any): void {
  console.log('');
  console.log(clr.bold(`▶ ${flowName}`));
  console.log('');
  for (const entry of result.trace ?? []) printTraceEntry(entry, 1);
  console.log('');
  const n = countTraceActions(result.trace ?? []);
  if (result.status === 'Succeeded') {
    console.log(`${clr.green(clr.bold('✓ Flow succeeded'))} ${clr.dim(`— ${n} action${n === 1 ? '' : 's'} executed`)}`);
  } else {
    const msg = result.error instanceof Error ? result.error.message : result.error ? String(result.error) : '';
    console.log(`${clr.red(clr.bold('✗ Flow failed'))}${msg ? ` ${clr.dim('— ' + msg)}` : ''}`);
  }
  console.log('');
}

interface SharePointSite {
  id: string;
  name: string;
  displayName: string;
  webUrl: string;
}

interface SharePointList {
  id: string;
  name: string;
  displayName: string;
  list?: { template: string };
}

async function discoverSharePoint(token: string, siteUrl?: string, listName?: string): Promise<void> {
  const graphBase = 'https://graph.microsoft.com/v1.0';

  try {
    if (!siteUrl) {
      // List all sites
      console.log('\n=== Discovering SharePoint Sites ===\n');
      const sitesRes = await fetch(`${graphBase}/sites?search=*`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!sitesRes.ok) {
        const error = await sitesRes.text();
        throw new Error(`Failed to fetch sites: ${sitesRes.status} ${error}`);
      }

      const sitesData = await sitesRes.json();
      const sites: SharePointSite[] = sitesData.value;

      console.log(`Found ${sites.length} sites:\n`);
      sites.forEach((site, idx) => {
        console.log(`${idx + 1}. ${site.displayName}`);
        console.log(`   ID: ${site.id}`);
        console.log(`   URL: ${site.webUrl}`);
        console.log('');
      });

      console.log('\nTo discover lists in a site, run:');
      console.log('  flowforger sp-discover --token <token> --site <site-url>');
    } else {
      // Get site ID from URL
      const siteHost = new URL(siteUrl).hostname;
      const sitePath = new URL(siteUrl).pathname;

      console.log(`\n=== Getting Site ID for ${siteUrl} ===\n`);

      const siteRes = await fetch(`${graphBase}/sites/${siteHost}:${sitePath}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!siteRes.ok) {
        const error = await siteRes.text();
        throw new Error(`Failed to fetch site: ${siteRes.status} ${error}`);
      }

      const site = await siteRes.json();
      console.log(`Site: ${site.displayName}`);
      console.log(`Site ID: ${site.id}\n`);

      // List all lists in the site
      console.log('=== Lists in Site ===\n');

      const listsRes = await fetch(`${graphBase}/sites/${site.id}/lists`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!listsRes.ok) {
        const error = await listsRes.text();
        throw new Error(`Failed to fetch lists: ${listsRes.status} ${error}`);
      }

      const listsData = await listsRes.json();
      const lists: SharePointList[] = listsData.value;

      if (listName) {
        // Filter to specific list
        const matchingLists = lists.filter(
          (l) =>
            l.name.toLowerCase().includes(listName.toLowerCase()) ||
            l.displayName.toLowerCase().includes(listName.toLowerCase())
        );

        if (matchingLists.length === 0) {
          console.log(`No lists found matching "${listName}"`);
        } else {
          console.log(`Found ${matchingLists.length} matching list(s):\n`);
          matchingLists.forEach((list, idx) => {
            console.log(`${idx + 1}. ${list.displayName}`);
            console.log(`   ID: ${list.id}`);
            console.log(`   Name: ${list.name}`);
            if (list.list?.template) console.log(`   Type: ${list.list.template}`);
            console.log('');
          });
        }
      } else {
        // Show all lists
        console.log(`Found ${lists.length} lists:\n`);
        lists.forEach((list, idx) => {
          console.log(`${idx + 1}. ${list.displayName}`);
          console.log(`   ID: ${list.id}`);
          console.log(`   Name: ${list.name}`);
          if (list.list?.template) console.log(`   Type: ${list.list.template}`);
          console.log('');
        });
      }

      // Output usage example
      console.log('\n=== Usage in Flow IR ===\n');
      if (listName && lists.find((l) => l.displayName.toLowerCase().includes(listName.toLowerCase()))) {
        const targetList = lists.find((l) => l.displayName.toLowerCase().includes(listName.toLowerCase()))!;
        console.log(
          JSON.stringify(
            {
              id: 'con_1',
              type: 'connector',
              name: 'GetItems',
              connector: 'sharepoint',
              operation: 'GetItems',
              params: {
                siteId: site.id,
                listId: targetList.id,
                top: 10,
              },
            },
            null,
            2
          )
        );
      } else {
        console.log('Select a list and use its siteId and listId in your flow IR:');
        console.log('  siteId: ' + site.id);
        console.log('  listId: <list-id-from-above>');
      }
    }
  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(cliVersion());
    return;
  }

  switch (cmd) {
    case 'compile': {
      const input = args._ as string;
      if (!input) return help();
      const inputExt = extname(input).toLowerCase();

      // Auto-detect: .ts/.ff.ts → DSL compile, .json → IR compile
      if (inputExt === '.ts') {
        // DSL → IR (or Logic Apps JSON with --emit logicapps)
        const out = (args.out as string) || (args.emit === 'logicapps' ? 'clientdata.json' : 'flow.ir.json');
        const { transformFile } = await import('@flowforger/dsl-native');
        const ir = await transformFile(resolve(input));

        if (args.emit === 'logicapps') {
          const cfg = loadEmitterConfig(args);
          const def = emitLogicAppsJson(ir, cfg);
          writeFileSync(resolve(out), JSON.stringify(def, null, 2));
          console.log(`Wrote Logic Apps JSON to ${out}`);
        } else {
          writeFileSync(resolve(out), JSON.stringify(ir, null, 2));
          console.log(`Wrote IR to ${out}`);
        }
      } else {
        // IR JSON → Logic Apps JSON
        const out = (args.out as string) || 'clientdata.json';
        const ir: FlowIR = JSON.parse(readFileSync(resolve(input), 'utf-8'));
        const cfg = loadEmitterConfig(args);
        const def = emitLogicAppsJson(ir, cfg);
        writeFileSync(resolve(out), JSON.stringify(def, null, 2));
        console.log(`Wrote ${out}`);
      }
      break;
    }
    case 'validate': {
      const file = args._ as string;
      if (!file) return help();
      const filePath = resolve(file);
      const ext = extname(filePath).toLowerCase();

      if (ext === '.ts') {
        // DSL validation — run the same diagnostics as Monaco / VS Code extension
        const code = readFileSync(filePath, 'utf-8');
        const diagnostics = getDiagnostics(code);
        const counts = getDiagnosticCounts(diagnostics);
        const hasErrors = counts.error > 0;

        if (diagnostics.length === 0) {
          console.log('✓ No issues found.');
          process.exit(0);
        }

        // Sort by line number
        diagnostics.sort((a: Diagnostic, b: Diagnostic) => a.range.start.line - b.range.start.line);

        // Print diagnostics in a readable format
        for (const d of diagnostics) {
          const line = d.range.start.line + 1;
          const col = d.range.start.character + 1;
          const sev = d.severity.toUpperCase();
          console.log(`${file}:${line}:${col} ${sev} [${d.code}] ${d.message}`);
        }

        console.log(`\n${diagnostics.length} issue(s): ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info, ${counts.hint} hint(s)`);
        process.exit(hasErrors ? 1 : 0);
      } else {
        // JSON validation (IR or Logic Apps)
        const json = JSON.parse(readFileSync(filePath, 'utf-8'));
        if (json && json.nodes) {
          const res = validateFlowIR(json as FlowIR);
          console.log(JSON.stringify(res, null, 2));
          process.exit(res.ok ? 0 : 1);
        } else {
          const res = validateLogicApps(json);
          console.log(JSON.stringify(res, null, 2));
          process.exit(res.ok ? 0 : 1);
        }
      }
      break;
    }
    case 'run': {
      const input = args._ as string;
      if (!input) return help();
      let ir: FlowIR;
      if (input.endsWith('.ts')) {
        // Compile DSL to IR on-the-fly
        const { transformFile } = await import('@flowforger/dsl-native');
        ir = await transformFile(resolve(input));
      } else {
        ir = JSON.parse(readFileSync(resolve(input), 'utf-8'));
      }
      const payload = args.in ? JSON.parse(readFileSync(resolve(args.in as string), 'utf-8')) : {};
      // --auth: automatic token acquisition via MSAL
      if (args['auth']) {
        const authConfig = loadAuthConfig(args);
        const scopesByResource = await resolveRequiredScopes(ir, authConfig);
        const tokens = await acquireTokens(authConfig, scopesByResource, (msg) => console.error(msg));

        // Set token args — existing connector init code will pick these up.
        // Explicit --xxx-token flags override --auth tokens.
        if (tokens.graph && !args['graph-token']) {
          args['graph-token'] = tokens.graph;
        }
        if (tokens.sharepoint && !args['sp-token']) {
          args['sp-token'] = tokens.sharepoint;
        }
        if (tokens.dataverse && !args['dv-token']) {
          args['dv-token'] = tokens.dataverse;
          if (tokens.dataverseUrl && !args['dv-url']) {
            args['dv-url'] = tokens.dataverseUrl;
          }
        }
      }

      const http = new HttpConnector();
      let connectors: Record<string, any> = { http };
      // Optional connectors via flags
      if (args['sp-token']) {
        try {
          const { SharePointConnector } = await import('@flowforger/connectors-sharepoint');
          connectors['sharepoint'] = new (SharePointConnector as any)({ token: args['sp-token'] as string });
        } catch {}
      }
      if (args['dv-url'] && args['dv-token']) {
        try {
          const { DataverseConnector } = await import('@flowforger/connectors-dataverse');
          connectors['dataverse'] = new (DataverseConnector as any)({ baseUrl: args['dv-url'] as string, token: args['dv-token'] as string });
        } catch (err) {
          console.error('[ERROR] Failed to load Dataverse connector:', err instanceof Error ? err.message : err);
          throw err;
        }
      }
      // Graph-token connectors: each is loaded on demand and keyed into
      // `connectors`. A dedicated `tokenFlag` (e.g. --word-token) takes
      // precedence over the shared --graph-token. `keys[0]` is canonical; any
      // remaining keys are aliases pointing at the same instance.
      // Import specifiers are static string literals so esbuild bundles them.
      const graphConnectors: Array<{
        label: string;
        tokenFlag?: string;
        load: () => Promise<any>;
        exportName: string;
        keys: string[];
      }> = [
        { label: 'Office 365', load: () => import('@flowforger/connectors-office365'), exportName: 'Office365Connector', keys: ['office365'] },
        { label: 'Teams', load: () => import('@flowforger/connectors-teams'), exportName: 'TeamsConnector', keys: ['teams'] },
        { label: 'Word Online', tokenFlag: 'word-token', load: () => import('@flowforger/connectors-wordonline'), exportName: 'WordOnlineConnector', keys: ['wordonlinebusiness', 'wordonline'] },
        { label: 'Excel Online', tokenFlag: 'excel-token', load: () => import('@flowforger/connectors-excelonline'), exportName: 'ExcelOnlineConnector', keys: ['excelonlinebusiness', 'excelonline'] },
        { label: 'OneDrive for Business', tokenFlag: 'onedrive-token', load: () => import('@flowforger/connectors-onedrive'), exportName: 'OneDriveConnector', keys: ['onedriveforbusiness', 'onedrive'] },
        { label: 'Office 365 Groups', load: () => import('@flowforger/connectors-office365groups'), exportName: 'Office365GroupsConnector', keys: ['office365groups'] },
        { label: 'Office 365 Users', load: () => import('@flowforger/connectors-office365users'), exportName: 'Office365UsersConnector', keys: ['office365users'] },
      ];
      for (const c of graphConnectors) {
        const token = (c.tokenFlag && args[c.tokenFlag]) || args['graph-token'];
        if (!token) continue;
        try {
          const mod = await c.load();
          const instance = new mod[c.exportName]({ token: token as string });
          for (const key of c.keys) connectors[key] = instance;
        } catch (err) {
          console.error(`[ERROR] Failed to load ${c.label} connector:`, err instanceof Error ? err.message : err);
          throw err;
        }
      }
      // Variables
      let variables: Record<string, any> = {};
      if (args['vars']) {
        const varsPath = Array.isArray(args['vars']) ? (args['vars'] as string[])[0] : (args['vars'] as string);
        variables = { ...variables, ...JSON.parse(readFileSync(resolve(varsPath), 'utf-8')) };
      }
      if (args['var']) {
        const entries = Array.isArray(args['var']) ? (args['var'] as string[]) : [args['var'] as string];
        for (const entry of entries) {
          const idx = (entry as string).indexOf('=');
          if (idx > 0) {
            const k = (entry as string).slice(0, idx);
            const vraw = (entry as string).slice(idx + 1);
            let v: any = vraw;
            try { v = JSON.parse(vraw); } catch {}
            variables[k] = v;
          }
        }
      }
      // Parameter overrides (--param key=value)
      let parameterOverrides: Record<string, any> | undefined;
      if (args['param']) {
        parameterOverrides = {};
        const entries = Array.isArray(args['param']) ? (args['param'] as string[]) : [args['param'] as string];
        for (const entry of entries) {
          const idx = (entry as string).indexOf('=');
          if (idx > 0) {
            const k = (entry as string).slice(0, idx);
            const vraw = (entry as string).slice(idx + 1);
            let v: any = vraw;
            try { v = JSON.parse(vraw); } catch {}
            parameterOverrides[k] = v;
          }
        }
      }
      // Child workflow loader setup
      let loadChildFlow: ((workflowId: string) => Promise<FlowIR | null>) | undefined;

      // DSL-based child flow loader: when running a .ff.ts file, resolve child flows
      // from dslPath in childFlows config or by convention ({name}.ff.ts in same dir)
      const inputDir = dirname(resolve(input));
      const dslChildFlowLoader = async (workflowRef: string): Promise<FlowIR | null> => {
        // Check ir.childFlows for dslPath
        if (ir.childFlows) {
          const def = ir.childFlows[workflowRef];
          if (def?.dslPath) {
            const childPath = resolve(inputDir, def.dslPath);
            if (existsSync(childPath)) {
              try {
                const { transformFile } = await import('@flowforger/dsl-native');
                return await transformFile(childPath);
              } catch (err: any) {
                console.error(`[ERROR] Failed to compile child flow '${childPath}': ${err.message}`);
              }
            }
          }
          // Check by workflowId match
          for (const [, childDef] of Object.entries(ir.childFlows)) {
            if (childDef.workflowId === workflowRef && childDef.dslPath) {
              const childPath = resolve(inputDir, childDef.dslPath);
              if (existsSync(childPath)) {
                try {
                  const { transformFile } = await import('@flowforger/dsl-native');
                  return await transformFile(childPath);
                } catch (err: any) {
                  console.error(`[ERROR] Failed to compile child flow '${childPath}': ${err.message}`);
                }
              }
            }
          }
        }
        // Convention fallback: {workflowRef}.ff.ts in same directory
        const conventionPath = resolve(inputDir, `${workflowRef}.ff.ts`);
        if (existsSync(conventionPath)) {
          try {
            const { transformFile } = await import('@flowforger/dsl-native');
            return await transformFile(conventionPath);
          } catch (err: any) {
            console.error(`[ERROR] Failed to compile child flow '${conventionPath}': ${err.message}`);
          }
        }
        return null;
      };

      // Set up WorkflowLoader for IR-based child flow loading (existing behavior)
      let workflowLoaderFn: ((workflowId: string) => Promise<FlowIR | null>) | undefined;
      if (args['workflows-config'] || args['workflows-dir'] || (args['dv-url'] && args['dv-token'])) {
        const workflowLoader = new WorkflowLoader({
          configPath: args['workflows-config'] ? resolve(args['workflows-config'] as string) : undefined,
          workflowsDir: args['workflows-dir'] ? resolve(args['workflows-dir'] as string) : undefined,
          dataverse: (args['dv-url'] && args['dv-token']) ? {
            url: args['dv-url'] as string,
            token: args['dv-token'] as string,
            cacheDir: args['cache-workflows'] ? resolve('./.workflow-cache') : undefined,
          } : undefined,
          strict: !!args['strict-workflows'],
        });
        workflowLoaderFn = (workflowId: string) => workflowLoader.loadWorkflow(workflowId);
      }

      // Combined loader: try DSL first, then fall back to WorkflowLoader
      loadChildFlow = async (workflowRef: string): Promise<FlowIR | null> => {
        const dslResult = await dslChildFlowLoader(workflowRef);
        if (dslResult) return dslResult;
        if (workflowLoaderFn) return workflowLoaderFn(workflowRef);
        return null;
      };

      // Pre-resolve listCallbackUrl() if the flow uses it and the host has
      // the necessary identifiers + auth context. Failures are non-fatal —
      // the engine returns '' from listCallbackUrl() when callbackUrl is unset.
      let callbackUrl: string | undefined;
      if (flowUsesListCallbackUrl(ir) && args['flow-id'] && args['environment-id']) {
        const explicitToken = args['flow-token'] as string | undefined;
        let flowSvcToken = explicitToken;
        if (!flowSvcToken && args['auth']) {
          try {
            flowSvcToken = await acquireFlowServiceToken(loadAuthConfig(args), (msg) => console.error(msg));
          } catch {
            // Config missing, unreadable, or no auth section — fall through with no token.
          }
        }
        if (flowSvcToken) {
          callbackUrl = await fetchTriggerCallbackUrl({
            environmentId: args['environment-id'] as string,
            flowId: args['flow-id'] as string,
            triggerName: args['trigger-name'] as string | undefined,
            flowServiceToken: flowSvcToken,
            log: (msg) => console.error(msg),
          });
          if (callbackUrl) {
            console.error(`[INFO] Pre-resolved listCallbackUrl() = ${callbackUrl.slice(0, 80)}...`);
          }
        } else {
          console.error('[WARN] Flow uses listCallbackUrl() but no Flow Service token is available; expression will return ""');
        }
      }

      const result = await runEngine(ir, {
        connectors,
        input: payload,
        variables,
        parameterOverrides,
        logger: (e) => console.error('[LOG]', e),
        loadChildFlow,
        strictWorkflows: !!args['strict-workflows'],
        callbackUrl,
      });

      // Materialize debug file artifacts (from ctx.saveFile / @@ff:saveFile compose)
      const artifacts: FileArtifact[] = result.artifacts ?? [];
      if (artifacts.length > 0) {
        const outDir = resolve((args['artifacts-dir'] as string) || 'ff-artifacts');
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
        for (const a of artifacts) {
          const target = resolve(outDir, a.fileName);
          try {
            const data = a.encoding === 'base64' ? Buffer.from(a.content, 'base64') : a.content;
            writeFileSync(target, data);
            console.error(`[ARTIFACT] wrote ${target}`);
          } catch (e) {
            console.error(`[WARN] failed to write artifact ${a.fileName}:`, e instanceof Error ? e.message : e);
          }
        }
      }

      // Output: human-readable trace on a terminal, raw JSON when piped.
      // --pretty / --json force either mode explicitly.
      const wantJson = !!args.json || (!args.pretty && !process.stdout.isTTY);

      // Enhanced error reporting (JSON mode only — pretty mode shows errors inline)
      if (wantJson && result.status === 'Failed') {
        console.error('\n=== FLOW FAILED ===');
        if (result.error) {
          console.error('Flow Error:', result.error instanceof Error ? result.error.message : result.error);
          if (result.error instanceof Error && result.error.stack) {
            console.error('Stack:', result.error.stack);
          }
        }
        console.error('\nTrace:');
        for (const step of result.trace) {
          if (step.status === 'Failed') {
            console.error(`\n  ❌ ${step.name}:`);
            if (step.error) {
              console.error('     Error:', step.error instanceof Error ? step.error.message : JSON.stringify(step.error));
              if (step.error instanceof Error && step.error.stack) {
                console.error('     Stack:', step.error.stack);
              }
            }
          }
        }
        console.error('\n===================\n');
      }

      if (wantJson) console.log(JSON.stringify(result, null, 2));
      else printPrettyRunResult(ir.name, result);
      process.exit(result.status === 'Succeeded' ? 0 : 1);
      break;
    }
    case 'pull': {
      const id = args.id as string | undefined;
      const name = args.name as string | undefined;
      const all = !!args.all;
      const solution = args.solution as string | undefined;
      let url = args.url as string | undefined;
      let token = (args.token as string) || process.env.DATAVERSE_TOKEN || '';
      const json = !!args.json;
      const pullChildren = !args['no-children']; // enabled by default

      // --auth: acquire Dataverse token via MSAL
      if (args['auth']) {
        ({ url, token } = await acquireDataverseAuth(args, url, token, 'pull'));
      }

      if ((!id && !name && !all && !solution) || !url || !token) {
        console.error('Required: (--id, --name, --all, or --solution <name>), --url (or --auth with config), and --token or DATAVERSE_TOKEN env or --auth');
        process.exit(2);
      }
      const client = new DataverseClient({ baseUrl: url, token });

      // Default: decompile to DSL. Like --auth and push, fall back to
      // flowforger.config.json in the working directory when --config is not
      // passed; a missing default file is tolerated, a missing explicit
      // --config file still throws.
      let config: FlowForgerConfig = DEFAULT_CONFIG;
      const pullConfigPath = (args.config as string) || 'flowforger.config.json';
      if (args.config || existsSync(resolve(pullConfigPath))) {
        config = loadConfig(pullConfigPath, args['config-env'] as string | undefined);
      }
      config = buildConfigFromFlags(args, config);

      const outArg = args.out as string | undefined;

      /**
       * Scan Logic Apps JSON actions for child workflow references.
       * Returns a set of workflow GUIDs referenced via Workflow actions.
       */
      function collectChildWorkflowGuids(actions: Record<string, any>): Set<string> {
        const guids = new Set<string>();
        for (const action of Object.values(actions)) {
          if (action.type === 'Workflow') {
            const ref = action.inputs?.host?.workflowReferenceName;
            if (ref) guids.add(ref);
          }
          if (action.actions) {
            for (const g of collectChildWorkflowGuids(action.actions)) guids.add(g);
          }
          if (action.else?.actions) {
            for (const g of collectChildWorkflowGuids(action.else.actions)) guids.add(g);
          }
          if (action.cases) {
            for (const c of Object.values(action.cases) as any[]) {
              if (c.actions) {
                for (const g of collectChildWorkflowGuids(c.actions)) guids.add(g);
              }
            }
          }
          if (action.default?.actions) {
            for (const g of collectChildWorkflowGuids(action.default.actions)) guids.add(g);
          }
        }
        return guids;
      }

      function sanitizeFlowName(n: string): string {
        return n.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '-');
      }

      /**
       * Extract trigger parameters from child flow triggers (for childFlows metadata).
       */
      function extractChildTriggerParams(
        triggers: Record<string, any>
      ): Record<string, ChildFlowParameter> | undefined {
        for (const trigger of Object.values(triggers)) {
          if (trigger.type === 'Request' && trigger.kind === 'Button') {
            const schema = trigger.inputs?.schema;
            if (schema?.properties) {
              const params: Record<string, ChildFlowParameter> = {};
              for (const [key, prop] of Object.entries(schema.properties) as [string, any][]) {
                params[key] = {
                  title: (prop as any).title || key,
                  type: (prop as any).type || 'string',
                  required: schema.required?.includes(key) ?? false,
                };
              }
              return Object.keys(params).length > 0 ? params : undefined;
            }
          }
        }
        return undefined;
      }

      // --all or --solution: pull multiple flows (--out is a directory)
      if (all || solution) {
        const outDir = outArg ? resolve(outArg) : process.cwd();
        let flows: any[];
        if (solution) {
          const sol = await client.getSolutionByUniqueName(solution);
          if (!sol) {
            console.error(`Solution '${solution}' not found`);
            process.exit(1);
          }
          console.log(`Pulling flows from solution '${sol.friendlyname || solution}' (${sol.solutionid})...`);
          flows = await client.listFlowsInSolution(sol.solutionid);
        } else {
          console.log('Pulling all flows from environment...');
          flows = await client.listAllFlows();
        }

        // Filter to only flows with clientdata
        const validFlows = flows.filter((f: any) => f.clientdata);
        console.log(`Found ${flows.length} flow(s), ${validFlows.length} with definitions`);

        if (validFlows.length === 0) {
          console.log('No flows to pull.');
          break;
        }

        // Ensure output directory exists
        if (!existsSync(resolve(outDir))) {
          mkdirSync(resolve(outDir), { recursive: true });
        }

        // Pre-build a GUID → { displayName, fileName, definition } map so that
        // Workflow actions referencing sibling flows in the same pull can be
        // rewritten to use the child flow name + dslPath instead of a raw GUID.
        type SolutionFlowEntry = {
          displayName: string;
          fileName: string;
          definition: any;
          description?: string;
        };
        const guidToFlow = new Map<string, SolutionFlowEntry>();
        if (!json && pullChildren) {
          for (const wf of validFlows) {
            const wfName = wf.name || `Flow_${wf.workflowid.substring(0, 8)}`;
            try {
              const definition = JSON.parse(wf.clientdata);
              guidToFlow.set(wf.workflowid.toLowerCase(), {
                displayName: wfName,
                fileName: `${sanitizeFlowName(wfName)}.ff.ts`,
                definition,
                description: wf.description,
              });
            } catch {
              // invalid JSON — will be reported during the main loop
            }
          }
        }

        for (const wf of validFlows) {
          const wfName = wf.name || `Flow_${wf.workflowid.substring(0, 8)}`;
          const safeName = sanitizeFlowName(wfName);

          if (json) {
            const outFile = resolve(outDir, `${safeName}.clientdata.json`);
            writeFileSync(outFile, wf.clientdata);
            console.log(`  ${wfName} → ${basename(outFile)}`);
          } else {
            try {
              const definition = JSON.parse(wf.clientdata);

              // Resolve in-solution child workflow references
              let childFlows: Record<string, ChildFlowDefinition> | undefined;
              if (pullChildren) {
                const defActions = definition.properties?.definition?.actions
                                || definition.definition?.actions
                                || {};
                const guids = collectChildWorkflowGuids(defActions);
                if (guids.size > 0) {
                  childFlows = {};
                  for (const guid of guids) {
                    // Skip self-references
                    if (guid.toLowerCase() === wf.workflowid.toLowerCase()) continue;

                    const entry = guidToFlow.get(guid.toLowerCase());
                    if (!entry) {
                      // Referenced flow is not in this solution — leave as raw GUID
                      continue;
                    }

                    const childFlowName = sanitizeFlowName(entry.displayName).replace(/-/g, '_');
                    const def: ChildFlowDefinition = {
                      workflowId: guid,
                      dslPath: `./${entry.fileName}`,
                    };
                    if (entry.description) def.description = entry.description;

                    const childTriggers = entry.definition.properties?.definition?.triggers
                                       || entry.definition.definition?.triggers
                                       || {};
                    const params = extractChildTriggerParams(childTriggers);
                    if (params) def.parameters = params;

                    childFlows[childFlowName] = def;
                  }
                  if (Object.keys(childFlows).length === 0) {
                    childFlows = undefined;
                  }
                }
              }

              const ir = parseLogicAppsToIR(definition, { flowName: wfName, config, childFlows });
              ir.workflowId = wf.workflowid;
              const code = generateNativeDslFromIR(ir, { flowName: wfName, config });
              const outFile = resolve(outDir, `${safeName}.ff.ts`);
              writeFileSync(outFile, code);
              console.log(`  ${wfName} → ${basename(outFile)}`);
            } catch (err: any) {
              console.error(`  ${wfName} → ERROR: ${err.message}`);
            }
          }
        }

        console.log(`\nPulled ${validFlows.length} flow(s) to ${outDir}`);
        break;
      }

      // Single flow pull: --id or --name (--out is a file path)
      const outDir = outArg ? dirname(resolve(outArg)) : process.cwd();
      let workflow: any;
      if (id) {
        workflow = await client.getFlow(id);
      } else {
        workflow = await client.getFlowByName(name!);
        if (!workflow) {
          console.error(`No flow found with name '${name}'`);
          process.exit(1);
        }
      }

      const flowName = name || workflow.name || 'PulledFlow';
      const clientdata = workflow.clientdata;
      if (!clientdata) {
        console.error('Flow has no clientdata (definition)');
        process.exit(1);
      }

      // --json: output raw clientdata JSON
      if (json) {
        const out = (args.out as string) || `${flowName.replace(/\s+/g, '-')}.clientdata.json`;
        writeFileSync(resolve(out), clientdata);
        console.log(`Wrote ${out}`);
        break;
      }

      // Track pulled flows to avoid cycles and duplicates
      const pulledFlows = new Map<string, string>(); // workflowId -> output filename

      /**
       * Pull a single flow and recursively pull its child flows.
       * Returns the childFlows map for the parent's DSL generation.
       */
      async function pullFlowRecursive(
        workflowId: string,
        wfName: string,
        clientdataStr: string,
        outFile: string,
      ): Promise<void> {
        // Mark as pulled early to prevent cycles
        pulledFlows.set(workflowId, outFile);

        const definition = JSON.parse(clientdataStr);
        const defActions = definition.properties?.definition?.actions
                        || definition.definition?.actions
                        || {};

        // Scan for child workflow GUIDs
        let childFlows: Record<string, ChildFlowDefinition> | undefined;
        if (pullChildren) {
          const guids = collectChildWorkflowGuids(defActions);

          if (guids.size > 0) {
            childFlows = {};

            for (const guid of guids) {
              // Already pulled — just reference it
              if (pulledFlows.has(guid)) {
                const existingFile = pulledFlows.get(guid)!;
                const existingBasename = basename(existingFile);
                const childFlowName = existingBasename.replace(/\.ff\.ts$/, '').replace(/-/g, '_');
                childFlows[childFlowName] = {
                  workflowId: guid,
                  dslPath: `./${existingBasename}`,
                };
                continue;
              }

              // Fetch child flow from Dataverse
              try {
                const childWorkflow = await client.getFlow(guid);
                if (!childWorkflow?.clientdata) {
                  console.error(`  Warning: child flow ${guid} has no clientdata, skipping`);
                  continue;
                }

                const childDisplayName = childWorkflow.name || `ChildFlow_${guid.substring(0, 8)}`;
                const childFileName = `${sanitizeFlowName(childDisplayName)}.ff.ts`;
                const childFlowName = sanitizeFlowName(childDisplayName).replace(/-/g, '_');
                const childOutPath = resolve(outDir, childFileName);

                // Recursively pull the child flow (handles its own children)
                await pullFlowRecursive(guid, childDisplayName, childWorkflow.clientdata, childOutPath);

                const def: ChildFlowDefinition = {
                  workflowId: guid,
                  dslPath: `./${childFileName}`,
                };
                if (childWorkflow.description) {
                  def.description = childWorkflow.description;
                }

                // Extract trigger parameters from child flow
                const childDef = JSON.parse(childWorkflow.clientdata);
                const childTriggers = childDef.properties?.definition?.triggers
                                   || childDef.definition?.triggers
                                   || {};
                const params = extractChildTriggerParams(childTriggers);
                if (params) def.parameters = params;

                childFlows[childFlowName] = def;
              } catch (err: any) {
                console.error(`  Warning: failed to pull child flow ${guid}: ${err.message}`);
              }
            }

            if (Object.keys(childFlows).length === 0) {
              childFlows = undefined;
            }
          }
        }

        // Generate DSL with child flow references
        const ir = parseLogicAppsToIR(definition, { flowName: wfName, config, childFlows });
        ir.workflowId = workflowId;  // embed Dataverse GUID for round-trip push
        const code = generateNativeDslFromIR(ir, { flowName: wfName, config });

        // Warn if an existing file at outFile carries a different workflowId
        if (existsSync(resolve(outFile))) {
          try {
            const existing = readFileSync(resolve(outFile), 'utf-8');
            const match = existing.match(/workflowId:\s*['"]([0-9a-f-]{36})['"]/i);
            if (match && match[1].toLowerCase() !== workflowId.toLowerCase()) {
              console.warn(
                `WARNING: workflowId in ${basename(outFile)} changed from ${match[1]} → ${workflowId}`
              );
            }
          } catch {
            // best-effort detection only — never fail the pull because of a read error
          }
        }

        writeFileSync(resolve(outFile), code);
        console.log(`Pulled '${wfName}' (${workflowId}) → ${basename(outFile)}`);
      }

      const mainOutFile = outArg
        ? resolve(outArg)
        : resolve(outDir, `${sanitizeFlowName(flowName)}.ff.ts`);

      await pullFlowRecursive(workflow.workflowid, flowName, clientdata, mainOutFile);

      break;
    }
    case 'push': {
      const explicitId = args.id as string | undefined;
      const file = args.file as string;
      let url = args.url as string;
      let token = (args.token as string) || process.env.DATAVERSE_TOKEN || '';

      // --auth: acquire Dataverse token via MSAL
      if (args['auth']) {
        ({ url, token } = await acquireDataverseAuth(args, url, token, 'push'));
      }

      if (!file || !url || !token) {
        console.error('Required: --file, --url (or --auth with config), and --token or DATAVERSE_TOKEN env or --auth');
        process.exit(2);
      }

      let clientdata: string;
      let decoratorWorkflowId: string | undefined;
      const fileExt = extname(file).toLowerCase();

      if (fileExt === '.ts') {
        // DSL → compile to Logic Apps JSON on the fly
        console.log(`Compiling ${file} to Logic Apps JSON...`);
        const { transformFile } = await import('@flowforger/dsl-native');
        const ir = await transformFile(resolve(file));
        decoratorWorkflowId = ir.workflowId;

        const cfg = loadEmitterConfig(args, 'flowforger.config.json');
        const def = emitLogicAppsJson(ir, cfg);
        clientdata = JSON.stringify(def, null, 2);
        console.log('Compiled successfully.');
      } else {
        // JSON file — read as-is
        clientdata = readFileSync(resolve(file), 'utf-8');
      }

      // Resolve effective workflow ID: explicit --id wins, then decorator workflowId, then error.
      const effectiveId = explicitId || decoratorWorkflowId;
      if (!effectiveId) {
        if (fileExt === '.ts') {
          console.error(
            'Required: --id, or add `workflowId` to @Flow({...}) in your DSL. ' +
            'Tip: run `flowforger pull --name "<flow>"` to embed the workflowId automatically.'
          );
        } else {
          console.error('Required: --id (JSON files have no embedded workflowId)');
        }
        process.exit(2);
      }
      if (explicitId && decoratorWorkflowId && explicitId !== decoratorWorkflowId) {
        console.warn(
          `WARNING: --id ${explicitId} overrides decorator workflowId ${decoratorWorkflowId}`
        );
      }

      const client = new DataverseClient({ baseUrl: url, token });
      await client.patchFlow(effectiveId, { clientdata });
      console.log('Patched clientdata');
      break;
    }
    case 'generate-dsl': {
      const infile = (args.in as string) || (args._ as string);
      const out = (args.out as string) || 'flow.native.ts';
      const name = (args.name as string) || undefined;
      if (!infile) return help();

      // Load config from file if specified, then apply CLI flag overrides
      let config: FlowForgerConfig = DEFAULT_CONFIG;
      if (args.config) {
        config = loadConfig(args.config as string, args['config-env'] as string | undefined);
      }
      config = buildConfigFromFlags(args, config);

      const json = JSON.parse(readFileSync(resolve(infile), 'utf-8'));
      // Logic Apps JSON -> IR -> DSL
      const ir = parseLogicAppsToIR(json, { flowName: name, config });
      const code = generateNativeDslFromIR(ir, { flowName: name, config });
      writeFileSync(resolve(out), code);
      console.log(`Wrote ${out}`);
      break;
    }
    case 'parity': {
      const infile = (args.in as string) || (args._ as string);
      const name = (args.name as string) || undefined;
      if (!infile) return help();

      // Load config from file if specified, then apply CLI flag overrides
      let config: FlowForgerConfig = DEFAULT_CONFIG;
      if (args.config) {
        config = loadConfig(args.config as string, args['config-env'] as string | undefined);
      }
      config = buildConfigFromFlags(args, config);

      const json = JSON.parse(readFileSync(resolve(infile), 'utf-8'));

      // Round-trip parity check: Logic Apps JSON -> IR -> DSL -> IR -> Logic Apps JSON,
      // then normalize and compare. See ./parity.ts for the full pipeline.
      let parityResult;
      try {
        parityResult = checkParity(json, { flowName: name, config });
      } catch (err) {
        if (err instanceof ParityTransformError) {
          console.error(err.message);
          console.error('Error:', err.transformCause instanceof Error ? err.transformCause.message : err.transformCause);
          process.exit(2);
        }
        throw err;
      }

      if (parityResult.ok) {
        console.log(JSON.stringify({ ok: true }, null, 2));
        process.exit(0);
      }

      const totalDiffs = parityResult.totalDiffs ?? 0;
      console.log(JSON.stringify({
        ok: false,
        category: parityResult.category,
        totalDiffs,
        note: `${totalDiffs} semantic difference${totalDiffs > 1 ? 's' : ''} found`,
        differences: parityResult.differences,
      }, null, 2));
      process.exit(1);
    }
    case 'activate': {
      const id = args.id as string;
      const url = args.url as string;
      const token = (args.token as string) || process.env.DATAVERSE_TOKEN || '';
      const statecode = Number(args.state);
      const statuscode = Number(args.status);
      if (!id || !url || !token || Number.isNaN(statecode) || Number.isNaN(statuscode)) {
        console.error('Required: --id, --url, --token or DATAVERSE_TOKEN, --state, --status');
        process.exit(2);
      }
      const client = new DataverseClient({ baseUrl: url, token });
      await client.patchFlow(id, { statecode, statuscode });
      console.log('Patched state');
      break;
    }
    case 'sp-discover': {
      const token = (args.token as string) || process.env.GRAPH_TOKEN || '';
      const siteUrl = args.site as string | undefined;
      const listName = args.list as string | undefined;

      if (!token) {
        console.error('Required: --token or GRAPH_TOKEN env variable');
        process.exit(2);
      }

      await discoverSharePoint(token, siteUrl, listName);
      break;
    }
    case 'optimize': {
      const infile = (args.in as string) || (args._ as string);
      if (!infile) return help();

      // Default output file: input.optimized.ts
      const defaultOut = infile.replace(/\.ts$/, '.optimized.ts');
      const out = (args.out as string) || defaultOut;
      const reportFile = args.report as string | undefined;

      // Load config if specified
      let config: FlowForgerConfig = DEFAULT_CONFIG;
      if (args.config) {
        config = loadConfig(args.config as string, args['config-env'] as string | undefined);
      }
      config = buildConfigFromFlags(args, config);

      // Read input DSL
      const dslCode = readFileSync(resolve(infile), 'utf-8');

      // Import and run optimizer
      const { optimizeDsl, formatReportSummary } = await import('@flowforger/dsl-native');
      const result = await optimizeDsl(dslCode, {
        config,
        optimizations: {
          singleSetVariableToCompose: !args['no-variable-to-compose'],
          loopVariableToCompose: !args['no-loop-variable-to-compose'],
          appendToSelect: !args['no-append-to-select'],
        },
        includeParallelismWarnings: !args['no-parallelism-warnings'],
      });

      // Write optimized code
      writeFileSync(resolve(out), result.code);
      console.log(`Wrote optimized DSL to ${out}`);

      // Write report if requested
      if (reportFile) {
        writeFileSync(resolve(reportFile), JSON.stringify(result.report, null, 2));
        console.log(`Wrote optimization report to ${reportFile}`);
      }

      // Print summary to console
      console.log('');
      console.log(formatReportSummary(result.report));
      break;
    }
    case 'init': {
      const url = args.url as string | undefined;
      const clientId = args['client-id'] as string | undefined;
      const spUrl = args['sp-url'] as string | undefined;
      const outFile = (args.out as string) || 'flowforger.config.json';
      const skipDiscovery = !!args['skip-discovery'];
      const tenantIdFlag = args['tenant-id'] as string | undefined;

      if (!url || !clientId) {
        console.error('Required: --url <dataverseUrl> --client-id <azureAdClientId>');
        console.error('Example: flowforger init --url https://org.crm4.dynamics.com --client-id 720b41d5-...');
        process.exit(2);
      }

      const { discoverTenantId, acquireInitToken, discoverConnectionReferences, generateConfig } = await import('./init.js');
      const log = (msg: string) => console.log(msg);

      // Phase 1: Discover tenant ID (no auth needed) or use provided value
      let tenantId: string;
      if (tenantIdFlag) {
        tenantId = tenantIdFlag;
        log(`Using provided tenant ID: ${tenantId}`);
      } else {
        log('Discovering tenant ID...');
        try {
          tenantId = await discoverTenantId(url);
          log(`  Tenant ID: ${tenantId}`);
        } catch (e: any) {
          console.error(`Failed to discover tenant ID: ${e.message}`);
          process.exit(1);
        }
      }

      let connectionRefs = new Map<string, { logicalName: string; displayName: string }>();

      if (!skipDiscovery) {
        // Phase 2: Authenticate to Dataverse
        log('Authenticating to Dataverse...');
        let token: string;
        try {
          token = await acquireInitToken(clientId, tenantId, url, log);
        } catch (e: any) {
          console.error(`Authentication failed: ${e.message}`);
          process.exit(1);
        }

        // Phase 3: Discover connection references
        log('Discovering connection references...');
        try {
          connectionRefs = await discoverConnectionReferences(url, token, log);
        } catch (e: any) {
          console.error(`Warning: Could not discover connection references: ${e.message}`);
          log('  Continuing with empty connection references...');
        }
      }

      // Phase 4: Generate and write config
      const config = generateConfig({
        clientId,
        tenantId,
        dataverseUrl: url,
        sharepointUrl: spUrl,
        connectionRefs,
      });

      // Check for existing config
      if (existsSync(resolve(outFile))) {
        log(`\nWarning: ${outFile} already exists. Writing to ${outFile}.new`);
        writeFileSync(resolve(`${outFile}.new`), JSON.stringify(config, null, 2) + '\n');
        log(`Wrote ${outFile}.new`);
        log(`Review and rename to ${outFile} when ready.`);
      } else {
        writeFileSync(resolve(outFile), JSON.stringify(config, null, 2) + '\n');
        log(`\nWrote ${outFile}`);
      }

      log('\nNext steps:');
      if (!spUrl) {
        log('  - Add your SharePoint URL to auth.resources.sharepoint');
      }
      if (connectionRefs.size === 0 && skipDiscovery) {
        log('  - Run without --skip-discovery to auto-fill connection reference names');
      }
      const emptyRefs = Object.entries(config.global.connections)
        .filter(([_, v]: [string, any]) => !v.connectionReferenceLogicalName)
        .map(([k]) => k);
      if (emptyRefs.length > 0) {
        log(`  - Fill in connectionReferenceLogicalName for: ${emptyRefs.join(', ')}`);
      }
      log('  - Run: flowforger pull --name "My Flow" --url ' + url + ' --auth');
      break;
    }
    case 'skills': {
      const sub = (args._ as string) || 'install';
      if (sub !== 'install') {
        console.error(`Unknown skills subcommand: ${sub}. Available: install`);
        process.exit(2);
      }
      const targetRoot = resolve(
        typeof args.dir === 'string' ? args.dir : join('.claude', 'skills')
      );
      const repo = typeof args.repo === 'string' ? args.repo : 'tomdam/flowforger';
      const ref = typeof args.ref === 'string' ? args.ref : 'main';
      const repoPath = typeof args.path === 'string' ? args.path : 'skills';

      // Default: fetch the latest skills from GitHub so they stay current
      // independently of the installed CLI version. --bundled forces the
      // copies shipped inside the npm package (offline / air-gapped use).
      let installedNames: string[] | null = null;
      let sourceLabel = '';
      if (!args.bundled) {
        try {
          installedNames = await installSkillsFromGitHub(repo, ref, repoPath, targetRoot);
          sourceLabel = `github:${repo}@${ref}`;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`Could not fetch skills from github:${repo}@${ref} (${msg})`);
          console.warn('Falling back to the skills bundled with this CLI. Use --bundled to skip the fetch.\n');
        }
      }

      if (!installedNames) {
        // Skills ship inside the npm package next to dist/. Resolve from the
        // module URL (symlink-safe) rather than process.argv[1], which keeps the
        // bin symlink path on a global install.
        const pkgRoot = cliPackageRoot();
        const pkgSkillsDir = join(pkgRoot, 'skills');
        if (!existsSync(pkgSkillsDir)) {
          console.error(`No bundled skills found at ${pkgSkillsDir}`);
          process.exit(1);
        }
        const skillNames = readdirSync(pkgSkillsDir).filter((n) =>
          statSync(join(pkgSkillsDir, n)).isDirectory()
        );
        if (skillNames.length === 0) {
          console.error(`No skills found in ${pkgSkillsDir}`);
          process.exit(1);
        }
        mkdirSync(targetRoot, { recursive: true });
        for (const skillName of skillNames) {
          cpSync(join(pkgSkillsDir, skillName), join(targetRoot, skillName), { recursive: true });
        }
        installedNames = skillNames;
        sourceLabel = `bundled (CLI v${cliVersion()})`;
      }

      for (const skillName of installedNames) {
        console.log(`Installed skill '${skillName}' -> ${join(targetRoot, skillName)}`);
      }
      console.log(`\n${installedNames.length} skill(s) installed from ${sourceLabel}.`);
      if (sourceLabel.startsWith('github:')) {
        console.log('Re-run this command any time to refresh them — no CLI upgrade needed.');
      } else {
        console.log('Re-run without --bundled (online) to fetch the latest versions from GitHub.');
      }
      break;
    }
    default:
      help();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
