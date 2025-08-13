#!/usr/bin/env node
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Proxy-stdio wrapper to run python CLI 'sdominanta-mcp'
// Usage: npx sdominanta-mcp --base <path>

const args = process.argv.slice(2);

const pythonCmd = process.env.SDOMINANTA_PYTHON || 'python';

// Prefer local server file if present to avoid network dependency; otherwise use GitHub raw
const REMOTE_BASE = process.env.SDOM_REMOTE || 'https://raw.githubusercontent.com/DumpKod/Sdominanta.net/main/Sdominanta.net';
const localServerPath = path.resolve(__dirname, '../../../mcp_server.py');

const bootstrap = `
import sys,os,urllib.request,subprocess

def ensure_deps():
  # Avoid pip noise breaking MCP stdio handshake
  os.environ.setdefault('PIP_DISABLE_PIP_VERSION_CHECK','1')
  try:
    import mcp.server.fastmcp  # type: ignore
    import jsonschema  # type: ignore
    import nacl  # type: ignore
  except Exception:
    try:
      subprocess.check_call(
        [sys.executable,'-m','pip','install','--user','mcp[cli]>=1.2.0','jsonschema>=4.19.0','PyNaCl>=1.5.0','rfc8785>=0.1.1'],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
      )
    except Exception as e:
      print('pip install failed:', e, file=sys.stderr)
      raise

def fetch(url_base, p):
  with urllib.request.urlopen(url_base.rstrip('/')+'/'+p) as r:
    return r.read().decode('utf-8')

def main_boot():
  ensure_deps()
  ns={}
  local=os.environ.get('SDOM_LOCAL_SERVER')
  code=None
  if local and os.path.exists(local):
    try:
      code=open(local,'r',encoding='utf-8').read()
    except Exception:
      code=None
  if not code:
    url=os.environ.get('SDOM_REMOTE') or '${REMOTE_BASE}'
    try:
      code=fetch(url,'mcp_server.py')
    except Exception as e:
      print('bootstrap fetch failed:', e, file=sys.stderr)
      raise
  exec(compile(code,'mcp_server.py','exec'),ns,ns)
  ns['main']()

if __name__=='__main__':
  main_boot()
`;

const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
if (fs.existsSync(localServerPath)) {
  env.SDOM_LOCAL_SERVER = localServerPath;
}

const child = spawn(pythonCmd, ['-c', bootstrap, ...args], {
  stdio: 'inherit',
  env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});


