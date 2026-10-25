import test from "node:test";
import assert from "node:assert/strict";
import { createCollector, BASE } from "../coletor/coletor.mjs";

// Arquivo "-u.json" do TSE com só os campos que o painel lê.
function tse({ idg, ts, lula = 0, flavio = 0, st = 0, total = 100, te = 1000 }) {
  const [d, h] = ts.split("T");
  const dg = `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
  return {
    idg: String(idg), dg, hg: h,
    carg: [{ agr: [{ par: [{ cand: [{ n: "13", vap: String(lula) }, { n: "22", vap: String(flavio) }] }] }] }],
    v: { vv: String(lula + flavio) }, s: { st: String(st), ts: String(total) }, e: { te: String(te), c: "0" },
  };
}
const url2 = (uf, mun = "") => `${BASE}/6258/dados/${uf}/${uf}${mun}-c0001-e006258-u.json`;
const url1 = (uf, mun = "") => `${BASE}/6257/dados/${uf}/${uf}${mun}-c0001-e006257-u.json`;
const CONFIG = `${BASE}/6258/config/mun-e006258-cm.json`;

// TSE falso: um mapa url -> json que o teste vai trocando; o que não está no mapa responde 404.
function fakeTse(initial) {
  const files = { ...initial };
  const calls = [];
  return {
    files, calls,
    fetchJson: async (u) => {
      calls.push(u);
      if (!(u in files)) { const e = new Error(`404 ${u}`); e.status = 404; throw e; }
      return JSON.parse(JSON.stringify(files[u]));
    },
  };
}

function setup(extra = {}, saved = {}) {
  const t = fakeTse({
    [CONFIG]: { abr: [{ cd: "sp", mu: [{ cd: "71072", cdi: "3550308", nm: "SÃO PAULO" }, { cd: "62910", cdi: "3509502", nm: "CAMPINAS" }] }] },
    [url2("br")]: tse({ idg: 10, ts: "2026-10-25T19:00:00", lula: 30, flavio: 20, st: 5 }),
    [url2("sp")]: tse({ idg: 10, ts: "2026-10-25T19:00:00", lula: 20, flavio: 10, st: 3 }),
    [url2("zz")]: tse({ idg: 9, ts: "2026-10-25T18:59:00", lula: 10, flavio: 10, st: 2 }),
    [url2("sp", "71072")]: tse({ idg: 10, ts: "2026-10-25T19:00:00", lula: 15, flavio: 5, st: 2 }),
    [url2("sp", "62910")]: tse({ idg: 10, ts: "2026-10-25T19:00:00", lula: 5, flavio: 5, st: 1 }),
    [url1("sp", "71072")]: tse({ idg: 1, ts: "2026-10-05T12:00:00", lula: 40, flavio: 50, st: 10, total: 10 }),
    [url1("sp", "62910")]: tse({ idg: 1, ts: "2026-10-05T12:00:00", lula: 30, flavio: 40, st: 5, total: 5 }),
    ...extra,
  });
  const c = createCollector({ fetchJson: t.fetchJson, ufs: ["SP", "ZZ"], saved, sleep: async () => {}, log: () => {} });
  return { t, c };
}

test("o primeiro lote vira a primeira entrada do histórico e põe o estado na fila de cidades", async () => {
  const { c } = setup();
  await c.national();
  const h = c.files()["historico.json"];
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].idg, 10);
  assert.deepEqual(Object.keys(h.entries[0].ufs).sort(), ["SP", "ZZ"]);
  assert.deepEqual(c.queue(), ["SP"]); // ZZ (exterior) não tem cidades
});

test("o mesmo lote de novo, ou uma cópia antiga, não cria entrada nem duplica votos", async () => {
  const { t, c } = setup();
  await c.national();
  await c.national(); // mesma versão
  t.files[url2("br")] = tse({ idg: 8, ts: "2026-10-25T18:50:00", lula: 1, flavio: 1, st: 1 }); // cópia antiga
  await c.national();
  assert.equal(c.files()["historico.json"].entries.length, 1);
});

test("um lote novo entra; um estado que chega depois do total atualiza a última entrada", async () => {
  const { t, c } = setup();
  await c.national();
  t.files[url2("br")] = tse({ idg: 11, ts: "2026-10-25T19:02:00", lula: 50, flavio: 30, st: 8 });
  await c.national(); // SP ainda é a versão 10: a soma não bate
  let h = c.files()["historico.json"];
  assert.equal(h.entries.length, 2);
  assert.equal(h.entries[1].ufs.SP[0], 10);
  t.files[url2("sp")] = tse({ idg: 11, ts: "2026-10-25T19:02:00", lula: 40, flavio: 20, st: 6 });
  await c.national(); // mesmo total, SP chegou
  h = c.files()["historico.json"];
  assert.equal(h.entries.length, 2);
  assert.equal(h.entries[1].ufs.SP[0], 11);
});

test("a varredura grava o 2º turno de cada cidade e o 1º turno uma vez só", async () => {
  const { t, c } = setup();
  await c.national();
  await c.sweep();
  const f = c.files();
  assert.deepEqual(f["mun/SP.json"].cidades["71072"].map((v) => v[0]), [10]);
  assert.deepEqual(f["mun1t/SP.json"]["71072"], [40, 50, 90, 0, 10, 1000]);
  const before1t = t.calls.filter((u) => u.includes("/6257/")).length;
  t.files[url2("sp", "71072")] = tse({ idg: 12, ts: "2026-10-25T19:05:00", lula: 30, flavio: 10, st: 4 });
  t.files[url2("sp")] = tse({ idg: 12, ts: "2026-10-25T19:05:00", lula: 35, flavio: 15, st: 5 });
  t.files[url2("br")] = tse({ idg: 12, ts: "2026-10-25T19:05:00", lula: 45, flavio: 25, st: 7 });
  await c.national();
  await c.sweep();
  assert.deepEqual(c.files()["mun/SP.json"].cidades["71072"].map((v) => v[0]), [10, 12]);
  assert.equal(t.calls.filter((u) => u.includes("/6257/")).length, before1t); // 1º turno não é baixado de novo
});

test("só os arquivos que mudaram são publicados, e uma vez", async () => {
  const published = [];
  const { c } = setup();
  await c.national();
  await c.flush(async (files) => { published.push(Object.keys(files).sort()); });
  await c.flush(async (files) => { published.push(Object.keys(files).sort()); });
  assert.deepEqual(published, [["historico.json"]]);
});

test("retoma a partir dos arquivos gravados sem repetir o que já tinha", async () => {
  const first = setup();
  await first.c.national();
  await first.c.sweep();
  const saved = first.c.files();
  const { t, c } = setup({}, saved);
  await c.national(); // o TSE ainda está na versão 10
  assert.equal(c.files()["historico.json"].entries.length, 1);
  assert.deepEqual(c.queue(), []);
  await c.sweep();
  assert.equal(t.calls.filter((u) => u.includes("/6257/")).length, 0);
});

test("o arquivo de cidades guarda o horário do estado da varredura, não o do envio", async () => {
  const { t, c } = setup();
  await c.national();
  await c.sweep();
  t.files[url2("sp")] = tse({ idg: 13, ts: "2026-10-25T19:08:00", lula: 22, flavio: 12, st: 4 });
  t.files[url2("br")] = tse({ idg: 13, ts: "2026-10-25T19:08:00", lula: 32, flavio: 22, st: 6 });
  await c.national(); // SP mudou, mas as cidades ainda não foram varridas de novo
  assert.equal(c.files()["mun/SP.json"].hora, "25/10 19:00");
});
