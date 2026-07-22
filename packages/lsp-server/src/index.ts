#!/usr/bin/env node
/**
 * FlowForger LSP Server Entry Point
 *
 * This is the main entry point for the language server.
 * It can be invoked directly via Node.js or as a VS Code extension server.
 *
 * Usage:
 *   node packages/lsp-server/dist/index.js --stdio
 *   flowforger-lsp --stdio
 */

import './server.js';
