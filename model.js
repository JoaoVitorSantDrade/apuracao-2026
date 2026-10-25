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

  const api = { parseTse, priorLula, projectUf, simulate, acceptSnapshot, delta, addFeed, sumCheck, swing, withRetry };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Model = api;
})(this);
