/* Mindat Multi-Mineral Specimen Finder
 *
 * Injected onto mindat.org by a bookmarklet. Finds photos whose structured
 * species list contains EVERY mineral you name (2, 3, 4, ...), a query
 * Mindat's own search cannot run.
 *
 * How: Mindat's photosearch matches one structured mineral (minname) plus one
 * caption substring (text). For each wanted mineral M we sweep
 * (anchor=cheapest other mineral, text=M), fetch every result page in YOUR
 * browser session at a polite pace, parse each row's species links, and keep
 * rows containing all wanted minerals. Union of sweeps, deduped by photo id.
 *
 * Completeness: a photo is only findable if its caption names at least one of
 * your minerals. Structured species lists are printed on every row, so the
 * final filter is exact; the caption dependence only limits recall, and the
 * UI says so rather than pretending otherwise.
 *
 * Politeness: sequential fetches, ~800 ms apart with jitter, hard run cap,
 * pause/stop, auto-pause on any non-OK response. These are ordinary page
 * views in the user's own session — nothing is stored or redistributed.
 */
(() => {
  "use strict";
  if (location.hostname !== "www.mindat.org" && location.hostname !== "mindat.org") {
    alert("This tool runs on mindat.org.\n\nOpen www.mindat.org first, then click the bookmarklet again.");
    location.href = "https://www.mindat.org/photosearch.php";
    return;
  }
  if (window.__mmfPanel) { window.__mmfPanel.show(); return; }

  /* ---------- config ---------- */
  const DELAY_MS = 800;          // base spacing between requests
  const JITTER_MS = 250;
  const PAGE_SIZE = 10;          // photosearch.php fixed page size
  const HARD_PAGE_CAP = 900;     // absolute ceiling per run (politeness backstop)
  const CONFIRM_ABOVE = 250;     // ask before runs bigger than this many pages

  /* Spelling aliases: wanted-name -> caption/text variants to sweep, and
   * normalization applied to both sides of the structural match. */
  const SPELLINGS = {
    baryte: ["baryte", "barite"], barite: ["baryte", "barite"],
    sulphur: ["sulphur", "sulfur"], sulfur: ["sulphur", "sulfur"],
  };
  const NORM_MAP = { barite: "baryte", sulfur: "sulphur" };

  const norm = (s) =>
    (NORM_MAP[k(s)] || k(s));
  const k = (s) => String(s).toLowerCase().normalize("NFD")
      .replace(/\p{M}/gu, "").replace(/[^a-z]/g, "");

  /* ---------- mindat query plumbing ---------- */
  const buildURL = (minname, text, region, mtype, page) =>
    "/photosearch.php?" + new URLSearchParams({
      frm_id: "mls", cform_is_valid: "1", minname, cf_mls_page: String(page),
      region: region || "", text, phototype: "M", mtype: mtype || "0",
      potd: "0", sort: "2", submit_mls: "Search",
    });

  const parsePage = (html) => {
    if (/Just a moment|cf-challenge|Performing security verification/i.test(html))
      return { challenge: true, rows: [], total: null };
    const doc = new DOMParser().parseFromString(html, "text/html");
    const m = doc.body.innerText.match(/of ([\d,]+) total\)/);
    const total = m ? parseInt(m[1].replace(/,/g, ""), 10) : null;
    const rows = [...doc.querySelectorAll("div.galrow")].map((r) => {
      const idHref = r.querySelector('a[href*="photo-"]')?.getAttribute("href") || "";
      const id = (idHref.match(/photo-(\d+)/) || [])[1];
      if (!id) return null;
      const speciesLinks = [...r.querySelectorAll('a[href*="min-"]')]
        .map((a) => a.textContent.trim()).filter(Boolean);
      const locA = r.querySelector('a[href*="loc-"]');
      const img = r.querySelector("img");
      const thumb = img ? img.getAttribute("src") : null;
      const txt = r.innerText.replace(/\s+/g, " ");
      const dims = (txt.match(/Dimensions: ([^A-Z]*?)(?:Largest|Field|Weight|Copyright|Photo ID|$)/) || [])[1];
      return {
        id,
        url: "https://www.mindat.org/photo-" + id + ".html",
        species: speciesLinks,
        speciesNorm: speciesLinks.map(norm),
        loc: locA ? locA.textContent.trim() : "",
        thumb: thumb && !/childm\.png/.test(thumb) ? thumb : null,
        dims: dims ? dims.trim() : "",
      };
    }).filter(Boolean);
    return { challenge: false, rows, total };
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const politeWait = () => sleep(DELAY_MS + Math.random() * JITTER_MS);

  const fetchPage = async (url) => {
    const resp = await fetch(url, { credentials: "include" });
    if (!resp.ok) return { challenge: true, rows: [], total: null, status: resp.status };
    return parsePage(await resp.text());
  };

  /* ---------- run engine ---------- */
  const state = {
    running: false, paused: false, stopReq: false,
    fetched: 0, planned: 0, matches: new Map(), t0: 0,
  };

  const rowMatches = (row, wantedNorm) =>
    wantedNorm.every((w) => row.speciesNorm.includes(w));

  async function runSearch(minerals, region, mtype, ui) {
    const wantedNorm = minerals.map(norm);
    state.running = true; state.paused = false; state.stopReq = false;
    state.fetched = 0; state.matches = new Map(); state.t0 = Date.now();
    ui.phase("Probing query sizes…");

    /* Probe: for each mineral as the caption term (incl. spelling variants),
     * try each other mineral as the structural anchor; keep the cheapest.
     * Probe fetches are page 1 of the real sweep, so their rows are reused. */
    const sweeps = [];
    for (const target of minerals) {
      const variants = SPELLINGS[k(target)] || [k(target)];
      for (const variant of variants) {
        let best = null;
        for (const anchor of minerals.filter((x) => x !== target)) {
          const url = buildURL(anchor, variant, region, mtype, 1);
          const pg = await fetchPage(url); state.fetched++;
          ui.probe(`${anchor} × “${variant}” → ${pg.total ?? (pg.rows.length || 0)}`);
          if (pg.challenge) { ui.challenge(); return finish(ui, minerals, true); }
          const total = pg.total ?? pg.rows.length;
          if (best === null || total < best.total)
            best = { anchor, variant, total, firstPage: pg };
          await politeWait();
          if (state.stopReq) return finish(ui, minerals, true);
        }
        if (best && best.total > 0) sweeps.push(best);
      }
    }

    /* Dedupe sweeps that ended up identical & count pages */
    const seen = new Set();
    const plan = sweeps.filter((s) => {
      const key = s.anchor + "|" + s.variant;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    let totalPages = plan.reduce((n, s) => n + Math.ceil(s.total / PAGE_SIZE), 0);
    state.planned = totalPages;

    if (totalPages === 0) {
      ui.phase("No candidate photos found. Check the mineral spellings — Mindat uses e.g. “Baryte”.");
      return finish(ui, minerals, false);
    }
    if (totalPages > HARD_PAGE_CAP) {
      ui.phase(`This needs ${totalPages} pages — over the ${HARD_PAGE_CAP}-page politeness cap. Narrow it with a region or fewer/rarer minerals.`);
      return finish(ui, minerals, false);
    }
    if (totalPages > CONFIRM_ABOVE) {
      const mins = Math.round((totalPages * (DELAY_MS + JITTER_MS / 2)) / 60000);
      const go = await ui.confirm(
        `Complete run needs ${totalPages} pages (≈${mins} min at a polite pace). Fetch them all?`);
      if (!go) return finish(ui, minerals, true);
    }

    /* Sweep phase */
    for (let i = 0; i < plan.length; i++) {
      const s = plan[i];
      const pages = Math.ceil(s.total / PAGE_SIZE);
      ui.phase(`Sweep ${i + 1}/${plan.length}: ${s.anchor} photos mentioning “${s.variant}” — ${s.total} photos / ${pages} pages`);
      for (let p = 1; p <= pages; p++) {
        while (state.paused && !state.stopReq) await sleep(300);
        if (state.stopReq) return finish(ui, minerals, true);
        let pg;
        if (p === 1) { pg = s.firstPage; }
        else {
          await politeWait();
          pg = await fetchPage(buildURL(s.anchor, s.variant, region, mtype, p));
          state.fetched++;
        }
        if (pg.challenge) { ui.challenge(); return finish(ui, minerals, true); }
        for (const row of pg.rows) {
          if (!state.matches.has(row.id) && rowMatches(row, wantedNorm)) {
            state.matches.set(row.id, row);
            ui.addMatch(row, minerals);
          }
        }
        ui.progress(state.fetched, totalPages + probesCount(minerals), state.matches.size);
      }
    }
    return finish(ui, minerals, false);
  }

  const probesCount = (minerals) =>
    minerals.reduce((n, t) => n + (SPELLINGS[k(t)] || [1]).length * (minerals.length - 1), 0);

  function finish(ui, minerals, partial) {
    state.running = false;
    const secs = Math.round((Date.now() - state.t0) / 1000);
    ui.done(state.matches.size, state.fetched, secs, partial);
  }

  /* ---------- UI (shadow DOM so mindat's CSS can't touch it) ---------- */
  const SPECIES = ["Acanthite","Adamite","Aegirine","Albite","Almandine","Analcime","Anatase","Andradite","Anglesite","Anhydrite","Ankerite","Annabergite","Apatite","Apophyllite","Aragonite","Arsenopyrite","Augite","Aurichalcite","Autunite","Axinite","Azurite","Baryte","Barite","Benitoite","Beryl","Biotite","Bornite","Boulangerite","Bournonite","Brookite","Brucite","Calcite","Cassiterite","Cavansite","Celestine","Cerussite","Chabazite","Chalcopyrite","Chrysoberyl","Chrysocolla","Cinnabar","Cobaltite","Colemanite","Conichalcite","Copper","Cordierite","Corundum","Covellite","Creedite","Crocoite","Cuprite","Danburite","Datolite","Descloizite","Diamond","Dioptase","Dolomite","Dravite","Elbaite","Enargite","Epidote","Erythrite","Euclase","Eudialyte","Fluorapatite","Fluorite","Forsterite","Franklinite","Galena","Goethite","Gold","Grossular","Gypsum","Halite","Hematite","Hemimorphite","Heulandite","Hubnerite","Ilmenite","Ilvaite","Inesite","Jamesonite","Kyanite","Lazurite","Legrandite","Lepidolite","Libethenite","Linarite","Ludlamite","Magnetite","Malachite","Marcasite","Mesolite","Microcline","Millerite","Mimetite","Molybdenite","Monazite","Mottramite","Muscovite","Natrolite","Okenite","Olivenite","Opal","Orpiment","Orthoclase","Pectolite","Phenakite","Phlogopite","Prehnite","Proustite","Pyrargyrite","Pyrite","Pyromorphite","Pyrope","Pyrrhotite","Quartz","Realgar","Rhodochrosite","Rhodonite","Rosasite","Rutile","Scheelite","Schorl","Scolecite","Siderite","Silver","Skutterudite","Smithsonite","Sodalite","Spessartine","Sphalerite","Spinel","Spodumene","Stibnite","Stilbite","Strontianite","Sulphur","Sulfur","Talc","Tennantite","Tetrahedrite","Titanite","Topaz","Torbernite","Tourmaline","Tremolite","Turquoise","Vanadinite","Variscite","Vesuvianite","Vivianite","Wavellite","Willemite","Wolframite","Wulfenite","Zircon"];

  const host = document.createElement("div");
  host.id = "mmf-host";
  const shadow = host.attachShadow({ mode: "open" });
  document.documentElement.appendChild(host);

  shadow.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; }
  .drawer {
    position: fixed; top: 0; right: 0; height: 100vh; width: min(480px, 100vw);
    z-index: 2147483000; display: flex; flex-direction: column;
    background: #17151C; color: #EDEAF3;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    box-shadow: -12px 0 40px rgba(0,0,0,.45); border-left: 1px solid #332E3F;
  }
  .hd { padding: 16px 18px 12px; border-bottom: 1px solid #332E3F; display:flex; align-items:flex-start; gap:10px; }
  .hd h1 { font: 600 18px/1.2 ui-serif, "Iowan Old Style", Palatino, Georgia, serif; flex: 1; }
  .hd .sub { color:#9C94AB; font-size:12px; margin-top:3px; }
  .iconbtn { background:none; border:1px solid #332E3F; color:#9C94AB; border-radius:6px;
    width:26px; height:26px; cursor:pointer; font-size:13px; line-height:1; flex:0 0 auto; }
  .iconbtn:hover { color:#EDEAF3; border-color:#9C94AB; }
  .body { padding: 14px 18px; display:flex; flex-direction:column; gap:12px; overflow-y:auto; flex:1; }
  .lbl { font-size:11px; letter-spacing:.09em; text-transform:uppercase; font-weight:600; color:#A585E8; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; padding:8px; background:#211E29;
    border:1px solid #332E3F; border-radius:8px; min-height:44px; align-items:center; cursor:text; }
  .chip { display:inline-flex; align-items:center; gap:6px; background:#2A2140;
    border:1px solid #A585E8; color:#EDEAF3; border-radius:999px; padding:3px 6px 3px 11px; font-size:13px; }
  .chip button { background:none; border:none; color:#A585E8; cursor:pointer; font-size:14px; padding:0 3px; line-height:1; }
  .chip button:hover { color:#fff; }
  .chips input { background:none; border:none; outline:none; color:#EDEAF3;
    font:inherit; flex:1; min-width:110px; padding:4px; }
  .row2 { display:grid; grid-template-columns:1.5fr 1fr; gap:10px; }
  .fld { display:flex; flex-direction:column; gap:5px; }
  .fld input, .fld select { background:#211E29; border:1px solid #332E3F; color:#EDEAF3;
    border-radius:7px; padding:8px 10px; font:inherit; width: 100%; }
  .go { background:#A585E8; color:#17151C; border:none; border-radius:8px; padding:11px;
    font:600 15px/1 system-ui, sans-serif; cursor:pointer; }
  .go:hover { filter:brightness(1.08); }
  .go[disabled] { opacity:.45; cursor:default; }
  .runbtns { display:flex; gap:8px; }
  .runbtns button { flex:1; background:#211E29; color:#EDEAF3; border:1px solid #332E3F;
    border-radius:8px; padding:9px; font:600 13px/1 system-ui, sans-serif; cursor:pointer; }
  .runbtns button:hover { border-color:#9C94AB; }
  .status { background:#211E29; border:1px solid #332E3F; border-radius:8px; padding:10px 12px;
    font-size:12.5px; color:#9C94AB; display:flex; flex-direction:column; gap:7px; }
  .status .phase { color:#EDEAF3; }
  .bar { height:6px; background:#332E3F; border-radius:3px; overflow:hidden; }
  .bar i { display:block; height:100%; width:0%; background:linear-gradient(90deg,#A585E8,#DD9B5C); transition:width .3s; }
  .cnt { font-variant-numeric: tabular-nums; }
  .note { font-size:12px; color:#9C94AB; border-left:2px solid #332E3F; padding-left:10px; }
  .grid { display:flex; flex-direction:column; gap:10px; }
  .card { display:grid; grid-template-columns:96px 1fr; gap:12px; background:#211E29;
    border:1px solid #332E3F; border-radius:9px; padding:10px; text-decoration:none; color:inherit; }
  .card:hover { border-color:#A585E8; }
  .card .th { width:96px; height:96px; border-radius:6px; object-fit:cover; background:#332E3F; }
  .card .noth { width:96px; height:96px; border-radius:6px; background:#332E3F; display:flex;
    align-items:center; justify-content:center; color:#9C94AB; font-size:11px; text-align:center; }
  .card .sp { font-weight:600; font-size:13px; line-height:1.35; }
  .card .sp em { color:#DD9B5C; font-style:normal; }
  .card .lc { color:#9C94AB; font-size:12px; margin-top:3px; line-height:1.4; }
  .card .dm { color:#9C94AB; font-size:11.5px; margin-top:3px; font-variant-numeric:tabular-nums; }
  .ft { padding:10px 18px; border-top:1px solid #332E3F; display:flex; gap:8px; align-items:center; }
  .ft button { background:#211E29; color:#EDEAF3; border:1px solid #332E3F; border-radius:7px;
    padding:7px 12px; font:600 12px/1 system-ui,sans-serif; cursor:pointer; }
  .ft button:hover { border-color:#9C94AB; }
  .ft .n { color:#9C94AB; font-size:12px; flex:1; }
  datalist { display:none; }
  .min { position:fixed; bottom:18px; right:18px; z-index:2147483000; background:#A585E8;
    color:#17151C; border:none; border-radius:999px; padding:12px 18px;
    font:600 14px/1 system-ui,sans-serif; cursor:pointer; box-shadow:0 6px 24px rgba(0,0,0,.4); display:none; }
</style>
<div class="drawer" id="drawer">
  <div class="hd">
    <div style="flex:1">
      <h1>Multi-mineral specimen finder</h1>
      <div class="sub">Every photo whose species list has ALL of these &mdash; the search Mindat can't run</div>
    </div>
    <button class="iconbtn" id="minbtn" title="Minimize">&#8722;</button>
    <button class="iconbtn" id="closebtn" title="Close">&#10005;</button>
  </div>
  <div class="body">
    <div class="fld">
      <span class="lbl">Minerals (2 or more &mdash; Enter to add)</span>
      <div class="chips" id="chips"><input id="minin" list="mmfsp" placeholder="Fluorite&hellip;" autocomplete="off" spellcheck="false"></div>
      <datalist id="mmfsp">${SPECIES.map((s) => `<option value="${s}">`).join("")}</datalist>
    </div>
    <div class="row2">
      <div class="fld"><span class="lbl">Region (optional)</span>
        <input id="region" placeholder="Tennessee" autocomplete="off" spellcheck="false"></div>
      <div class="fld"><span class="lbl">Photo type</span>
        <select id="mtype">
          <option value="0">All</option><option value="1">Full view</option>
          <option value="2">Close-up</option><option value="9">UV shortwave</option>
          <option value="10">UV midwave</option><option value="11">UV longwave</option>
          <option value="13">In situ</option><option value="38">Gem rough</option>
        </select></div>
    </div>
    <button class="go" id="go">Find specimens</button>
    <div class="runbtns" id="runbtns" style="display:none">
      <button id="pause">Pause</button><button id="stop">Stop &amp; keep results</button>
    </div>
    <div class="status" id="status" style="display:none">
      <span class="phase" id="phase"></span>
      <div class="bar"><i id="bar"></i></div>
      <span class="cnt" id="cnt"></span>
    </div>
    <div class="note" id="note" style="display:none"></div>
    <div class="grid" id="grid"></div>
  </div>
  <div class="ft" id="ft" style="display:none">
    <span class="n" id="ftn"></span>
    <button id="csv">Download CSV</button>
    <button id="copy">Copy links</button>
  </div>
</div>
<button class="min" id="restore">&#9670; Finder</button>`;

  const $ = (id) => shadow.getElementById(id);
  const minerals = [];

  const renderChips = () => {
    [...shadow.querySelectorAll(".chip")].forEach((c) => c.remove());
    const input = $("minin");
    minerals.forEach((m, i) => {
      const c = document.createElement("span");
      c.className = "chip";
      c.innerHTML = `${m}<button data-i="${i}" title="Remove">&#10005;</button>`;
      c.querySelector("button").onclick = () => { minerals.splice(i, 1); renderChips(); };
      $("chips").insertBefore(c, input);
    });
    $("go").disabled = minerals.length < 2 || state.running;
    $("go").textContent = minerals.length < 2
      ? "Add at least two minerals"
      : `Find ${minerals.join(" + ")}`;
  };

  const addMineral = (raw) => {
    const v = raw.trim();
    if (!v) return;
    const canon = SPECIES.find((s) => k(s) === k(v)) || (v[0].toUpperCase() + v.slice(1).toLowerCase());
    if (!minerals.some((m) => norm(m) === norm(canon))) minerals.push(canon);
    $("minin").value = "";
    renderChips();
  };

  $("minin").addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); addMineral($("minin").value); }
    else if (e.key === "Backspace" && !$("minin").value && minerals.length) { minerals.pop(); renderChips(); }
  });
  $("minin").addEventListener("change", () => addMineral($("minin").value));
  $("chips").addEventListener("click", () => $("minin").focus());

  const ui = {
    phase: (t) => { $("status").style.display = "flex"; $("phase").textContent = t; },
    probe: (t) => { $("cnt").textContent = "probe: " + t; },
    progress: (done, total, found) => {
      $("bar").style.width = Math.min(100, (done / total) * 100).toFixed(1) + "%";
      const eta = Math.max(0, Math.round(((total - done) * (DELAY_MS + JITTER_MS / 2)) / 1000));
      $("cnt").textContent = `${done}/${total} pages · ${found} match${found === 1 ? "" : "es"} · ~${eta}s left`;
    },
    addMatch: (row, wanted) => {
      const wn = wanted.map(norm);
      const sp = row.species.map((s) => (wn.includes(norm(s)) ? `<em>${s}</em>` : s)).join(", ");
      const a = document.createElement("a");
      a.className = "card"; a.href = row.url; a.target = "_blank"; a.rel = "noopener";
      a.innerHTML = `${row.thumb
        ? `<img class="th" loading="lazy" src="${row.thumb}" alt="">`
        : `<div class="noth">no cached thumbnail</div>`}
        <div><div class="sp">${sp}</div><div class="lc">${row.loc}</div>
        ${row.dims ? `<div class="dm">${row.dims}</div>` : ""}</div>`;
      $("grid").appendChild(a);
    },
    confirm: (msg) => Promise.resolve(confirm(msg)),
    challenge: () => {
      $("note").style.display = "block";
      $("note").textContent = "Mindat's bot protection interrupted the run. Reload any mindat.org page to clear it, then run again — results below are what was found so far.";
    },
    done: (found, fetched, secs, partial) => {
      $("runbtns").style.display = "none"; $("go").disabled = minerals.length < 2;
      $("bar").style.width = "100%";
      $("phase").textContent = (partial ? "Stopped — partial results. " : "Complete. ") +
        `${found} matching specimen photo${found === 1 ? "" : "s"} (${fetched} pages, ${secs}s).`;
      $("note").style.display = "block";
      $("note").textContent = partial
        ? "Partial: not every candidate page was checked."
        : "Complete within what this method can see: every candidate whose caption mentions at least one of your minerals was checked against Mindat's structured species lists. A photo captioned without naming any of them cannot be found this way.";
      if (found) { $("ft").style.display = "flex"; $("ftn").textContent = `${found} specimens`; }
    },
  };

  $("go").onclick = async () => {
    if (minerals.length < 2 || state.running) return;
    $("grid").innerHTML = ""; $("ft").style.display = "none"; $("note").style.display = "none";
    $("go").disabled = true; $("runbtns").style.display = "flex"; $("pause").textContent = "Pause";
    await runSearch(minerals.slice(), $("region").value.trim(), $("mtype").value, ui);
  };
  $("pause").onclick = () => {
    state.paused = !state.paused;
    $("pause").textContent = state.paused ? "Resume" : "Pause";
    if (state.paused) $("phase").textContent = "Paused.";
  };
  $("stop").onclick = () => { state.stopReq = true; };
  $("closebtn").onclick = () => { state.stopReq = true; host.remove(); delete window.__mmfPanel; };
  $("minbtn").onclick = () => { $("drawer").style.display = "none"; $("restore").style.display = "block"; };
  $("restore").onclick = () => { $("drawer").style.display = "flex"; $("restore").style.display = "none"; };

  const rowsCSV = () => {
    const esc = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    const lines = [["photo_id", "url", "species", "locality", "dimensions"].join(",")];
    for (const r of state.matches.values())
      lines.push([r.id, r.url, esc(r.species.join(" + ")), esc(r.loc), esc(r.dims)].join(","));
    return lines.join("\n");
  };
  $("csv").onclick = () => {
    const blob = new Blob([rowsCSV()], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mindat-" + minerals.map(k).join("-") + ".csv";
    a.click(); URL.revokeObjectURL(a.href);
  };
  $("copy").onclick = async () => {
    const links = [...state.matches.values()].map((r) => r.url).join("\n");
    try { await navigator.clipboard.writeText(links); $("copy").textContent = "Copied"; }
    catch { $("copy").textContent = "Copy failed"; }
    setTimeout(() => { $("copy").textContent = "Copy links"; }, 1500);
  };

  window.__mmfPanel = { show: () => { $("drawer").style.display = "flex"; $("restore").style.display = "none"; } };
  $("minin").focus();
})();
