# Apuração 2026 · 2º turno — design

Aprovado em chat em 25/10/2026, modo rápido (spec e plano sem revisão prévia).

## Objetivo
Acompanhar ao vivo a apuração do 2º turno presidencial de 25/10/2026 (Flávio Bolsonaro × Lula), com mapa
por UF, projeção do resultado final e comparação com 2018, 2022 e o 1º turno de 2026. Visual Kotodama.

## Fontes
- TSE, JSON aberto com CORS: `https://resultados.tse.jus.br/oficial/ele2026/<eleicao>/dados/<uf>/<uf>-c0001-e<eleicao 6 díg.>-u.json`.
  6258 = 2º turno (ao vivo), 6257 = 1º turno (totalizado). `<uf>` = `br`, sigla minúscula, ou `zz` (exterior).
  Campos usados: `carg[0].agr[].par[].cand[]` (`n`, `nmu`, `vap`), `s.ts`/`s.st` (seções), `e.te` (eleitorado),
  `e.c` (comparecimento), `v.vv` (votos válidos), `dg`/`hg` (hora da divulgação).
- 2018 e 2022 (2º turno por UF; 2022 também 1º turno): tabelas da Wikipédia em inglês, embutidas em `data.js`.
- Mapa: GeoJSON das UFs (click_that_hood), simplificado e embutido em `data.js`.

## Arquitetura
Página estática, sem build: `index.html` (estilo e layout), `model.js` (funções puras de previsão, testadas
com `node --test`), `app.js` (busca, estado e renderização), `data.js` (dados fixos). Atualiza a cada 45 s.

## Modelo de projeção (por UF)
- Votos válidos esperados = eleitorado × comparecimento do 1º turno × (válidos/comparecimento do 1º turno).
- Faltam = max(0, esperados − válidos apurados).
- Prior da fatia de Lula: (Lula₁ + outros₁ × t) / válidos₁, onde t = fatia de Lula no 2º turno de 2022 na UF.
- Peso do parcial w = fração de seções apuradas; fatia no restante = w·parcial + (1−w)·prior (sem parcial: prior).
- Monte Carlo (2000 sorteios): erro nacional comum σ=1,5 pp·(1−p_nacional) + erro por UF σ=3 pp·(1−p_uf);
  saída: faixa de 90 % e chance de vitória de cada candidato.

## Falhas
Erro de rede mantém o último dado e mostra "dados de HH:MM" em kin. Nenhum número inventado; sem dado,
a UF aparece neutra.

## Testes
`model.js` com TDD: parsing de um JSON real do TSE, prior, mistura, projeção e Monte Carlo com semente fixa.
Página conferida no navegador com dados reais do 1º turno (modo de simulação lendo 6257).

## Adendo (aprovado em 25/10, ~17h): entrada de votos, variação, cidades

- **Entrada de votos:** a cada 15 s consulta só `br`; os 28 arquivos de UF são baixados quando o `idg` do Brasil muda.
  Cada lote aceito vira uma linha no feed com o delta por UF; votos válidos por minuto entre os dois últimos lotes.
- **Sem duplicados:** `acceptSnapshot` aceita um lote só com `idg` e horário mais novos e contagem que não diminui;
  o delta é sempre entre dois lotes aceitos; o feed tem chave UF + `idg`. A soma das UFs + exterior é conferida
  com o total do Brasil (`sumCheck`).
- **Variação:** pontos percentuais da fatia de Lula contra o 1º turno 2026 ou o 2º turno 2022; usa a projeção até
  95 % das seções da UF e o apurado depois. Modo de mapa "Variação".
- **Cidades:** ao clicar numa UF, contorno dos municípios do IBGE (`codarea` = `cdi` da lista do TSE) e um arquivo
  do TSE por município. 4 conexões por vez, nova tentativa com espera dobrada em 429, 1º turno guardado no navegador,
  2º turno rebaixado no máximo a cada 90 s, uma carga por vez.
- **TSE sobrecarregado:** tempo-limite de 20 s por pedido e nunca duas consultas simultâneas.
