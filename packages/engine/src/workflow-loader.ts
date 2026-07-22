import type { FlowIR } from '@flowforger/ir';

// Check if running in Node.js environment
const isNode = typeof process !== 'undefined' && process.versions != null && process.versions.node != null;

// Lazy-loaded Node.js modules (only available in Node.js)
let fsPromises: any = null;
let fsSync: any = null;
let pathModule: any = null;

/**
 * Lazy load Node.js modules only when needed
 */
async function ensureNodeModules() {
  if (!isNode) {
    return false;
  }

  if (!fsPromises) {
    fsPromises = await import('fs/promises');
    fsSync = await import('fs');
    pathModule = await import('path');
  }

  return true;
}

export interface WorkflowLoaderConfig {
  /**
   * Path to workflow mapping config file (flowforger.workflows.json)
   * Maps workflow GUIDs to local file paths
   */
  configPath?: string;

  /**
   * Directory to search for workflows using convention-based naming
   * Looks for files like {workflowId}.ir.json
   */
  workflowsDir?: string;

  /**
   * Custom loader function (used by web app to integrate IndexedDB)
   * If provided, this is called before file-based lookups
   */
  customLoader?: (workflowId: string) => Promise<FlowIR | null>;

  /**
   * Dataverse configuration for remote workflow fetching
   */
  dataverse?: {
    url: string;
    token: string;
    /**
     * Optional cache directory for saving fetched workflows
     */
    cacheDir?: string;
  };

  /**
   * Strict mode: throw error if workflow not found
   * Non-strict mode: return null and let caller handle gracefully
   */
  strict?: boolean;
}

interface WorkflowMapping {
  workflows: Record<string, string>; // GUID -> file path
}

export class WorkflowLoader {
  private config: WorkflowLoaderConfig;
  private cache: Map<string, FlowIR> = new Map();
  private configMapping?: WorkflowMapping;

  constructor(config: WorkflowLoaderConfig = {}) {
    this.config = config;
  }

  /**
   * Load a workflow by its GUID or reference name
   * Resolution order:
   * 1. Memory cache
   * 2. Custom loader (if provided)
   * 3. Config file mapping
   * 4. Convention-based lookup in workflowsDir
   * 5. Dataverse fetch (if configured)
   */
  async loadWorkflow(workflowId: string): Promise<FlowIR | null> {
    // Check cache first
    if (this.cache.has(workflowId)) {
      return this.cache.get(workflowId)!;
    }

    // Try custom loader (for web app IndexedDB integration)
    if (this.config.customLoader) {
      const flow = await this.config.customLoader(workflowId);
      if (flow) {
        this.cache.set(workflowId, flow);
        return flow;
      }
    }

    // Try config file mapping
    const configFlow = await this.loadFromConfig(workflowId);
    if (configFlow) {
      this.cache.set(workflowId, configFlow);
      return configFlow;
    }

    // Try convention-based lookup
    const conventionFlow = await this.loadFromConvention(workflowId);
    if (conventionFlow) {
      this.cache.set(workflowId, conventionFlow);
      return conventionFlow;
    }

    // Try Dataverse fetch
    if (this.config.dataverse) {
      const dataverseFlow = await this.loadFromDataverse(workflowId);
      if (dataverseFlow) {
        this.cache.set(workflowId, dataverseFlow);

        // Optionally cache to disk
        if (this.config.dataverse.cacheDir) {
          await this.saveToDisk(workflowId, dataverseFlow);
        }

        return dataverseFlow;
      }
    }

    // Not found
    if (this.config.strict) {
      throw new Error(`Workflow not found: ${workflowId}`);
    }

    return null;
  }

  /**
   * Load from config file mapping
   */
  private async loadFromConfig(workflowId: string): Promise<FlowIR | null> {
    if (!this.config.configPath || !(await ensureNodeModules())) {
      return null;
    }

    // Load config mapping if not already loaded
    if (!this.configMapping) {
      try {
        const configContent = await fsPromises.readFile(this.config.configPath, 'utf-8');
        this.configMapping = JSON.parse(configContent);
      } catch (error) {
        // Config file doesn't exist or invalid JSON
        return null;
      }
    }

    // Look up workflow path in mapping
    const filePath = this.configMapping?.workflows[workflowId];
    if (!filePath) {
      return null;
    }

    // Resolve relative paths from config file location
    const configDir = pathModule.resolve(this.config.configPath, '..');
    const absolutePath = pathModule.resolve(configDir, filePath);

    return this.loadFromFile(absolutePath);
  }

  /**
   * Load using convention-based file naming: {workflowId}.ir.json
   */
  private async loadFromConvention(workflowId: string): Promise<FlowIR | null> {
    if (!this.config.workflowsDir || !(await ensureNodeModules())) {
      return null;
    }

    const filePath = pathModule.join(this.config.workflowsDir, `${workflowId}.ir.json`);
    return this.loadFromFile(filePath);
  }

  /**
   * Load workflow from file system
   */
  private async loadFromFile(filePath: string): Promise<FlowIR | null> {
    if (!(await ensureNodeModules())) {
      return null;
    }

    if (!fsSync.existsSync(filePath)) {
      return null;
    }

    try {
      const content = await fsPromises.readFile(filePath, 'utf-8');
      const flow: FlowIR = JSON.parse(content);
      return flow;
    } catch (error) {
      // Invalid JSON or read error
      return null;
    }
  }

  /**
   * Fetch workflow from Dataverse
   */
  private async loadFromDataverse(workflowId: string): Promise<FlowIR | null> {
    if (!this.config.dataverse) {
      return null;
    }

    try {
      const { url, token } = this.config.dataverse;

      // Fetch workflow definition from Dataverse Web API
      const response = await fetch(
        `${url}/api/data/v9.2/workflows(${workflowId})?$select=clientdata`,
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json',
            'OData-MaxVersion': '4.0',
            'OData-Version': '4.0',
          },
        }
      );

      if (!response.ok) {
        return null;
      }

      const data = await response.json();
      const clientdata = data.clientdata;

      if (!clientdata) {
        return null;
      }

      // Convert Logic Apps JSON to IR
      // For now, we expect the workflow to already be in IR format
      // In a full implementation, you might need to convert from Logic Apps JSON
      const flow: FlowIR = typeof clientdata === 'string'
        ? JSON.parse(clientdata)
        : clientdata;

      return flow;
    } catch (error) {
      return null;
    }
  }

  /**
   * Save fetched workflow to disk cache
   */
  private async saveToDisk(workflowId: string, flow: FlowIR): Promise<void> {
    if (!this.config.dataverse?.cacheDir || !(await ensureNodeModules())) {
      return;
    }

    try {
      const { cacheDir } = this.config.dataverse;

      // Ensure cache directory exists
      if (!fsSync.existsSync(cacheDir)) {
        await fsPromises.mkdir(cacheDir, { recursive: true });
      }

      const filePath = pathModule.join(cacheDir, `${workflowId}.ir.json`);
      await fsPromises.writeFile(filePath, JSON.stringify(flow, null, 2), 'utf-8');
    } catch (error) {
      // Silently fail if we can't cache to disk
      // The workflow is still available in memory cache
    }
  }

  /**
   * Clear the in-memory cache
   */
  clearCache(): void {
    this.cache.clear();
    this.configMapping = undefined;
  }

  /**
   * Pre-load a workflow into cache (useful for testing)
   */
  setWorkflow(workflowId: string, flow: FlowIR): void {
    this.cache.set(workflowId, flow);
  }
}
