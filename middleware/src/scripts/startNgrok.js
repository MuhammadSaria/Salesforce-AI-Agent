import 'dotenv/config';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const port = Number(process.env.PORT || 3000);
const ngrokPath = process.env.NGROK_BIN || 'node_modules/ngrok/bin/ngrok.exe';
const args = ['http', String(port), '--log=stdout'];

if (process.env.NGROK_AUTHTOKEN) {
  args.push('--authtoken', process.env.NGROK_AUTHTOKEN);
}

const child = spawn(ngrokPath, args, {
  shell: false,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe']
});

let printed = false;
const timer = setInterval(async () => {
  if (printed) {
    return;
  }
  const url = await readPublicUrl();
  if (url) {
    printed = true;
    await writeFile('.ngrok-url', `${url}\n`, 'utf8');
    console.log(`ngrok tunnel: ${url}`);
    console.log('Use this as the Agent_Middleware Named Credential URL.');
  }
}, 1000);

child.stdout.on('data', (chunk) => process.stdout.write(chunk));
child.stderr.on('data', (chunk) => process.stderr.write(chunk));
child.on('exit', (code) => {
  clearInterval(timer);
  process.exit(code || 0);
});

async function readPublicUrl() {
  try {
    const response = await fetch('http://127.0.0.1:4040/api/tunnels');
    const payload = await response.json();
    const tunnel = payload.tunnels?.find((item) => item.proto === 'https') || payload.tunnels?.[0];
    return tunnel?.public_url || '';
  } catch {
    return '';
  }
}

const shutdown = () => {
  clearInterval(timer);
  child.kill('SIGTERM');
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
