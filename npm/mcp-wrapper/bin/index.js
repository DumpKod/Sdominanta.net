#!/usr/bin/env node
const { spawn } = require('child_process');

// Proxy-stdio wrapper to run python CLI 'sdominanta-mcp'
// Usage: npx @sdominanta/mcp --base <path>

const args = process.argv.slice(2);

const pythonCmd = process.env.SDOMINANTA_PYTHON || 'python';

// Bootstrap: fetch python server from GitHub raw and exec without requiring pip install
const REMOTE_BASE = process.env.SDOM_REMOTE || 'https://raw.githubusercontent.com/DumpKod/Sdominanta.net/main/Sdominanta.net';
const bootstrap = `
import sys,os,urllib.request
ns={}
url=os.environ.get('SDOM_REMOTE') or '${REMOTE_BASE}'
def fetch(p):
  with urllib.request.urlopen(url.rstrip('/')+'/'+p) as r:
    return r.read().decode('utf-8')
code=fetch('mcp_server.py')
exec(compile(code,'mcp_server.py','exec'),ns,ns)
ns['main']()
`;

const child = spawn(pythonCmd, ['-c', bootstrap, ...args], {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});


