/**
 * FlowForger VS Code Extension
 *
 * Provides language support for FlowForger DSL (.ff.ts) files:
 * - IntelliSense (autocomplete, hover, signatures)
 * - Diagnostics (errors, warnings)
 * - Snippets
 * - Commands (compile to IR, compile to Logic Apps JSON)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';
import { FlowForgerDebugAdapterFactory } from './debug-adapter.js';
import { transformCode } from '@flowforger/dsl-native';
import { emitLogicAppsJson } from '@flowforger/emitter-logicapps';
import type { FlowIR, Node } from '@flowforger/ir';
import { resolveRequiredScopes, acquireTokens, type AuthConfig } from './auth.js';

let client: LanguageClient | undefined;

/**
 * Activate the extension.
 */
export function activate(context: vscode.ExtensionContext): void {
  console.log('FlowForger extension activating...');

  // Start the language client
  startLanguageClient(context);

  // Register commands
  registerCommands(context);

  // Register debug adapter
  registerDebugAdapter(context);

  console.log('FlowForger extension activated');
}

/**
 * Deactivate the extension.
 */
export async function deactivate(): Promise<void> {
  if (client) {
    await client.stop();
    client = undefined;
  }
}

/**
 * Start the language client and connect to the LSP server.
 */
function startLanguageClient(context: vscode.ExtensionContext): void {
  // Check if language features are enabled
  const config = vscode.workspace.getConfiguration('flowforger');
  if (!config.get<boolean>('enable', true)) {
    console.log('FlowForger language features disabled');
    return;
  }

  // Path to the LSP server
  // In development, use the local build
  // In production (packaged extension), use bundled server
  const serverModule = getServerPath(context);

  if (!serverModule) {
    vscode.window.showWarningMessage(
      'FlowForger: Could not find language server. Some features may not work.'
    );
    return;
  }

  // Server options
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ['--nolazy', '--inspect=6009'],
      },
    },
  };

  // Client options
  const clientOptions: LanguageClientOptions = {
    // Register for FlowForger documents
    documentSelector: [
      { scheme: 'file', language: 'flowforger' },
      { scheme: 'file', pattern: '**/*.ff.ts' },
      // Also support regular TypeScript files with FlowForger code
      {
        scheme: 'file',
        language: 'typescript',
        pattern: '**/*.ff.ts',
      },
    ],
    synchronize: {
      // Watch for changes to .ff.ts files
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.ff.ts'),
    },
    outputChannelName: 'FlowForger',
  };

  // Create the language client
  client = new LanguageClient(
    'flowforger',
    'FlowForger Language Server',
    serverOptions,
    clientOptions
  );

  // Start the client (also starts the server)
  client.start();

  // Register status bar item
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.text = '$(zap) FlowForger';
  statusBarItem.tooltip = 'FlowForger Language Server';
  statusBarItem.command = 'flowforger.restartServer';
  context.subscriptions.push(statusBarItem);

  // Show status bar for .ff.ts files
  vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (editor && isFlowForgerFile(editor.document)) {
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  });

  // Check current editor
  if (
    vscode.window.activeTextEditor &&
    isFlowForgerFile(vscode.window.activeTextEditor.document)
  ) {
    statusBarItem.show();
  }
}

/**
 * Get the path to the LSP server module.
 */
function getServerPath(context: vscode.ExtensionContext): string | null {
  // Try multiple locations

  // 1. Bundled in extension (production)
  const bundledPath = context.asAbsolutePath(
    path.join('server', 'dist', 'index.js')
  );

  // 2. Monorepo sibling package (development)
  const monorepoPath = path.resolve(
    context.extensionPath,
    '..',
    'lsp-server',
    'dist',
    'index.js'
  );

  // 3. Workspace root packages (development)
  const workspaceFolders = vscode.workspace.workspaceFolders;
  let workspacePath: string | null = null;
  if (workspaceFolders && workspaceFolders.length > 0) {
    workspacePath = path.join(
      workspaceFolders[0].uri.fsPath,
      'packages',
      'lsp-server',
      'dist',
      'index.js'
    );
  }

  // Check which path exists
  const fs = require('fs');

  if (fs.existsSync(bundledPath)) {
    console.log(`Using bundled server: ${bundledPath}`);
    return bundledPath;
  }

  if (fs.existsSync(monorepoPath)) {
    console.log(`Using monorepo server: ${monorepoPath}`);
    return monorepoPath;
  }

  if (workspacePath && fs.existsSync(workspacePath)) {
    console.log(`Using workspace server: ${workspacePath}`);
    return workspacePath;
  }

  console.error('Could not find FlowForger LSP server');
  return null;
}

/**
 * Check if a document is a FlowForger file.
 */
function isFlowForgerFile(document: vscode.TextDocument): boolean {
  return (
    document.languageId === 'flowforger' ||
    document.fileName.endsWith('.ff.ts')
  );
}

/**
 * Register extension commands.
 */
function registerCommands(context: vscode.ExtensionContext): void {
  // Restart server command
  context.subscriptions.push(
    vscode.commands.registerCommand('flowforger.restartServer', async () => {
      if (client) {
        vscode.window.showInformationMessage(
          'FlowForger: Restarting language server...'
        );
        await client.stop();
        await client.start();
        vscode.window.showInformationMessage(
          'FlowForger: Language server restarted'
        );
      }
    })
  );

  // Compile to IR command
  context.subscriptions.push(
    vscode.commands.registerCommand('flowforger.compileToIR', () =>
      compileActiveFlow('ir')
    )
  );

  // Compile to Logic Apps JSON command
  context.subscriptions.push(
    vscode.commands.registerCommand('flowforger.compileToLogicApps', () =>
      compileActiveFlow('logicapps')
    )
  );
}

/**
 * Find and load flowforger.config.json for connection references, mirroring
 * the CLI's config resolution (workspace root first, then the flow file's
 * directory). Returns the `global` section, or undefined when no config exists.
 */
function loadEmitterConfig(filePath: string): any {
  const candidates = [
    ...(vscode.workspace.workspaceFolders ?? []).map((f) =>
      path.join(f.uri.fsPath, 'flowforger.config.json')
    ),
    path.join(path.dirname(filePath), 'flowforger.config.json'),
  ];
  const configPath = candidates.find((p) => fs.existsSync(p));
  if (!configPath) return undefined;
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  return raw.global || raw;
}

/**
 * Compile the active .ff.ts file in-process using the bundled compiler and
 * emitter, write the result next to the source file, and open it.
 */
async function compileActiveFlow(emit: 'ir' | 'logicapps'): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !isFlowForgerFile(editor.document)) {
    vscode.window.showWarningMessage(
      'FlowForger: Please open a .ff.ts file first'
    );
    return;
  }

  try {
    await editor.document.save();
    const filePath = editor.document.uri.fsPath;
    const ir = transformCode(editor.document.getText());

    const outputPath = filePath.replace(
      '.ff.ts',
      emit === 'logicapps' ? '.clientdata.json' : '.ir.json'
    );
    const output =
      emit === 'logicapps'
        ? emitLogicAppsJson(ir, loadEmitterConfig(filePath))
        : ir;
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

    const doc = await vscode.workspace.openTextDocument(outputPath);
    await vscode.window.showTextDocument(doc, { preview: true });
    vscode.window.showInformationMessage(
      `FlowForger: Compiled to ${path.basename(outputPath)}`
    );
  } catch (error: any) {
    vscode.window.showErrorMessage(
      `FlowForger: Compilation failed - ${error?.message ?? error}`
    );
  }
}

/**
 * Register the debug adapter for FlowForger flows.
 */
function registerDebugAdapter(context: vscode.ExtensionContext): void {
  // Register inline debug adapter factory
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory(
      'flowforger',
      new FlowForgerDebugAdapterFactory()
    )
  );

  // Register debug configuration provider for auto-fill
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider(
      'flowforger',
      new FlowForgerDebugConfigProvider()
    )
  );

  // Register debug command
  context.subscriptions.push(
    vscode.commands.registerCommand('flowforger.debugFlow', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !isFlowForgerFile(editor.document)) {
        vscode.window.showWarningMessage(
          'FlowForger: Please open a .ff.ts file first'
        );
        return;
      }
      await vscode.debug.startDebugging(undefined, {
        type: 'flowforger',
        request: 'launch',
        name: 'Debug FlowForger Flow',
        program: editor.document.uri.fsPath,
      });
    })
  );
}

/**
 * Fetch environment variable values from Dataverse and match them to flow parameters.
 *
 * Flow parameter names follow the convention: "Display Name (schema_name)"
 * We extract the schema name and match against environment variable definitions.
 * Current values take priority; falls back to definition defaultValue.
 */
async function fetchEnvironmentVariableOverrides(
  dataverseUrl: string,
  token: string,
  flowParameters: Record<string, any>,
  outputChannel: vscode.OutputChannel,
): Promise<Record<string, string>> {
  const baseUrl = dataverseUrl.replace(/\/$/, '');
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
  };

  // Extract schema names from flow parameter keys: "Display Name (schema_name)" -> "schema_name"
  const schemaNameMap = new Map<string, string>(); // schemaName -> paramKey
  for (const paramKey of Object.keys(flowParameters)) {
    const match = paramKey.match(/\(([^)]+)\)\s*$/);
    if (match) {
      schemaNameMap.set(match[1].toLowerCase(), paramKey);
    }
  }

  if (schemaNameMap.size === 0) return {};

  outputChannel.appendLine(`Fetching environment variables for ${schemaNameMap.size} parameter(s)...`);

  // Fetch definitions and values in parallel
  const [defsResponse, valsResponse] = await Promise.all([
    fetch(`${baseUrl}/api/data/v9.2/environmentvariabledefinitions?$select=environmentvariabledefinitionid,schemaname,defaultvalue`, { headers }),
    fetch(`${baseUrl}/api/data/v9.2/environmentvariablevalues?$select=value,_environmentvariabledefinitionid_value`, { headers }),
  ]);

  if (!defsResponse.ok) {
    throw new Error(`Failed to fetch env var definitions: ${defsResponse.status} ${defsResponse.statusText}`);
  }
  if (!valsResponse.ok) {
    throw new Error(`Failed to fetch env var values: ${valsResponse.status} ${valsResponse.statusText}`);
  }

  const defs: { value: Array<{ environmentvariabledefinitionid: string; schemaname: string; defaultvalue?: string }> } = await defsResponse.json() as any;
  const vals: { value: Array<{ value: string; _environmentvariabledefinitionid_value: string }> } = await valsResponse.json() as any;

  // Build value lookup: definitionId -> current value
  const currentValues = new Map<string, string>();
  for (const v of vals.value) {
    currentValues.set(v._environmentvariabledefinitionid_value, v.value);
  }

  // Match definitions to flow parameters
  const overrides: Record<string, string> = {};
  for (const def of defs.value) {
    const paramKey = schemaNameMap.get(def.schemaname.toLowerCase());
    if (!paramKey) continue;

    // Current value takes priority over default
    const value = currentValues.get(def.environmentvariabledefinitionid) ?? def.defaultvalue;
    if (value !== undefined && value !== null) {
      overrides[paramKey] = value;
      outputChannel.appendLine(`  ${def.schemaname} = ${value.length > 60 ? value.substring(0, 60) + '...' : value}`);
    }
  }

  return overrides;
}

/**
 * Resolve child flow .ff.ts files from workflow actions and compile them to IR.
 * Scans recursively (child of child) to collect all connector requirements.
 */
function resolveChildFlowIRs(ir: FlowIR, parentFilePath: string, visited = new Set<string>()): FlowIR[] {
  const parentDir = path.dirname(parentFilePath);
  const results: FlowIR[] = [];

  function collectWorkflowRefs(nodes: Node[]): string[] {
    const refs: string[] = [];
    for (const node of nodes) {
      if (node.type === 'action' && (node as any).kind === 'workflow') {
        const ref = (node as any).inputs?.workflowReferenceName;
        if (ref) refs.push(ref);
      }
      if ('actions' in node && Array.isArray((node as any).actions)) {
        refs.push(...collectWorkflowRefs((node as any).actions));
      }
      if ('elseActions' in node && Array.isArray((node as any).elseActions)) {
        refs.push(...collectWorkflowRefs((node as any).elseActions));
      }
      if ('defaultActions' in node && Array.isArray((node as any).defaultActions)) {
        refs.push(...collectWorkflowRefs((node as any).defaultActions));
      }
      if ('cases' in node && Array.isArray((node as any).cases)) {
        for (const c of (node as any).cases) {
          if (Array.isArray(c.actions)) refs.push(...collectWorkflowRefs(c.actions));
        }
      }
    }
    return refs;
  }

  for (const ref of collectWorkflowRefs(ir.nodes)) {
    // Try childFlows config first, then convention fallback
    let childPath: string | null = null;
    if (ir.childFlows) {
      const def = ir.childFlows[ref];
      if (def?.dslPath) {
        const resolved = path.resolve(parentDir, def.dslPath);
        if (fs.existsSync(resolved)) childPath = resolved;
      }
    }
    if (!childPath) {
      const conventionPath = path.resolve(parentDir, `${ref}.ff.ts`);
      if (fs.existsSync(conventionPath)) childPath = conventionPath;
    }

    if (childPath && !visited.has(childPath)) {
      visited.add(childPath);
      try {
        const childSource = fs.readFileSync(childPath, 'utf-8');
        const childIR = transformCode(childSource);
        results.push(childIR);
        // Recurse into child's children
        results.push(...resolveChildFlowIRs(childIR, childPath, visited));
      } catch {
        // Skip child flows that fail to compile
      }
    }
  }

  return results;
}

/**
 * Debug configuration provider — auto-fills launch config and acquires auth tokens.
 */
class FlowForgerDebugConfigProvider implements vscode.DebugConfigurationProvider {
  resolveDebugConfiguration(
    _folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): vscode.ProviderResult<vscode.DebugConfiguration> {
    // If no config at all (user hit F5 with no launch.json)
    if (!config.type && !config.request && !config.name) {
      const editor = vscode.window.activeTextEditor;
      if (editor && isFlowForgerFile(editor.document)) {
        config.type = 'flowforger';
        config.request = 'launch';
        config.name = 'Debug FlowForger Flow';
        config.program = editor.document.uri.fsPath;
        config.stopOnEntry = false;
      }
    }

    if (!config.program) {
      return vscode.window.showInformationMessage(
        'Cannot find a .ff.ts file to debug'
      ).then(() => undefined);
    }

    return config;
  }

  async resolveDebugConfigurationWithSubstitutedVariables(
    folder: vscode.WorkspaceFolder | undefined,
    config: vscode.DebugConfiguration,
    _token?: vscode.CancellationToken
  ): Promise<vscode.DebugConfiguration | undefined> {
    if (!config.auth) return config;

    try {
      // Find flowforger.config.json
      let configPath = config.config;
      if (!configPath) {
        // Default: look in workspace root, then flow file's directory
        const candidates = [
          folder ? path.join(folder.uri.fsPath, 'flowforger.config.json') : '',
          path.join(path.dirname(path.resolve(config.program)), 'flowforger.config.json'),
        ].filter(Boolean);

        configPath = candidates.find((p) => fs.existsSync(p));
      } else if (!path.isAbsolute(configPath)) {
        // Resolve relative to workspace root or flow file directory
        if (folder) {
          configPath = path.resolve(folder.uri.fsPath, configPath);
        } else {
          configPath = path.resolve(path.dirname(config.program), configPath);
        }
      }

      if (!configPath || !fs.existsSync(configPath)) {
        vscode.window.showErrorMessage(
          'FlowForger: flowforger.config.json not found. Required for auth.'
        );
        return undefined;
      }

      const flowConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const authConfig: AuthConfig = flowConfig.auth;
      if (!authConfig?.clientId || !authConfig?.tenantId) {
        vscode.window.showErrorMessage(
          'FlowForger: auth.clientId and auth.tenantId required in flowforger.config.json'
        );
        return undefined;
      }

      // Compile DSL to determine which connectors need tokens
      const programPath = path.resolve(config.program);
      const sourceContent = fs.readFileSync(programPath, 'utf-8');
      const ir = transformCode(sourceContent);

      // Also scan child flow files for connector requirements
      const childIRs = resolveChildFlowIRs(ir, programPath);
      const mergedIR = { ...ir, nodes: [...ir.nodes, ...childIRs.flatMap(c => c.nodes)] };
      const scopesByResource = resolveRequiredScopes(mergedIR, authConfig);

      if (scopesByResource.size === 0) {
        return config; // No connectors that need auth
      }

      // Acquire tokens (with progress indicator)
      const outputChannel = vscode.window.createOutputChannel('FlowForger Auth');
      const tokens = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'FlowForger: Acquiring tokens...',
          cancellable: false,
        },
        async () => {
          return acquireTokens(authConfig, scopesByResource, {
            onLog: (msg) => outputChannel.appendLine(msg),
            onDeviceCode: async (info) => {
              outputChannel.appendLine(info.message);
              outputChannel.show(true);
              // Copy code to clipboard and offer to open browser
              await vscode.env.clipboard.writeText(info.userCode);
              const action = await vscode.window.showInformationMessage(
                `FlowForger Auth: Enter code ${info.userCode} (copied to clipboard)`,
                'Open Browser'
              );
              if (action === 'Open Browser') {
                vscode.env.openExternal(vscode.Uri.parse(info.verificationUri));
              }
            },
          });
        }
      );

      // Inject acquired tokens into the launch config
      if (tokens.graph && !config.graphToken) config.graphToken = tokens.graph;
      if (tokens.sharepoint && !config.spToken) config.spToken = tokens.sharepoint;
      if (tokens.dataverse && !config.dvToken) {
        config.dvToken = tokens.dataverse;
        if (tokens.dataverseUrl && !config.dvUrl) config.dvUrl = tokens.dataverseUrl;
      }

      // Fetch environment variable values from Dataverse and inject as parameter overrides
      // Merge parameters from main flow and all child flows
      const dvToken = config.dvToken || tokens.dataverse;
      const dvUrl = config.dvUrl || tokens.dataverseUrl || authConfig.resources?.dataverse;
      const allParameters: Record<string, any> = { ...(ir.parameters || {}) };
      for (const childIR of childIRs) {
        if (childIR.parameters) Object.assign(allParameters, childIR.parameters);
      }
      if (dvToken && dvUrl && Object.keys(allParameters).length > 0) {
        try {
          const envVarOverrides = await fetchEnvironmentVariableOverrides(dvUrl, dvToken, allParameters, outputChannel);
          if (Object.keys(envVarOverrides).length > 0) {
            config.parameters = { ...(config.parameters || {}), ...envVarOverrides };
            outputChannel.appendLine(`Resolved ${Object.keys(envVarOverrides).length} environment variable(s) from Dataverse`);
          }
        } catch (err: any) {
          outputChannel.appendLine(`Warning: Could not fetch environment variables: ${err.message}`);
        }
      }

      return config;
    } catch (err: any) {
      vscode.window.showErrorMessage(`FlowForger Auth: ${err.message}`);
      return undefined;
    }
  }
}
