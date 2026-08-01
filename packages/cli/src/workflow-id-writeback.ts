import { readFileSync, writeFileSync } from 'node:fs';
import { setFlowWorkflowIdInSource } from '@flowforger/dsl-native';

/**
 * Read a DSL file, stamp the workflowId into its @Flow decorator, and write it
 * back. Returns false when there was no editable decorator; the file is left
 * untouched in that case.
 *
 * This wrapper lives in the CLI rather than in @flowforger/dsl-native because
 * that package's entry point is bundled for the browser by the web app, and a
 * `node:fs` import anywhere reachable from it breaks the Vite build. The pure
 * string transform stays in dsl-native; only the filesystem I/O is here.
 */
export function writeFlowWorkflowId(filePath: string, workflowId: string): boolean {
  const source = readFileSync(filePath, 'utf-8');
  const updated = setFlowWorkflowIdInSource(source, workflowId);
  if (updated === null) return false;
  writeFileSync(filePath, updated, 'utf-8');
  return true;
}
