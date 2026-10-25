# Apuração 2026 — plano de implementação

Execução inline (executing-plans), TDD no modelo.

1. **model.js · parsing** — teste: `parseTse(json)` de um `-u.json` real devolve `{lula, flavio, validos, secoes,
   secoesTot, eleitores, comparecimento, hora}`. Implementar.
2. **model.js · prior** — teste: `priorLula(t1, t22)` com números conhecidos. Implementar.
3. **model.js · projeção por UF** — teste: sem parcial = prior; 100 % apurado = parcial exato; meio a meio mistura.
4. **model.js · Monte Carlo** — teste: semente fixa é determinística; 100 % apurado dá chance 0 ou 1.
5. **index.html + app.js** — layout Kotodama (Sumi/Washi), placar, mapa SVG, painel da UF, projeção, linha do tempo.
6. **Verificação** — `node --test`; abrir no navegador com `?sim=1t` (dados do 1º turno) e ao vivo; checar tema
   claro/escuro e largura de celular; publicar como Artifact.
