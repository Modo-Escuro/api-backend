import { readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';

// Artefato autocontido: usa o SDK já instalado na API, sem alterar ou publicar o serviço.
const result = ts.transpileModule(readFileSync('scripts/int01-console-probe.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
});
writeFileSync('docs/int-01-console-command.sh',
  "# Executar na pasta da API pelo Console autenticado da Railway. Não imprime credenciais.\nnode --input-type=module <<'INT01_PROBE'\n" +
  result.outputText + '\nconsole.log(JSON.stringify(await runConsoleProbe()));\nINT01_PROBE\n');
