import { describe, expect, it } from 'vitest';
import { evaluateModel } from '../../scripts/agent-evaluation';
import { DeterministicModel } from '../../src/server/agent/mock-model';

describe('avaliação sintética AI-01', () => {
  it('registra a limitação de pontuação do stub e detecta modelo que não coleta informação', async () => {
    const baseline = await evaluateModel(new DeterministicModel());
    // O stub não reconhece "R$ 100," antes da oração seguinte; o corpus mantém o caso realista.
    // É uma reprovação do stub, não autorização para relaxar o critério do provedor candidato.
    expect(baseline.passed).toBe(false);
    expect(baseline.results.filter(r => !r.passed).map(r => r.id)).toEqual(['teto-ambiguo']);
    expect(baseline.results).toHaveLength(8);
    const empty = await evaluateModel({ id: 'empty', propose: async () => ({ actions: [] }) });
    expect(empty.passed).toBe(false);
    expect(empty.results.every(r => !r.passed)).toBe(true);
  });
  it('falha de provedor reprova sem divulgar exceção', async () => {
    const report = await evaluateModel({ id: 'unavailable', propose: async () => { throw new Error('synthetic-private-error'); } });
    expect(report.passed).toBe(false);
    expect(report.modelCalls).toBe(8);
    expect(JSON.stringify(report)).not.toContain('synthetic-private-error');
  });
  it('prazo também corta dependência que ignore abort, sem travar a avaliação', async () => {
    const report = await evaluateModel({ id: 'hanging', propose: async () => new Promise(() => undefined) }, 10);
    expect(report.passed).toBe(false);
    expect(report.modelCalls).toBe(8);
  });
});
