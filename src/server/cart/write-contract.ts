import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import { contentHash } from '../contracts/guards.js';
import { CartError, assertMutationConfirmation, parseCreatedCart, parseSnapshot, type CartGateway } from './contracts.js';
import type { WriteStep, WriteTool } from './write-store.js';

export interface CartContractGate { verify(gateway: CartGateway, tools: WriteTool[], calls?: WriteStep[]): Promise<void> }
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const evidenceSchema = z.object({
  version: z.literal(1), endpoint: z.literal('https://consumer-mcp.ifood.com.br/marketplace'),
  source: z.literal('OBSERVED_AUTHENTICATED'), businessToolsCalled: z.literal(true), parserSha256: sha,
  tools: z.array(z.object({ name: z.enum(['getCart','createCart','addItemToCart','updateCartItem','removeItemFromCart']),
    inputSchemaSha256: sha, observedAt: z.iso.datetime(), samplePath: z.string().min(1), sampleSha256: sha }).strict()).min(1).max(5),
}).strict();

/** A declaração do operador é evidência com origem explícita; nunca nasce de flags, modelo ou tools/list. */
export class ObservedCartContract implements CartContractGate {
  constructor(private readonly evidenceFile: string) {}
  async verify(gateway: CartGateway, tools: WriteTool[], calls: WriteStep[] = []) {
    try {
      const file = resolve(this.evidenceFile), evidence = evidenceSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
      const parser = readFileSync(new URL('./contracts.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
      if (createHash('sha256').update(parser).digest('hex') !== evidence.parserSha256 || !gateway.describe || !gateway.writeConfirmed) throw new Error();
      const advertised = await gateway.describe();
      for (const name of new Set(['getCart', ...tools])) {
        const proof = evidence.tools.filter(t => t.name === name), metadata = advertised.filter(t => t.name === name);
        if (proof.length !== 1 || metadata.length !== 1 || contentHash(metadata[0]!.inputSchema) !== proof[0]!.inputSchemaSha256) throw new Error();
        const sample = JSON.parse(readFileSync(resolve(dirname(file), proof[0]!.samplePath), 'utf8'));
        if (contentHash(sample) !== proof[0]!.sampleSha256) throw new Error();
        if (name === 'getCart') parseSnapshot(sample);
        else if (name === 'createCart') parseCreatedCart(sample);
        else assertMutationConfirmation(sample);
        const validate = new AjvJsonSchemaValidator().getValidator(metadata[0]!.inputSchema as JsonSchemaType);
        if (calls.filter(c => c.tool === name).some(c => !validate(c.args).valid)) throw new Error();
      }
    } catch {
      throw new CartError('CART_CONTRACT_UNVERIFIED', 'Saídas reais e schemas desta operação ainda não estão validados. Nenhuma escrita foi autorizada.', 503);
    }
  }
}
