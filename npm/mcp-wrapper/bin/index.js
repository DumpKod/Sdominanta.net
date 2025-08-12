#!/usr/bin/env node
const { spawn } = require('child_process');

// Proxy-stdio wrapper to run python CLI 'sdominanta-mcp'
// Usage: npx @sdominanta/mcp --base <path>

const args = process.argv.slice(2);

const pythonCmd = process.env.SDOMINANTA_PYTHON || 'python';
const cliArgs = ['-m', 'sdominanta_mcp_entry'];

// We rely on Python package exposing module 'sdominanta_mcp_entry'
// which runs mcp_server.main(), accepting same args (--base ...)
const child = spawn(pythonCmd, [...cliArgs, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});


