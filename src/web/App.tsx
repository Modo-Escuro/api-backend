import { useCallback, useEffect, useState } from 'react';

interface AuthStatus {
  configured: boolean;
  authenticated: boolean;
  source: string | null;
  expiresAt: string | null;
  expired: boolean | null;
  hasRefreshToken: boolean;
  scopes: string[];
}

interface SearchSample {
  itemId: string;
  itemName: string | null;
  unitPrice: number | null;
  promotionalUnitPrice: number | null;
  merchantName: string | null;
  isOpen: boolean | null;
}

const brl = (v: number | null) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));

async function getJson<T>(url: string): Promise<{ ok: boolean; data: T }> {
  const res = await fetch(url);
  return { ok: res.ok, data: (await res.json()) as T };
}

export function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [diag, setDiag] = useState<unknown>(null);
  const [search, setSearch] = useState<{ ok: boolean; data: Record<string, unknown> } | null>(null);
  const [query, setQuery] = useState('pizza');
  const [busy, setBusy] = useState<string | null>(null);
  const params = new URLSearchParams(window.location.search);

  const loadAuth = useCallback(async () => setAuth((await getJson<AuthStatus>('/api/auth/status')).data), []);
  useEffect(() => {
    void loadAuth();
  }, [loadAuth]);

  const run = async (name: string, fn: () => Promise<void>) => {
    setBusy(name);
    try {
      await fn();
    } finally {
      setBusy(null);
    }
  };

  return (
    <main>
      <h1>Compra com Contexto</h1>
      <p className="muted">SEMCOMP × iFood — diagnóstico da integração MCP (F1). Recomendação sem checkout.</p>

      {params.get('auth') === 'ok' && <p className="ok">Login iFood concluído.</p>}
      {params.get('auth') === 'error' && <p className="bad">Falha no login: {params.get('reason')}</p>}

      <section>
        <h2>Autenticação</h2>
        {!auth ? (
          <p>Carregando…</p>
        ) : (
          <>
            <p>
              Client configurado: <b className={auth.configured ? 'ok' : 'bad'}>{auth.configured ? 'sim' : 'não'}</b> · Autenticado:{' '}
              <b className={auth.authenticated && !auth.expired ? 'ok' : 'bad'}>
                {auth.authenticated ? (auth.expired ? 'token expirado' : 'sim') : 'não'}
              </b>
              {auth.expiresAt && <span className="muted"> · expira {new Date(auth.expiresAt).toLocaleString('pt-BR')}</span>}
              {auth.source && <span className="muted"> · origem {auth.source}</span>}
            </p>
            <div className="row">
              <a className="btn" href="/api/auth/login">
                Entrar com iFood
              </a>
              <button
                onClick={() =>
                  run('logout', async () => {
                    await fetch('/api/auth/logout', { method: 'POST' });
                    await loadAuth();
                  })
                }
                disabled={!!busy}
              >
                Sair
              </button>
            </div>
          </>
        )}
      </section>

      <section>
        <h2>Conexão MCP</h2>
        <button disabled={!!busy} onClick={() => run('diag', async () => setDiag((await getJson('/api/diagnostics')).data))}>
          {busy === 'diag' ? 'Testando…' : 'Testar tools/list'}
        </button>
        {diag != null && <pre>{JSON.stringify(diag, null, 2)}</pre>}
      </section>

      <section>
        <h2>Busca real (searchOffers)</h2>
        <div className="row">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="termo descritivo, ex.: pizza" />
          <button
            disabled={!!busy || !query.trim()}
            onClick={() =>
              run('search', async () => setSearch(await getJson(`/api/diagnostics/search?q=${encodeURIComponent(query.trim())}`)))
            }
          >
            {busy === 'search' ? 'Buscando…' : 'Buscar'}
          </button>
        </div>
        {search && !search.ok && <pre className="bad">{JSON.stringify(search.data, null, 2)}</pre>}
        {search?.ok && (
          <>
            <p className="muted">
              {String(search.data.resultCount)} resultados em {String(search.data.latencyMs)} ms · {String(search.data.note)}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Item</th>
                  <th>Loja</th>
                  <th>Preço</th>
                  <th>Promo (listagem)</th>
                  <th>Aberta</th>
                </tr>
              </thead>
              <tbody>
                {(search.data.sample as SearchSample[]).map((i) => (
                  <tr key={i.itemId}>
                    <td>{i.itemName ?? <i>sem nome</i>}</td>
                    <td>{i.merchantName ?? '—'}</td>
                    <td>{brl(i.unitPrice)}</td>
                    <td>{brl(i.promotionalUnitPrice)}</td>
                    <td>{i.isOpen == null ? 'não informado' : i.isOpen ? 'sim' : 'não'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </section>
    </main>
  );
}
