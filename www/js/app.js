// Riochi : recherche d'anime et lecture, alimentés par des plugins au format Weebox.
// Un plugin est une classe Provider (getSettings, search, findEpisodes, findEpisodeServer).
// Les sources s'ajoutent par lien ou par fichier JSON et sont gardées sur l'appareil.
(() => {
  "use strict";

  const $ = (s, r = document) => r.querySelector(s);

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === "class") e.className = v;
      else if (k === "style") e.style.cssText = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
    return e;
  }
  const msg = (e) => (e && e.message ? e.message : String(e));
  const withTimeout = (promise, ms) =>
    Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error("délai dépassé")), ms))]);
  const hue = (s) => [...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;

  // ---------------------------------------------------------------- journal réseau
  // Garde les dernières requêtes refusées (403, 5xx…) pour les montrer quand aucun flux ne se lance.
  const netLog = [];
  if (typeof window.fetch === "function") {
    const baseFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : (input && input.url) || String(input);
      try {
        const r = await baseFetch(input, init);
        if (!r.ok && !/graphql\.anilist\.co|fonts\.g/.test(url)) { netLog.push(r.status + " " + url.slice(0, 90)); if (netLog.length > 8) netLog.shift(); }
        return r;
      } catch (e) {
        if (!/graphql\.anilist\.co|fonts\.g/.test(url)) { netLog.push("réseau " + url.slice(0, 90)); if (netLog.length > 8) netLog.shift(); }
        throw e;
      }
    };
  }

  // ---------------------------------------------------------------- cache $store
  // Certains plugins gardent des pages en mémoire quelques minutes dans $store.
  const mem = new Map();
  window.$store = {
    get: (k) => mem.get(k),
    set: (k, v) => { mem.set(k, v); },
    delete: (k) => mem.delete(k),
    keys: () => Array.from(mem.keys()),
  };

  // ---------------------------------------------------------------- sources
  // Sources intégrées (Sources FR, extensions Anix, sources adultes, exemple) : toujours là, on les active ou non.
  // Sources ajoutées par lien ou fichier ("custom") : gardées sur l'appareil.
  const KEY = "riochi.sources", STATE = "riochi.state", ADULT = "riochi.adult";
  const store = {
    get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* tant pis */ } },
  };
  const readJson = (k, d) => { try { const v = JSON.parse(store.get(k)); return v == null ? d : v; } catch (e) { return d; } };
  const tag = (list, group, extra) => (list || []).map((p) => Object.assign({}, p, { group }, extra || {}));
  const buildBuiltin = () => [].concat(
    tag(window.RIOCHI_DEFAULTS, "fr-base"),
    tag(window.RIOCHI_ANIX, "anix"),
    tag(window.RIOCHI_ADULT, "adult", { adult: true }),
    window.RIOCHI_DEMO ? tag([window.RIOCHI_DEMO], "demo") : []
  ).filter((s, i, all) => all.findIndex((x) => x.id === s.id) === i);
  let builtin = buildBuiltin();
  let custom = readJson(KEY, []).filter((s) => !builtin.some((b) => b.id === s.id));
  // Les autres langues et les sources 18+ ne sont chargées que si on les demande (démarrage plus léger).
  let moreLoaded = false, moreLoading = null;
  function loadMore() {
    if (moreLoaded) return Promise.resolve();
    if (moreLoading) return moreLoading;
    const load = (src) => new Promise((res, rej) => {
      const t = document.createElement("script");
      t.src = src; t.onload = res; t.onerror = () => rej(new Error("fichier " + src + " introuvable"));
      document.head.append(t);
    });
    moreLoading = load("js/sources-anix.js").then(() => load("js/sources-18.js")).then(() => {
      builtin = buildBuiltin();
      custom = custom.filter((c) => !builtin.some((b) => b.id === c.id));
      moreLoaded = true;
    }).finally(() => { moreLoading = null; });
    return moreLoading;
  }
  let state = readJson(STATE, {});
  let adultOn = store.get(ADULT) === "1";
  // Par défaut : les sources françaises, l'exemple et tes ajouts. Le reste s'active à la main.
  const defaultOn = (s) => !s.adult && (s.group === "custom" || s.group === "demo" || s.group === "fr-base" || s.lang === "fr");
  const isOn = (s) => (s.id in state ? Boolean(state[s.id]) : defaultOn(s));
  const allSources = () => builtin.concat(custom).filter((s) => adultOn || !s.adult);
  const active = () => allSources().filter(isOn);
  const saveCustom = () => store.set(KEY, JSON.stringify(custom));
  const saveState = () => store.set(STATE, JSON.stringify(state));

  const providers = new Map();
  function providerOf(src) {
    if (providers.has(src.id)) return providers.get(src.id);
    const C = new Function(src.payload + "\n;return typeof Provider === 'function' ? Provider : null;")();
    if (!C) throw new Error("ce plugin ne définit pas de classe Provider");
    const p = new C();
    providers.set(src.id, p);
    return p;
  }

  function normalize(json) {
    const list = Array.isArray(json) ? json : json && Array.isArray(json.plugins) ? json.plugins : json && json.payload ? [json] : [];
    return list.filter((p) => p && typeof p.id === "string" && typeof p.name === "string" && typeof p.payload === "string" && p.payload.trim() !== "");
  }

  function addFromJson(json) {
    const list = normalize(json);
    if (!list.length) throw new Error("Aucun plugin trouvé dans ce fichier.");
    const added = [], bad = [];
    for (const p of list) {
      try {
        providers.delete(p.id);
        providerOf(p);
      } catch (e) {
        bad.push(p.name + " (" + msg(e) + ")");
        continue;
      }
      if (builtin.some((b) => b.id === p.id)) { bad.push(p.name + " (déjà intégrée)"); continue; }
      const rec = {
        id: p.id, name: p.name, version: p.version || "", lang: p.lang || "", group: "custom",
        languages: p.languages || null, description: p.description || "", payload: p.payload,
      };
      const i = custom.findIndex((s) => s.id === p.id);
      if (i >= 0) custom[i] = rec; else custom.push(rec);
      added.push(p.name);
    }
    saveCustom();
    return { added, bad };
  }

  // Un lien Google Drive « partagé » devient un lien de téléchargement direct.
  const driveDirect = (u) => {
    const m = /drive\.google\.com\/file\/d\/([\w-]+)/.exec(u);
    return m ? "https://drive.google.com/uc?export=download&id=" + m[1] : u;
  };

  async function addFromUrl(link) {
    let r;
    try {
      r = await fetch(driveDirect(link.trim()));
    } catch (e) {
      throw new Error("Lien inaccessible. Dans un navigateur il peut être bloqué (CORS) : utilise « Depuis un fichier » ou l'application Android.");
    }
    if (!r.ok) throw new Error("Le lien répond « HTTP " + r.status + " ».");
    let json;
    try { json = JSON.parse(await r.text()); } catch (e) {
      throw new Error("Ce lien ne renvoie pas un fichier JSON (page de connexion Google Drive ?).");
    }
    return addFromJson(json);
  }

  // ---------------------------------------------------------------- navigation
  const tabs = [["search", "Recherche"], ["sources", "Sources"]];
  function show(name) {
    $("#nav").replaceChildren(
      ...tabs.map(([k, label]) => el("button", { "aria-current": k === name ? "page" : false, onclick: () => show(k) }, label))
    );
    (name === "search" ? viewSearch : viewSources)();
  }

  // ---------------------------------------------------------------- titres AniList
  // AniList (base publique d'anime, sans clé) fournit l'accueil et les suggestions.
  // Le titre choisi est transmis aux plugins (media) pour mieux retrouver l'anime.
  const MEDIA = "id idMal title{romaji english} synonyms format episodes seasonYear startDate{year month day} coverImage{large}";
  async function anilist(query, variables) {
    const r = await withTimeout(fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query, variables }),
    }), 15000);
    if (!r.ok) throw new Error("AniList répond « HTTP " + r.status + " »");
    const j = await r.json();
    if (j.errors) throw new Error(j.errors[0].message);
    return j.data;
  }
  const titleOf = (m) => m.title.english || m.title.romaji || "Sans titre";
  const toMedia = (m) => ({
    id: m.id, idMal: m.idMal, englishTitle: m.title.english, romajiTitle: m.title.romaji,
    synonyms: m.synonyms || [], format: m.format, episodeCount: m.episodes,
    startDate: m.startDate, year: m.seasonYear || (m.startDate && m.startDate.year) || null,
  });
  const metaOf = (m) => [m.seasonYear || (m.startDate && m.startDate.year), m.format && m.format.replace(/_/g, " ")].filter(Boolean).join(" · ");

  let homeData = null;
  function loadHome() {
    if (homeData) return Promise.resolve(homeData);
    const cached = readJson("riochi.home", null);
    const fresh = cached && cached.data && Date.now() - cached.at < 6 * 3600 * 1000;
    const now = new Date();
    const season = ["WINTER", "SPRING", "SUMMER", "FALL"][Math.floor(now.getMonth() / 3)];
    const q = `query($season:MediaSeason,$year:Int){
      trending:Page(perPage:12){media(type:ANIME,sort:TRENDING_DESC,isAdult:false){${MEDIA}}}
      season:Page(perPage:12){media(type:ANIME,season:$season,seasonYear:$year,sort:POPULARITY_DESC,isAdult:false){${MEDIA}}}
      top:Page(perPage:12){media(type:ANIME,sort:SCORE_DESC,isAdult:false){${MEDIA}}}}`;
    const fetchIt = () => anilist(q, { season, year: now.getFullYear() }).then((d) => {
      store.set("riochi.home", JSON.stringify({ at: Date.now(), data: d }));
      return d;
    });
    if (cached && cached.data) {
      homeData = cached.data;
      if (!fresh) fetchIt().catch(() => {});
      return Promise.resolve(homeData);
    }
    return fetchIt().then((d) => (homeData = d));
  }

  // ---------------------------------------------------------------- recherche
  let lastQuery = "", lastDub = false, searchToken = 0, lastRes = [];

  function viewSearch() {
    const main = $("#main");
    const input = el("input", { type: "search", id: "q", placeholder: "Titre d'un anime", autocomplete: "off", "aria-label": "Titre" });
    input.value = lastQuery;
    const dub = el("input", { type: "checkbox", id: "dub" });
    dub.checked = lastDub;
    const sugg = el("div", { class: "sugg", hidden: true });
    const out = el("div", { id: "out" });
    let media = null, suggToken = 0, timer = 0;
    main.replaceChildren(
      el("form", { onsubmit: (e) => { e.preventDefault(); sugg.hidden = true; run(); } },
        el("div", { class: "sw" }, input, sugg),
        el("label", { class: "chk", for: "dub" }, dub, "Version doublée (VF)")),
      out
    );

    // Suggestions pendant la frappe.
    input.addEventListener("input", () => {
      media = null;
      clearTimeout(timer);
      const q = input.value.trim();
      if (q.length < 2) { sugg.hidden = true; if (!q) { lastQuery = ""; showHome(); } return; }
      timer = setTimeout(async () => {
        const token = ++suggToken;
        try {
          const d = await anilist(`query($s:String){Page(perPage:6){media(type:ANIME,search:$s,sort:SEARCH_MATCH,isAdult:false){${MEDIA}}}}`, { s: q });
          if (token !== suggToken) return;
          const list = d.Page.media;
          sugg.replaceChildren(...list.map((m) =>
            el("button", { type: "button", onclick: () => pick(m) }, el("b", {}, titleOf(m)), el("small", {}, metaOf(m)))));
          sugg.hidden = !list.length;
        } catch (e) { sugg.hidden = true; }
      }, 300);
    });
    input.addEventListener("blur", () => setTimeout(() => { sugg.hidden = true; }, 200));

    function pick(m) {
      input.value = titleOf(m);
      media = toMedia(m);
      sugg.hidden = true;
      run();
    }

    async function showHome() {
      const token = ++searchToken;
      out.replaceChildren(el("p", { class: "empty" }, "Chargement des titres…"));
      try {
        const d = await loadHome();
        if (token !== searchToken) return;
        const shelf = (title, list) => [
          el("h2", {}, title),
          el("div", { class: "shelf" }, list.map((m) =>
            el("button", { class: "card", onclick: () => pick(m) },
              poster(titleOf(m), m.coverImage && m.coverImage.large), el("b", {}, titleOf(m)), el("small", {}, metaOf(m))))),
        ];
        out.replaceChildren(...shelf("Tendances", d.trending.media), ...shelf("Populaires cette saison", d.season.media), ...shelf("Les mieux notés", d.top.media));
      } catch (e) {
        if (token !== searchToken) return;
        out.replaceChildren(
          el("p", { class: "empty" }, "Les titres suggérés sont indisponibles (" + msg(e) + "). Tu peux quand même chercher un titre ci-dessus."),
          el("button", { onclick: showHome }, "Réessayer"));
      }
    }

    async function run() {
      const q = input.value.trim();
      if (!q) { showHome(); return; }
      lastQuery = q; lastDub = dub.checked;
      if (!active().length) { out.replaceChildren(el("p", { class: "empty" }, "Aucune source active. Active-en dans l'onglet Sources.")); return; }
      out.replaceChildren(el("p", { class: "empty" }, "Recherche en cours…"));
      const token = ++searchToken;
      const asked = media || {};
      const srcs = active();
      const results = new Array(srcs.length).fill(null);
      let pending = srcs.length;
      const paint = () => {
        if (token !== searchToken) return;
        const done = results.filter(Boolean);
        lastRes = done.filter((r) => r.items.length);
        const cards = done.flatMap(({ src, items }) => items.map((r) => card(src, r)));
        const errors = done.filter((r) => r.error).map((r) => el("p", { class: "mut" }, r.src.name + " : " + r.error));
        out.replaceChildren(
          cards.length ? el("div", { class: "grid", style: "margin-top:20px" }, cards) : null,
          pending ? el("p", { class: "empty" }, "Recherche en cours… (" + (srcs.length - pending) + "/" + srcs.length + " sources)")
            : !cards.length ? el("p", { class: "empty" }, "Aucun résultat dans tes sources.") : null,
          ...errors,
          !pending && done.some((r) => r.error && /unreachable|Failed to fetch|NetworkError/i.test(r.error))
            ? el("p", { class: "mut" }, "Dans un navigateur, les sites d'anime bloquent les appels des plugins (CORS) : les sources FR ne marcheront que dans l'application Android.")
            : null
        );
      };
      await Promise.all(srcs.map(async (src, n) => {
        let r;
        try {
          const p = providerOf(src);
          const st = (p.getSettings && p.getSettings()) || {};
          if (lastDub && st.supportsDub === false) r = { src, items: [] };
          else {
            const items = await withTimeout(p.search({ query: q, dub: lastDub, media: asked }), 30000);
            r = { src, items: Array.isArray(items) ? items : [] };
          }
        } catch (e) {
          r = { src, items: [], error: msg(e) };
        }
        results[n] = r;
        pending--;
        paint();
      }));
    }

    if (lastQuery) run(); else showHome();
  }

  function poster(title, image) {
    return el("div", { class: "poster", style: "--h:" + hue(title) },
      image ? el("img", { src: image, alt: "", loading: "lazy", referrerpolicy: "no-referrer", onerror: (e) => e.target.remove() }) : null,
      el("span", {}, ([...title][0] || "?").toUpperCase()));
  }

  function card(src, r) {
    const title = r.title || r.name || "Sans titre";
    return el("button", { class: "card", onclick: () => openDetail(src, r, title) },
      poster(title, r.image || r.cover || r.poster), el("b", {}, title), el("small", {}, src.name));
  }

  // ---------------------------------------------------------------- détail et épisodes
  let session = null;
  // Épisodes vus, gardés sur l'appareil par titre : coche sur la liste et bouton « Reprendre ».
  const seenKey = () => "riochi.seen." + session.title.toLowerCase() + (lastDub ? "|vf" : "");
  const readSeen = () => readJson(seenKey(), { eps: {}, last: -1 });
  function paintEps() {
    if (!session || !session.chips) return;
    const d = readSeen();
    session.chips.forEach((c, i) => { c.classList.toggle("seen", Boolean(d.eps[i])); c.classList.toggle("now", i === session.index && $("#player").open); });
  }
  function markSeen() {
    const d = readSeen();
    d.eps[session.index] = 1; d.last = session.index;
    store.set(seenKey(), JSON.stringify(d));
    paintEps();
  }

  async function openDetail(src, r, title) {
    const d = $("#detail");
    const info = el("p", { class: "mut" }, "Chargement des épisodes…");
    const eps = el("ul", { class: "eps" });
    d.replaceChildren(
      el("div", { class: "bar" }, el("h2", {}, title), el("button", { "data-close": true }, "Fermer")),
      el("div", { class: "dbody" },
        poster(title, r.image || r.cover || r.poster),
        el("div", {}, el("p", { class: "mut" }, src.name), r.description ? el("p", {}, r.description) : null, info)),
      eps
    );
    d.showModal();
    try {
      const list = await withTimeout(providerOf(src).findEpisodes(r.id), 45000);
      if (!Array.isArray(list) || !list.length) throw new Error("aucun épisode");
      info.textContent = list.length + " épisode" + (list.length > 1 ? "s" : "");
      // La source ouverte d'abord, puis les autres sources qui ont trouvé cet anime (changement possible dans le lecteur).
      const alts = lastRes.filter((x) => x.src.id !== src.id).map((x) => ({ src: x.src, item: x.items[0], episodes: null }));
      session = { title, index: 0, cur: 0, entries: [{ src, item: r, episodes: list }].concat(alts) };
      session.chips = [];
      list.forEach((ep, i) => {
        const chip = el("button", { title: ep.title || "", onclick: () => openPlayer(i) }, String(ep.number ?? i + 1));
        session.chips.push(chip);
        eps.append(el("li", {}, chip));
      });
      const seen = readSeen();
      if (seen.last >= 0 && seen.last < list.length)
        eps.before(el("button", { class: "ac resume", onclick: () => openPlayer(seen.last) }, "Reprendre · épisode " + (list[seen.last].number ?? seen.last + 1)));
      paintEps();
    } catch (e) {
      info.textContent = "Épisodes introuvables : " + msg(e);
    }
  }

  // ---------------------------------------------------------------- lecteur
  let hls = null, playToken = 0;

  function ensurePlayerUi() {
    if ($("#pstat")) return;
    const psrc = el("select", { id: "psrc", "aria-label": "Source", hidden: true });
    const psel = el("select", { id: "psel", "aria-label": "Version", hidden: true });
    psrc.onchange = () => { session.cur = Number(psrc.value); playEpisode(session.index, true); };
    const seek = (d) => { const v = $("#video"); v.currentTime = Math.max(0, v.currentTime + d); };
    $("#video").after(
      el("div", { id: "pctl" },
        psrc, psel,
        el("button", { type: "button", "aria-label": "Reculer de 10 secondes", onclick: () => seek(-10) }, "⟲ 10 s"),
        el("button", { type: "button", "aria-label": "Avancer de 10 secondes", onclick: () => seek(10) }, "10 s ⟳"),
        el("button", { type: "button", id: "pfs", onclick: () => setCinema(!$("#player").classList.contains("cinema")) }, "⛶ Plein écran")),
      el("p", { class: "mut", id: "pstat", role: "status" })
    );
  }

  // Plein écran : la fenêtre remplit l'écran et on demande le mode paysage (si le système le permet).
  function setCinema(on) {
    const p = $("#player");
    p.classList.toggle("cinema", on);
    const b = $("#pfs");
    if (b) b.textContent = on ? "✕ Quitter" : "⛶ Plein écran";
    try {
      if (on) {
        const r = p.requestFullscreen || p.webkitRequestFullscreen;
        if (r) { const x = r.call(p); if (x && x.catch) x.catch(() => {}); }
        if (screen.orientation && screen.orientation.lock) screen.orientation.lock("landscape").catch(() => {});
      } else {
        if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(() => {});
        if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      }
    } catch (e) { /* tant pis : le plein écran « maison » reste actif */ }
  }

  function stopVideo() {
    if (hls) { hls.destroy(); hls = null; }
    const v = $("#video");
    v.pause();
    v.querySelectorAll("track").forEach((t) => t.remove());
    v.removeAttribute("src");
    v.load();
  }

  function openPlayer(i) {
    ensurePlayerUi();
    const p = $("#player");
    if (!p.open) p.showModal();
    playEpisode(i);
  }

  // Les épisodes d'une autre source : chargés à la demande, retrouvés par leur numéro.
  async function episodeFor(entry, i) {
    const base = session.entries[0].episodes[i];
    if (entry === session.entries[0]) return base;
    if (!entry.episodes) {
      try { entry.episodes = await withTimeout(providerOf(entry.src).findEpisodes(entry.item.id), 45000); }
      catch (e) { entry.episodes = []; entry.error = msg(e); }
    }
    const n = base.number;
    return entry.episodes.find((e) => n != null && e.number === n)
      || (entry.episodes.length === session.entries[0].episodes.length ? entry.episodes[i] : null) || null;
  }

  // Tous les flux qu'une source donne pour un épisode (un appel par serveur du plugin).
  async function collectChoices(entry, ep) {
    const prov = providerOf(entry.src);
    const settings = (prov.getSettings && prov.getSettings()) || {};
    const servers = settings.episodeServers && settings.episodeServers.length ? settings.episodeServers : ["default"];
    const errors = [];
    const results = await Promise.all(servers.map(async (sv) => {
      try { return await withTimeout(prov.findEpisodeServer(ep, sv), 60000); }
      catch (e) { errors.push(sv + " : " + msg(e)); return null; }
    }));
    const choices = [];
    for (const r of results) {
      if (!r || !Array.isArray(r.videoSources)) continue;
      for (const v of r.videoSources) {
        if (v && v.url) choices.push({ url: v.url, type: v.type, headers: r.headers || {}, subtitles: v.subtitles || [], label: [entry.src.name, r.server || v.label, v.quality].filter(Boolean).join(" · ") });
      }
    }
    return { choices, errors };
  }

  // explicit = l'utilisateur a choisi une source : on ne bascule pas ailleurs sans le lui dire.
  async function playEpisode(i, explicit) {
    const s = session;
    s.index = i;
    const base = s.entries[0].episodes[i];
    $("#ptitle").textContent = s.title + " · " + (base.title || "Épisode " + (base.number ?? i + 1));
    $("#pprev").disabled = i <= 0;
    $("#pnext").disabled = i >= s.entries[0].episodes.length - 1;
    const stat = $("#pstat"), sel = $("#psel"), psrc = $("#psrc");
    const token = ++playToken;
    stopVideo();
    sel.hidden = true;
    sel.replaceChildren();
    psrc.replaceChildren(...s.entries.map((e, k) => el("option", { value: k }, e.src.name)));
    psrc.value = String(s.cur);
    psrc.hidden = s.entries.length < 2;
    netLog.length = 0;
    $("#video").onended = () => { if (session === s && s.index === i && i < s.entries[0].episodes.length - 1) playEpisode(i + 1); };
    paintEps();

    const order = explicit ? [s.cur] : [s.cur].concat(s.entries.map((_, k) => k).filter((k) => k !== s.cur));
    const log = [];
    const next = async (pos) => {
      if (token !== playToken) return;
      if (pos >= order.length) {
        const net = netLog.length ? " Requêtes refusées : " + netLog.join(" ; ") + "." : "";
        const hint = s.entries.length < 2 ? " Aucune autre source n'a trouvé cet anime : active d'autres sources dans l'onglet Sources puis relance la recherche." : "";
        stat.textContent = "Aucun flux disponible. " + log.join(" | ") + net + hint;
        return;
      }
      const k = order[pos], entry = s.entries[k];
      stat.textContent = (pos ? "Source suivante : " : "Recherche du flux : ") + entry.src.name + "…";
      const ep = await episodeFor(entry, i);
      if (token !== playToken) return;
      if (!ep) { log.push(entry.src.name + " : épisode " + (base.number ?? i + 1) + " introuvable" + (entry.error ? " (" + entry.error + ")" : "")); return next(pos + 1); }
      const { choices, errors } = await collectChoices(entry, ep);
      if (token !== playToken) return;
      if (!choices.length) { log.push(entry.src.name + " → " + errors.join(" ; ")); return next(pos + 1); }
      s.cur = k;
      psrc.value = String(k);
      choices.forEach((c, n) => sel.append(el("option", { value: n }, c.label || "Flux " + (n + 1))));
      sel.hidden = choices.length < 2;
      const dead = (why) => { log.push(entry.src.name + " → " + why); next(pos + 1); };
      sel.onchange = () => play(choices, Number(sel.value), token, dead);
      play(choices, 0, token, dead);
    };
    next(0);
  }

  // hls.js lit les flux .m3u8 ; s'il n'est pas déjà chargé, on le demande à trois CDN à la suite.
  let hlsLoading = null;
  function loadHls() {
    if (window.Hls) return Promise.resolve(true);
    if (hlsLoading) return hlsLoading;
    const urls = [
      "https://cdn.jsdelivr.net/npm/hls.js@1.5.8/dist/hls.min.js",
      "https://unpkg.com/hls.js@1.5.8/dist/hls.min.js",
      "https://cdnjs.cloudflare.com/ajax/libs/hls.js/1.5.8/hls.min.js",
    ];
    hlsLoading = (async () => {
      for (const u of urls) {
        const ok = await new Promise((res) => {
          const s = document.createElement("script");
          s.src = u;
          s.onload = () => res(true);
          s.onerror = () => { s.remove(); res(false); };
          document.head.append(s);
        });
        if (ok && window.Hls) return true;
      }
      hlsLoading = null;
      return false;
    })();
    return hlsLoading;
  }

  const MEDIA_ERRORS = { 1: "annulée", 2: "erreur réseau", 3: "décodage impossible", 4: "lien ou format non pris en charge" };

  // Lance le flux choices[k] ; en cas d'échec, essaie le suivant et dit ce qui s'est passé.
  async function play(choices, k, token, onDead) {
    if (token !== playToken) return;
    const c = choices[k], v = $("#video"), stat = $("#pstat");
    stopVideo();
    $("#psel").value = String(k);
    const fail = (why) => {
      if (token !== playToken) return;
      if (k + 1 < choices.length) { stat.textContent = why + " Essai du flux suivant…"; play(choices, k + 1, token, onDead); }
      else if (onDead) onDead(why);
      else stat.textContent = why + " Aucun autre flux à essayer.";
    };
    v.onerror = () => fail("Lecture impossible (" + (MEDIA_ERRORS[v.error && v.error.code] || "erreur inconnue") + ").");
    v.onplaying = v.oncanplay = () => { stat.textContent = ""; };
    v.addEventListener("playing", () => { if (token === playToken) markSeen(); }, { once: true });
    v.onwaiting = () => { if (!v.paused) stat.textContent = "Mise en mémoire…"; };
    stat.textContent = "Chargement : " + (c.label || "flux") + "…";

    const isHls = c.type === "m3u8" || /\.m3u8(\?|$)/.test(c.url);
    if (isHls) {
      if (!window.Hls) { stat.textContent = "Chargement du lecteur HLS…"; await loadHls(); }
      if (token !== playToken) return;
      if (window.Hls && window.Hls.isSupported()) {
        hls = new window.Hls({
          // hls.js appelle xhrSetup avant xhr.open() : sans cette ouverture, setRequestHeader échoue
          // (état UNSENT) et les en-têtes du plugin (Referer, Origin…) ne partaient jamais.
          xhrSetup: (xhr, url) => {
            if (!xhr.readyState) xhr.open("GET", url, true);
            for (const [h, val] of Object.entries(c.headers)) { try { xhr.setRequestHeader(h, val); } catch (e) { /* en-tête refusé */ } }
          },
        });
        hls.on(window.Hls.Events.ERROR, (_, data) => { if (data.fatal) fail("Flux illisible (" + data.details + ")."); });
        hls.loadSource(c.url);
        hls.attachMedia(v);
      } else if (v.canPlayType("application/vnd.apple.mpegurl")) {
        v.src = c.url;
      } else {
        fail("Le lecteur HLS n'a pas pu se charger (connexion ?).");
        return;
      }
    } else {
      v.src = c.url;
    }
    for (const t of c.subtitles) {
      if (t && t.url) v.append(el("track", { kind: "subtitles", src: t.url, label: t.label || t.lang || "Sous-titres", srclang: t.lang || "fr" }));
    }
    v.play().catch((e) => { if (e && e.name === "NotAllowedError") stat.textContent = "Appuie sur lecture pour démarrer."; });
  }

  // ---------------------------------------------------------------- sources
  const langName = (code) => {
    if (!code) return "Autre langue";
    try { return new Intl.DisplayNames(["fr"], { type: "language" }).of(code); } catch (e) { return code; }
  };

  function viewSources() {
    const main = $("#main");
    const url = el("input", { type: "url", id: "srcurl", placeholder: "Lien d'une liste de sources (.json ou Google Drive)", "aria-label": "Lien" });
    const file = el("input", { type: "file", id: "srcfile", accept: ".json,application/json", hidden: true });
    const st = el("p", { class: "mut", role: "status" });
    const summary = el("p", { class: "mut" });
    const list = el("div", { id: "srclist" });
    const adult = el("input", { type: "checkbox", id: "adult" });
    adult.checked = adultOn;
    adult.onchange = () => {
      adultOn = adult.checked; store.set(ADULT, adultOn ? "1" : "0");
      if (adultOn && !moreLoaded) { st.textContent = "Chargement…"; loadMore().then(() => { st.textContent = ""; renderList(); }, fail); }
      renderList();
    };
    const more = el("button", { type: "button", onclick: () => {
      st.textContent = "Chargement des autres langues…";
      loadMore().then(() => { st.textContent = ""; more.hidden = true; renderList(); }, fail);
    } }, "Afficher les autres langues (anglais, espagnol…)");
    more.hidden = moreLoaded;

    const done = (r) => {
      const t = [];
      if (r.added.length) t.push("Ajouté : " + r.added.join(", ") + ".");
      if (r.bad.length) t.push("Refusé : " + r.bad.join(" ; ") + ".");
      st.textContent = t.join(" ");
      renderList();
    };
    const fail = (e) => { st.textContent = msg(e); };
    const setMany = (items, on) => { items.forEach((s) => { state[s.id] = on; }); saveState(); renderList(); };

    function renderList() {
      const all = allSources();
      const groups = new Map();
      for (const s of all) {
        const key = s.adult ? "~adult" : s.lang || "~other";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(s);
      }
      const order = (k) => (k === "fr" ? 0 : k === "en" ? 1 : k === "~adult" ? 9 : k === "~other" ? 8 : 5);
      const keys = [...groups.keys()].sort((x, y) => order(x) - order(y) || langName(x).localeCompare(langName(y), "fr"));
      summary.textContent = active().length + " source" + (active().length > 1 ? "s" : "") + " active" + (active().length > 1 ? "s" : "") + " sur " + all.length + ". Chaque source active est interrogée à chaque recherche.";
      list.replaceChildren(...keys.flatMap((k) => {
        const items = groups.get(k);
        return [
          el("div", { class: "grp-h" },
            el("h3", {}, k === "~adult" ? "Adulte (18+)" : k === "~other" ? "Autre langue" : langName(k)),
            el("span", { class: "mut" }, items.filter(isOn).length + "/" + items.length),
            el("button", { type: "button", onclick: () => setMany(items, true) }, "Tout activer"),
            el("button", { type: "button", onclick: () => setMany(items, false) }, "Tout désactiver")),
          el("ul", { class: "srcs" }, items.map((s) => {
            const box = el("input", { type: "checkbox", id: "on-" + s.id });
            box.checked = isOn(s);
            box.onchange = () => { state[s.id] = box.checked; saveState(); renderList(); };
            return el("li", {},
              el("label", { for: "on-" + s.id }, box, el("span", {}, s.name), el("small", {}, [s.version && "v" + s.version, s.group === "demo" && "exemple"].filter(Boolean).join(" · "))),
              s.group === "custom" ? el("button", { onclick: () => { custom = custom.filter((x) => x.id !== s.id); providers.delete(s.id); saveCustom(); renderList(); } }, "Retirer") : null);
          })),
        ];
      }));
    }

    main.replaceChildren(
      el("h2", {}, "Sources"),
      el("p", { class: "mut" }, "Une source est un plugin au format Weebox. Les sources FR, les extensions Anix et les sources adultes sont déjà intégrées : coche celles que tu veux utiliser. Ajouter une source par lien ou fichier exécute son code sur cet appareil : n'ajoute que des liens ou des fichiers de confiance."),
      el("form", { class: "row", onsubmit: (e) => {
        e.preventDefault();
        if (!url.value.trim()) return;
        st.textContent = "Téléchargement…";
        addFromUrl(url.value).then((r) => { url.value = ""; done(r); }, fail);
      } }, url, el("button", { class: "ac", type: "submit" }, "Ajouter")),
      el("div", { class: "row" }, el("button", { type: "button", onclick: () => file.click() }, "Depuis un fichier"), file, more),
      st,
      el("label", { class: "chk", for: "adult" }, adult, "Afficher les sources adultes (réservé aux personnes majeures, 18+)"),
      summary,
      list
    );
    file.onchange = async () => {
      const f = file.files[0];
      if (!f) return;
      try { done(addFromJson(JSON.parse(await f.text()))); } catch (e) { fail(e instanceof SyntaxError ? new Error("Ce fichier n'est pas un JSON valide.") : e); }
      file.value = "";
    };
    renderList();
  }

  // ---------------------------------------------------------------- fenêtres
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-close]");
    if (b) b.closest("dialog").close();
  });
  $("#player").addEventListener("close", () => { playToken++; stopVideo(); setCinema(false); paintEps(); });
  $("#pprev").addEventListener("click", () => session && session.index > 0 && playEpisode(session.index - 1));
  $("#pnext").addEventListener("click", () => session && session.index < session.entries[0].episodes.length - 1 && playEpisode(session.index + 1));

  if (adultOn) loadMore().catch(() => {});
  // Le lecteur HLS se charge en arrière-plan, sans bloquer l'affichage.
  setTimeout(() => { loadHls(); }, 1500);
  show("search");
})();
