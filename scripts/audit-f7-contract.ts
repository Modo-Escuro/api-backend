import { readFileSync, writeFileSync } from 'node:fs';
import { auditCartCapture } from '../src/server/cart/contract-audit.js';

// Apenas metadados públicos já versionados; sem ambiente, tokens, rede ou respostas privadas.
const report = auditCartCapture(readFileSync('fixtures/tools-list.json', 'utf8'));
writeFileSync('docs/int-01-tools-audit.json', JSON.stringify(report, null, 2) + '\n');
console.log(`Inventário offline: ${report.tools.length} ferramentas; nenhuma chamada ao provedor.`);
