import IORedis from 'ioredis';
import { config } from '../config.js';

export const redisConnection =
  config.queueDriver === 'redis'
    ? new IORedis(config.redisUrl, {
        maxRetriesPerRequest: null
      })
    : null;

export const redis = config.queueDriver === 'redis' ? new IORedis(config.redisUrl) : null;
