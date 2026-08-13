import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { executeSpecialistModel } from '../src/services/modelExecutor.js';

test('specialist model execution fails closed when the configured backend is unavailable', async (t) => {
  const original = config.agentBackend;
  config.agentBackend = 'unavailable';
  t.after(() => { config.agentBackend = original; });

  await assert.rejects(
    () => executeSpecialistModel({ specialistId: 'FLOW' }),
    (error) => error.code === 'SPECIALIST_MODEL_UNAVAILABLE'
  );
});
