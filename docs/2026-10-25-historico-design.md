# Histórico central da apuração — design

Aprovado em chat em 25/10/2026 (~17h40), modo rápido. Abordagem escolhida: coletor no PC do autor.

## Objetivo
Quem abre o painel no meio da noite vê a noite inteira (gráfico, feed, votos por minuto), e as cidades de um estado
abrem com um download do GitHub em vez de centenas de pedidos ao TSE.

## Peças
- **Coletor** `coletor/coletor.mjs` (Node 24, sem dependências), rodando num terminal do PC do autor.
  Reaproveita `model.js` (aceitação de versão, delta).
- **Branch `historico`**: só dados, sempre um único commit (refeito com `--amend` + push forçado). O histórico vive
  dentro dos JSONs; o repositório não cresce a cada envio e o site (branch `main`) não é republicado.
- **Página**: lê os arquivos por `https://raw.githubusercontent.com/JoaoVitorSantDrade/apuracao-2026/historico/...`
  (CORS liberado; cache de até 5 min) e continua ao vivo pelo TSE.

## Arquivos na branch `historico`
- `historico.json`: `{ ele, entries: [ { idg, ts, hora, br: Snap, ufs: { UF: Snap } } ] }`, uma entrada por lote
  nacional aceito, em ordem de `idg`. `Snap` compacto = `[idg, ts, lula, flavio, validos, secoes, secoesTot, eleitores]`.
- `mun/<UF>.json`: `{ hora, cidades: { cd: [[idg, ts, lula, flavio, validos, secoes, secoesTot], ...] } }`, a sequência
  de versões aceitas de cada cidade (a última é a atual).
- `mun1t/<UF>.json`: 1º turno das cidades, fixo: `{ cd: [lula, flavio, validos, outros, secoesTot, eleitores] }`.

## Coletor
- A cada 15 s baixa `br`; se o `idg` mudou, baixa as 28 UFs, aceita com `acceptSnapshot` e grava a entrada.
- Estados cujo arquivo mudou entram numa fila de cidades; a fila é varrida com 4 conexões, com nova tentativa em 429.
- Envio: um push por lote nacional; cidades juntas no envio seguinte ou a cada 60 s.
- Retoma lendo os próprios arquivos: um intervalo sem coletar vira uma entrada maior, nunca votos duplicados.
- Termina quando o Brasil chega a 100 % das seções (ou Ctrl+C).

## Página
- Ao abrir, baixa `historico.json`: reconstrói gráfico, feed e votos por minuto, e semeia o estado atual com a última
  entrada; o ao vivo segue daí. Lotes do histórico e do ao vivo têm a mesma chave (`BR:idg`) e não se duplicam.
- Ao abrir um estado, baixa `mun/<UF>.json` e `mun1t/<UF>.json` antes de tudo; os pedidos ao TSE por cidade só
  complementam, passando pela mesma aceitação de versão. No detalhe da cidade, a linha do tempo dela.
- Sem histórico (arquivo ausente ou erro), a página funciona como antes.

## Testes
TDD nas funções puras novas (compactar/expandir, entrada do histórico, feed a partir do histórico, histórico de cidade)
e no coletor com `fetch`, relógio e publicação injetados, usando respostas gravadas do TSE. Depois, uma execução real.
