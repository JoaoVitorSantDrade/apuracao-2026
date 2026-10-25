// Coletor do histórico da apuração. Roda no PC do autor durante a noite:
//   node coletor/coletor.mjs
// Consulta o TSE como o painel faz, guarda cada lote no historico.json e as cidades em mun/<UF>.json, e publica
// tudo na branch "historico" do GitHub (sempre um único commit, refeito a cada envio). A página lê esses arquivos.
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const M = require("../model.js");

export const BASE = "https://resultados.tse.jus.br/oficial/ele2026";
const ELE_2T = "6258";
const ELE_1T = "6257";
const UFS = ["AC", "AL", "AP", "AM", "BA", "CE", "DF", "ES", "GO", "MA", "MT", "MS", "MG", "PA", "PB", "PR", "PE",
  "PI", "RJ", "RN", "RS", "RO", "RR", "SC", "SP", "SE", "TO", "ZZ"];
const CITY_CONC = 4; // o TSE responde 429 a quem pede demais

const url = (ele, uf, mun = "") => {
  const u = uf.toLowerCase();
  return `${BASE}/${ele}/dados/${u}/${u}${mun}-c0001-e${ele.padStart(6, "0")}-u.json`;
};

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

// O coletor não sabe nada de rede, disco ou git: tudo entra por `deps`, para os testes rodarem com um TSE falso.
export function createCollector({ fetchJson, ufs = UFS, saved = {}, sleep, log = console.log }) {
  const get = (u) => M.withRetry(() => fetchJson(u), { sleep });

  // Estado retomado dos arquivos já publicados: um intervalo sem coletar vira uma entrada maior, nunca votos repetidos.
  let entries = saved["historico.json"]?.entries || [];
  const live = {};
  const last = entries[entries.length - 1];
  if (last) {
    live.BR = M.unpackSnap(last.br);
    for (const [uf, a] of Object.entries(last.ufs)) live[uf] = M.unpackSnap(a);
  }
  const cityV = {}; // UF -> cd -> versões
  const city1 = {}; // UF -> cd -> [lula, flavio, validos, outros, secoesTot, eleitores]
  const swept = {}; // UF -> horário do arquivo do estado quando as cidades foram varridas
  for (const [p, v] of Object.entries(saved)) {
    const m = p.match(/^mun(1t)?\/([A-Z]{2})\.json$/);
    if (!m) continue;
    if (m[1]) city1[m[2]] = v;
    else { cityV[m[2]] = v.cidades; swept[m[2]] = v.hora; }
  }
  const queue = new Set();
  const dirty = new Set();
  let mun = null; // UF -> [{cd, nm}]

  const parts = () => Object.fromEntries(ufs.filter((u) => live[u]).map((u) => [u, live[u]]));
  const consistent = () => !!live.BR && ufs.every((u) => live[u]) && M.sumCheck(live.BR, Object.values(parts())).ok;

  async function national() {
    const br = M.parseTse(await get(url(ELE_2T, "BR")));
    const brNew = M.acceptSnapshot(live.BR, br).ok;
    if (!brNew && consistent()) return false;
    // Lote novo, ou a soma dos estados ainda não bate com o total: baixa os estados.
    const res = await Promise.allSettled(ufs.map(async (uf) => [uf, M.parseTse(await get(url(ELE_2T, uf)))]));
    let partsChanged = false;
    for (const r of res) {
      if (r.status !== "fulfilled") continue;
      const [uf, s] = r.value;
      if (!M.acceptSnapshot(live[uf], s).ok) continue;
      live[uf] = s;
      partsChanged = true;
      if (uf !== "ZZ" && s.secoes > 0) queue.add(uf);
    }
    if (brNew) {
      const before = live.BR;
      live.BR = br;
      entries = M.appendEntry(entries, M.historyEntry(br, parts()));
      dirty.add("historico.json");
      const d = M.delta(before, br);
      const pct = (br.p * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      log(`lote ${br.idg} (TSE ${br.hora}) · ${pct}% das seções · +${d.validos.toLocaleString("pt-BR")} válidos`);
    } else if (partsChanged && entries.length) {
      // Estado que chegou depois do total: entra na mesma entrada, que é a deste lote.
      const i = entries.length - 1;
      entries = [...entries.slice(0, i), { ...entries[i], ufs: M.historyEntry(live.BR, parts()).ufs }];
      dirty.add("historico.json");
    }
    return brNew;
  }

  async function loadMun() {
    if (mun) return mun;
    const j = await get(`${BASE}/${ELE_2T}/config/mun-e${ELE_2T.padStart(6, "0")}-cm.json`);
    mun = {};
    for (const a of j.abr) mun[a.cd.toUpperCase()] = a.mu.map((m) => ({ cd: m.cd, nm: m.nm }));
    return mun;
  }

  // Uma rodada: o 2º turno de todos os estados na fila e, depois, o 1º turno de um estado que ainda não tem.
  async function sweep() {
    await loadMun();
    const todo = [...queue];
    queue.clear();
    for (const uf of todo) {
      const list = mun[uf] || [];
      const vs = (cityV[uf] ??= {});
      const hora = live[uf]?.hora ?? null; // a página compara com o estado atual para saber se está em dia
      let failed = 0, changed = 0;
      await pool(list, CITY_CONC, async (m) => {
        try {
          const s = M.parseTse(await get(url(ELE_2T, uf, m.cd)));
          const next = M.addCityVersion(vs[m.cd] || [], s);
          if (next !== (vs[m.cd] || [])) { vs[m.cd] = next; changed++; }
        } catch { failed++; }
      });
      if (!failed) swept[uf] = hora;
      if (changed || !failed) dirty.add(`mun/${uf}.json`);
      if (failed) queue.add(uf); // tenta de novo na próxima rodada
      log(`cidades ${uf}: ${changed} novas versões${failed ? `, ${failed} sem resposta (tenta de novo)` : ""}`);
    }
    const need1t = ufs.find((u) => u !== "ZZ" && !city1[u] && mun[u]);
    if (need1t) {
      const out = {};
      let failed = 0;
      await pool(mun[need1t], CITY_CONC, async (m) => {
        try {
          const s = M.parseTse(await get(url(ELE_1T, need1t, m.cd)));
          out[m.cd] = [s.lula, s.flavio, s.validos, s.outros, s.secoesTot, s.eleitores];
        } catch { failed++; }
      });
      if (!failed) { city1[need1t] = out; dirty.add(`mun1t/${need1t}.json`); }
      log(`1º turno das cidades ${need1t}: ${Object.keys(out).length} cidades${failed ? `, ${failed} sem resposta (tenta de novo)` : ""}`);
    }
  }

  function files() {
    const f = { "historico.json": { ele: ELE_2T, entries } };
    for (const [uf, c] of Object.entries(cityV)) f[`mun/${uf}.json`] = { hora: swept[uf] ?? null, cidades: c };
    for (const [uf, c] of Object.entries(city1)) f[`mun1t/${uf}.json`] = c;
    return f;
  }

  // Publica só o que mudou desde o último envio.
  async function flush(publish) {
    if (!dirty.size) return false;
    const all = files();
    const out = Object.fromEntries([...dirty].map((p) => [p, all[p]]));
    dirty.clear();
    try {
      await publish(out);
    } catch (e) {
      Object.keys(out).forEach((p) => dirty.add(p)); // falhou: fica para o próximo envio
      throw e;
    }
    return true;
  }

  return {
    national, sweep, flush, files,
    queue: () => [...queue],
    done: () => !!live.BR && live.BR.p >= 1 && queue.size === 0 && dirty.size === 0,
  };
}

// ---- Linha de comando: disco, git e laços de tempo ----
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// --sem-publicar: grava os arquivos numa pasta local, sem git nem GitHub (para testar).
const DRY = process.argv.includes("--sem-publicar");
const DATA = path.join(ROOT, DRY ? ".historico-teste" : ".historico");
const BRANCH = "historico";
const git = (args, cwd = ROOT) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// A branch de dados fica num worktree em .historico/, separado da main do site.
function ensureWorktree() {
  if (fs.existsSync(path.join(DATA, ".git"))) return;
  const remote = git(["ls-remote", "--heads", "origin", BRANCH]);
  if (remote) {
    git(["fetch", "origin", `${BRANCH}:${BRANCH}`]);
    git(["worktree", "add", DATA, BRANCH]);
  } else {
    git(["worktree", "add", "--detach", DATA]);
    git(["checkout", "--orphan", BRANCH], DATA);
    git(["rm", "-rf", "--quiet", "."], DATA);
  }
}

function readSaved() {
  const saved = {};
  const read = (rel) => { try { saved[rel] = JSON.parse(fs.readFileSync(path.join(DATA, rel), "utf8")); } catch { /* ainda não existe */ } };
  read("historico.json");
  for (const dir of ["mun", "mun1t"]) {
    const d = path.join(DATA, dir);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) read(`${dir}/${f}`);
  }
  return saved;
}

async function publishGit(files) {
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(DATA, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(content));
  }
  if (DRY) return;
  git(["add", "-A"], DATA);
  let hasCommit = true;
  try { git(["rev-parse", "--verify", "HEAD"], DATA); } catch { hasCommit = false; }
  const msg = `Dados da apuração · ${new Date().toLocaleString("pt-BR")}`;
  // Um único commit, refeito a cada envio: o histórico mora dentro dos JSONs e o repositório não incha.
  git(hasCommit ? ["commit", "--amend", "--quiet", "-m", msg] : ["commit", "--quiet", "-m", msg], DATA);
  git(["push", "--force", "--quiet", "origin", BRANCH], DATA);
}

async function main() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const stamp = () => new Date().toLocaleTimeString("pt-BR");
  const log = (m) => console.log(`${stamp()} · ${m}`);
  const fetchJson = async (u) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const r = await fetch(u, { signal: ctl.signal, headers: { "cache-control": "no-cache" } });
      if (!r.ok) { const e = new Error(`${r.status} ${u}`); e.status = r.status; throw e; }
      return await r.json();
    } finally { clearTimeout(t); }
  };

  if (DRY) fs.mkdirSync(DATA, { recursive: true });
  else ensureWorktree();
  const c = createCollector({ fetchJson, saved: readSaved(), sleep, log });
  log(`coletor ligado · dados em ${DATA}${DRY ? " · sem publicar" : ` · branch ${BRANCH}`}`);

  let publishing = Promise.resolve();
  const flush = () => (publishing = publishing.then(async () => {
    try { if (await c.flush(publishGit)) log(DRY ? "gravado na pasta local" : "publicado no GitHub"); } catch (e) { log(`falha ao publicar, tenta de novo: ${e.message}`); }
  }));

  let stop = false;
  process.on("SIGINT", async () => { stop = true; log("encerrando: publicando o que falta…"); await flush(); process.exit(0); });

  // Laço nacional: a cada 15 s; lote novo é publicado na hora.
  (async () => {
    while (!stop) {
      try { if (await c.national()) flush(); } catch (e) { log(`TSE não respondeu: ${e.message}`); }
      await sleep(15000);
    }
  })();
  // Laço das cidades: varre sem parar o que está na fila (e o 1º turno que falta).
  (async () => {
    while (!stop) {
      try { await c.sweep(); } catch (e) { log(`cidades: ${e.message}`); }
      await sleep(3000);
    }
  })();
  // Envio das cidades em lote, a cada 60 s.
  while (!stop) {
    await sleep(60000);
    await flush();
    if (c.done()) { log("apuração totalizada e tudo publicado. Fim."); process.exit(0); }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
