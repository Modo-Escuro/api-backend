// Configuração lida exclusivamente do ambiente. Nunca logar segredos.

export interface AppConfig {
  mcpUrl: string;
  clientId: string | undefined;
  clientSecret: string | undefined;
  redirectUri: string;
  scope: string | undefined;
  webOrigin: string;
  port: number;
  tokenFile: string;
  /** Issuer usado para OIDC discovery (verificado em /.well-known/openid-configuration). */
  authServer: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    mcpUrl: env.IFOOD_MCP_URL || 'https://consumer-mcp.ifood.com.br/marketplace',
    clientId: env.IFOOD_CLIENT_ID || undefined,
    clientSecret: env.IFOOD_CLIENT_SECRET || undefined,
    redirectUri: env.IFOOD_REDIRECT_URI || 'http://localhost:8000/callback',
    scope: env.IFOOD_SCOPE || undefined,
    webOrigin: env.WEB_ORIGIN || 'http://localhost:5173',
    port: Number(env.PORT || 8000),
    tokenFile: env.IFOOD_TOKEN_FILE || '.tokens.json',
    authServer: env.IFOOD_AUTH_SERVER || 'https://id.ifood.com.br',
  };
}

export const config = loadConfig();

/** Mascara um identificador público (ex.: clientId) para diagnóstico. */
export function mask(value: string | undefined): string | null {
  if (!value) return null;
  return value.length <= 6 ? '***' : `${value.slice(0, 4)}…${value.slice(-2)}`;
}
