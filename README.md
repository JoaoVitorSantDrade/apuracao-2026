# Apuração 2026 · 2º turno

Painel da apuração presidencial de 25/10/2026 (Flávio Bolsonaro × Lula), com dados ao vivo do TSE, mapa por UF,
projeção do resultado final e comparação com 2018, 2022 e o 1º turno de 2026. Visual do Kotodama (Sumi/Washi).

No ar: https://joaovitorsantdrade.github.io/apuracao-2026/

## Publicar uma atualização

O site é o GitHub Pages deste repositório (branch `main`, raiz). Todo push na `main` publica sozinho em 1 a 2 minutos.

```bash
git add -A
git commit -m "Descreve a mudança"
git push
```

Para trabalhar em outro computador, clone primeiro: `gh repo clone JoaoVitorSantDrade/apuracao-2026`.

## Abrir no seu computador

```bash
python -m http.server 8765
```

Depois abra http://localhost:8765. Abrir o `index.html` direto com dois cliques também funciona.
`http://localhost:8765/#simulacao` roda uma apuração fictícia a partir do 1º turno, para testar a tela. Ela envia
de propósito arquivos repetidos e antigos, para mostrar a proteção contra votos duplicados.

## O que tem

- Placar, projeção com chance de vitória e evolução da noite.
- Entrada de votos: cada lote novo do TSE, por estado, com votos válidos por minuto e a conferência da soma dos estados.
- Placar com as fotos oficiais dos candidatos, servidas pelo próprio TSE.
- Mapa por região ou por estado (apurado, projeção, variação, 1º turno, 2022, 2018). Clique num estado para ver as cidades.
- Variação: para que lado cada estado ou cidade foi, contra o 1º turno 2026 ou o 2º turno 2022.

Abrir um estado grande pela primeira vez leva cerca de 1 a 2 minutos (São Paulo tem 645 cidades e o TSE limita
quantos arquivos se baixa por vez). Depois disso o 1º turno fica guardado no navegador.

## Arquivos

- `index.html`: layout e estilo.
- `app.js`: busca no TSE (Brasil a cada 15 s; estados e cidades quando mudam), feed, mapa, gráficos e tabela.
- `model.js`: projeção, aceitação de lotes, variação e novas tentativas (funções puras). Testes: `node --test test/model.test.js`.
- `data.js`: resultados de 2018/2022 por UF e o contorno dos estados e das regiões (o das cidades vem do IBGE na hora).
- `docs/`: design e plano.
