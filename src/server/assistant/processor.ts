import { modelBudgetScope } from '../ai/budget-scope.js';
import { planControls, resolveLimitReply } from './controls.js';
import { ContractError } from '../contracts/guards.js';
import type { Snapshot } from '../contracts/conversation.js';
import type { DomainOp } from '../domain/purchase.js';
import type { IfoodLinkService } from '../links/service.js';
import { conversationKey, type SpendBudget } from '../ops/budget.js';
import { metrics } from '../ops/metrics.js';
import { log } from '../ops/log.js';
import { scopeKey } from '../turns/store.js';
import type { TurnProcessor } from '../turns/runtime.js';
import { ASSISTANT_TOOLS, AssistantStepSchema, type AssistantInput, type AssistantModel } from './protocol.js';
import { AudienceSchema, selectAudience, type AudienceInput, type AudienceModel } from './audience.js';
import { projectAction, recipient, type MemoryAction, type MemoryCommit, type MemoryDirectory, type MemoryPerson, type PersonProfile } from './memory.js';
import { AssistantTools, safeText } from './tools.js';
import { choosePattern, planSync, proposeSet, selectProposal } from './bag.js';
import { DomainError, type PurchaseState } from '../domain/purchase.js';

export const ADDRESS_PENDING = 'Confirme seu endereço pelo botão Endereços iFood antes das sugestões. Podemos continuar organizando participantes, restrições e orçamento.';
const LIMIT_NOTE = 'A consulta atingiu o limite deste turno. Posso continuar a busca na próxima mensagem.';
const ERROR_NOTES: Record<string, string> = {
  ADDRESS_REQUIRED: ADDRESS_PENDING,
  IFOOD_LINK_REQUIRED: 'Entre na sua conta iFood para consultar opções disponíveis para entrega.',
  IFOOD_RECONNECT_REQUIRED: 'Reconecte sua conta iFood para continuar a busca.',
  IFOOD_SCOPE_REQUIRED: 'A conexão iFood precisa das permissões de consulta de catálogo.',
  UNAVAILABLE: 'Parte das consultas ficou indisponível. Posso tentar uma nova busca quando você quiser.',
  TOOL_UNAVAILABLE: 'Esta consulta de catálogo não está disponível nesta conexão.',
};

/** Texto social não é a fonte dos fatos do catálogo. Cartões e bloqueios são montados pelo servidor. */
export function narration(message: string): string {
  const clean = safeText(message, 600);
  if (/https?:|R\$|\b(?:item|merchant|page)_\d+|\b\d+[.,]\d{2}\b/iu.test(clean)) return '';
  if (/(?:pedido|compra|pagamento).{0,30}(?:enviad|confirmad|aprovad|realizad)|(?:seguro para|livre de al[eé]rgen|n[aã]o cont[eé]m)/iu.test(clean)) return '';
  return clean;
}

export interface AssistantOptions {
  model: AssistantModel;
  audienceModel: AudienceModel;
  links: Pick<IfoodLinkService, 'status' | 'withOperational'>;
  selectedAddress(organizerId: string, linkId: string): { addressId: string; addressHash: string };
  budget?: SpendBudget;
  maxOutputTokens?: number;
  timeoutMs?: number;
  maxRounds?: number;
  maxCalls?: number;
}

async function bounded<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(new ContractError('UNAVAILABLE')); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([work(), stopped]); }
  finally { signal.removeEventListener('abort', abort); }
}

function modelProfiles(profiles: readonly PersonProfile[], food: boolean): AssistantInput['context']['people'] {
  return profiles.map(p => ({ ref: p.ref, kind: p.kind, label: p.label,
    ...(food ? { restrictions: p.restrictions, restrictionsKnown: p.restrictionsKnown } : {}),
    preferences: p.preferences }));
}
const samePeople = (a: readonly MemoryPerson[], b: readonly MemoryPerson[]) =>
  JSON.stringify(a.map(p => p.ref).sort()) === JSON.stringify(b.map(p => p.ref).sort());

export function createAssistantProcessor(options: AssistantOptions): TurnProcessor {
  const maxRounds = options.maxRounds ?? 4, maxCalls = options.maxCalls ?? 10;
  const timeoutMs = options.timeoutMs ?? 45_000, maxOutputTokens = options.maxOutputTokens ?? 2048;
  if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 4 || !Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 12
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error('Limites do assistente inválidos.');
  return async ctx => {
    if (ctx.event.input.kind !== 'TEXT') throw new ContractError('ACTION_UNAVAILABLE');
    const message = ctx.event.input.text;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
    return bounded(signal, async () => {
      const status = await options.links.status(ctx.principal.organizerId), linkId = status.linkId;
      signal.throwIfAborted();
      const verifyAccount = async () => {
        signal.throwIfAborted();
        const current = await options.links.status(ctx.principal.organizerId);
        signal.throwIfAborted();
        if (current.linkId !== linkId) throw new ContractError('LINK_CHANGED');
      };
      if (linkId && !ctx.memory) throw new ContractError('UNAVAILABLE');
      const directory: MemoryDirectory = linkId ? ctx.memory!.directory(linkId) : { revision: 0, recipients: [], previous: null };
      const snapshot = (text: string, pending: string[] = []): Snapshot => ({
        contractVersion: '1.0', conversationId: ctx.snapshot.conversationId, version: ctx.snapshot.version + 1,
        phase: 'COLLECTING', blocks: [{ kind: 'TEXT', source: 'SERVER', text }], pending, allowedActions: [], humanApproval: null,
      });
      if (/^Confirmo: apagar todos os dados deste pedido[.!]?$/iu.test(message)) {
        return { snapshot: snapshot('Perfil e contexto desta conta apagados.'), completeness: 'COMPLETE', paths: ['PHASE'],
          domain: { ops: ctx.purchase ? [{ op: 'END', reason: 'CANCELLED' }] : [], ...(linkId ? { linkId } : {}) },
          ...(linkId ? { memory: { linkId, baseRevision: directory.revision, people: [], actions: [], clear: true as const,
            context: { targets: [], purpose: 'UNKNOWN' as const, queries: [] } } } : {}) };
      }
      // Admin do próprio perfil: confirmação digitada, sem modelo. Vale só para a partição do vínculo autenticado.
      if (/^Confirmo: apagar meus dados da mem[óo]ria[.!]?$/iu.test(message)) {
        if (!linkId) return { snapshot: snapshot('Entre na sua conta iFood para gerir dados do perfil.'), completeness: 'COMPLETE', paths: ['PHASE'], domain: { ops: [] } };
        const removed = ctx.memory!.purgeSelf(linkId);
        return { snapshot: snapshot(removed ? 'Apaguei seus dados desta memória. Você continua como titular.' : 'Não há dados seus registrados nesta memória.'),
          completeness: 'COMPLETE', paths: ['PHASE'], domain: { ops: [] } };
      }
      const removal = /^Confirmo: remover (.+) do pedido[!.]$/iu.exec(message);
      if (removal?.[1]) {
        const name = removal[1].trim().slice(0, 80);
        const found = linkId ? directory.recipients.find(r => r.ref === recipient(name).ref) : undefined;
        if (!linkId) return { snapshot: snapshot('Entre na sua conta iFood para gerir dados do perfil.'), completeness: 'COMPLETE', paths: ['PHASE'], domain: { ops: [] } };
        if (!found) {
          return { snapshot: snapshot(`Não encontrei ${name} nesta memória; nada foi alterado.`), completeness: 'COMPLETE', paths: ['PHASE'], domain: { ops: [] } };
        }
        const removed = ctx.memory!.removeRecipient(linkId, found.label);
        return { snapshot: snapshot(removed ? `Removi ${found.label} e seus dados da memória.` : `Não encontrei ${found.label} nesta memória; nada foi alterado.`),
          completeness: 'COMPLETE', paths: ['PHASE'], domain: { ops: [] } };
      }
      // Fecho da sacola: escolha digitada resolvida pelo armazenamento (proposta gravada no escopo), sem modelo.
      const choice = choosePattern.exec(message);
      if (choice?.[1]) {
        const selection = Number(choice[1]);
        const expected = ctx.purchase?.linkId ?? null;
        if (!ctx.purchase || (linkId && expected !== linkId) || (!linkId && expected)) {
          return { snapshot: snapshot('Escape de escolha não reconhecida: peça uma nova busca. Opções anteriores não sobrevivem a mudança de conta.'),
            completeness: 'COMPLETE', paths: ['PHASE'], domain: { ops: [] } };
        }
        const op = selectProposal(ctx.purchase, selection);
        if (!op) return { snapshot: snapshot(`Não reconheço a opção ${selection}: use os números da última lista apresentada.`),
          completeness: 'COMPLETE', paths: ['PHASE'], domain: { ops: [] } };
        const close = ctx.previewDomain({ ops: [op], ...(linkId ? { linkId } : {}) });
        const bag = close?.bag, names = new Map(close?.participants.map(p => [p.participantId, p.displayName]) ?? []);
        const lines = (bag?.lines ?? []).map(l => `${names.get(l.consumerIds[0] ?? '') ?? 'Pessoa'} — ${l.name}`);
        const text = bag ? ['Sacola atual (estimativa; só o carrinho confirma):', ...lines].join('\n')
          : 'Escolha registrada, mas a composição ficou indisponível: peça uma nova busca.';
        const out2 = snapshot(text);
        return { snapshot: out2, completeness: 'COMPLETE', paths: ['CART'],
          domain: { ops: [op], ...(linkId ? { linkId } : {}) } };
      }
      const limitReply = ctx.purchase?.linkId === (linkId ?? null) ? resolveLimitReply(ctx.purchase, message) : null;
      if (limitReply) {
        const domain = { ops: [limitReply], ...(linkId ? { linkId } : {}) };
        try { ctx.previewDomain(domain); } // mesma validação de teto obrigatório do commit
        catch (error) {
          if (!(error instanceof DomainError)) throw error;
          return { snapshot: snapshot('O teto obrigatório existente foi preservado. Essa mudança exige confirmação específica.'),
            completeness: 'PARTIAL', paths: ['PHASE'], domain: { ops: [], ...(linkId ? { linkId } : {}) } };
        }
        return { snapshot: snapshot('Orçamento atualizado com o valor informado anteriormente.'), completeness: 'COMPLETE', paths: ['BUDGET'], domain };
      }
      const invoke = async <T>(input: unknown, work: (reportUsage: (usage: { inputTokens?: number; outputTokens?: number; costMicroUsd?: number }) => void) => Promise<T>): Promise<T> => {
        signal.throwIfAborted();
        const reservedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(input)) / 3) + maxOutputTokens;
        const reservation = options.budget?.reserve(conversationKey(scopeKey(ctx.principal)), reservedTokens);
        if (reservation && !reservation.ok) {
          metrics.inc('agent_budget_exceeded_total', { kind: reservation.denial });
          log('warn', 'agent.budget_exceeded', { component: 'assistant', kind: reservation.denial });
          throw new ContractError('LIMIT_EXCEEDED');
        }
        let used: number | null = null, cost: number | null = null, settled = false;
        const started = Date.now();
        try {
          const raw = await bounded(signal, () => work(usage => {
            if (settled) return;
            if (Number.isSafeInteger(usage.inputTokens) && Number.isSafeInteger(usage.outputTokens) && usage.inputTokens! >= 0 && usage.outputTokens! >= 0) {
              used = usage.inputTokens! + usage.outputTokens!;
              metrics.inc('model_tokens_total', { kind: 'input' }, usage.inputTokens!);
              metrics.inc('model_tokens_total', { kind: 'output' }, usage.outputTokens!);
            }
            if (Number.isSafeInteger(usage.costMicroUsd) && usage.costMicroUsd! >= 0) cost = usage.costMicroUsd!;
          }));
          metrics.inc('model_calls_total', { outcome: 'OK' });
          return raw;
        } catch (error) {
          metrics.inc('model_calls_total', { outcome: 'ASSISTANT_FAILED' });
          throw error instanceof ContractError ? error : new ContractError('UNAVAILABLE');
        } finally {
          settled = true;
          if (reservation?.ok) reservation.reservation.settle(used);
          if (used === null) metrics.inc('model_tokens_total', { kind: 'reserved_unreported' }, reservedTokens);
          if (cost !== null && cost > 0) metrics.inc('model_cost_micro_usd_total', {}, cost);
          metrics.observe('model_call_duration_ms', {}, Date.now() - started);
        }
      };
      const budgetScope = modelBudgetScope(ctx.principal);
      const routingInput: AudienceInput = { message, recipients: directory.recipients.map(p => ({ label: p.label })),
        previousTargets: (directory.previous?.targets ?? []).map(p => ({ kind: p.kind, label: p.label })), previousPurpose: directory.previous?.purpose ?? null };
      const rawAudience = await invoke(routingInput, reportUsage => options.audienceModel.propose({ input: routingInput, signal, maxOutputTokens, budgetScope, reportUsage }));
      const audience = AudienceSchema.safeParse(rawAudience);
      if (!audience.success) throw new ContractError('UNAVAILABLE');
      const selectedAudience = selectAudience(audience.data, message, directory);
      await verifyAccount();
      const { targets, purpose, question } = selectedAudience;
      const people = [...new Map([...targets, ...selectedAudience.mentioned].map(p => [p.ref, p])).values()];
      const writable = selectedAudience.mentioned;
      const memoryBase = linkId ? { linkId, baseRevision: directory.revision, people } : null;
      if (question) {
        return { snapshot: snapshot(question), completeness: 'PARTIAL', paths: ['PHASE'],
          domain: { ops: [], ...(linkId ? { linkId } : {}) },
          ...(memoryBase ? { memory: { ...memoryBase, actions: [], context: { targets: [], purpose: 'UNKNOWN', queries: [] } } } : {}) };
      }
      // Só agora se consultam os fatos: SQL por vínculo, pessoa e finalidade. Snapshot/histórico bruto não entra.
      const originalProfiles = linkId ? ctx.memory!.retrieve(linkId, targets, purpose) : targets.map(p => ({ ...p, restrictions: [], restrictionsKnown: false, preferences: [] }));
      let profiles = structuredClone(originalProfiles);
      const previous = directory.previous && directory.previous.purpose === purpose && samePeople(directory.previous.targets, targets)
        ? directory.previous.queries.map(q => `Busca anterior para estes destinatários: ${q}`) : [];
      const relevantBudget = ctx.purchase?.linkId === (linkId ?? null) ? ctx.purchase.groupLimit : { state: 'NOT_ASKED' };
      const input: AssistantInput = { message, context: { people: modelProfiles(profiles, purpose === 'FOOD'), targets,
        writableSubjects: writable, purpose, budget: relevantBudget, previous },
        tools: ASSISTANT_TOOLS, results: [], round: 0, remainingCalls: maxCalls };
      const tools = new AssistantTools({ links: options.links, organizerId: ctx.principal.organizerId, linkId, signal,
        selectedAddress: id => options.selectedAddress(ctx.principal.organizerId, id) });
      let finalMessage = '', selected: string[] = [], complete = false, announced = false, catalogRequested = false;
      const ops: DomainOp[] = [], notes: string[] = [], actions: MemoryAction[] = [], queries: string[] = [];
      const contextApplied = new Set<string>();
      for (let round = 0; round < maxRounds; round++) {
        signal.throwIfAborted(); input.round = round + 1;
        const raw = await invoke(input, reportUsage => options.model.propose({ input: structuredClone(input), signal, maxOutputTokens, budgetScope, reportUsage }));
        const parsed = AssistantStepSchema.safeParse(raw);
        if (!parsed.success) throw new ContractError('UNAVAILABLE');
        const step = parsed.data;
        if (step.requests.some(r => ['searchOffers', 'browseOffers', 'getRecommendations'].includes(r.name))) catalogRequested = true;
        const proposed = step.memoryActions ?? [];
        if (proposed.length) {
          if (!linkId) notes.push('Entre na sua conta iFood para salvar as informações do perfil correspondente.');
          else {
            const checked = ctx.memory!.validate(linkId, [...actions, ...proposed], writable, purpose, message);
            actions.splice(0, actions.length, ...checked.actions); notes.push(...checked.notes);
            profiles = structuredClone(originalProfiles);
            for (const action of actions) projectAction(profiles, action);
            input.context.people = modelProfiles(profiles, purpose === 'FOOD');
          }
        }
        const controls = (step.contextActions ?? []).filter(a => {
          const key = JSON.stringify(a);
          if (contextApplied.has(key)) return false;
          contextApplied.add(key);
          return true;
        });
        const plan = planControls(controls, message, change => ctx.previewDomain({ ...change, ...(linkId ? { linkId } : {}), ops: [...ops, ...change.ops] }));
        ops.push(...plan.ops); notes.push(...plan.notes);
        const social = narration(step.message);
        if (social) finalMessage = social;
        selected = step.itemRefs;
        if (!step.requests.length) { complete = true; break; }
        if (!announced && social) { ctx.publishProgress?.(social); announced = true; }
        if (step.requests.length > input.remainingCalls) { notes.push(LIMIT_NOTE); break; }
        input.remainingCalls -= step.requests.length;
        tools.setAudience(profiles, purpose);
        for (const request of step.requests) if (request.name === 'searchOffers' && !queries.includes(request.arguments.query)) queries.push(request.arguments.query);
        const results = await bounded(signal, () => Promise.all(step.requests.map(async request => ({ name: request.name, result: await tools.execute(request) }))));
        input.results = [...input.results, ...results].slice(-8);
        for (const { result } of results) {
          const r = result as { error?: { code?: string }; state?: string };
          const note = r.error?.code ? ERROR_NOTES[r.error.code] : r.state === 'EMPTY' || r.state === 'CHOICE_REQUIRED' ? ADDRESS_PENDING : undefined;
          if (note) notes.push(note);
        }
      }
      if (!complete && !notes.includes(LIMIT_NOTE)) notes.push(LIMIT_NOTE);
      await verifyAccount();
      // Fato novo de pessoa que já consome precisa invalidar a sacola imediatamente, mesmo sem busca.
      // Só participantes existentes: registrar memória não cria participante genérico nem relaxa obrigação.
      if (actions.some(a => a.action === 'REMEMBER_RESTRICTION' || a.action === 'DECLARE_NO_RESTRICTIONS'))
        ops.push(...planSync(ctx.purchase, profiles).existing);
      let cards = tools.render(selected, profiles, purpose);
      let composed = false;
      if (selected.some(ref => !tools.hasDetail(ref))) notes.push('Algumas opções não puderam ser detalhadas e não foram apresentadas. Posso procurar outras.');
      // Fecho da sacola: participantes e propostas são gravados pelo armazenamento no mesmo patch; sem proposta válida ⇒ nenhum participante novo nem cartão numerado.
      if (purpose === 'FOOD' && linkId && selected.length && tools.candidates(selected).length) {
        try {
          const syncedState = ops.length ? ctx.previewDomain({ ops, linkId }) : ctx.purchase;
          if (syncedState?.participants.some(p => !profiles.some(person => person.label === p.displayName))) {
            notes.push('A composição atual inclui outras pessoas. Confirme quem deve consumir antes de montar outra sacola.');
            throw new ContractError('ACTION_UNAVAILABLE');
          }
          const sync = planSync(syncedState, profiles);
          const addressId = tools.observedAddressId();
          if (!addressId) throw new ContractError('UNAVAILABLE');
          const addressOps: DomainOp[] = ctx.purchase?.address.state === 'DECLARED' && ctx.purchase.address.value.addressId === addressId
            ? [] : [{ op: 'SET_ADDRESS', addressId }];
          const prefixOps = [...ops, ...sync.adds, ...sync.existing, ...addressOps];
          let stage: PurchaseState | null | undefined = prefixOps.length ? ctx.previewDomain({ ops: prefixOps, linkId }) : ctx.purchase;
          const restrictionOps = sync.Fresh.flatMap(person => {
            const id = stage?.participants.find(p => p.displayName === person.label)?.participantId;
            return id ? [{ op: 'SET_RESTRICTIONS' as const, participantId: id, value: person.keys }] : [];
          });
          if (prefixOps.length !== ops.length || restrictionOps.length) stage = ctx.previewDomain({ ops: [...prefixOps, ...restrictionOps], linkId });
          if (stage) {
            const full = proposeSet(stage, tools.candidates(selected), { seed: scopeKey(ctx.principal), addressId });
            if (full) {
              const finalOps = [...prefixOps, ...restrictionOps, full.op];
              ctx.previewDomain({ ops: finalOps, linkId });
              ops.push(...sync.adds, ...sync.existing, ...addressOps, ...restrictionOps, full.op);
              cards = full.cards;
              composed = true;
            }
          }
        } catch { cards = []; }
      }
      // Uma busca nova sem composição não pode deixar o número da lista anterior selecionável.
      if (catalogRequested && !composed && ctx.purchase?.proposals?.length) ops.push({ op: 'SET_PROPOSALS', proposals: [] });
      const out = snapshot(finalMessage || 'Vamos encontrar uma opção que combine com o que você tem em mente.', [...new Set(notes)]);
      out.blocks[0] = { kind: 'TEXT', source: 'MODEL', text: finalMessage || 'Vamos encontrar uma opção que combine com o que você tem em mente.' };
      for (const card of cards) out.blocks.push({ kind: 'TEXT', source: 'SERVER', text: card });
      if (cards.length) out.blocks.push({ kind: 'TEXT', source: 'SERVER', text: 'Opções informativas. Preços estimados, sem taxa de serviço. Lojas diferentes têm entregas e custos separados.' });
      const memory: MemoryCommit | undefined = memoryBase ? { ...memoryBase, actions,
        context: { targets, purpose, queries: queries.length ? queries.slice(0, 4)
          : directory.previous && directory.previous.purpose === purpose && samePeople(directory.previous.targets, targets) ? directory.previous.queries : [] } } : undefined;
      return { snapshot: out, completeness: complete && !notes.length ? 'COMPLETE' : 'PARTIAL', paths: ['PHASE'],
        domain: { ops, ...(linkId ? { linkId } : {}) }, ...(memory ? { memory } : {}) };
    });
  };
}
