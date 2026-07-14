import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import ngrok from '@ngrok/ngrok';

const port = Number(process.env.PORT || 3000);
const listener = await ngrok.forward({ addr: port, authtoken_from_env: true });
const url = listener.url();
await writeFile('.ngrok-url', `${url}\n`, { encoding: 'utf8', mode: 0o600 });
console.log(`ngrok tunnel: ${url}`);
console.log('Use this as the Agent_Middleware Named Credential URL.');
const keepAlive = setInterval(() => {}, 60_000);

const shutdown = async () => {
  clearInterval(keepAlive);
  await listener.close();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
