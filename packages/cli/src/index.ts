#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, extname, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { emitLogicAppsJson } from '@flowforger/emitter-logicapps';
import { validateFlowIR, validateLogicApps } from '@flowforger/validator';
import type { FlowIR, FlowForgerConfig, ChildFlowDefinition, ChildFlowParameter } from '@flowforger/ir';
import { parseConfigFromJson, DEFAULT_CONFIG } from '@flowforger/ir';
import { run as runEngine, flattenTrace, requestTriggerOutputs, WorkflowLoader, type FileArtifact } from '@flowforger/engine';
import { DataverseClient } from '@flowforger/dataverse-sdk';
import { buildConnectors } from '@flowforger/debug-node';
import { parseLogicAppsToIR, generateNativeDslFromIR } from '@flowforger/dsl-native';
import { getDiagnostics, getDiagnosticCounts, type Diagnostic } from '@flowforger/dsl-language-service';
import { connectorsForExplicitTokens, resolveRequiredScopes, acquireTokens, acquireFlowServiceToken, fetchTriggerCallbackUrl, flowUsesListCallbackUrl, collectAllConnectorScopes, resourceKeyForUrl, RESOURCE_APIS, type AuthConfig } from './auth.js';
import { checkParity, ParityTransformError } from './parity.js';
import { runPush, PushError, flowStateSummary } from './push.js';
import { runDiff } from './diff.js';
import { formatDiffReport } from './definition-diff.js';
import { resolveFlowTarget, type FlowTarget } from './flow-target.js';
import { FlowApiClient, FlowApiError, findEnvironmentForDataverse } from './flow-api.js';
import { fetchCloudRun, prepareReplay, describeReplay, type Replay, type CloudRun } from './replay-run.js';
import { formatPrettyRunResult } from './pretty-trace.js';
import { parseArgs, requireBooleanFlag, requireStringFlag, findUnknownFlags, ArgError } from './cli-args.js';
import { resolveRunParameterOverrides } from './env-var-overrides.js';
import { printPrettyRunResult } from './pretty-trace.js';
import { collectMocks, parseLiveFlags, createRunGuard, mockedActionsInTrace } from './run-mocks.js';

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
  if (args['expressions-strict'] !== undefined) {
    config.generator = { ...config.generator, expressionFidelity: 'strict' };
  }
  if (args['expressions-relaxed'] !== undefined) {
    config.generator = { ...config.generator, expressionFidelity: 'relaxed' };
  }
  if (args['description-jsdoc'] !== undefined) {
    config.generator = { ...config.generator, descriptionStyle: 'jsdoc' };
  }
  if (args['description-comment'] !== undefined) {
    config.generator = { ...config.generator, descriptionStyle: 'lineComment' };
  }
  if (args['skip-default-constructor'] !== undefined) {
    config.generator = { ...config.generator, skipDefaultConstructor: true };
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
 * The FlowForgerConfig for commands that fall back to flowforger.config.json
 * in the working directory (pull, push, diff): an explicit --config must
 * exist, the default file is optional.
 */
function loadCwdConfig(args: Record<string, any>): FlowForgerConfig {
  const configPath = (args.config as string) || 'flowforger.config.json';
  if (args.config || existsSync(resolve(configPath))) {
    return loadConfig(configPath, args['config-env'] as string | undefined);
  }
  return DEFAULT_CONFIG;
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
  cmd: 'pull' | 'push' | 'activate' | 'diff' | 'runs' | 'run-show' | 'run',
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
    const tokens = await acquireTokens(authConfig, scopes, (msg) => console.error(msg), { verbose: !!args.verbose });
    if (tokens.dataverse) token = tokens.dataverse;
  }
  return { url, token };
}

/**
 * What `runs`, `run-show` and `run --replay-run` share: a Dataverse connection (--url/--token or
 * --auth), a flow-service token (--flow-token or --auth), the flow resolved like push/diff
 * (--id, the decorator workflowId, then the name), its Flow API id (the workflow row's
 * resourceid) and the environment id (--environment-id, else found from the Dataverse URL).
 * Prints the reason and exits 2 when any of these is missing.
 */
async function connectFlowApi(
  args: Record<string, any>,
  cmd: 'runs' | 'run-show' | 'run',
  flow: { explicitId?: string; decoratorWorkflowId?: string; flowName?: string; isDsl: boolean; hasFile: boolean },
): Promise<{ client: DataverseClient; url: string; flowApi: FlowApiClient; environmentId: string; flowApiId: string; target: FlowTarget }> {
  const log = (msg: string) => console.error(msg);
  let url = args.url as string;
  let token = (args.token as string) || process.env.DATAVERSE_TOKEN || '';
  if (args['auth']) {
    ({ url, token } = await acquireDataverseAuth(args, url, token, cmd));
  }
  if ((!flow.hasFile && !flow.explicitId && !flow.flowName) || !url || !token) {
    console.error(
      cmd === 'run'
        ? 'Required for --replay-run: --auth (recommended), or --url with --token/DATAVERSE_TOKEN'
        : 'Required: --file, --id or --name; --url (or --auth with config); and --token or DATAVERSE_TOKEN env or --auth',
    );
    process.exit(2);
  }

  // The flow-service token: --flow-token, else --auth (same MSAL cache as the Dataverse token).
  let flowToken = (args['flow-token'] as string | undefined) || undefined;
  if (!flowToken && args['auth']) flowToken = await acquireFlowServiceToken(loadAuthConfig(args), args.verbose ? log : () => {});
  if (!flowToken) {
    console.error('A flow-service token is needed: pass --auth (recommended) or --flow-token <token> (resource https://service.flow.microsoft.com/)');
    process.exit(2);
  }

  const client = new DataverseClient({ baseUrl: url, token });
  let target: FlowTarget | null;
  try {
    target = await resolveFlowTarget(client, { explicitId: flow.explicitId, decoratorWorkflowId: flow.decoratorWorkflowId, flowName: flow.flowName, isDsl: flow.isDsl }, log);
  } catch (err) {
    if (err instanceof PushError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
  if (!target) {
    console.error(`No flow named '${flow.flowName}' found in this environment`);
    process.exit(2);
  }
  const flowApiId = await client.getFlowApiId(target.workflowId);
  if (!flowApiId) {
    console.error(`Flow ${target.workflowId} has no resourceid, so it cannot be addressed through the Flow API`);
    process.exit(2);
  }

  const flowApi = new FlowApiClient({ token: flowToken });
  let environmentId = args['environment-id'] as string | undefined;
  if (!environmentId) {
    let envs;
    try {
      envs = await flowApi.listEnvironments();
    } catch (err) {
      exitOnFlowApiError(err);
      throw err;
    }
    const env = findEnvironmentForDataverse(envs, url);
    if (!env) {
      console.error(`No Power Platform environment linked to ${url} is visible to you; pass --environment-id <guid>`);
      process.exit(2);
    }
    environmentId = env.id;
  }
  return { client, url, flowApi, environmentId, flowApiId, target };
}

/** Print a Flow API failure (with the permission hint for 401/403) and exit 2; returns for any other error. */
function exitOnFlowApiError(err: unknown): void {
  if (err instanceof FlowApiError) {
    console.error(err.message);
    if (err.status === 401 || err.status === 403) console.error('The flow-service token was refused; the app registration needs the Power Automate (service.flow.microsoft.com) User permission, and the flow must be visible to you.');
    process.exit(2);
  }
}

function help() {
  console.log(`FlowForger CLI

Usage:
  flowforger compile <input.ff.ts|input.ir.json> --out <output> [--emit logicapps] [--config flowforger.config.json] [--config-env <envName>]
  flowforger validate <file.json|file.ff.ts>
  flowforger run <input.ir.json|input.ff.ts> [--in payload.json [--in-content-type <type>]]
                    (--in-content-type: --in is the raw request body, e.g. a form post or multipart data)
                    [--pretty | --json]  (default: pretty on a terminal, JSON when piped)
                    [--verbose]  (also print sign-in progress, and in pretty mode connector request/response logs)
                    [--stop-before <actionName>]  (end the run before that action, printing the inputs it would get; exit code 3)
                    [--mock <actionName>=<outputs.json>]  (repeatable: the action does not run, its outputs are the file's JSON)
                    [--mocks <mocks.json>]  (one JSON object mapping action names to their outputs)
                    [--live <actionName>[,<actionName>]]  (repeatable: only these actions may call out; any other
                                                          connector/HTTP/child-flow action must be mocked, else the run
                                                          ends before it with its inputs, exit code 3 — a safe dry run)
                    [--replay-run <runId>]  (replay a cloud run: its trigger outputs are the input unless --in is given,
                                             every connector/HTTP/child-flow action it recorded is pinned to the recorded
                                             outputs per loop iteration — a failure as a failure — and safe mode is on:
                                             an unpinned external action stops the run (exit 3) unless listed with --live,
                                             which unpins it. Needs --auth (or --flow-token plus --url/--token); the flow
                                             is resolved like run-show: --id, the @Flow workflowId, then the name)
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
                    [--name <flowName>] [--solution <uniqueName>] [--create | --no-create] [--require-active] [--expect-clean]
  --id is optional when the DSL has \`workflowId\` in @Flow({...}); explicit --id always wins.
  With no id, push finds the flow by name and updates it, or creates it if there is no match
  (as Draft, and writing the new workflowId back into your @Flow decorator).
  --solution places a newly created flow in that solution. --create always creates; --no-create
  makes a missing flow an error. JSON files need --name for name lookup and creation.
  After the push the flow's state is printed (Activated / Draft / Suspended); --require-active
  exits 1 when it is not Activated. push itself never changes the state.
  --expect-clean refuses to update when the live flow has actions, triggers or parameters the
  local file lacks (something was added in the designer since you pulled); pull and merge first.
  flowforger diff --file <flow.ff.ts|clientdata.json> --url <dataverseUrl> [--token <token>] [--auth] [--config flowforger.config.json]
                    [--id <workflowid> | --name <flowName>] [--pretty | --json]  (default: pretty on a terminal, JSON when piped)
  Compare the local flow with the live one, per action: only-local, only-live, changed (type, inputs,
  expression, runAfter, moved), plus trigger, parameter and flow-level differences. The live flow is
  resolved like push (--id, then the decorator workflowId, then the name). Exit code 0 when identical,
  1 when there are differences, 2 on a usage or resolution error.
  flowforger runs (--file <flow.ff.ts> | --id <workflowid> | --name <flowName>) --auth [--top <n>] [--status <Succeeded|Failed|Cancelled|Running>]
                    [--environment-id <guid>] [--flow-token <token>] [--pretty | --json]
  flowforger run-show --run <runId> (--file <flow.ff.ts> | --id <workflowid> | --name <flowName>) --auth [--environment-id <guid>] [--pretty | --json]
  List a flow's cloud runs, or print one run with the trace shape of \`run --json\` ({ status, trace }: every
  action with the cloud's status, inputs, outputs and error; a block's body under children, a loop's under
  iterations). Needs a flow-service token (--auth, or --flow-token). The environment is found from the
  Dataverse URL unless --environment-id is given. run-show exits 0 when the run Succeeded, 1 otherwise.
  flowforger activate --id <workflowid> [--url <dataverseUrl>] [--token <token> | --auth [--config flowforger.config.json]] --state <statecode> --status <statuscode>
  flowforger generate-dsl --in <clientdata.json> --out <flow.ff.ts> [--name <flowName>] [--config <config.json>]
  flowforger parity --in <clientdata.json> [--name <flowName>] [--config <config.json>] [--ignore-whitespace]
  flowforger sp-discover --token <graph-token> [--site <site-url>] [--list <list-name>]
  flowforger optimize <input.ff.ts> [--out <output.ff.ts>] [--report <report.json>]
  flowforger init --url <dataverseUrl> --client-id <azureAdClientId> [--tenant-id <id>] [--sp-url <sharepointUrl>] [--out <config.json>]
  flowforger scopes <input.ff.ts|input.ir.json> [--config flowforger.config.json] [--json]
                    Print the delegated permissions your app registration needs for this flow
  flowforger scopes --all [--json]              Print every permission any connector can request
  flowforger skills install [--dir <targetDir>] [--bundled] [--repo <owner/repo>] [--ref <branch>] [--path <repoPath>]
  flowforger mcp [--auth] [--budget N]            Run the debug MCP server over stdio (for AI agents)

Config Options:
  --config <file>           Path to flowforger.config.json (optional)
  --config-env <name>       Environment name to use from config (optional)

Generator Options (for generate-dsl, parity):
  --multiline-preserve      Preserve multiline expression formatting (default)
  --multiline-flatten       Flatten multiline expressions to single line
  --whitespace-spaced       Use spaces after commas: func(a, b) (default)
  --whitespace-compact      No spaces after commas: func(a,b)
  --expressions-strict      Preserve expressions verbatim via ctx.eval() when regeneration
                            would change cosmetic details (spacing, casing) (default)
  --expressions-relaxed     Generate native DSL for parseable expressions, normalizing
                            cosmetic spacing/casing (re-emitted JSON may differ textually)
  --description-comment     Render action descriptions as // line comments (default)
  --description-jsdoc       Render action descriptions as /** @description ... */ tags
  --skip-default-constructor  Omit the constructor when it only contains default boilerplate
                            (standard schema metadata, default $connections/$authentication,
                            empty connection references) that compile re-injects

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

/** Whether the flow (its root, not child flows) contains an action named `name`, at any depth. */
function flowHasAction(ir: FlowIR, name: string): boolean {
  const walk = (nodes: any[] | undefined): boolean =>
    (nodes ?? []).some((n) =>
      n.name === name ||
      walk(n.actions) ||
      walk(n.elseActions) ||
      (n.cases ?? []).some((c: any) => walk(c.actions)) ||
      walk(n.defaultActions) ||
      walk(n.default?.actions),
    );
  return walk(ir.nodes as any[]);
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(cliVersion());
    return;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help || rest.includes('-h')) {
    help();
    return;
  }
  // A misspelled or single-dash option used to be ignored without a word
  // (`compile x.ff.ts -o out/` wrote to the cwd). Refuse it instead.
  const unknown = findUnknownFlags(rest);
  if (unknown.length > 0) {
    throw new ArgError(`${unknown.join('\n')}\nRun 'flowforger --help' for the option list.`);
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
        let hasErrors = counts.error > 0;

        // Sort by line number
        diagnostics.sort((a: Diagnostic, b: Diagnostic) => a.range.start.line - b.range.start.line);

        // Print diagnostics in a readable format
        for (const d of diagnostics) {
          const line = d.range.start.line + 1;
          const col = d.range.start.character + 1;
          const sev = d.severity.toUpperCase();
          console.log(`${file}:${line}:${col} ${sev} [${d.code}] ${d.message}`);
        }

        // When the DSL itself is clean enough to transform, also run the IR validator: some
        // rules (nesting depth, expression length, parameter count, connector params) are
        // only checked on the IR. Codes with a DSL twin are skipped so nothing is reported twice.
        let irIssueCount = 0;
        if (!hasErrors) {
          const DSL_COVERED_IR_CODES = new Set([
            'EXPR_UNKNOWN_ACTION', 'ACTION_NAME_DUPLICATE', 'VARIABLE_UNDEFINED', // DSL004, DSL005, DSL007
            'EXPR_LOOP_REFERENCE', 'VAR_INIT_NESTED', 'EXPR_UNKNOWN_PARAMETER', // DSL012/013, DSL014, DSL015
            'RUNAFTER_STATUS', 'RUNAFTER_UNKNOWN', 'RUNAFTER_SELF', // DSL021, DSL022
            'VAR_INIT_DUPLICATE', 'EXPR_SYNTAX', 'EXPR_UNKNOWN_FUNCTION', // DSL030, DSL033, DSL034
            'RESPONSE_NESTED', 'TERMINATE_NESTED', 'RESPONSE_TRIGGER', // DSL037, DSL038
            'ACTION_NAME_LENGTH', 'ACTION_COUNT', 'SWITCH_CASES', 'VARIABLE_COUNT', // DSL039-DSL042
            'FOREACH_CONCURRENCY', 'RETRY_POLICY', 'UNTIL_COUNT', 'UNTIL_TIMEOUT', // DSL043
            'RESPONSE_KIND', 'RECURRENCE', 'RECURRENCE_SCHEDULE', // DSL044, DSL045
            // Not EXPR_ARG_COUNT / EXPR_ARG_TYPE: DSL049 sees only ctx.eval literals, not
            // expressions written as plain parameter strings.
            // Not EXPR_RUNAFTER_PATH / EXPR_SELF_REFERENCE: DSL048 skips what it can't resolve, and an
            // error from it stops this pass anyway, so the IR check only reports what DSL048 missed.
          ]);
          try {
            const { transformFile } = await import('@flowforger/dsl-native');
            const ir = await transformFile(filePath);
            const res = validateFlowIR(ir);
            // Info-level hints are shown too (DV_LOOKUP_UNGUARDED); HTTP_RETRY is left out because the
            // cloud applies its default retry policy to an HTTP action without one.
            const irIssues = res.issues.filter((i) => !DSL_COVERED_IR_CODES.has(i.code) && !(i.level === 'info' && i.code === 'HTTP_RETRY'));
            irIssueCount = irIssues.length;
            for (const i of irIssues) {
              console.log(`${file} ${i.level.toUpperCase()} [${i.code}] ${i.message}${i.path ? ` (${i.path})` : ''}`);
              if (i.level === 'error') hasErrors = true;
            }
          } catch (e: any) {
            console.log(`${file} WARNING [IR_TRANSFORM] Could not transform the DSL to IR for the IR-level checks: ${e?.message ?? e}`);
          }
        }

        if (diagnostics.length === 0 && irIssueCount === 0) {
          console.log('✓ No issues found.');
          process.exit(hasErrors ? 1 : 0);
        }

        console.log(`\n${diagnostics.length + irIssueCount} issue(s): ${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} info, ${counts.hint} hint(s)${irIssueCount ? `, ${irIssueCount} IR-level` : ''}`);
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
      // --in-content-type: --in is a raw request body (a form post, multipart data), stored the
      // way the cloud's Request trigger stores it.
      const inContentType = args['in-content-type'] ? requireStringFlag(args, 'in-content-type') : undefined;
      if (inContentType && !args.in) throw new ArgError('--in-content-type needs --in <body file>');
      let payload: unknown = !args.in
        ? {}
        : inContentType
          ? requestTriggerOutputs(inContentType, readFileSync(resolve(args.in as string)))
          : JSON.parse(readFileSync(resolve(args.in as string), 'utf-8'));
      // --auth: automatic token acquisition via MSAL
      if (args['auth']) {
        const authConfig = loadAuthConfig(args);
        const explicitTokenConnectors = connectorsForExplicitTokens({
          spToken: !!args['sp-token'],
          dvToken: !!args['dv-token'],
          graphToken: !!args['graph-token'],
          wordToken: !!args['word-token'],
          excelToken: !!args['excel-token'],
          onedriveToken: !!args['onedrive-token'],
        });
        const scopesByResource = await resolveRequiredScopes(ir, authConfig, { skipConnectors: explicitTokenConnectors });
        const tokens = await acquireTokens(authConfig, scopesByResource, (msg) => console.error(msg), {
          verbose: !!args.verbose,
        });

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

      const connectors: Record<string, any> = buildConnectors({
        spToken: args['sp-token'] as string | undefined,
        dvUrl: args['dv-url'] as string | undefined,
        dvToken: args['dv-token'] as string | undefined,
        graphToken: args['graph-token'] as string | undefined,
        wordToken: args['word-token'] as string | undefined,
        excelToken: args['excel-token'] as string | undefined,
        onedriveToken: args['onedrive-token'] as string | undefined,
      });
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
      // Env-var-backed parameters resolve to their CURRENT environment values
      // when a Dataverse connection is available (from --dv-url/--dv-token or
      // --auth) — otherwise the engine would use the design-time defaultValue
      // snapshot baked into the flow. Explicit --param flags win per key.
      parameterOverrides = await resolveRunParameterOverrides({
        ir,
        dvUrl: args['dv-url'] as string | undefined,
        dvToken: args['dv-token'] as string | undefined,
        explicitOverrides: parameterOverrides,
        log: (msg) => console.error(msg),
        showSecrets: !!args.verbose,
      });
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

      // Output: human-readable trace on a terminal, raw JSON when piped.
      // --pretty / --json force either mode explicitly.
      const wantJson = !!args.json || (!args.pretty && !process.stdout.isTTY);

      // Engine/connector logs (every REST request and response) go to stderr. The pretty
      // trace already shows each step and its error, so on a terminal they are only noise
      // in front of it; --verbose brings them back.
      const logger = wantJson || args.verbose ? (e: unknown) => console.error('[LOG]', e) : () => {};

      // --stop-before <action>: end the run before that action executes, printing the inputs it
      // would have been invoked with. Makes a local run safe before a write (create, update, send).
      const stopBefore = args['stop-before'] ? requireStringFlag(args, 'stop-before') : undefined;
      if (stopBefore && !flowHasAction(ir, stopBefore)) {
        throw new ArgError(`--stop-before: no action named '${stopBefore}' in ${ir.name}`);
      }

      // --mock <action>=<file.json> / --mocks <file.json>: the action does not run; its outputs are
      // the given JSON (for a connector/HTTP/child-flow action the full { statusCode, body } shape).
      const hasAction = (n: string) => flowHasAction(ir, n);
      const mocks = collectMocks(args, (f) => JSON.parse(readFileSync(resolve(f), 'utf-8')), hasAction);
      // --live <action>: deny-by-default for everything that calls out. With it, every connector,
      // HTTP and child-flow action must be mocked or listed, else the run ends before it.
      const live = args.live === undefined ? undefined : parseLiveFlags(args.live, hasAction, mocks);

      // --replay-run <runId>: pin every external action to what the cloud recorded for it (per loop
      // iteration, a failure as a failure), take the run's trigger outputs as input, and imply the
      // --live guard: an external action the run has no pin for stops the run unless listed.
      const replayRunId = args['replay-run'] ? requireStringFlag(args, 'replay-run') : undefined;
      let replay: Replay | undefined;
      let cloudRun: CloudRun | undefined;
      if (replayRunId) {
        const cloud = await connectFlowApi(args, 'run', {
          explicitId: args.id as string | undefined,
          decoratorWorkflowId: ir.workflowId,
          flowName: ir.name,
          isDsl: input.endsWith('.ts'),
          hasFile: true,
        });
        const liveFlow = await cloud.client.getFlow(cloud.target.workflowId);
        if (!liveFlow?.clientdata) {
          console.error(`Flow ${cloud.target.workflowId} has no clientdata (definition)`);
          process.exit(2);
        }
        const liveIr = parseLogicAppsToIR(JSON.parse(liveFlow.clientdata), { flowName: liveFlow.name || ir.name, config: loadCwdConfig(args) });
        try {
          cloudRun = await fetchCloudRun(cloud.flowApi, cloud.environmentId, cloud.flowApiId, replayRunId, liveIr);
        } catch (err) {
          exitOnFlowApiError(err);
          throw err;
        }
        replay = prepareReplay(cloudRun, ir, { live: live ?? new Set(), input: args.in ? payload : undefined, mockMap: mocks });
        for (const w of replay.warnings) console.error(w);
        console.error(describeReplay(cloudRun, replay));
        payload = replay.input;
      }
      const guard = replay
        ? createRunGuard({ stopBefore, live: live ?? new Set(), isMocked: replay.isMocked })
        : createRunGuard({ stopBefore, live, mocks });

      const result = await runEngine(ir, {
        connectors,
        input: payload,
        variables,
        parameterOverrides,
        logger,
        loadChildFlow,
        strictWorkflows: !!args['strict-workflows'],
        callbackUrl,
        environmentName: args['environment-id'] as string | undefined,
        onBeforeExecute: guard?.hook,
        mocks: replay ? replay.mocks : mocks,
      });
      if (cloudRun) (result as any).replayedRun = { runId: cloudRun.runId, status: cloudRun.status };

      // Why the run stopped early: the --live guard, or --stop-before.
      const deniedLive = guard?.deniedLive();
      if (result.stopped && result.stoppedBefore) {
        (result.stoppedBefore as any).reason = deniedLive ? 'live' : 'stop-before';
      }
      if (stopBefore && !result.stopped) {
        console.error(`[WARN] --stop-before: action '${stopBefore}' was never reached; the flow ran to the end`);
      }
      if (mocks) {
        const reached = mockedActionsInTrace(result.trace);
        for (const name of Object.keys(mocks)) {
          if (!reached.has(name)) console.error(`[WARN] --mock: action '${name}' was never reached, so its mock was not used`);
        }
      }

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
        for (const step of flattenTrace(result.trace)) {
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
      else {
        printPrettyRunResult(ir.name, result);
        if (result.stopped && result.stoppedBefore) {
          const { name, inputs } = result.stoppedBefore;
          if (deniedLive && replay) {
            console.log(`\n⏸  Stopped before '${name}' (--replay-run safe mode): it would call out, but the cloud run has no pin for it here and it is not listed as live. Nothing after it ran.`);
            console.log(`   Allow it with --live ${name}, or mock it (--mock ${name}=<outputs.json>).`);
          } else if (deniedLive) {
            console.log(`\n⏸  Stopped before '${name}' (--live): it would call out, but it is neither mocked nor listed as live. Nothing after it ran.`);
            console.log(`   Mock it (--mock ${name}=<outputs.json> or an entry in --mocks), or allow it with --live ${name}.`);
          } else {
            console.log(`\n⏸  Stopped before '${name}' (--stop-before). Nothing after it ran.`);
          }
          if (inputs !== undefined) console.log(`   Inputs it would have been invoked with:\n${JSON.stringify(inputs, null, 2).replace(/^/gm, '   ')}`);
        }
      }
      // 0 = Succeeded, 1 = Failed/Cancelled, 3 = stopped by --stop-before (the run is incomplete, not failed)
      process.exit(result.stopped ? 3 : result.status === 'Succeeded' ? 0 : 1);
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

      // For a single flow --out is the file path; create its folder like the
      // --solution/--all form creates its directory.
      const mainOutFile = outArg
        ? resolve(outArg)
        : resolve(outDir, `${sanitizeFlowName(flowName)}.ff.ts`);
      mkdirSync(dirname(mainOutFile), { recursive: true });

      await pullFlowRecursive(workflow.workflowid, flowName, clientdata, mainOutFile);

      break;
    }
    case 'push': {
      let create: boolean;
      let noCreate: boolean;
      let requireActive: boolean;
      let expectClean: boolean;
      let pushName: string | undefined;
      try {
        create = requireBooleanFlag(args, 'create');
        noCreate = requireBooleanFlag(args, 'no-create');
        requireActive = requireBooleanFlag(args, 'require-active');
        expectClean = requireBooleanFlag(args, 'expect-clean');
        pushName = requireStringFlag(args, 'name');
      } catch (err) {
        if (err instanceof ArgError) {
          console.error(err.message);
          process.exit(2);
        }
        throw err;
      }

      const explicitId = args.id as string | undefined;
      const file = args.file as string;
      const solution = args.solution as string | undefined;
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
      let flowName: string | undefined = pushName;
      let description: string | undefined;
      const fileExt = extname(file).toLowerCase();
      const isDsl = fileExt === '.ts';

      if (isDsl) {
        // DSL → compile to Logic Apps JSON on the fly
        console.log(`Compiling ${file} to Logic Apps JSON...`);
        const { transformFile } = await import('@flowforger/dsl-native');
        const ir = await transformFile(resolve(file));
        decoratorWorkflowId = ir.workflowId;
        flowName = ir.name;          // the IR name wins over --name for DSL sources
        description = ir.description;

        const cfg = loadEmitterConfig(args, 'flowforger.config.json');
        const def = emitLogicAppsJson(ir, cfg);
        clientdata = JSON.stringify(def, null, 2);
        console.log('Compiled successfully.');
      } else {
        // JSON file — read as-is
        clientdata = readFileSync(resolve(file), 'utf-8');
      }

      // --expect-clean compares with the same tolerance as diff (cwd config, if any).
      const pushConfig = loadCwdConfig(args);

      const client = new DataverseClient({ baseUrl: url, token });

      let result;
      try {
        result = await runPush(
          client,
          { clientdata, flowName, description, explicitId, decoratorWorkflowId, create, noCreate, solution, isDsl, expectClean, config: pushConfig },
          (msg) => console.log(msg),
        );
      } catch (err) {
        if (err instanceof PushError) {
          console.error(err.message);
          process.exit(2);
        }
        throw err;
      }

      if (result.action === 'patched') {
        console.log('Patched clientdata');
        // Say whether the flow is actually running: a push keeps the record's
        // state, and a flow that arrived as Draft stays off until activated.
        let state: ReturnType<typeof flowStateSummary>;
        try {
          const record = await client.getFlow(result.workflowId);
          state = flowStateSummary(record?.statecode, record?.statuscode, result.workflowId);
        } catch (err) {
          state = { active: false, text: `State: unknown (could not read the workflow record: ${(err as Error).message})` };
        }
        console.log(state.text);
        if (requireActive && !state.active) {
          console.error('--require-active: the flow is not Activated after the push');
          process.exit(1);
        }
        break;
      }

      console.log(
        result.lookedUp
          ? `Created flow '${result.name}' (${result.workflowId}) — no existing flow with this name was visible to you`
          : `Created flow '${result.name}' (${result.workflowId})`
      );
      if (result.solution) console.log(`Added to solution '${result.solution}'`);
      console.log(flowStateSummary(0, 1, result.workflowId).text);

      // Stamp the new GUID into the DSL so the next push is a plain update.
      // Best-effort: a failure here must not look like the create failed.
      if (isDsl) {
        const { writeFlowWorkflowId } = await import('./workflow-id-writeback.js');
        let written = false;
        try {
          written = writeFlowWorkflowId(resolve(file), result.workflowId);
        } catch (err) {
          console.warn(`WARNING: could not update ${file}: ${(err as Error).message}`);
        }
        if (written) {
          console.log(`Added workflowId to ${file}`);
        } else {
          console.log(`Add workflowId: "${result.workflowId}" to your @Flow decorator in ${file}`);
        }
      }
      if (requireActive) {
        console.error('--require-active: a created flow is always Draft; activate it, then push again');
        process.exit(1);
      }
      break;
    }
    case 'runs':
    case 'run-show': {
      let flowNameArg: string | undefined;
      let runId: string | undefined;
      let topArg: string | undefined;
      let statusArg: string | undefined;
      try {
        flowNameArg = requireStringFlag(args, 'name');
        runId = requireStringFlag(args, 'run');
        topArg = requireStringFlag(args, 'top');
        statusArg = requireStringFlag(args, 'status');
      } catch (err) {
        if (err instanceof ArgError) {
          console.error(err.message);
          process.exit(2);
        }
        throw err;
      }
      if (cmd === 'run-show' && !runId) {
        console.error('Required: --run <runId> (list them with flowforger runs)');
        process.exit(2);
      }
      const top = topArg === undefined ? 20 : Number(topArg);
      if (!Number.isInteger(top) || top < 1) {
        console.error(`--top must be a positive integer (got '${topArg}')`);
        process.exit(2);
      }

      const explicitId = args.id as string | undefined;
      const file = args.file as string | undefined;
      const wantJson = !!args.json || (!args.pretty && !process.stdout.isTTY);

      // Which flow: like push/diff — --id, the decorator workflowId of --file, then the name.
      let decoratorWorkflowId: string | undefined;
      let flowName = flowNameArg;
      const isDsl = !!file && extname(file).toLowerCase() === '.ts';
      if (isDsl) {
        const { transformFile } = await import('@flowforger/dsl-native');
        const ir = await transformFile(resolve(file!));
        decoratorWorkflowId = ir.workflowId;
        flowName = ir.name;
      }
      const { client, url, flowApi, environmentId, flowApiId, target } = await connectFlowApi(args, cmd, {
        explicitId, decoratorWorkflowId, flowName, isDsl, hasFile: !!file,
      });
      try {
        if (cmd === 'runs') {
          const runs = await flowApi.listRuns(environmentId, flowApiId, { top, status: statusArg });
          if (wantJson) {
            console.log(JSON.stringify({ workflowId: target.workflowId, flowId: flowApiId, environmentId, runs }, null, 2));
          } else {
            console.log(`Runs of '${flowName ?? target.workflowId}' (${runs.length}${statusArg ? `, status ${statusArg}` : ''}, newest first):`);
            for (const r of runs) {
              const err = r.error && typeof r.error === 'object' ? ` — ${(r.error as any).code ?? ''} ${(r.error as any).message ?? ''}`.trimEnd() : '';
              console.log(`  ${r.runId}  ${(r.status ?? '').padEnd(9)}  ${r.startTime ?? ''}  →  ${r.endTime ?? ''}${err}`);
            }
            if (runs.length) console.log(`Show one: flowforger run-show --run <runId> ${file ? `--file ${file}` : `--id ${target.workflowId}`} --auth`);
          }
          process.exit(0);
        }

        // run-show: the live definition gives the nesting; the Flow API gives every action's record.
        const live = await client.getFlow(target.workflowId);
        if (!live?.clientdata) {
          console.error(`Flow ${target.workflowId} has no clientdata (definition)`);
          process.exit(2);
        }
        const liveIr = parseLogicAppsToIR(JSON.parse(live.clientdata), { flowName: live.name || flowName, config: loadCwdConfig(args) });
        const result = await fetchCloudRun(flowApi, environmentId, flowApiId, runId!, liveIr);
        if (wantJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`Run ${runId} of '${live.name || flowName}': ${result.status} (${result.startTime ?? '?'} → ${result.endTime ?? '?'})`);
          for (const line of formatPrettyRunResult(live.name || flowName || target.workflowId, result, { color: !!process.stdout.isTTY && !process.env.NO_COLOR })) console.log(line);
        }
        process.exit(result.status === 'Succeeded' ? 0 : 1);
      } catch (err) {
        exitOnFlowApiError(err);
        throw err;
      }
    }
    case 'diff': {
      let diffName: string | undefined;
      try {
        diffName = requireStringFlag(args, 'name');
      } catch (err) {
        if (err instanceof ArgError) {
          console.error(err.message);
          process.exit(2);
        }
        throw err;
      }

      const explicitId = args.id as string | undefined;
      const file = args.file as string | undefined;
      let url = args.url as string;
      let token = (args.token as string) || process.env.DATAVERSE_TOKEN || '';

      if (args['auth']) {
        ({ url, token } = await acquireDataverseAuth(args, url, token, 'diff'));
      }

      if (!file || !url || !token) {
        console.error('Required: --file, --url (or --auth with config), and --token or DATAVERSE_TOKEN env or --auth');
        process.exit(2);
      }

      // Same convention as run: human output on a terminal, JSON when piped;
      // --pretty / --json force either. Progress goes to stderr so stdout stays jq-safe.
      const wantJson = !!args.json || (!args.pretty && !process.stdout.isTTY);
      const log = (msg: string) => console.error(msg);

      // The comparison tolerance (parity + parser.skipMetadataFields) from the cwd config and flags.
      const diffConfig = buildConfigFromFlags(args, loadCwdConfig(args));

      let clientdata: string;
      let decoratorWorkflowId: string | undefined;
      let flowName: string | undefined = diffName;
      const isDsl = extname(file).toLowerCase() === '.ts';

      if (isDsl) {
        // DSL → compile exactly as push would send it
        const { transformFile } = await import('@flowforger/dsl-native');
        const ir = await transformFile(resolve(file));
        decoratorWorkflowId = ir.workflowId;
        flowName = ir.name;
        const cfg = loadEmitterConfig(args, 'flowforger.config.json');
        clientdata = JSON.stringify(emitLogicAppsJson(ir, cfg));
      } else {
        clientdata = readFileSync(resolve(file), 'utf-8');
      }

      const client = new DataverseClient({ baseUrl: url, token });

      let outcome;
      try {
        outcome = await runDiff(client, { clientdata, flowName, explicitId, decoratorWorkflowId, isDsl, config: diffConfig }, log);
      } catch (err) {
        if (err instanceof PushError) {
          console.error(err.message);
          process.exit(2);
        }
        throw err;
      }

      const { report, workflowId, flowName: liveName } = outcome;
      if (wantJson) {
        console.log(JSON.stringify({ workflowId, flowName: liveName, file, ...report }, null, 2));
      } else {
        for (const line of formatDiffReport(report, { flowName: liveName, workflowId, file })) console.log(line);
      }
      process.exit(report.identical ? 0 : 1);
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
      let url = args.url as string;
      let token = (args.token as string) || process.env.DATAVERSE_TOKEN || '';
      const statecode = Number(args.state);
      const statuscode = Number(args.status);

      // --auth: acquire Dataverse token via MSAL (the URL may come from the config)
      if (args['auth']) {
        ({ url, token } = await acquireDataverseAuth(args, url, token, 'activate'));
      }

      if (!id || !url || !token || Number.isNaN(statecode) || Number.isNaN(statuscode)) {
        console.error('Required: --id, --url (or --auth with config), --token or DATAVERSE_TOKEN or --auth, --state, --status');
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
    case 'mcp': {
      const { startMcpServer } = await import('@flowforger/mcp-server');

      // Static token flags; --auth resolves the rest lazily per flow.
      const connectorOptions = {
        spToken: args['sp-token'] as string | undefined,
        dvUrl: args['dv-url'] as string | undefined,
        dvToken: args['dv-token'] as string | undefined,
        graphToken: args['graph-token'] as string | undefined,
        wordToken: args['word-token'] as string | undefined,
        excelToken: args['excel-token'] as string | undefined,
        onedriveToken: args['onedrive-token'] as string | undefined,
      };

      const budgetArg = args['budget'] ? Number(args['budget']) : undefined;

      // Scope resolution needs the flow IR, so auth is deferred to first start.
      const resolveAuth = args['auth']
        ? async (ir: FlowIR) => {
            const authConfig = loadAuthConfig(args);
            const scopes = await resolveRequiredScopes(ir, authConfig);
            const tokens = await acquireTokens(authConfig, scopes, (msg) => console.error(msg), {
              silentOnly: true,
            });
            return {
              graphToken: tokens.graph,
              spToken: tokens.sharepoint,
              dvToken: tokens.dataverse,
              dvUrl: tokens.dataverseUrl,
            };
          }
        : undefined;

      await startMcpServer({
        connectorOptions,
        defaultBudget: Number.isFinite(budgetArg) ? budgetArg : undefined,
        resolveAuth,
      });
      return;
    }
    case 'scopes': {
      const input = args._ as string | undefined;
      const wantAll = Boolean(args['all']);
      if (!input && !wantAll) return help();

      // Config is optional here: without one, SharePoint/Dataverse resources
      // are shown as placeholders so the command still answers "which
      // permissions do I add to the app registration".
      let authConfig: AuthConfig;
      try {
        authConfig = loadAuthConfig(args);
      } catch {
        authConfig = { clientId: '', tenantId: '' };
      }
      authConfig = {
        ...authConfig,
        resources: {
          sharepoint: authConfig.resources?.sharepoint ?? 'https://<tenant>.sharepoint.com',
          dataverse: authConfig.resources?.dataverse ?? 'https://<org>.crm.dynamics.com',
          ...(authConfig.resources?.flowservice ? { flowservice: authConfig.resources.flowservice } : {}),
        },
      };

      type ApiEntry = { api: string; appId: string; resource: string; scopes: string[]; connectors?: string[] };
      const entries: ApiEntry[] = [];
      let title: string;

      if (wantAll) {
        title = 'All delegated permissions FlowForger connectors can request';
        const byResource = new Map<keyof typeof RESOURCE_APIS, { scopes: Set<string>; connectors: Set<string> }>();
        for (const { connector, resource, scopes } of await collectAllConnectorScopes()) {
          if (!byResource.has(resource)) byResource.set(resource, { scopes: new Set(), connectors: new Set() });
          const slot = byResource.get(resource)!;
          for (const sc of scopes) slot.scopes.add(sc);
          slot.connectors.add(connector);
        }
        for (const [key, { scopes, connectors }] of byResource) {
          const api = RESOURCE_APIS[key];
          const resource = api.defaultResource ?? (authConfig.resources as any)[key];
          entries.push({ api: api.label, appId: api.appId, resource, scopes: [...scopes].sort(), connectors: [...connectors] });
        }
      } else {
        let ir: FlowIR;
        if (input!.endsWith('.ts')) {
          const { transformFile } = await import('@flowforger/dsl-native');
          ir = await transformFile(resolve(input!));
        } else {
          ir = JSON.parse(readFileSync(resolve(input!), 'utf-8'));
        }
        title = `Delegated permissions required by ${input}`;
        const scopesByResource = await resolveRequiredScopes(ir, authConfig);
        if (flowUsesListCallbackUrl(ir)) {
          const fs = authConfig.resources?.flowservice ?? RESOURCE_APIS.flowservice.defaultResource!;
          scopesByResource.set(fs, [`${fs}/User`]);
        }
        for (const [resource, scopes] of scopesByResource) {
          const key = resourceKeyForUrl(resource, authConfig);
          const api = key ? RESOURCE_APIS[key] : { label: resource, appId: '' };
          // Non-Graph scopes are resource-prefixed for MSAL; show the bare permission name.
          const bare = scopes.map((sc) => (sc.startsWith(`${resource}/`) ? sc.slice(resource.length + 1) : sc)).sort();
          entries.push({ api: api.label, appId: api.appId, resource, scopes: bare });
        }
      }

      if (args['json']) {
        console.log(JSON.stringify(entries, null, 2));
        break;
      }

      console.log(title);
      if (entries.length === 0) {
        console.log('\n  (none — this flow uses no connector that needs a token)');
        break;
      }
      for (const e of entries) {
        console.log('');
        console.log(e.appId ? `${e.api}  (App ID ${e.appId})` : e.api);
        if (e.resource !== e.api) console.log(`  resource: ${e.resource}`);
        if (e.connectors) console.log(`  used by:  ${e.connectors.join(', ')}`);
        for (const sc of e.scopes) console.log(`    ${sc}`);
      }
      console.log(`
Add these as Delegated permissions on the app registration (${authConfig.clientId || '<clientId>'}),
then grant admin consent. The CLI requests only the subset a given flow needs at run time.`);
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
  if (err instanceof ArgError) {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err);
  process.exit(1);
});
