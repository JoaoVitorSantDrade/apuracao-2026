# Histórico central — plano

Execução inline, TDD. Branch `feat/historico-coletor`.

1. `model.js`: `packSnap`/`unpackSnap`, `historyEntry`, `appendEntry` (só `idg` crescente), `feedFromHistory`,
   `addCityVersion`. Testes primeiro.
2. `coletor/coletor.mjs`: `createCollector({ fetchJson, publish, sleep, now, log })` com `step()` (um ciclo) e
   varredura de cidades; CLI no fim do arquivo. Publicação por `git worktree` em `.historico/` (ignorado na `main`).
   Teste `test/coletor.test.js` com TSE falso: lote novo, repetido, antigo, cidades, retomada.
3. `app.js`: carregar `historico.json` (semente + gráfico + feed) e `mun`/`mun1t` do GitHub; linha do tempo da cidade.
4. Execução real: 1º turno das cidades, um ciclo do 2º turno, conferir a branch `historico` e a página.
5. README (como ligar o coletor), commit, push; merge na `main` só com o ok do autor.
