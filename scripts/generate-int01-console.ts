import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

// Artefato autocontido: usa o SDK já instalado na API, sem alterar ou publicar o serviço.
const result = ts.transpileModule(readFileSync('scripts/int01-console-probe.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
});
writeFileSync('docs/int-01-console-command.sh',
  "# Executar na pasta da API pelo Console autenticado da Railway. Não imprime credenciais.\nnode --import tsx --input-type=module <<'INT01_PROBE'\n" +
  "import { config } from './src/server/config.ts';\n" + result.outputText +
  '\nconsole.log(JSON.stringify(await runConsoleProbe({ env: { ...process.env, IFOOD_LINKS_DIR: config.linksDir } })));\nINT01_PROBE\n');
