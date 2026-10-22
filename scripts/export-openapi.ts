import fs from 'node:fs';
import path from 'node:path';
import { openapiSpec } from '../src/docs/openapi';

const out = path.resolve(__dirname, '../docs/openapi.json');
fs.writeFileSync(out, JSON.stringify(openapiSpec, null, 2) + '\n');
console.log(`Wrote ${out}`);
