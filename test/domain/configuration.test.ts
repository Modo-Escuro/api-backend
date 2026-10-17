import { describe, expect, it } from 'vitest';
import { cheapestRequiredSelection, validateSelection } from '../../src/server/domain/configuration';
import { item, optionId, rawItem } from './helpers';
import { normalizeItemDetail } from '../../src/server/domain/normalize';

describe('validateSelection (min/max reais)', () => {
  const pizza = item('Promoção pizza grande');

  it('2 sabores em grupo 2–2 ⇒ VALID', () => {
    const v = validateSelection(pizza, [{ optionId: optionId(pizza, 'Margherita') }, { optionId: optionId(pizza, 'Calabria') }]);
    expect(v.status).toBe('VALID');
    expect(v.groups[0]).toMatchObject({ min: 2, max: 2, selectedCount: 2, required: true });
  });

  it('abaixo do mínimo e acima do máximo ⇒ INVALID', () => {
    expect(validateSelection(pizza, [{ optionId: optionId(pizza, 'Margherita') }]).issues.map((i) => i.code)).toEqual(['BELOW_MIN']);
    const three = ['Margherita', 'Calabria', 'Gigione'].map((n) => ({ optionId: optionId(pizza, n) }));
    expect(validateSelection(pizza, three)).toMatchObject({ status: 'INVALID', issues: [{ code: 'ABOVE_MAX' }] });
  });

  it('optionId que não existe no item ⇒ INVALID (nunca aceito)', () => {
    const v = validateSelection(pizza, [{ optionId: '00000000-0000-4000-8000-000000000000' }]);
    expect(v.issues.map((i) => i.code)).toContain('UNKNOWN_OPTION');
  });

  it('opção bloqueada por restrição ⇒ INVALID', () => {
    const presunto = optionId(pizza, 'Presunto');
    const v = validateSelection(pizza, [{ optionId: presunto }, { optionId: optionId(pizza, 'Margherita') }], new Set([presunto]));
    expect(v.status).toBe('INVALID');
    expect(v.issues[0]!.code).toBe('BLOCKED_OPTION');
  });

  describe('opções repetidas (min/max por distintas ou por unidades: não informado)', () => {
    it('1 sabor ×2 em grupo 2–2: mínimo só atingido contando repetição ⇒ UNKNOWN, nunca VALID', () => {
      const v = validateSelection(pizza, [{ optionId: optionId(pizza, 'Margherita'), quantity: 2 }]);
      expect(v.status).toBe('UNKNOWN');
      expect(v.groups[0]).toMatchObject({ selectedCount: 1, selectedUnits: 2 });
      expect(v.issues.map((i) => i.code).sort()).toEqual(['LIMIT_SEMANTICS_UNKNOWN', 'OPTION_REPEAT_UNVERIFIED']);
    });
    it('2 sabores, um ×2: dentro do máximo por distintas, acima por unidades ⇒ UNKNOWN', () => {
      const v = validateSelection(pizza, [{ optionId: optionId(pizza, 'Margherita'), quantity: 2 }, { optionId: optionId(pizza, 'Calabria') }]);
      expect(v.status).toBe('UNKNOWN');
      expect(v.issues.find((i) => i.code === 'LIMIT_SEMANTICS_UNKNOWN')!.message).toMatch(/3 unidades/);
    });
    it('3 sabores distintos em grupo 2–2 ⇒ INVALID em qualquer interpretação', () => {
      const three = ['Margherita', 'Calabria', 'Gigione'].map((n) => ({ optionId: optionId(pizza, n), quantity: 1 }));
      expect(validateSelection(pizza, three).status).toBe('INVALID');
    });
    it('quantidade 0, negativa ou fracionária ⇒ INVALID', () => {
      for (const q of [0, -1, 1.5]) expect(validateSelection(pizza, [{ optionId: optionId(pizza, 'Margherita'), quantity: q }]).status).toBe('INVALID');
    });
    it('opção repetida em grupo opcional com folga ⇒ UNKNOWN (cobrança/limite por opção não expostos)', () => {
      const d = item('Maria salada Veg');
      const base = ['Lanche Totalmente Vegano', 'Feijão Roxo', 'Nenhum combo', 'Ketchup'].map((n) => ({ optionId: optionId(d, n) }));
      const v = validateSelection(d, [...base, { optionId: optionId(d, 'Picles'), quantity: 2 }]);
      expect(v.status).toBe('UNKNOWN');
      expect(v.issues.map((i) => i.code)).toEqual(['OPTION_REPEAT_UNVERIFIED']);
    });
  });

  it('grupos opcionais podem ficar vazios; obrigatórios não', () => {
    const d = item('Vegano Brooks');
    expect(validateSelection(d, [{ optionId: optionId(d, 'Não desejo descartáveis') }]).status).toBe('VALID');
    expect(validateSelection(d, []).issues.map((i) => i.code)).toEqual(['BELOW_MIN']);
  });

  it('optionGroups ausente ⇒ UNKNOWN', () => {
    const r = rawItem('Veggie Burger');
    delete r.optionGroups;
    expect(validateSelection(normalizeItemDetail(r), []).status).toBe('UNKNOWN');
  });
});

describe('cheapestRequiredSelection', () => {
  it('escolhe as opções obrigatórias mais baratas e ignora grupos opcionais', () => {
    const d = item('Maria salada Veg');
    const s = cheapestRequiredSelection(d);
    expect(s.problems).toEqual([]);
    // 4 grupos obrigatórios (1–1); "Adicionais" e "Molhos adicionais" são 0–5.
    expect(s.selection!.map((o) => o.optionId)).toEqual([
      optionId(d, 'Lanche Totalmente Vegano'),
      optionId(d, 'Feijão Roxo'),
      optionId(d, 'Nenhum combo'),
      optionId(d, 'Ketchup'),
    ]);
  });

  it('respeita opções bloqueadas', () => {
    const d = item('Maria salada Veg');
    const s = cheapestRequiredSelection(d, new Set([optionId(d, 'Feijão Roxo')]));
    expect(s.selection!.map((o) => o.optionId)).toContain(optionId(d, 'Grão de bico c/ castanha do pará'));
  });

  it('impossível quando o grupo obrigatório fica sem opções', () => {
    const d = item('Vegano Brooks');
    const blocked = new Set([optionId(d, 'Desejo descartáveis'), optionId(d, 'Não desejo descartáveis')]);
    const s = cheapestRequiredSelection(d, blocked);
    expect(s.selection).toBeNull();
    expect(s.problems[0]).toMatch(/Descartáveis/);
  });

  it('item sem grupos ⇒ seleção vazia válida', () => {
    expect(cheapestRequiredSelection(item('Veggie Burger'))).toEqual({ selection: [], problems: [] });
  });
});
