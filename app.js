// Busca no TSE, estado da página e renderização. A lógica de projeção e de lotes fica em model.js.
(function () {
  const BASE = "https://resultados.tse.jus.br/oficial/ele2026";
  // Histórico central, gravado pelo coletor (coletor/coletor.mjs) na branch "historico" do repositório.
  // ?hist=<pasta> aponta para outra origem, como a pasta local do coletor em modo de teste.
  const HIST = new URLSearchParams(location.search).get("hist") || "https://raw.githubusercontent.com/JoaoVitorSantDrade/apuracao-2026/historico";
  const ELE_2T = "6258";
  const ELE_1T = "6257";
  const CHECK_MS = 15000; // consulta só o arquivo do Brasil; os estados vêm quando a versão dele muda
  const SIM = location.hash === "#simulacao";
  const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

  const NAMES = {
    AC: "Acre", AL: "Alagoas", AP: "Amapá", AM: "Amazonas", BA: "Bahia", CE: "Ceará", DF: "Distrito Federal",
    ES: "Espírito Santo", GO: "Goiás", MA: "Maranhão", MT: "Mato Grosso", MS: "Mato Grosso do Sul",
    MG: "Minas Gerais", PA: "Pará", PB: "Paraíba", PR: "Paraná", PE: "Pernambuco", PI: "Piauí",
    RJ: "Rio de Janeiro", RN: "Rio Grande do Norte", RS: "Rio Grande do Sul", RO: "Rondônia", RR: "Roraima",
    SC: "Santa Catarina", SP: "São Paulo", SE: "Sergipe", TO: "Tocantins", ZZ: "Exterior", BR: "Brasil",
  };
  const UFS = Object.keys(NAMES).filter((u) => u !== "BR"); // 27 UFs + exterior
  const { h22, h18, shapes, regions } = window.STATIC;
  // Regiões usam a chave "reg:<código>": o Sudeste do IBGE ("SE") tem a mesma sigla de Sergipe.
  const REG_NAMES = { N: "Norte", NE: "Nordeste", CO: "Centro-Oeste", SE: "Sudeste", S: "Sul" };
  const isReg = (k) => k.startsWith("reg:");
  const M = window.Model;

  const S = {
    t1: {}, live: {}, proj: {}, nat: null,
    sel: "BR", view: "BR", selCity: null, mode: "live", ref: "t1", level: "uf",
    ok: null, lastOk: null, brIdg: null, lastCheck: null, nextAt: null, sinceChange: Date.now(), syncing: null,
    hist: [], feed: [], batches: [], flash: new Set(), flashNew: new Set(),
    mun: null, geo: {}, city1: {}, city: {}, cityHist: {}, cityAt: {}, cityLoad: null, cityBusy: null,
  };
  const KEY = SIM ? "apuracao26-sim" : "apuracao26-v2"; // v2: feed agrupado por lote

  const $ = (id) => document.getElementById(id);
  const pct = (x, d = 2) => x == null || !isFinite(x) ? "–"
    : (x * 100).toLocaleString("pt-BR", { minimumFractionDigits: d, maximumFractionDigits: d }) + "%";
  const int = (x) => x == null ? "–" : Math.round(x).toLocaleString("pt-BR");
  const mi = (x) => (x / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + " mi";
  const pp = (x) => Math.abs(x).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " pp";
  const title = (s) => s.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
    .replace(/ (D[aeo]s?|E) /g, (m) => m.toLowerCase());
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sem storage: segue sem lembrar */ } },
  };

  const url = (ele, uf, mun = "") => `${BASE}/${ele}/dados/${uf}/${uf}${mun}-c0001-e${ele.padStart(6, "0")}-u.json`;
  // Tempo-limite: em pico de acesso o TSE pode demorar muito, e um pedido pendurado não pode travar o painel.
  const TIMEOUT_MS = 20000;
  async function getJson(u) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const r = await fetch(u, { cache: "no-store", signal: ctl.signal });
      if (!r.ok) { const e = new Error(`${r.status} ${u}`); e.status = r.status; throw e; }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  }
  const fetchUf = async (ele, uf, mun) => M.parseTse(await M.withRetry(() => getJson(url(ele, uf.toLowerCase(), mun))));

  // Baixa muitos arquivos com no máximo `n` ao mesmo tempo.
  async function pool(items, n, fn) {
    const out = new Array(items.length);
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
    }));
    return out;
  }

  // ---- Referências ----
  function sumH22() {
    const t2 = { lula: 0, bolsonaro: 0 };
    Object.values(h22).forEach((h) => { t2.lula += h.t2.lula; t2.bolsonaro += h.t2.bolsonaro; });
    return { t2 };
  }
  function sumH18() {
    const t2 = { haddad: 0, bolsonaro: 0 };
    Object.values(h18).forEach((h) => { t2.haddad += h.t2.haddad; t2.bolsonaro += h.t2.bolsonaro; });
    return { t2 };
  }
  const lean22 = (uf) => {
    const h = uf === "BR" ? sumH22() : h22[uf];
    return h ? h.t2.lula / (h.t2.lula + h.t2.bolsonaro) : null;
  };
  const two = (x) => x && x.lula + x.flavio > 0 ? x.lula / (x.lula + x.flavio) : null;
  const placeName = (k) => isReg(k) ? REG_NAMES[k.slice(4)] : NAMES[k];
  function sumH(table, ufs, keys) {
    const t2 = Object.fromEntries(keys.map((k) => [k, 0]));
    const have = ufs.filter((u) => table[u]);
    have.forEach((u) => keys.forEach((k) => { t2[k] += table[u].t2[k]; }));
    return have.length ? { t2 } : null;
  }
  function sumProj(ps) {
    if (!ps.length) return null;
    const lula = ps.reduce((s, p) => s + p.lula, 0), flavio = ps.reduce((s, p) => s + p.flavio, 0);
    return { lula, flavio, remaining: ps.reduce((s, p) => s + p.remaining, 0), share: lula / (lula + flavio) };
  }
  // Tudo o que o painel mostra de um lugar: um estado ("SP"), uma região ("reg:NE"), o exterior ou o Brasil.
  function placeData(k) {
    if (k === "BR") {
      return { live: S.live.BR, t1: S.t1.BR, proj: sumProj(Object.values(S.proj)), h22: sumH22(), h18: sumH18() };
    }
    if (isReg(k)) {
      const ufs = M.REGIONS[k.slice(4)];
      return {
        live: M.sumRegion(S.live, ufs), t1: M.sumRegion(S.t1, ufs), proj: sumProj(ufs.map((u) => S.proj[u]).filter(Boolean)),
        h22: sumH(h22, ufs, ["lula", "bolsonaro"]), h18: sumH(h18, ufs, ["haddad", "bolsonaro"]),
      };
    }
    return { live: S.live[k], t1: S.t1[k], proj: S.proj[k], h22: h22[k], h18: h18[k] };
  }
  const h22Share = (h) => h ? h.t2.lula / (h.t2.lula + h.t2.bolsonaro) : null;
  const refShare = (k) => S.ref === "h22" ? h22Share(placeData(k).h22) : two(placeData(k).t1);
  const REF_NAME = { t1: "1º turno 2026", h22: "2º turno 2022" };
  const swingUf = (k) => {
    if (k === "BR") return M.swing(S.live.BR, S.nat ? { share: S.nat.mean } : null, refShare("BR"));
    const d = placeData(k);
    return M.swing(d.live, d.proj, refShare(k));
  };

  // ---- Simulação (#simulacao): apuração fictícia a partir do 1º turno. Imita o TSE de verdade: o total do
  //      Brasil sai sempre em dia, mas cada estado pode vir repetido ou numa versão antiga da CDN ----
  const sim = { step: 0, idg: 1000, speed: {}, bias: {}, natBias: (Math.random() - 0.5) * 0.04, past: {} };
  function simSnap(uf) {
    const t = S.t1[uf];
    sim.speed[uf] ??= 0.6 + Math.random() * 0.8;
    sim.bias[uf] ??= (Math.random() - 0.5) * 0.04;
    const p = Math.min(1, sim.step * sim.speed[uf]);
    const finalShare = M.priorLula(t, lean22(uf) ?? 0.5) + sim.natBias + sim.bias[uf];
    const share = Math.min(0.95, Math.max(0.05, finalShare + 0.04 * (1 - p) * (uf === "ZZ" ? 1 : -1)));
    const secoes = Math.round(t.secoesTot * p);
    const validos = Math.round(t.validos * secoes / t.secoesTot);
    const lula = Math.round(validos * share);
    const d = new Date();
    return { lula, flavio: validos - lula, validos, outros: 0, secoes, secoesTot: t.secoesTot, p: secoes / t.secoesTot,
      eleitores: t.eleitores, comparecimento: 0, hora: nowHora(d), idg: sim.idg, ts: isoLocal(d) };
  }
  // Gera a versão nova de todos os lugares e devolve o total do Brasil, que é a soma deles.
  function simPublish() {
    sim.step += 0.02; sim.idg += 1;
    const br = { lula: 0, flavio: 0, validos: 0, secoes: 0, secoesTot: 0, eleitores: 0 };
    UFS.forEach((uf) => { const s = simSnap(uf); (sim.past[uf] ??= []).push(s); for (const k in br) br[k] += s[k]; });
    const d = new Date();
    return { ...br, outros: 0, p: br.secoes / br.secoesTot, hora: nowHora(d), idg: sim.idg, ts: isoLocal(d) };
  }
  // O que a "CDN" entrega para um estado: quase sempre a versão nova, às vezes uma anterior.
  function simServe(uf) {
    const past = sim.past[uf];
    const r = Math.random();
    if (past.length > 2 && r < 0.08) return past[past.length - 3];
    if (past.length > 1 && r < 0.25) return past[past.length - 2];
    return past[past.length - 1];
  }
  const z2 = (n) => String(n).padStart(2, "0");
  const nowHora = (d = new Date()) => `${z2(d.getDate())}/${z2(d.getMonth() + 1)} ${z2(d.getHours())}:${z2(d.getMinutes())}`;
  const isoLocal = (d) => `${d.getFullYear()}-${z2(d.getMonth() + 1)}-${z2(d.getDate())}T${z2(d.getHours())}:${z2(d.getMinutes())}:${z2(d.getSeconds())}`;

  // ---- Carga ----
  async function loadT1() {
    const missing = ["BR", ...UFS].filter((uf) => !S.t1[uf]);
    const res = await Promise.allSettled(missing.map(async (uf) => [uf, await fetchUf(ELE_1T, uf)]));
    res.forEach((r) => { if (r.status === "fulfilled") S.t1[r.value[0]] = r.value[1]; });
    return res.every((r) => r.status === "fulfilled");
  }

  // A noite inteira para quem chega agora: gráfico, feed e votos por minuto refeitos a partir do histórico.
  // Sem histórico publicado (ou com erro ao baixar), a página segue como antes, só com o ao vivo.
  async function loadHistory() {
    if (SIM) return;
    let h;
    try { h = await getJson(`${HIST}/historico.json`); } catch { return; }
    const entries = h?.entries || [];
    if (!entries.length) return;
    S.feed = M.feedFromHistory(entries, 40);
    S.batches = [];
    S.hist = [];
    entries.forEach((e, i) => {
      const br = M.unpackSnap(e.br);
      if (i) {
        const d = M.delta(M.unpackSnap(entries[i - 1].br), br);
        if (d.validos > 0) S.batches.push({ ts: br.ts, hora: br.hora, validos: d.validos, lula: d.lula, flavio: d.flavio });
      }
      if (!br.validos || S.hist[S.hist.length - 1]?.p === br.p) return;
      const list = Object.entries(e.ufs).filter(([uf]) => S.t1[uf])
        .map(([uf, a]) => M.projectUf(M.unpackSnap(a), S.t1[uf], lean22(uf) ?? 0.5));
      if (!list.length) return;
      const n = M.simulate(list, { n: 400, seed: 2026 });
      S.hist.push({ p: br.p, s: br.lula / br.validos, m: n.mean, lo: n.lo, hi: n.hi, h: br.hora });
    });
    S.batches = S.batches.slice(-40);
    // O estado atual parte da última entrada: o ao vivo segue dela, e o que o TSE publicou depois vira um lote no feed.
    const last = entries[entries.length - 1];
    S.live.BR = M.unpackSnap(last.br);
    for (const [uf, a] of Object.entries(last.ufs)) S.live[uf] = M.unpackSnap(a);
    compute();
    render();
  }

  // Cidades publicadas pelo coletor: um download por estado. Devolve true se já estão na versão atual do estado.
  async function loadCityHistory(uf) {
    if (SIM) return false;
    const [m2, m1] = await Promise.allSettled([getJson(`${HIST}/mun/${uf}.json`), getJson(`${HIST}/mun1t/${uf}.json`)]);
    if (m1.status === "fulfilled") {
      for (const [cd, [lula, flavio, validos, outros, secoesTot, eleitores]] of Object.entries(m1.value)) {
        S.city1[uf][cd] = { lula, flavio, validos, outros, secoes: secoesTot, secoesTot, eleitores, p: 1 };
      }
      store.set(`apuracao26-c1-${uf}`, S.city1[uf]);
    }
    if (m2.status !== "fulfilled") return false;
    const { hora, cidades } = m2.value;
    S.cityHist[uf] = cidades;
    for (const [cd, vs] of Object.entries(cidades)) if (vs.length) apply(S.city[uf], cd, M.unpackSnap(vs[vs.length - 1]));
    return !!hora && hora === S.live[uf]?.hora;
  }

  // Aplica um lote de um lugar: aceita, calcula o que entrou de novo e devolve o delta (ou null).
  function apply(map, key, snap) {
    const prev = map[key];
    const a = M.acceptSnapshot(prev, snap);
    if (!a.ok) return null;
    map[key] = snap;
    return M.delta(prev, snap);
  }

  const SYNC_TRIES = 3;
  const SYNC_WAIT_MS = SIM ? 1000 : 5000;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const getTotal = () => SIM ? Promise.resolve(sim.lastBr) : fetchUf(ELE_2T, "BR");
  const getPart = (uf) => SIM ? Promise.resolve(simServe(uf)) : fetchUf(ELE_2T, uf);

  // Baixa as partes pedidas e entrega cada uma assim que chega.
  async function fetchParts(list, onSnap) {
    await Promise.allSettled(list.map(async (uf) => onSnap(uf, await getPart(uf))));
  }

  // Redesenho agrupado: muitos arquivos chegando em sequência viram um redesenho a cada 80 ms.
  // Temporizador, não requestAnimationFrame: este para quando a aba fica em segundo plano.
  const DRAW_MS = 80;
  let drawQueued = false;
  function scheduleRender() {
    if (drawQueued) return;
    drawQueued = true;
    setTimeout(() => { drawQueued = false; compute(); render(); }, DRAW_MS);
  }

  function applyTotal(br) {
    const dBr = apply(S.live, "BR", br);
    if (dBr) S.sinceChange = Date.now();
    if (dBr && dBr.validos > 0) {
      S.batches = [...S.batches, { ts: br.ts, hora: br.hora, validos: dBr.validos, lula: dBr.lula, flavio: dBr.flavio }].slice(-40);
    }
  }

  // Nunca duas consultas ao mesmo tempo: se o TSE estiver lento, o ciclo seguinte espera em vez de empilhar pedidos.
  let ticking = false, timer = null;
  async function tick() {
    if (ticking) return;
    ticking = true;
    clearTimeout(timer);
    S.nextAt = null;
    renderFresh();
    try {
      if (SIM) sim.lastBr = simPublish();
      let br = await getTotal();
      S.lastCheck = Date.now();
      if (br.idg !== S.brIdg) {
        // A tela atualiza conforme os arquivos chegam: o total do Brasil na hora, cada estado assim que
        // baixa (sempre pela aceitação de versão, então nada conta duas vezes). Os arquivos de um lote saem
        // do TSE em momentos diferentes, por isso o lote só fecha no feed depois de insistir por alguns
        // segundos nos atrasados (estados mais velhos que o total, ou o próprio total).
        const first = !S.live.BR; // a primeira carga é o ponto de partida, não um lote
        const items = {};
        S.flash.clear();
        applyTotal(br);
        scheduleRender();
        const take = (uf, snap) => {
          const d = apply(S.live, uf, snap);
          if (d && (d.validos > 0 || d.secoes > 0)) {
            S.flash.add(uf);
            S.flashNew.add(uf);
            const a = items[uf] || { uf, lula: 0, flavio: 0, validos: 0, secoes: 0 };
            items[uf] = { uf, lula: a.lula + d.lula, flavio: a.flavio + d.flavio, validos: a.validos + d.validos,
              secoes: a.secoes + d.secoes, dp: (a.secoes + d.secoes) / snap.secoesTot };
          }
          scheduleRender();
        };
        await fetchParts(UFS, take);
        for (let i = 1; i <= SYNC_TRIES; i++) {
          const parts = {};
          UFS.forEach((uf) => { if (S.live[uf]) parts[uf] = S.live[uf]; });
          const missing = UFS.filter((uf) => !parts[uf]);
          const stale = M.staleParts(br, parts);
          const totalOld = M.totalIsStale(br, parts);
          if (!missing.length && !stale.length && !totalOld) break;
          S.syncing = i;
          renderSeal();
          await sleep(SYNC_WAIT_MS);
          await fetchParts([...new Set([...missing, ...stale])], take);
          if (totalOld) {
            const nb = await getTotal();
            if (nb.idg > br.idg) { br = nb; applyTotal(nb); scheduleRender(); }
          }
        }
        S.syncing = null;
        const list = Object.values(items);
        if (!first && list.length) S.feed = M.addFeed(S.feed, M.makeBatch(br, list), 40);
        store.set(KEY, { hist: S.hist, feed: S.feed, batches: S.batches });
        S.ok = UFS.every((uf) => S.live[uf]);
        if (S.ok) S.brIdg = br.idg; // faltou algum estado: o próximo ciclo baixa tudo de novo
        if (S.view !== "BR" && S.flash.has(S.view)) loadCities(S.view);
      } else S.ok = true;
      S.lastOk = new Date();
    } catch {
      S.ok = false;
    } finally {
      ticking = false;
      S.syncing = null;
    }
    S.nextAt = Date.now() + (SIM ? 4000 : CHECK_MS);
    timer = setTimeout(tick, S.nextAt - Date.now());
    compute();
    render();
  }

  function compute() {
    const list = [];
    UFS.forEach((uf) => {
      if (!S.t1[uf] || !S.live[uf]) return;
      S.proj[uf] = M.projectUf(S.live[uf], S.t1[uf], lean22(uf) ?? 0.5);
      list.push(S.proj[uf]);
    });
    if (!list.length) return;
    S.nat = M.simulate(list, { n: 2000, seed: 2026 });
    const br = S.live.BR;
    if (br && br.validos) {
      const last = S.hist[S.hist.length - 1];
      if (!last || last.p !== br.p) {
        S.hist.push({ p: br.p, s: br.lula / br.validos, m: S.nat.mean, lo: S.nat.lo, hi: S.nat.hi, h: br.hora });
        S.hist = S.hist.slice(-400);
      }
    }
  }

  // ---- Cidades ----
  async function loadMun() {
    if (S.mun) return S.mun;
    const j = await getJson(`${BASE}/${ELE_2T}/config/mun-e${ELE_2T.padStart(6, "0")}-cm.json`);
    S.mun = {};
    j.abr.forEach((a) => { S.mun[a.cd.toUpperCase()] = a.mu.map((m) => ({ cd: m.cd, cdi: m.cdi, nm: title(m.nm) })); });
    return S.mun;
  }
  async function loadGeo(uf) {
    if (S.geo[uf]) return S.geo[uf];
    const j = await getJson(`https://servicodados.ibge.gov.br/api/v3/malhas/estados/${uf}?intrarregiao=municipio&formato=application/vnd.geo%2Bjson&qualidade=minima`);
    S.geo[uf] = j.features;
    return j.features;
  }

  // O TSE barra quem pede demais (429): poucas conexões por vez, o 1º turno das cidades fica guardado
  // no navegador e o 2º turno de um estado é rebaixado no máximo a cada 90 s.
  const CITY_CONC = 4;
  const CITY_REFRESH_MS = 90000;
  let cityRun = 0;
  async function loadCities(uf, force = false) {
    if (S.cityBusy === uf) return; // uma carga por vez; a próxima atualização pega o que mudou
    if (!force && S.cityAt[uf] && Date.now() - S.cityAt[uf] < CITY_REFRESH_MS) return;
    const run = ++cityRun;
    S.cityBusy = uf;
    try {
      // O mapa só é desenhado com a lista do TSE em mãos: é ela que liga cada contorno do IBGE ao código da cidade.
      const [mun, geo] = await Promise.all([loadMun(), loadGeo(uf)]);
      if (run === cityRun && S.view === uf) drawCityMap(uf, geo);
      const list = mun[uf] || [];
      S.city1[uf] ??= store.get(`apuracao26-c1-${uf}`) || {};
      S.city[uf] ??= {};
      // Primeiro o que o coletor publicou; o TSE só completa o que ainda não está em dia.
      const fresh = await loadCityHistory(uf);
      if (run !== cityRun) return;
      paintMap();
      const missing1 = list.filter((m) => !S.city1[uf][m.cd]);
      const list2 = fresh ? [] : list;
      const total = missing1.length + list2.length;
      let done = 0;
      // Cada cidade é pintada assim que chega (um redesenho do mapa a cada 80 ms, no máximo).
      let paintQueued = false;
      const paintSoon = () => {
        if (paintQueued || run !== cityRun) return;
        paintQueued = true;
        setTimeout(() => { paintQueued = false; if (run === cityRun) { paintMap(); renderCityStatus(); } }, DRAW_MS);
      };
      const progress = () => { S.cityLoad = { done, total }; paintSoon(); };
      const each = (fn, keep) => async (m) => { const s = await fn(m); if (s) keep(m, s); done++; progress(); return s; };
      progress();
      // O 2º turno vem primeiro: é o que está na tela.
      const r2 = SIM ? list.map((m) => simCity(uf, m.cd))
        : await pool(list2, CITY_CONC, each((m) => fetchUf(ELE_2T, uf, m.cd), (m, s) => apply(S.city[uf], m.cd, s)));
      if (SIM) list.forEach((m, i) => { if (r2[i]) apply(S.city[uf], m.cd, r2[i]); });
      if (run !== cityRun) return;
      if (missing1.length) {
        await pool(missing1, CITY_CONC, each((m) => fetchUf(ELE_1T, uf, m.cd), (m, s) => { S.city1[uf][m.cd] = s; }));
        store.set(`apuracao26-c1-${uf}`, S.city1[uf]);
      }
      S.cityAt[uf] = Date.now();
      const failed = (SIM ? 0 : list2.length - r2.filter(Boolean).length) + missing1.length - missing1.filter((m) => S.city1[uf][m.cd]).length;
      S.cityLoad = failed ? { failed } : null;
      if (run === cityRun) render();
    } catch {
      S.cityLoad = { error: true };
      if (run === cityRun) renderCityStatus();
    } finally {
      if (S.cityBusy === uf) S.cityBusy = null;
    }
  }
  // Na simulação, a cidade apura na mesma proporção do estado, com o viés do 1º turno local.
  function simCity(uf, cd) {
    const t = S.city1[uf]?.[cd], st = S.live[uf];
    if (!t || !st) return null;
    const share = Math.min(0.95, Math.max(0.05, two(t) + (two(st) ?? 0.5) - (two(S.t1[uf]) ?? 0.5)));
    const validos = Math.round(t.validos * st.p);
    const lula = Math.round(validos * share);
    return { lula, flavio: validos - lula, validos, secoes: Math.round(t.secoesTot * st.p), secoesTot: t.secoesTot,
      p: st.p, eleitores: t.eleitores, hora: st.hora, idg: st.idg, ts: st.ts };
  }

  // ---- Mapa ----
  const K = Math.cos((15 * Math.PI) / 180);
  const xy = ([lo, la]) => [lo * K, -la];
  function ringsToPath(rings, box) {
    return rings.map((ring) => "M" + ring.map((pt) => {
      const [x, y] = xy(pt);
      box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], y); box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], y);
      return `${x.toFixed(3)},${y.toFixed(3)}`;
    }).join("L") + "Z").join("");
  }
  function setViewBox(svg, box, pad) {
    svg.setAttribute("viewBox", `${box[0] - pad} ${box[1] - pad} ${box[2] - box[0] + 2 * pad} ${box[3] - box[1] + 2 * pad}`);
  }

  function drawStateMap() {
    const svg = $("map");
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const nudge = { DF: [0.3, 0.2], SE: [0.5, 0], AL: [0.6, 0], PB: [0.9, 0], RN: [0.6, -0.2], PE: [0.6, 0], ES: [0.4, 0], RJ: [0.2, 0.2] };
    let paths = "", labels = "";
    for (const [uf, rings] of Object.entries(shapes)) {
      paths += `<path data-uf="${uf}" d="${ringsToPath(rings, box)}"><title>${NAMES[uf]}</title></path>`;
      const big = rings.reduce((a, b) => (b.length > a.length ? b : a));
      const cx = big.reduce((s, p) => s + xy(p)[0], 0) / big.length, cy = big.reduce((s, p) => s + xy(p)[1], 0) / big.length;
      const [dx, dy] = nudge[uf] || [0, 0];
      labels += `<text x="${(cx + dx).toFixed(2)}" y="${(cy + dy).toFixed(2)}" text-anchor="middle">${uf}</text>`;
    }
    svg.dataset.kind = "uf";
    svg.innerHTML = paths + labels;
    setViewBox(svg, box, 0.6);
    paintMap();
  }

  function drawRegionMap() {
    const svg = $("map");
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    let paths = "", labels = "";
    for (const [code, rings] of Object.entries(regions)) {
      paths += `<path data-uf="reg:${code}" d="${ringsToPath(rings, box)}"><title>${REG_NAMES[code]}</title></path>`;
      const big = rings.reduce((a, b) => (b.length > a.length ? b : a));
      const cx = big.reduce((s, p) => s + xy(p)[0], 0) / big.length, cy = big.reduce((s, p) => s + xy(p)[1], 0) / big.length;
      labels += `<text class="reg" x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" text-anchor="middle">${REG_NAMES[code]}</text>`;
    }
    svg.dataset.kind = "reg";
    svg.innerHTML = paths + labels;
    setViewBox(svg, box, 0.6);
    paintMap();
  }
  const drawMainMap = () => (S.level === "reg" ? drawRegionMap() : drawStateMap());

  function drawCityMap(uf, features) {
    const svg = $("map");
    const box = [Infinity, Infinity, -Infinity, -Infinity];
    const byCdi = {};
    (S.mun?.[uf] || []).forEach((m) => { byCdi[m.cdi] = m; });
    svg.dataset.kind = "city";
    svg.innerHTML = features.map((f) => {
      const g = f.geometry;
      const rings = g.type === "MultiPolygon" ? g.coordinates.map((p) => p[0]) : [g.coordinates[0]];
      const m = byCdi[f.properties.codarea];
      return `<path data-cd="${m ? m.cd : ""}" d="${ringsToPath(rings, box)}"><title>${m ? m.nm : ""}</title></path>`;
    }).join("");
    const w = box[2] - box[0];
    setViewBox(svg, box, w * 0.02);
    paintMap();
  }

  const fillShare = (s) => {
    if (s == null) return "var(--map-empty)";
    const k = Math.min(1, Math.abs(s - 0.5) * 10);
    return `color-mix(in oklab, ${s >= 0.5 ? "var(--shu)" : "var(--ai)"} ${Math.round(35 + 65 * k)}%, var(--map-empty))`;
  };
  const fillSwing = (sw) => {
    if (sw == null) return "var(--map-empty)";
    const k = Math.min(1, Math.abs(sw) / 10);
    return `color-mix(in oklab, ${sw >= 0 ? "var(--shu)" : "var(--ai)"} ${Math.round(15 + 85 * k)}%, var(--map-empty))`;
  };

  function ufShare(k, mode) {
    const d = placeData(k);
    if (mode === "live") return d.live?.validos > 0 ? two(d.live) : null;
    if (mode === "proj") return d.proj?.share ?? null;
    if (mode === "t1") return two(d.t1);
    if (mode === "h22") return h22Share(d.h22);
    if (mode === "h18") { const h = d.h18; return h ? h.t2.haddad / (h.t2.haddad + h.t2.bolsonaro) : null; }
    return null;
  }
  // Nas cidades não há projeção nem dados de 2018/2022: a variação usa o apurado contra o 1º turno local.
  function citySwing(uf, cd) {
    const live = S.city[uf]?.[cd], t1 = S.city1[uf]?.[cd];
    if (!live || !live.validos || !t1) return null;
    return (two(live) - two(t1)) * 100;
  }

  function paintMap() {
    const svg = $("map");
    if (svg.dataset.kind === "city") {
      const uf = S.view;
      svg.querySelectorAll("path").forEach((p) => {
        const cd = p.dataset.cd;
        const live = S.city[uf]?.[cd], t1 = S.city1[uf]?.[cd];
        p.style.fill = S.mode === "swing" ? fillSwing(citySwing(uf, cd))
          : S.mode === "t1" ? fillShare(two(t1)) : fillShare(live?.validos ? two(live) : null);
        p.classList.toggle("sel", cd === S.selCity);
      });
    } else {
      svg.querySelectorAll("path").forEach((p) => {
        const uf = p.dataset.uf;
        p.style.fill = S.mode === "swing" ? fillSwing(swingUf(uf)) : fillShare(ufShare(uf, S.mode));
        p.classList.toggle("sel", uf === S.sel);
        if (S.flashNew.has(uf) && !REDUCED) { p.classList.remove("flash"); void p.getBBox(); p.classList.add("flash"); }
      });
    }
  }

  const MODE_TITLES = {
    live: "Quem lidera, no apurado", proj: "Quem vence, pela projeção", swing: "Para que lado cada lugar foi",
    t1: "1º turno de 2026: Lula × Flávio", h22: "2022 · 2º turno: Lula × Bolsonaro", h18: "2018 · 2º turno: Haddad × Bolsonaro",
  };
  function renderMapChrome() {
    const city = S.view !== "BR";
    $("map-title").textContent = (city ? `${NAMES[S.view]} · ` : "") + MODE_TITLES[S.mode]
      + (S.mode === "swing" ? ` (vs ${city ? REF_NAME.t1 : REF_NAME[S.ref]})` : "");
    document.querySelectorAll("#modes button").forEach((b) => {
      b.hidden = city && !["live", "t1", "swing"].includes(b.dataset.mode);
      b.setAttribute("aria-pressed", String(b.dataset.mode === S.mode));
    });
    $("back").hidden = !city;
    document.querySelectorAll("#levels button").forEach((b) => b.setAttribute("aria-pressed", String(!city && b.dataset.level === S.level)));
    $("city-search").hidden = !city;
    $("zz-row").hidden = city;
    const sw = S.mode === "swing";
    const right = S.mode === "h18" || S.mode === "h22" ? "Bolsonaro" : "Flávio";
    const left = S.mode === "h18" ? "Haddad" : "Lula";
    $("leg-r").textContent = sw ? "foi para Flávio +10 pp" : `${right} +10 pp`;
    $("leg-l").textContent = sw ? "foi para Lula +10 pp" : `${left} +10 pp`;
  }
  function renderCityStatus() {
    const el = $("city-status");
    const c = S.cityLoad;
    el.hidden = S.view === "BR" || !c;
    if (!c) return;
    el.textContent = c.error ? "Não foi possível baixar as cidades agora. Tentando de novo na próxima atualização."
      : c.failed ? `${int(c.failed)} cidades sem resposta do TSE agora (aparecem sem cor). Tentando de novo em 90 s.`
      : `Baixando as cidades: ${int(c.done)} de ${int(c.total)} arquivos`;
  }

  // ---- Animação dos números ----
  function tween(el, to, fmt) {
    const from = el._v ?? to;
    el._v = to;
    if (REDUCED || from === to || !isFinite(from)) { el.textContent = fmt(to); return; }
    const t0 = performance.now(), dur = 900;
    cancelAnimationFrame(el._raf);
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3);
      el.textContent = fmt(from + (to - from) * e);
      if (k < 1) el._raf = requestAnimationFrame(step);
    };
    el._raf = requestAnimationFrame(step);
  }

  // ---- Renderização ----
  function render() {
    const br = S.live.BR;
    if (br) {
      const tot = br.lula + br.flavio;
      if (tot) { tween($("s-l"), br.lula / tot, (v) => pct(v)); tween($("s-f"), br.flavio / tot, (v) => pct(v)); }
      tween($("s-lv"), br.lula, (v) => `${int(v)} votos`);
      tween($("s-fv"), br.flavio, (v) => `${int(v)} votos`);
      tween($("s-p"), br.p, (v) => pct(v));
      $("s-ps").textContent = `${int(br.secoes)} de ${int(br.secoesTot)} seções`;
      $("b-l").style.width = tot ? (br.lula / tot * 100).toFixed(3) + "%" : "0";
      $("b-f").style.width = tot ? (br.flavio / tot * 100).toFixed(3) + "%" : "0";
      $("clock").textContent = `TSE · ${br.hora}`;
    }
    const chip = $("chip");
    if (SIM) { chip.className = "chip sim"; chip.textContent = "simulação"; }
    else if (!S.lastOk && S.ok === null) { chip.className = "chip stale"; chip.textContent = "carregando"; }
    else if (!S.lastOk) { chip.className = "chip err"; chip.textContent = "sem conexão com o TSE"; }
    else if (!S.ok) {
      chip.className = "chip stale";
      chip.textContent = `dados de ${S.lastOk.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    } else if (br && br.p >= 1) { chip.className = "chip live"; chip.textContent = "totalizado"; }
    else if (br && br.p > 0 && M.quietMinutes(Date.now(), S.sinceChange)) {
      chip.className = "chip stale"; chip.textContent = `TSE sem lote novo há ${M.quietMinutes(Date.now(), S.sinceChange)} min`;
    } else if (br && br.p > 0) { chip.className = "chip live"; chip.textContent = "ao vivo"; }
    else { chip.className = "chip stale"; chip.textContent = "aguardando a apuração"; }

    renderMapChrome();
    paintMap();
    renderCityStatus();
    renderFeed();
    renderProj();
    renderChart();
    renderDetail();
    renderTable();
    S.flashNew.clear(); // cada chegada pisca uma vez, mesmo com vários redesenhos seguidos
  }

  function renderFeed() {
    // Votos por minuto: diferença entre os dois últimos lotes nacionais aceitos.
    const b = S.batches;
    if (b.length >= 2) {
      const a = b[b.length - 2], c = b[b.length - 1];
      const min = Math.max(0.25, (new Date(c.ts) - new Date(a.ts)) / 60000);
      tween($("vpm"), c.validos / min, (v) => int(v));
    }
    $("last-batch").textContent = b.length ? `último lote: +${int(b[b.length - 1].validos)} válidos às ${b[b.length - 1].hora.slice(6)}` : "nenhum lote ainda";
    const max = Math.max(1, ...b.map((x) => x.validos));
    $("spark").innerHTML = b.slice(-30).map((x) => {
      const h = Math.max(2, (x.validos / max) * 36), lw = x.validos ? x.lula / x.validos : 0.5;
      return `<span title="${x.hora} · +${int(x.validos)}" style="height:${h.toFixed(1)}px">` +
        `<i class="l" style="height:${(lw * 100).toFixed(1)}%"></i></span>`;
    }).join("");

    renderSeal();
    renderFresh();

    const list = $("feed");
    const have = new Set([...list.children].map((li) => li.dataset.key));
    if (!S.feed.length) { list.innerHTML = `<li class="empty caption">Cada lote que o TSE publicar aparece aqui, com o que entrou de novo em cada estado.</li>`; return; }
    const split = (l, f) => {
      const t = l + f, lw = t ? l / t : 0;
      return `<span class="mini"><i class="l" style="width:${(lw * 100).toFixed(1)}%"></i></span>` +
        `<span class="mono s"><span class="l">${pct(lw, 1)}</span> · <span class="f">${pct(t ? 1 - lw : 0, 1)}</span></span>`;
    };
    list.innerHTML = S.feed.slice(0, 20).map((b) => {
      const ufs = b.items.filter((i) => i.uf !== "ZZ").length, zz = b.items.some((i) => i.uf === "ZZ");
      const where = [ufs ? `${ufs} ${ufs === 1 ? "estado" : "estados"}` : "", zz ? "exterior" : ""].filter(Boolean).join(" + ");
      return `<li data-key="${b.key}" class="batch${have.size && !have.has(b.key) ? " new" : ""}">` +
        `<div class="bh"><span class="mono t">${b.hora.slice(6)}</span><b class="mono">+${int(b.validos)}</b>` +
        `<span class="caption">${where}</span>${split(b.lula, b.flavio)}</div>` +
        `<ul>${b.items.map((e) => `<li><b>${e.uf}</b><span class="mono v">+${int(e.validos)}</span>${split(e.lula, e.flavio)}` +
          `<span class="mono dp">+${(e.dp * 100).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} pp seções</span></li>`).join("")}</ul></li>`;
    }).join("");
  }

  // Conferência: soma das UFs + exterior contra o total do Brasil publicado pelo TSE.
  function renderSeal() {
    const seal = $("seal");
    const br = S.live.BR;
    const parts = UFS.map((u) => S.live[u]).filter(Boolean);
    if (S.syncing) { seal.className = "chip stale"; seal.textContent = `sincronizando estados · tentativa ${S.syncing} de ${SYNC_TRIES}`; return; }
    if (!br || parts.length < UFS.length) { seal.className = "chip stale"; seal.textContent = "conferindo"; return; }
    const c = M.sumCheck(br, parts);
    if (c.ok) { seal.className = "chip ok"; seal.textContent = "soma dos estados confere"; }
    else { seal.className = "chip stale"; seal.textContent = `TSE ainda não publicou tudo · ${int(c.diff)} votos de diferença`; }
  }

  function renderFresh() {
    $("fresh").textContent = M.freshness(Date.now(), S.lastCheck, S.nextAt);
  }

  function renderProj() {
    const n = S.nat;
    if (!n) return;
    tween($("p-l"), n.pLula, (v) => pct(v, 0));
    tween($("p-f"), 1 - n.pLula, (v) => pct(v, 0));
    const x = (s) => Math.min(100, Math.max(0, (s - 0.4) / 0.2 * 100));
    $("p-rng").style.left = x(n.lo) + "%";
    $("p-rng").style.width = Math.max(0.6, x(n.hi) - x(n.lo)) + "%";
    $("p-mean").style.left = `calc(${x(n.mean)}% - 1px)`;
    const br = S.live.BR;
    const remaining = Object.values(S.proj).reduce((s, p) => s + p.remaining, 0);
    const range = `faixa de 90%: ${pct(n.lo, 1)} a ${pct(n.hi, 1)}`;
    $("p-text").textContent = !br || br.p === 0
      ? `Antes da primeira urna, a projeção vem só do modelo: Lula com ${pct(n.mean, 1)} dos válidos (${range}). ` +
        "Ela parte do 1º turno e de como cada estado dividiu os votos em 2022, e fica mais firme conforme as seções chegam."
      : `Com ${pct(br.p, 1)} das seções apuradas, o modelo projeta Lula com ${pct(n.mean, 1)} dos válidos ` +
        `e Flávio com ${pct(1 - n.mean, 1)} (${range}). Faltam cerca de ${mi(remaining)} de votos válidos.`;
  }

  let prevLen = 0;
  function renderChart() {
    const svg = $("chart");
    const H = S.hist;
    const W = 400, Ht = 180, L = 40, R = 378, T = 10, B = 150;
    if (!H.length) {
      svg.innerHTML = `<text x="${W / 2}" y="${Ht / 2}" text-anchor="middle">A evolução aparece quando a apuração começar.</text>`;
      return;
    }
    const vals = H.flatMap((h) => [h.s, h.lo, h.hi]).concat([0.5]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const mid = (lo + hi) / 2, half = Math.max(0.05, (hi - lo) / 2 + 0.01);
    lo = mid - half; hi = mid + half;
    const xs = (p) => L + p * (R - L), ys = (s) => B - (s - lo) / (hi - lo) * (B - T);
    const step = half > 0.1 ? 0.05 : 0.02;
    let g = "";
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) {
      g += `<line x1="${L}" x2="${R}" y1="${ys(v)}" y2="${ys(v)}" stroke="var(--line)" stroke-width="0.5"/>` +
        `<text x="${L - 4}" y="${ys(v) + 3}" text-anchor="end">${Math.round(v * 100)}%</text>`;
    }
    for (const p of [0, 0.25, 0.5, 0.75, 1]) g += `<text x="${xs(p)}" y="${B + 14}" text-anchor="middle">${p * 100}%</text>`;
    g += `<text x="${(L + R) / 2}" y="${B + 28}" text-anchor="middle">seções apuradas</text>`;
    g += `<line x1="${L}" x2="${R}" y1="${ys(0.5)}" y2="${ys(0.5)}" stroke="var(--line-strong)" stroke-dasharray="3 3"/>`;
    const band = H.map((h) => `${xs(h.p)},${ys(h.hi)}`).concat(H.slice().reverse().map((h) => `${xs(h.p)},${ys(h.lo)}`)).join(" ");
    const line = (k) => H.map((h) => `${xs(h.p).toFixed(1)},${ys(h[k]).toFixed(1)}`).join(" ");
    const last = H[H.length - 1];
    svg.innerHTML = g +
      `<polygon points="${band}" fill="var(--kin-wash)" stroke="none"/>` +
      `<polyline points="${line("m")}" fill="none" stroke="var(--kin)" stroke-width="1.5"/>` +
      `<polyline id="ln" points="${line("s")}" fill="none" stroke="var(--ink)" stroke-width="1.5"/>` +
      `<circle cx="${xs(last.p)}" cy="${ys(last.s)}" r="3" fill="var(--shu)"/>`;
    // Desenha só o trecho novo da linha.
    const ln = $("ln"), len = ln.getTotalLength();
    if (!REDUCED && prevLen && len > prevLen) {
      ln.style.strokeDasharray = len;
      ln.style.strokeDashoffset = len - prevLen;
      ln.getBoundingClientRect();
      ln.style.transition = "stroke-dashoffset 0.9s ease-out";
      ln.style.strokeDashoffset = 0;
    }
    prevLen = len;
  }

  function sbar(l, o, f) {
    const t = l + o + f;
    if (!t) return `<div class="sbar"></div>`;
    return `<div class="sbar"><div class="l" style="width:${(l / t * 100).toFixed(2)}%"></div>` +
      (o ? `<div class="o" style="width:${(o / t * 100).toFixed(2)}%"></div>` : "") +
      `<div class="f" style="width:${(f / t * 100).toFixed(2)}%"></div></div>`;
  }
  function row(ttl, sub, l, o, f, ln, fn) {
    const t = l + o + f;
    return `<div class="row"><div class="lbl"><b>${ttl}</b>${sub}</div>${sbar(l, o, f)}` +
      `<div class="nums"><span class="l">${ln} ${t ? pct(l / t, 1) : "–"}</span><br><span class="f">${fn} ${t ? pct(f / t, 1) : "–"}</span></div></div>`;
  }
  const swingTag = (sw) => sw == null ? `<span class="swing">–</span>`
    : Math.abs(sw) < 0.05 ? `<span class="swing">= igual</span>`
    : sw > 0 ? `<span class="swing l">← Lula +${pp(sw)}</span>` : `<span class="swing f">Flávio +${pp(sw)} →</span>`;
  function swingRow(sw, label, note) {
    return `<div class="row"><div class="lbl"><b>Variação</b>${label}</div>` +
      `<div class="swing-meter"><span class="mid"></span><span class="mark ${sw >= 0 ? "l" : "f"}" style="left:${sw == null ? 50 : Math.max(2, Math.min(98, 50 - sw * 4)).toFixed(1)}%"></span></div>` +
      `<div class="nums">${swingTag(sw)}<br><span class="caption">${note}</span></div></div>`;
  }

  function renderDetail() {
    if (S.view !== "BR" && S.selCity) return renderCityDetail();
    const uf = S.sel;
    $("d-title").textContent = placeName(uf);
    const { live, t1, proj, h22: h2, h18: h1 } = placeData(uf);
    $("d-sub").textContent = t1 ? `${int(live?.eleitores ?? t1.eleitores)} eleitores` : "";
    let html = "";
    if (live) html += row("Apurado agora", `${pct(live.p, 1)} das seções`, live.lula, 0, live.flavio, "Lula", "Flávio");
    if (proj) html += row("Projeção final", `faltam ${mi(proj.remaining)}`, proj.lula, 0, proj.flavio, "Lula", "Flávio");
    html += swingRow(swingUf(uf), `vs ${REF_NAME[S.ref]}`, live && live.p >= 0.95 ? "pelo apurado" : "pela projeção");
    if (t1) html += row("1º turno 2026", "cinza: outros", t1.lula, t1.outros, t1.flavio, "Lula", "Flávio");
    if (h2) html += row("2022 · 2º turno", "Lula × Bolsonaro", h2.t2.lula, 0, h2.t2.bolsonaro, "Lula", "Bolsonaro");
    if (h1) html += row("2018 · 2º turno", "Haddad × Bolsonaro", h1.t2.haddad, 0, h1.t2.bolsonaro, "Haddad", "Bolsonaro");
    $("d-rows").innerHTML = html || `<p class="caption">Carregando os dados do TSE…</p>`;
  }

  // Lula entre os votos válidos a cada lote da cidade, no eixo das seções apuradas dela.
  function cityTimeline(vs) {
    const pts = vs.map(([, , l, f, , s, st]) => [st ? s / st : 0, l + f ? l / (l + f) : 0.5]);
    const W = 100, H = 24;
    const line = pts.map(([p, s]) => `${(p * W).toFixed(1)},${(H - s * H).toFixed(1)}`).join(" ");
    const a = pts[0][1], b = pts[pts.length - 1][1];
    return `<div class="row"><div class="lbl"><b>Ao longo da noite</b>${vs.length} lotes do TSE</div>` +
      `<svg class="tl" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Lula entre os votos válidos a cada lote">` +
      `<line x1="0" x2="${W}" y1="${H / 2}" y2="${H / 2}" stroke="var(--line-strong)" stroke-dasharray="2 2" vector-effect="non-scaling-stroke"/>` +
      `<polyline points="${line}" fill="none" stroke="var(--shu)" stroke-width="1.5" vector-effect="non-scaling-stroke"/></svg>` +
      `<div class="nums"><span class="l">Lula ${pct(a, 1)} → ${pct(b, 1)}</span></div></div>`;
  }

  function renderCityDetail() {
    const uf = S.view, cd = S.selCity;
    const m = (S.mun?.[uf] || []).find((x) => x.cd === cd);
    const live = S.city[uf]?.[cd], t1 = S.city1[uf]?.[cd];
    $("d-title").textContent = m ? `${m.nm} · ${uf}` : uf;
    $("d-sub").textContent = t1 ? `${int(t1.eleitores)} eleitores` : "";
    let html = "";
    if (live) html += row("Apurado agora", `${pct(live.p, 1)} das seções`, live.lula, 0, live.flavio, "Lula", "Flávio");
    const vs = S.cityHist[uf]?.[cd];
    if (vs && vs.length > 1) html += cityTimeline(vs);
    html += swingRow(citySwing(uf, cd), "vs 1º turno 2026", "pelo apurado até agora");
    if (t1) html += row("1º turno 2026", "cinza: outros", t1.lula, t1.outros, t1.flavio, "Lula", "Flávio");
    $("d-rows").innerHTML = html || `<p class="caption">Carregando a cidade…</p>`;
  }

  function renderTable() {
    const order = UFS.slice().sort((a, b) => (S.t1[b]?.eleitores ?? 0) - (S.t1[a]?.eleitores ?? 0));
    const lead = (s, l = "Lula", f = "Flávio") => s == null ? "–"
      : s >= 0.5 ? `<span class="lead-l">${l} ${pct(s, 1)}</span>` : `<span class="lead-f">${f} ${pct(1 - s, 1)}</span>`;
    $("th-ref").textContent = `Variação vs ${S.ref === "h22" ? "2022" : "1º turno"}`;
    $("tbody").innerHTML = order.map((uf) => {
      const l = S.live[uf];
      const tot = l ? l.lula + l.flavio : 0;
      return `<tr data-uf="${uf}" class="${uf === S.sel ? "sel" : ""}${S.flashNew.has(uf) && !REDUCED ? " upd" : ""}">` +
        `<td><b>${uf}</b> <span class="caption">${NAMES[uf]}</span></td>` +
        `<td class="r mono">${l ? pct(l.p, 1) : "–"}</td>` +
        `<td>${l ? sbar(l.lula, 0, l.flavio) : ""}</td>` +
        `<td class="r mono">${tot ? pct(l.lula / tot, 1) : "–"}</td>` +
        `<td class="r mono">${tot ? pct(l.flavio / tot, 1) : "–"}</td>` +
        `<td class="r">${lead(S.proj[uf]?.share)}</td>` +
        `<td class="r">${swingTag(swingUf(uf))}</td></tr>`;
    }).join("");
  }

  // ---- Navegação ----
  function enterState(uf) {
    S.sel = uf;
    S.selCity = null;
    if (uf === "BR" || uf === "ZZ" || isReg(uf)) {
      if (S.view !== "BR") { S.view = "BR"; cityRun++; S.cityLoad = null; S.cityBusy = null; drawMainMap(); }
      render();
      return;
    }
    S.view = uf;
    S.cityBusy = null;
    $("map").innerHTML = "";
    $("city-list").innerHTML = "";
    $("city-input").value = "";
    render();
    loadMun().then((mun) => {
      $("city-list").innerHTML = (mun[uf] || []).map((m) => `<option value="${m.nm}"></option>`).join("");
    }).catch(() => {});
    loadCities(uf, true);
  }
  function selectCity(cd) {
    S.selCity = cd;
    paintMap();
    renderDetail();
  }

  $("map").addEventListener("click", (e) => {
    const p = e.target.closest("path");
    if (!p) return;
    if (p.dataset.uf) enterState(p.dataset.uf);
    else if (p.dataset.cd) selectCity(p.dataset.cd);
  });
  $("levels").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.level = b.dataset.level;
    if (S.view !== "BR") { S.view = "BR"; S.selCity = null; cityRun++; S.cityLoad = null; S.cityBusy = null; }
    drawMainMap();
    render();
  });
  $("modes").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.mode = b.dataset.mode;
    renderMapChrome();
    paintMap();
  });
  $("refs").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    S.ref = b.dataset.ref;
    document.querySelectorAll("#refs button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    render();
  });
  $("tbody").addEventListener("click", (e) => { const tr = e.target.closest("tr"); if (tr) enterState(tr.dataset.uf); });
  $("zz-btn").addEventListener("click", () => enterState("ZZ"));
  $("br-btn").addEventListener("click", () => enterState("BR"));
  $("back").addEventListener("click", () => enterState("BR"));
  $("city-input").addEventListener("change", (e) => {
    const m = (S.mun?.[S.view] || []).find((x) => x.nm.toLowerCase() === e.target.value.trim().toLowerCase());
    if (m) selectCity(m.cd);
  });
  $("theme").addEventListener("click", () => {
    const dark = getComputedStyle(document.documentElement).colorScheme.includes("dark");
    const next = dark ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    store.set("apuracao26-theme", next);
  });

  async function start() {
    const theme = store.get("apuracao26-theme");
    if (theme) document.documentElement.dataset.theme = theme;
    // A simulação recomeça do zero a cada carga; o histórico real sobrevive a um recarregar.
    const saved = SIM ? null : store.get(KEY);
    if (saved) { S.hist = saved.hist || []; S.feed = saved.feed || []; S.batches = saved.batches || []; }
    drawMainMap();
    render();
    while (!(await loadT1())) {
      $("chip").className = "chip err";
      $("chip").textContent = "TSE fora do ar · tentando de novo";
      await new Promise((r) => setTimeout(r, 10000));
    }
    await loadHistory();
    await tick(); // cada ciclo agenda o seguinte, então nunca se sobrepõem
    setInterval(renderFresh, 1000);
  }
  start();
})();
