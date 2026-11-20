"use strict";
// Requêtes HTTP « natives » pour la fenêtre Riochi.
// Les plugins de sources envoient des en-têtes que Chromium interdit (Referer, Origin…)
// et appellent des sites sans CORS. Sous Android, CapacitorHttp s'en charge ; ici c'est ce module,
// exécuté dans le processus principal d'Electron (pas de CORS, en-têtes libres).
// request() ne lève jamais d'exception : en cas d'échec elle renvoie { error: "timeout"|"abort"|"network", message }.

const controllers = new Map();
const DROP_RESPONSE_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "connection"]);

async function request(req, doFetch = fetch) {
  const { id, url, method = "GET", headers = [], body = null, timeout = 0, redirect = "follow" } = req || {};

  let u;
  try { u = new URL(url); } catch (e) { return { error: "network", message: "URL invalide : " + url }; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "network", message: "Protocole non pris en charge : " + u.protocol };

  const ctl = new AbortController();
  if (id != null) controllers.set(id, ctl);
  let timedOut = false;
  const timer = timeout > 0 ? setTimeout(() => { timedOut = true; ctl.abort(); }, timeout) : null;

  try {
    const h = new Headers();
    for (const [k, v] of headers) h.append(k, v);
    const verb = String(method).toUpperCase();
    const hasBody = body != null && verb !== "GET" && verb !== "HEAD";
    const res = await doFetch(u.href, {
      method: verb,
      headers: h,
      body: hasBody ? Buffer.from(body) : undefined,
      redirect,
      signal: ctl.signal,
    });
    const out = [];
    res.headers.forEach((v, k) => { if (!DROP_RESPONSE_HEADERS.has(k.toLowerCase())) out.push([k, v]); });
    const data = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, statusText: res.statusText, url: res.url || u.href, headers: out, body: data };
  } catch (e) {
    if (timedOut) return { error: "timeout", message: "timeout" };
    if (ctl.signal.aborted) return { error: "abort", message: "aborted" };
    const why = (e && e.cause && (e.cause.code || e.cause.message)) || (e && e.message) || String(e);
    return { error: "network", message: "Failed to fetch (" + why + ")" };
  } finally {
    if (timer) clearTimeout(timer);
    if (id != null) controllers.delete(id);
  }
}

function abort(id) {
  const c = controllers.get(id);
  if (c) c.abort();
}

module.exports = { request, abort };
