// Modelo de projeção da apuração. Funções puras: rodam no navegador (window.Model) e no node (testes).
(function (root) {
  const LULA = "13";
  const FLAVIO = "22";

  // Um arquivo "-u.json" do TSE (uma abrangência: br, UF ou zz) → números que o modelo usa.
  function parseTse(j) {
    const cands = j.carg[0].agr.flatMap((a) => a.par.flatMap((p) => p.cand));
    const votes = (n) => Number((cands.find((c) => c.n === n) || { vap: 0 }).vap);
    const lula = votes(LULA);
    const flavio = votes(FLAVIO);
    const validos = Number(j.v.vv);
    const secoes = Number(j.s.st);
    const secoesTot = Number(j.s.ts);
    return {
      lula, flavio, validos,
      outros: validos - lula - flavio,
      secoes, secoesTot,
      p: secoesTot ? secoes / secoesTot : 0,
      eleitores: Number(j.e.te),
      comparecimento: Number(j.e.c),
      // Comparecimento, abstenção, brancos e nulos valem sobre as seções já apuradas (est), como o TSE mostra.
      est: Number(j.e.est) || 0,
      abstencao: Number(j.e.a) || 0,
      tv: Number(j.v.tv) || 0,
      brancos: Number(j.v.vb) || 0,
      nulos: Number(j.v.tvn) || 0,
      hora: `${j.dg.slice(0, 5)} ${j.hg.slice(0, 5)}`,
      idg: Number(j.idg),
      ts: `${j.dg.slice(6, 10)}-${j.dg.slice(3, 5)}-${j.dg.slice(0, 2)}T${j.hg}`,
    };
  }

  // Um lote novo de um lugar só entra se for uma versão mais nova do TSE e a contagem não andar para trás.
  // Isso barra cópias repetidas ou antigas da CDN, que fariam o painel contar o mesmo voto duas vezes.
  function acceptSnapshot(prev, next) {
    if (!prev) return { ok: true };
    if (next.idg === prev.idg) return { ok: false, reason: "repetido" };
    if (next.idg < prev.idg || next.ts < prev.ts) return { ok: false, reason: "antigo" };
    if (next.secoes < prev.secoes || next.lula < prev.lula || next.flavio < prev.flavio || next.validos < prev.validos) {
      return { ok: false, reason: "regrediu" };
    }
    return { ok: true };
  }

  function delta(prev, next) {
    const p = prev || { lula: 0, flavio: 0, validos: 0, secoes: 0 };
    return { lula: next.lula - p.lula, flavio: next.flavio - p.flavio, validos: next.validos - p.validos, secoes: next.secoes - p.secoes };
  }

  // Feed com a entrada mais nova primeiro; a chave (lugar + versão do TSE) nunca entra duas vezes.
  function addFeed(feed, entry, max = 200) {
    if (feed.some((e) => e.key === entry.key)) return feed;
    return [entry, ...feed].slice(0, max);
  }

  // O total publicado deve ser igual à soma das partes (UFs + exterior, ou cidades de uma UF).
  function sumCheck(total, parts) {
    const sum = (k) => parts.reduce((s, p) => s + p[k], 0);
    const diff = Math.max(...["lula", "flavio", "validos"].map((k) => Math.abs(total[k] - sum(k))));
    return { ok: diff === 0, diff };
  }

  // Variação em pontos percentuais da fatia de Lula (Lula × adversário) contra uma eleição de referência.
  // Antes de 95 % das seções o apurado ainda é enviesado pela ordem de chegada, então usa a projeção.
  function swing(live, proj, refShare) {
    if (refShare == null) return null;
    let share = null;
    if (live && live.p >= 0.95 && live.lula + live.flavio > 0) share = live.lula / (live.lula + live.flavio);
    else if (proj) share = proj.share;
    return share == null ? null : (share - refShare) * 100;
  }

  // Fatia de Lula esperada antes de qualquer urna: cada um mantém o seu 1º turno e os votos dos
  // outros candidatos se dividem como a UF se dividiu no 2º turno de 2022 (lean22 = fatia de Lula).
  function priorLula(t1, lean22) {
    return (t1.lula + t1.outros * lean22) / t1.validos;
  }

  // Projeção de uma UF. Os votos válidos esperados vêm do 1º turno, ajustados pelo eleitorado.
  function projectUf(live, t1, lean22) {
    const prior = priorLula(t1, lean22);
    const expected = t1.validos * (live.eleitores / t1.eleitores);
    const remaining = live.p >= 1 ? 0 : Math.max(0, expected - live.validos);
    const partial = live.validos > 0 ? live.lula / live.validos : prior;
    const restShare = live.validos > 0 ? live.p * partial + (1 - live.p) * prior : prior;
    const lula = live.lula + remaining * restShare;
    const flavio = live.flavio + remaining * (1 - restShare);
    return { prior, remaining, restShare, lula, flavio, share: lula / (lula + flavio), p: live.p };
  }

  function rng(seed) {
    let a = seed >>> 0;
    const uni = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return () => Math.sqrt(-2 * Math.log(1 - uni())) * Math.cos(2 * Math.PI * uni());
  }

  // Monte Carlo sobre os votos que faltam: um erro nacional comum e um erro próprio de cada UF,
  // ambos encolhendo conforme as seções são apuradas.
  function simulate(ufs, { n = 2000, seed = 1 } = {}) {
    const gauss = rng(seed);
    const tot = ufs.reduce((s, u) => s + u.lula + u.flavio, 0);
    const pNat = tot ? ufs.reduce((s, u) => s + u.p * (u.lula + u.flavio), 0) / tot : 0;
    const shares = [];
    let wins = 0;
    for (let i = 0; i < n; i++) {
      const nat = gauss() * 0.015 * (1 - pNat);
      let lula = 0, all = 0;
      for (const u of ufs) {
        const counted = u.lula + u.flavio - u.remaining;
        const countedLula = u.lula - u.remaining * u.restShare;
        const s = Math.min(1, Math.max(0, u.restShare + nat + gauss() * 0.03 * (1 - u.p)));
        lula += countedLula + u.remaining * s;
        all += counted + u.remaining;
      }
      const share = all ? lula / all : 0.5;
      shares.push(share);
      if (share > 0.5) wins++;
    }
    shares.sort((a, b) => a - b);
    const q = (x) => shares[Math.min(n - 1, Math.floor(x * n))];
    return { pLula: wins / n, mean: shares.reduce((s, x) => s + x, 0) / n, lo: q(0.05), hi: q(0.95) };
  }

  // Repete um download quando o TSE responde 429 (pedidos demais), esperando o dobro a cada vez.
  async function withRetry(fn, { tries = 4, base = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (e.status !== 429 || i >= tries - 1) throw e;
        await sleep(base * 2 ** i);
      }
    }
  }

  // O TSE não publica o total e as partes ao mesmo tempo, e a CDN guarda cada arquivo por conta própria.
  // Se a soma não bate, as partes com horário mais antigo que o total são as que vale baixar de novo.
  // Quando é o total que está atrasado, as partes mais antigas que ele são só lugares que não mudaram.
  function staleParts(total, parts) {
    if (sumCheck(total, Object.values(parts)).ok || totalIsStale(total, parts)) return [];
    return Object.keys(parts).filter((k) => parts[k].ts < total.ts);
  }

  // Um lote nacional do TSE e o que entrou em cada lugar nele.
  function makeBatch(br, items) {
    const sum = (k) => items.reduce((s, i) => s + i[k], 0);
    return {
      key: `BR:${br.idg}`, hora: br.hora,
      lula: sum("lula"), flavio: sum("flavio"), validos: sum("validos"), n: items.length,
      items: items.slice().sort((a, b) => b.validos - a.validos),
    };
  }

  // O inverso: alguma parte já é mais nova que o total, então é o arquivo do Brasil que está atrasado.
  function totalIsStale(total, parts) {
    if (sumCheck(total, Object.values(parts)).ok) return false;
    return Object.values(parts).some((p) => p.ts > total.ts);
  }

  // Usa só o relógio de quem está vendo: o horário do dado já vem do TSE, e assim o fuso não importa.
  function freshness(now, lastCheck, nextAt) {
    if (lastCheck == null || nextAt == null) return "checando agora";
    const ago = Math.max(0, Math.round((now - lastCheck) / 1000));
    // A contagem regressiva arredonda para cima: nunca mostra "0 s" antes de a checagem sair.
    const wait = Math.max(0, Math.ceil((nextAt - now) / 1000));
    return `checado há ${ago} s · próxima checagem em ${wait} s`;
  }

  // Minutos sem lote novo do TSE, a partir de 5; antes disso é o intervalo normal entre lotes.
  function quietMinutes(now, sinceChange) {
    if (sinceChange == null) return null;
    const min = Math.floor((now - sinceChange) / 60000);
    return min >= 5 ? min : null;
  }

  // Macrorregiões do IBGE.
  const REGIONS = {
    N: ["AC", "AM", "AP", "PA", "RO", "RR", "TO"],
    NE: ["AL", "BA", "CE", "MA", "PB", "PE", "PI", "RN", "SE"],
    CO: ["DF", "GO", "MS", "MT"],
    SE: ["ES", "MG", "RJ", "SP"],
    S: ["PR", "RS", "SC"],
  };

  // Soma os estados de uma região que já têm dado; a fração apurada é refeita sobre as seções somadas.
  function sumRegion(snaps, ufs) {
    const have = ufs.map((u) => snaps[u]).filter(Boolean);
    if (!have.length) return null;
    const r = { lula: 0, flavio: 0, validos: 0, outros: 0, secoes: 0, secoesTot: 0, eleitores: 0,
      est: 0, comparecimento: 0, abstencao: 0, tv: 0, brancos: 0, nulos: 0 };
    have.forEach((s) => { for (const k in r) r[k] += s[k] || 0; });
    r.p = r.secoesTot ? r.secoes / r.secoesTot : 0;
    return r;
  }

  // ---- Histórico central (gravado pelo coletor, lido pela página) ----
  // Formato compacto de um lugar num lote: [idg, ts, lula, flavio, validos, secoes, secoesTot, eleitores].
  const packSnap = (s) => [s.idg, s.ts, s.lula, s.flavio, s.validos, s.secoes, s.secoesTot, s.eleitores];
  function unpackSnap(a) {
    const [idg, ts, lula, flavio, validos, secoes, secoesTot, eleitores = 0] = a;
    return {
      idg, ts, lula, flavio, validos, secoes, secoesTot, eleitores, outros: 0,
      p: secoesTot ? secoes / secoesTot : 0,
      hora: `${ts.slice(8, 10)}/${ts.slice(5, 7)} ${ts.slice(11, 16)}`,
    };
  }

  function historyEntry(br, ufs) {
    return { idg: br.idg, ts: br.ts, hora: br.hora, br: packSnap(br),
      ufs: Object.fromEntries(Object.entries(ufs).map(([uf, s]) => [uf, packSnap(s)])) };
  }

  // Uma entrada por versão nacional do TSE, sempre crescente: repetida ou antiga não entra.
  function appendEntry(entries, e) {
    const last = entries[entries.length - 1];
    return last && e.idg <= last.idg ? entries : [...entries, e];
  }

  // O feed da noite refeito a partir do histórico: o que cada lugar ganhou entre duas entradas seguidas.
  // A primeira entrada é só o ponto de partida.
  function feedFromHistory(entries, max = 40) {
    const out = [];
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1].ufs, cur = entries[i].ufs;
      const items = [];
      for (const uf of Object.keys(cur)) {
        const now = unpackSnap(cur[uf]);
        const d = delta(prev[uf] ? unpackSnap(prev[uf]) : null, now);
        if (d.validos > 0 || d.secoes > 0) items.push({ uf, ...d, dp: now.secoesTot ? d.secoes / now.secoesTot : 0 });
      }
      if (items.length) out.push(makeBatch(entries[i], items));
    }
    return out.reverse().slice(0, max);
  }

  // Versões de uma cidade: [idg, ts, lula, flavio, validos, secoes, secoesTot], só as aceitas.
  function addCityVersion(versions, snap) {
    const last = versions[versions.length - 1];
    if (!acceptSnapshot(last ? unpackSnap(last) : null, snap).ok) return versions;
    return [...versions, packSnap(snap).slice(0, 7)];
  }

  function turnout(s) {
    if (!s || !s.est || !s.tv) return null;
    return { comparecimento: s.comparecimento / s.est, abstencao: s.abstencao / s.est, brancos: s.brancos / s.tv, nulos: s.nulos / s.tv };
  }

  // Quem lidera, por quanto, e quanto dos válidos que faltam (estimados) o outro precisaria para virar.
  // "Decidido" só quando a vantagem supera todos os eleitores das seções ainda não apuradas: isso não depende do modelo.
  function virada(live, remaining) {
    const { lula, flavio } = live;
    if (lula + flavio === 0) return { lider: null, diff: 0, precisa: null, decidido: false };
    const diff = Math.abs(lula - flavio);
    const aberto = live.est != null && live.eleitores ? live.eleitores - live.est : null;
    return {
      lider: lula >= flavio ? "lula" : "flavio",
      diff,
      precisa: remaining > 0 ? (diff + remaining) / (2 * remaining) : null,
      decidido: aberto != null && diff > aberto,
    };
  }

  // Lotes nacionais para os votos por minuto: uma versão do TSE entra uma vez só.
  function addBatch(batches, b, max = 40) {
    if (batches.some((x) => x.idg === b.idg)) return batches;
    return [...batches, b].slice(-max);
  }

  // Tendência de um lugar ao longo da noite: [fração das seções apuradas, fatia de Lula] a cada versão nova com votos.
  function ufSeries(entries, uf) {
    const out = [];
    let lastIdg = null;
    for (const e of entries) {
      const a = uf === "BR" ? e.br : e.ufs[uf];
      if (!a || a[0] === lastIdg) continue;
      lastIdg = a[0];
      const s = unpackSnap(a);
      if (s.lula + s.flavio > 0) out.push([s.p, s.lula / (s.lula + s.flavio)]);
    }
    return out;
  }

  const api = {
    REGIONS, sumRegion, turnout, virada, addBatch, ufSeries, packSnap, unpackSnap, historyEntry, appendEntry, feedFromHistory, addCityVersion,
    parseTse, priorLula, projectUf, simulate, acceptSnapshot, delta, addFeed, sumCheck, swing, withRetry,
    staleParts, totalIsStale, makeBatch, freshness, quietMinutes,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Model = api;
})(this);
