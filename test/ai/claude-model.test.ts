import { describe, expect, it, vi } from 'vitest';
import { AgentProposalSchema } from '../../src/server/agent/model';
import { CLAUDE_DEMO_CORPUS, demoInput, scoreClaudeDemo } from '../../src/server/ai/claude-demo-corpus';
import { CLAUDE_MODEL, createClaudeModel, createGeminiModel, claudeWireSchema } from '../../src/server/ai/claude-model';
import { loadConfig } from '../../src/server/config';
import { createAgentProcessor } from '../../src/server/agent/processor';
import { TurnRuntime } from '../../src/server/turns/runtime';
import { TurnStore } from '../../src/server/turns/store';
import { event, flush, principal, temporary } from '../turns/helpers';

const payload = (proposal: unknown) => Response.json({ id:'msg_synthetic', type:'message', role:'assistant', model:CLAUDE_MODEL,
  content:[{type:'text',text:JSON.stringify(proposal)}], stop_reason:'end_turn', stop_sequence:null, usage:{input_tokens:1000,output_tokens:100} });
const request = () => ({ input: demoInput(), signal:new AbortController().signal, maxOutputTokens:800, budgetScope:'private-local-scope' });
describe('AI-01: Claude no contrato de ações AI-02', () => {
  it('corpus curto consistente; alteração perigosa nunca vira aprovação', () => {
    expect(CLAUDE_DEMO_CORPUS).toHaveLength(16);
    for (const c of CLAUDE_DEMO_CORPUS) for (const p of c.expected) {
      expect(AgentProposalSchema.safeParse(p).success).toBe(true);
      expect(scoreClaudeDemo(c,p)).toBe(true);
    }
    const c = CLAUDE_DEMO_CORPUS.find(c=>c.id==='preserve-allergy')!;
    expect(scoreClaudeDemo(c,{actions:[{action:'SET_NO_RESTRICTIONS',participant:{name:'P2'}}]})).toBe(false);
    expect(JSON.stringify(claudeWireSchema())).toContain('ADD_PARTICIPANT');
  });
  it('SDK nativo, sem tools/segredos/metadados; contador impede segunda chamada', async () => {
    const fetch = vi.fn(async (_url, init: RequestInit | undefined) => {
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe(CLAUDE_MODEL); expect(body.tools).toBeUndefined();
      expect(body.thinking).toEqual({type:'between_tools'}); expect(body.output_config.effort).toBe('low');
      expect(body.output_config.format.type).toBe('json_schema');
      expect(String(init?.body)).not.toMatch(/private-local-scope|synthetic-key|PRIVATE_EXTRA/);
      expect(init?.redirect).toBe('error');
      return payload({actions:[{action:'SET_PRIORITY',value:'SPEED'}]});
    });
    const model=createClaudeModel({apiKey:'synthetic-key',fetch,maxCalls:1});
    const req=request(); Object.assign(req.input,{secret:'PRIVATE_EXTRA'});
    expect(await model.propose(req)).toEqual({actions:[{action:'SET_PRIORITY',value:'SPEED'}]});
    await expect(model.propose(request())).rejects.toThrow('BUDGET');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('limite de reserva, entrada grande, cancelamento e campos humanos falham fechados', async () => {
    const fetch=vi.fn(async()=>payload({actions:[],humanConfirmed:true}));
    await expect(createClaudeModel({apiKey:'synthetic-key',fetch,budgetMicroUsd:1}).propose(request())).rejects.toThrow('BUDGET');
    expect(fetch).not.toHaveBeenCalled();
    const huge=request(); huge.input.message='x'.repeat(9000);
    await expect(createClaudeModel({apiKey:'synthetic-key',fetch}).propose(huge)).rejects.toThrow('INPUT_LIMIT');
    const abort=new AbortController();abort.abort();
    await expect(createClaudeModel({apiKey:'synthetic-key',fetch}).propose({...request(),signal:abort.signal})).rejects.toThrow('TIMEOUT');
    await expect(createClaudeModel({apiKey:'synthetic-key',fetch}).propose(request())).rejects.toThrow('INVALID_OUTPUT');
  });
  it.each([401,429,503])('HTTP %s sem retry nem detalhes privados',async status=>{
    const fetch=vi.fn(async()=>new Response('PRIVATE_RESPONSE',{status}));
    await expect(createClaudeModel({apiKey:'synthetic-key',fetch}).propose(request())).rejects.toThrow(status===401?'AUTH':status===429?'QUOTA':'UNAVAILABLE');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('Gemini: proposta real passa por AI-02/RUN-01/DATA-01; cota preserva o estado e depois permite recuperação', async()=>{
    const dir=temporary(); const store=new TurnStore(dir.file);
    let down=false;
    const fetch=vi.fn(async (_url, init: RequestInit | undefined)=>{
      expect(String(_url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent');
      const body=JSON.parse(String(init?.body)); expect(body.tools).toBeUndefined();
      expect(body.generationConfig.thinkingConfig).toEqual({thinkingLevel:'low',includeThoughts:false});
      if(down) return new Response('PRIVATE_QUOTA_BODY',{status:429});
      const proposal={actions:[{action:'ADD_PARTICIPANT',name:'P1'}]};
      return Response.json({candidates:[{content:{role:'model',parts:[{text:JSON.stringify(proposal)}]},finishReason:'STOP'}],modelVersion:'gemini-3.8-flash',usageMetadata:{promptTokenCount:800,candidatesTokenCount:40,totalTokenCount:840}});
    });
    const processor=createAgentProcessor({model:createGeminiModel({apiKey:'synthetic-key',fetch}),linkOf:async()=>null,timeoutMs:9000,maxOutputTokens:800});
    const runtime=new TurnRuntime(store,{processor});
    const err=vi.spyOn(console,'error').mockImplementation(()=>undefined);
    const send=async(n:number,version:number)=>{
      const accepted=runtime.accept(principal,event(n,version));
      for(let i=0;i<80;i++){runtime.tick();await flush(); const op=store.operation(principal,accepted.operation.operationId);if(!['ACCEPTED','RUNNING'].includes(op.status)) return op; await new Promise(r=>setTimeout(r,5));}
      throw new Error('operação não terminou');
    };
    try {
      expect(await send(1,0)).toMatchObject({status:'SUCCEEDED',resultVersion:1,snapshot:{phase:'COLLECTING',humanApproval:null}});
      const before=structuredClone(store.snapshot(principal));
      down=true;expect(await send(2,1)).toMatchObject({status:'FAILED',error:{code:'UNAVAILABLE'}});
      expect(store.snapshot(principal)).toEqual(before);
      down=false;expect(await send(3,1)).toMatchObject({status:'SUCCEEDED',resultVersion:2});
      expect(String(err.mock.calls)).not.toMatch(/PRIVATE_QUOTA|synthetic-key/);
    } finally {runtime.stop();dir.clean();err.mockRestore();}
  });
  it('configuração exige opt-in e runtime: chave presente sozinha não ativa modelo',()=>{
    expect(loadConfig({GEMINI_API_KEY:'synthetic-key'}).conversationModel).toBeUndefined();
    expect(()=>loadConfig({CONVERSATION_MODEL:'gemini-3.8-flash',GEMINI_API_KEY:'synthetic-key'})).toThrow(/runtime/);
    expect(loadConfig({CONVERSATION_RUNTIME_ENABLED:'true',CONVERSATION_DB_FILE:'.test-conversation.sqlite',BOT_TELEGRAM_ID:'900001',CONVERSATION_MODEL:'gemini-3.8-flash',GEMINI_API_KEY:'synthetic-key'}).conversationModel).toEqual({id:'gemini-3.8-flash',apiKey:'synthetic-key'});
  });
});
