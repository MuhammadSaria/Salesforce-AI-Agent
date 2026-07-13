import { RedisMemoryServer } from 'redis-memory-server';

const port = Number(process.env.REDISMS_PORT || 6379);
const redisServer = new RedisMemoryServer({
  instance: {
    port,
    ip: '127.0.0.1'
  }
});

const host = await redisServer.getHost();
const resolvedPort = await redisServer.getPort();

console.log(`Redis server listening at redis://${host}:${resolvedPort}`);

const keepAlive = setInterval(() => {}, 60_000);

const shutdown = async () => {
  clearInterval(keepAlive);
  await redisServer.stop();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
