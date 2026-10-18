import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { contractSchemas } from '../src/server/contracts/conversation.js';

mkdirSync('contracts/conversation/v1', { recursive: true });
for (const [name, schema] of Object.entries(contractSchemas)) {
  writeFileSync(`contracts/conversation/v1/${name}.schema.json`, JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12' }), null, 2) + '\n');
}
