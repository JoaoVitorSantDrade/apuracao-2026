const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const M = require("../model.js");

const fixture = (name) => JSON.parse(fs.readFileSync(path.join(__dirname, name), "utf8"));

test("parseTse reads a real, fully counted 1st-round file (SP)", () => {
  const r = M.parseTse(fixture("sp-1t.json"));
  assert.equal(r.lula, 9505413);
  assert.equal(r.flavio, 12922023);
  assert.equal(r.validos, 24882948);
  assert.equal(r.outros, 24882948 - 9505413 - 12922023);
  assert.equal(r.secoes, 103656);
  assert.equal(r.secoesTot, 103656);
  assert.equal(r.p, 1);
  assert.equal(r.eleitores, 34122892);
  assert.equal(r.comparecimento, 26431992);
  assert.equal(r.hora, "05/10 12:51");
});

test("parseTse reads a 2nd-round file before counting starts as zero progress", () => {
  const r = M.parseTse(fixture("sp-2t.json"));
  assert.equal(r.lula, 0);
  assert.equal(r.flavio, 0);
  assert.equal(r.p, 0);
  assert.ok(r.eleitores > 30_000_000);
});

test("priorLula keeps both candidates' 1st-round votes and splits the rest by the 2022 lean", () => {
  const t1 = { lula: 40, flavio: 50, outros: 10, validos: 100, eleitores: 200 };
  assert.ok(Math.abs(M.priorLula(t1, 0.6) - 0.46) < 1e-12);
});

const t1 = { lula: 400, flavio: 500, outros: 100, validos: 1000, eleitores: 2000 };

test("projectUf with nothing counted projects the prior over the expected valid votes", () => {
  const live = { lula: 0, flavio: 0, validos: 0, p: 0, eleitores: 2000 };
  const r = M.projectUf(live, t1, 0.6);
  assert.equal(r.remaining, 1000);
  assert.ok(Math.abs(r.share - 0.46) < 1e-12);
});

test("projectUf with everything counted returns the count itself", () => {
  const live = { lula: 520, flavio: 430, validos: 950, p: 1, eleitores: 2000 };
  const r = M.projectUf(live, t1, 0.6);
  assert.equal(r.remaining, 0);
  assert.ok(Math.abs(r.share - 520 / 950) < 1e-12);
});

test("projectUf halfway blends the partial share and the prior for the votes still to come", () => {
  const live = { lula: 300, flavio: 200, validos: 500, p: 0.5, eleitores: 2000 };
  const r = M.projectUf(live, t1, 0.6);
  assert.equal(r.remaining, 500);
  assert.ok(Math.abs(r.restShare - (0.5 * 0.6 + 0.5 * 0.46)) < 1e-12);
  assert.ok(Math.abs(r.lula - (300 + 500 * r.restShare)) < 1e-9);
});

test("simulate is deterministic for a fixed seed and spreads when votes remain", () => {
  const ufs = [
    { lula: 100, flavio: 100, remaining: 1000, restShare: 0.5, p: 0.1 },
    { lula: 50, flavio: 60, remaining: 800, restShare: 0.52, p: 0.2 },
  ];
  const a = M.simulate(ufs, { n: 500, seed: 7 });
  const b = M.simulate(ufs, { n: 500, seed: 7 });
  assert.deepEqual(a, b);
  assert.ok(a.pLula > 0 && a.pLula < 1);
  assert.ok(a.lo < a.mean && a.mean < a.hi);
});

test("simulate with everything counted is certain", () => {
  const ufs = [{ lula: 600, flavio: 400, remaining: 0, restShare: 0.6, p: 1 }];
  const r = M.simulate(ufs, { n: 200, seed: 1 });
  assert.equal(r.pLula, 1);
  assert.ok(Math.abs(r.mean - 0.6) < 1e-12);
});

// ---- Lotes do TSE: versão, ordem e duplicados ----
const snap = (o) => ({ idg: 10, ts: "2026-10-25T17:00:00", lula: 100, flavio: 100, validos: 200, secoes: 5, ...o });

test("parseTse keeps the TSE file version and a sortable timestamp", () => {
  const r = M.parseTse(fixture("sp-1t.json"));
  assert.equal(r.idg, 2837533);
  assert.equal(r.ts, "2026-10-05T12:51:59");
});

test("parseTse reads a municipality file (São Paulo capital)", () => {
  const r = M.parseTse(fixture("sp-capital-1t.json"));
  assert.ok(r.validos > 5_000_000 && r.lula > 0 && r.flavio > 0);
});

test("acceptSnapshot takes the first snapshot of a place", () => {
  assert.deepEqual(M.acceptSnapshot(null, snap()), { ok: true });
});

test("acceptSnapshot rejects the same TSE version fetched again", () => {
  assert.deepEqual(M.acceptSnapshot(snap(), snap()), { ok: false, reason: "repetido" });
});

test("acceptSnapshot rejects an older copy served after a newer one", () => {
  const prev = snap({ idg: 20, ts: "2026-10-25T17:05:00" });
  assert.deepEqual(M.acceptSnapshot(prev, snap({ idg: 19 })), { ok: false, reason: "antigo" });
  assert.deepEqual(M.acceptSnapshot(prev, snap({ idg: 21, ts: "2026-10-25T17:01:00" })), { ok: false, reason: "antigo" });
});

test("acceptSnapshot rejects a count that goes backwards", () => {
  const prev = snap();
  assert.deepEqual(M.acceptSnapshot(prev, snap({ idg: 11, lula: 99 })), { ok: false, reason: "regrediu" });
  assert.deepEqual(M.acceptSnapshot(prev, snap({ idg: 11, secoes: 4 })), { ok: false, reason: "regrediu" });
});

test("acceptSnapshot accepts a newer version with more votes", () => {
  assert.deepEqual(M.acceptSnapshot(snap(), snap({ idg: 11, lula: 150, validos: 250, secoes: 6 })), { ok: true });
});

test("delta counts only what came in between two accepted snapshots", () => {
  const d = M.delta(snap(), snap({ idg: 11, lula: 150, flavio: 130, validos: 280, secoes: 8 }));
  assert.deepEqual(d, { lula: 50, flavio: 30, validos: 80, secoes: 3 });
  assert.deepEqual(M.delta(null, snap()), { lula: 100, flavio: 100, validos: 200, secoes: 5 });
});

test("addFeed never adds the same place and version twice", () => {
  const e = { key: "SP:11", uf: "SP", lula: 1, flavio: 1 };
  const once = M.addFeed([], e);
  assert.equal(once.length, 1);
  assert.equal(M.addFeed(once, { ...e }).length, 1);
  assert.equal(M.addFeed(once, { ...e, key: "SP:12" }).length, 2);
});

test("addFeed keeps the newest entries first and caps the list", () => {
  let f = [];
  for (let i = 0; i < 5; i++) f = M.addFeed(f, { key: "k" + i }, 3);
  assert.deepEqual(f.map((e) => e.key), ["k4", "k3", "k2"]);
});

test("sumCheck matches the national total against the sum of the parts", () => {
  const parts = [{ lula: 10, flavio: 5, validos: 15 }, { lula: 1, flavio: 4, validos: 5 }];
  assert.deepEqual(M.sumCheck({ lula: 11, flavio: 9, validos: 20 }, parts), { ok: true, diff: 0 });
  assert.deepEqual(M.sumCheck({ lula: 12, flavio: 9, validos: 21 }, parts), { ok: false, diff: 1 });
});

// ---- Variação contra a eleição anterior ----
test("swing uses the projection until 95% of sections are counted", () => {
  const live = { lula: 60, flavio: 40, validos: 100, p: 0.5 };
  assert.ok(Math.abs(M.swing(live, { share: 0.52 }, 0.5) - 2) < 1e-9);
  assert.ok(Math.abs(M.swing({ ...live, p: 0.96 }, { share: 0.52 }, 0.5) - 10) < 1e-9);
});

test("swing is null without data", () => {
  assert.equal(M.swing({ lula: 0, flavio: 0, validos: 0, p: 0 }, null, 0.5), null);
  assert.equal(M.swing({ lula: 6, flavio: 4, validos: 10, p: 1 }, null, null), null);
});

// ---- Download educado: o TSE responde 429 quando chegam pedidos demais ----
test("withRetry tries again after a 429 and waits longer each time", async () => {
  let calls = 0;
  const waits = [];
  const fn = async () => { calls++; if (calls < 3) { const e = new Error("429"); e.status = 429; throw e; } return "ok"; };
  const r = await M.withRetry(fn, { tries: 4, base: 1000, sleep: async (ms) => { waits.push(ms); } });
  assert.equal(r, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test("withRetry gives up on errors other than 429 and after the last try", async () => {
  const notFound = async () => { const e = new Error("404"); e.status = 404; throw e; };
  await assert.rejects(M.withRetry(notFound, { tries: 4, sleep: async () => {} }), /404/);
  let calls = 0;
  const busy = async () => { calls++; const e = new Error("429"); e.status = 429; throw e; };
  await assert.rejects(M.withRetry(busy, { tries: 3, sleep: async () => {} }), /429/);
  assert.equal(calls, 3);
});

// ---- Sincronização: lote consistente, feed por lote e atualidade ----
const part = (ts, lula, flavio) => ({ ts, lula, flavio, validos: lula + flavio });

test("staleParts is empty when the parts already add up to the total", () => {
  const total = part("2026-10-25T19:10:00", 30, 20);
  const parts = { SP: part("2026-10-25T19:10:00", 10, 10), BA: part("2026-10-25T19:02:00", 20, 10) };
  assert.deepEqual(M.staleParts(total, parts), []);
});

test("staleParts names the parts older than the total when the sum does not match", () => {
  const total = part("2026-10-25T19:10:00", 40, 25);
  const parts = { SP: part("2026-10-25T19:10:00", 10, 10), ZZ: part("2026-10-24T20:11:36", 0, 0), BA: part("2026-10-25T19:02:00", 20, 10) };
  assert.deepEqual(M.staleParts(total, parts).sort(), ["BA", "ZZ"]);
});

test("makeBatch sums one TSE batch and lists its places, biggest first", () => {
  const b = M.makeBatch({ idg: 7, hora: "25/10 19:12" }, [
    { uf: "SE", lula: 3, flavio: 1, validos: 4, secoes: 1, dp: 0.01 },
    { uf: "SP", lula: 40, flavio: 60, validos: 100, secoes: 9, dp: 0.02 },
  ]);
  assert.equal(b.key, "BR:7");
  assert.equal(b.hora, "25/10 19:12");
  assert.deepEqual([b.lula, b.flavio, b.validos, b.n], [43, 61, 104, 2]);
  assert.deepEqual(b.items.map((i) => i.uf), ["SP", "SE"]);
});

test("freshness says when the page last checked the TSE and when it checks again", () => {
  const now = 1_000_000;
  assert.equal(M.freshness(now, now - 3_000, now + 12_000), "checado há 3 s · próxima checagem em 12 s");
  assert.equal(M.freshness(now, now - 3_000, now + 2_400), "checado há 3 s · próxima checagem em 3 s");
  assert.equal(M.freshness(now, now - 3_000, null), "checando agora");
  assert.equal(M.freshness(now, null, null), "checando agora");
});

test("quietMinutes reports a TSE pause only after 5 minutes without a new batch", () => {
  const now = 10_000_000;
  assert.equal(M.quietMinutes(now, now - 60_000), null);
  assert.equal(M.quietMinutes(now, now - 6 * 60_000), 6);
  assert.equal(M.quietMinutes(now, null), null);
});

test("totalIsStale when a part is newer than the total and the sum does not match", () => {
  const total = part("2026-10-25T17:06:31", 30, 20);
  assert.equal(M.totalIsStale(total, { PA: part("2026-10-25T17:07:00", 35, 20) }), true);
  assert.equal(M.totalIsStale(total, { PA: part("2026-10-25T17:07:00", 30, 20) }), false);
  assert.equal(M.totalIsStale(total, { PA: part("2026-10-25T17:00:00", 35, 20) }), false);
});

test("staleParts leaves the parts alone when the total is the stale one (TSE, 25/10 17:06)", () => {
  // Pará já tinha um lote das 17:07 e o total do Brasil ainda era das 17:06; SP e exterior estavam vazios e antigos.
  const total = part("2026-10-25T17:06:31", 30, 20);
  const parts = {
    PA: part("2026-10-25T17:07:00", 35, 20),
    SP: part("2026-10-13T17:50:07", 0, 0),
    ZZ: part("2026-10-24T20:11:36", 0, 0),
  };
  assert.deepEqual(M.staleParts(total, parts), []);
  assert.equal(M.totalIsStale(total, parts), true);
});

// ---- Macrorregiões ----
test("REGIONS covers the 27 federative units exactly once", () => {
  const all = Object.values(M.REGIONS).flat();
  assert.equal(all.length, 27);
  assert.equal(new Set(all).size, 27);
  assert.deepEqual(M.REGIONS.CO.slice().sort(), ["DF", "GO", "MS", "MT"]);
});

test("sumRegion adds up the states it has and recomputes the counted share", () => {
  const snaps = {
    SP: { lula: 10, flavio: 20, validos: 30, outros: 0, secoes: 5, secoesTot: 10, eleitores: 100 },
    RJ: { lula: 6, flavio: 4, validos: 10, outros: 0, secoes: 5, secoesTot: 30, eleitores: 50 },
  };
  const r = M.sumRegion(snaps, ["SP", "RJ", "MG"]);
  assert.deepEqual(r, { lula: 16, flavio: 24, validos: 40, outros: 0, secoes: 10, secoesTot: 40, eleitores: 150,
    est: 0, comparecimento: 0, abstencao: 0, tv: 0, brancos: 0, nulos: 0, p: 0.25 });
  assert.equal(M.sumRegion(snaps, ["BA"]), null);
});

// ---- Histórico central ----
const sn = (idg, ts, lula, flavio, secoes, o = {}) =>
  ({ idg, ts, hora: `${ts.slice(8, 10)}/${ts.slice(5, 7)} ${ts.slice(11, 16)}`, lula, flavio, validos: lula + flavio,
    secoes, secoesTot: 100, eleitores: 1000, ...o });

test("packSnap and unpackSnap round-trip what the panel uses", () => {
  const s = sn(7, "2026-10-25T19:05:00", 30, 20, 10);
  const u = M.unpackSnap(M.packSnap(s));
  assert.deepEqual([u.idg, u.ts, u.hora, u.lula, u.flavio, u.validos, u.secoes, u.secoesTot, u.eleitores, u.p],
    [7, "2026-10-25T19:05:00", "25/10 19:05", 30, 20, 50, 10, 100, 1000, 0.1]);
});

test("historyEntry packs the national total and every state of one batch", () => {
  const e = M.historyEntry(sn(9, "2026-10-25T19:10:00", 50, 40, 20), { SP: sn(3, "2026-10-25T19:09:00", 20, 30, 8) });
  assert.equal(e.idg, 9);
  assert.equal(e.hora, "25/10 19:10");
  assert.deepEqual(e.br, [9, "2026-10-25T19:10:00", 50, 40, 90, 20, 100, 1000]);
  assert.deepEqual(Object.keys(e.ufs), ["SP"]);
});

test("appendEntry only adds a newer national version", () => {
  const a = M.appendEntry([], { idg: 5 });
  const b = M.appendEntry(a, { idg: 6 });
  assert.equal(b.length, 2);
  assert.equal(M.appendEntry(b, { idg: 6 }), b);
  assert.equal(M.appendEntry(b, { idg: 4 }), b);
});

test("feedFromHistory rebuilds one batch per entry after the first, newest first", () => {
  const e1 = M.historyEntry(sn(1, "2026-10-25T19:00:00", 10, 10, 2), { SP: sn(1, "2026-10-25T19:00:00", 10, 10, 2) });
  const e2 = M.historyEntry(sn(2, "2026-10-25T19:02:00", 40, 20, 6), {
    SP: sn(2, "2026-10-25T19:02:00", 25, 15, 4), BA: sn(2, "2026-10-25T19:02:00", 15, 5, 2),
  });
  const e3 = M.historyEntry(sn(3, "2026-10-25T19:03:00", 40, 20, 6), {
    SP: sn(2, "2026-10-25T19:02:00", 25, 15, 4), BA: sn(2, "2026-10-25T19:02:00", 15, 5, 2),
  });
  const f = M.feedFromHistory([e1, e2, e3]);
  assert.equal(f.length, 1); // e1 é o ponto de partida; e3 não trouxe voto novo
  assert.equal(f[0].key, "BR:2");
  assert.deepEqual(f[0].items.map((i) => [i.uf, i.lula, i.flavio]), [["SP", 15, 5], ["BA", 15, 5]]);
});

test("addCityVersion keeps each accepted city version once", () => {
  let v = M.addCityVersion([], sn(1, "2026-10-25T19:00:00", 3, 2, 1));
  v = M.addCityVersion(v, sn(1, "2026-10-25T19:00:00", 3, 2, 1)); // repetido
  v = M.addCityVersion(v, sn(2, "2026-10-25T19:05:00", 6, 4, 2));
  v = M.addCityVersion(v, sn(3, "2026-10-25T19:06:00", 5, 4, 2)); // contagem menor
  assert.deepEqual(v.map((x) => x[0]), [1, 2]);
  assert.deepEqual(v[1], [2, "2026-10-25T19:05:00", 6, 4, 10, 2, 100]);
});

// ---- Virada, comparecimento ----
test("parseTse reads turnout, blank and null votes (SP, 1st round)", () => {
  const r = M.parseTse(fixture("sp-1t.json"));
  assert.deepEqual([r.est, r.comparecimento, r.abstencao, r.tv, r.brancos, r.nulos],
    [34122892, 26431992, 7690900, 26431992, 632801, 916243]);
});

test("turnout gives the shares over the counted sections, or null before any", () => {
  const t = M.turnout({ est: 1000, comparecimento: 800, abstencao: 200, tv: 800, brancos: 16, nulos: 24 });
  assert.deepEqual(t, { comparecimento: 0.8, abstencao: 0.2, brancos: 0.02, nulos: 0.03 });
  assert.equal(M.turnout({ est: 0, comparecimento: 0, abstencao: 0, tv: 0, brancos: 0, nulos: 0 }), null);
});

test("virada says who leads and what share of the remaining votes the other needs", () => {
  // Lula 60, Flávio 40; faltam 50 válidos: Flávio precisa de (20 + 50) / 100 = 70 % deles.
  const v = M.virada({ lula: 60, flavio: 40, eleitores: 1000, est: 500 }, 50);
  assert.deepEqual([v.lider, v.diff, v.decidido], ["lula", 20, false]);
  assert.ok(Math.abs(v.precisa - 0.7) < 1e-12);
});

test("virada is decided only when the lead beats every voter in the sections still uncounted", () => {
  assert.equal(M.virada({ lula: 900, flavio: 100, eleitores: 1500, est: 1000 }, 300).decidido, true); // 800 > 500
  assert.equal(M.virada({ lula: 900, flavio: 100, eleitores: 2000, est: 1000 }, 300).decidido, false); // 800 < 1000
  assert.equal(M.virada({ lula: 900, flavio: 100, eleitores: 1500 }, 300).decidido, false); // sem est: não afirma
});

test("virada with nothing counted has no leader", () => {
  assert.equal(M.virada({ lula: 0, flavio: 0, eleitores: 10, est: 0 }, 5).lider, null);
});

test("addBatch ignores a national version it already has and keeps the last 40", () => {
  let b = M.addBatch([], { idg: 1, validos: 10 });
  b = M.addBatch(b, { idg: 1, validos: 10 }); // a mesma versão de novo (ex.: página recarregada)
  b = M.addBatch(b, { idg: 2, validos: 5 });
  assert.deepEqual(b.map((x) => x.idg), [1, 2]);
  for (let i = 3; i < 50; i++) b = M.addBatch(b, { idg: i, validos: 1 });
  assert.equal(b.length, 40);
  assert.equal(b[b.length - 1].idg, 49);
});

test("ufSeries gives one point per new version of a place across the night", () => {
  const e = (idg, sp) => ({ idg, br: [idg, "2026-10-25T19:00:00", 1, 1, 2, 1, 10, 0], ufs: { SP: sp } });
  const entries = [
    e(1, [1, "2026-10-25T19:00:00", 0, 0, 0, 0, 100, 0]), // ainda sem votos: não entra
    e(2, [2, "2026-10-25T19:02:00", 30, 70, 100, 10, 100, 0]),
    e(3, [2, "2026-10-25T19:02:00", 30, 70, 100, 10, 100, 0]), // mesma versão de SP
    e(4, [4, "2026-10-25T19:06:00", 90, 110, 200, 25, 100, 0]),
  ];
  assert.deepEqual(M.ufSeries(entries, "SP"), [[0.1, 0.3], [0.25, 0.45]]);
  assert.deepEqual(M.ufSeries(entries, "RJ"), []);
});
