// Injecté par electron/main.js tout en haut de la page, avant les scripts de Riochi.
// Remplace fetch() et XMLHttpRequest pour les adresses externes : elles passent par le pont HTTP natif
// (voir http-bridge.js) au lieu du réseau du navigateur. Résultat : pas de CORS, et les en-têtes
// Referer / Origin / User-Agent demandés par les plugins de sources sont bien envoyés.
// C'est l'équivalent, côté Windows, de CapacitorHttp côté Android (app.js l'attend dans les deux cas).
(() => {
  "use strict";
  const bridge = window.__riochiNative;
  if (!bridge || window.__riochiPatched) return;
  window.__riochiPatched = true;

  const origFetch = window.fetch.bind(window);
  let seq = 0;

  const isExternal = (href) => {
    try {
      const u = new URL(href, location.href);
      return (u.protocol === "http:" || u.protocol === "https:") && u.origin !== location.origin;
    } catch (e) { return false; }
  };

  const pairs = (h) => {
    if (!h) return [];
    if (typeof Headers !== "undefined" && h instanceof Headers) return Array.from(h.entries());
    if (Array.isArray(h)) return h.map(([k, v]) => [String(k), String(v)]);
    return Object.entries(h).map(([k, v]) => [k, String(v)]);
  };

  // Concatène les en-têtes d'une Request puis ceux de init ; ces derniers remplacent les premiers.
  const mergeHeaders = (base, extra) => {
    const over = new Set(extra.map(([k]) => k.toLowerCase()));
    return base.filter(([k]) => !over.has(k.toLowerCase())).concat(extra);
  };
  const hasHeader = (list, name) => list.some(([k]) => k.toLowerCase() === name);

  const toBytes = async (body) => {
    const tmp = new Response(body);
    return { bytes: new Uint8Array(await tmp.arrayBuffer()), type: tmp.headers.get("content-type") };
  };

  // Transport local (même origine, blob:, data:…) : on laisse le vrai fetch s'en occuper.
  // Même contrat que bridge.request : renvoie { error, message } au lieu de lever une exception.
  async function localRequest(r) {
    const ctl = new AbortController();
    let timedOut = false;
    const timer = r.timeout > 0 ? setTimeout(() => { timedOut = true; ctl.abort(); }, r.timeout) : null;
    try {
      const res = await origFetch(r.url, { method: r.method, headers: r.headers, body: r.body, signal: ctl.signal });
      return { status: res.status, statusText: res.statusText, url: res.url, headers: Array.from(res.headers.entries()), body: new Uint8Array(await res.arrayBuffer()) };
    } catch (e) {
      return timedOut ? { error: "timeout", message: "timeout" } : { error: "network", message: (e && e.message) || "Failed to fetch" };
    } finally { if (timer) clearTimeout(timer); }
  }

  // Appel du pont ; une panne du pont lui-même (IPC) compte comme une erreur réseau.
  const transport = async (req) => {
    try { return await (isExternal(req.url) ? bridge.request(req) : localRequest(req)); }
    catch (e) { return { error: "network", message: (e && e.message) || "Failed to fetch" }; }
  };

  // ------------------------------------------------------------------ fetch
  window.fetch = async function fetch(input, init) {
    const isReq = typeof Request !== "undefined" && input instanceof Request;
    const url = isReq ? input.url : String(input instanceof URL ? input.href : input);
    if (!isExternal(url)) return origFetch(input, init);

    init = init || {};
    const method = String(init.method || (isReq ? input.method : "GET")).toUpperCase();
    const signal = init.signal || (isReq ? input.signal : null);
    const abortError = () => new DOMException("The operation was aborted.", "AbortError");
    if (signal && signal.aborted) throw abortError();

    let headers = mergeHeaders(isReq ? pairs(input.headers) : [], pairs(init.headers));
    let body = null;
    if (method !== "GET" && method !== "HEAD") {
      const raw = init.body !== undefined ? init.body : isReq ? await input.clone().arrayBuffer() : null;
      if (raw != null) {
        const b = await toBytes(raw);
        body = b.bytes;
        if (b.type && !hasHeader(headers, "content-type")) headers = headers.concat([["content-type", b.type]]);
      }
    }

    const id = "f" + ++seq;
    const onAbort = () => bridge.abort(id);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    const r = await transport({ id, url, method, headers, body, redirect: init.redirect || (isReq ? input.redirect : "follow") });
    if (signal) signal.removeEventListener("abort", onAbort);
    if (r.error) {
      if (r.error === "abort" || (signal && signal.aborted)) throw abortError();
      throw new TypeError(r.message || "Failed to fetch");
    }

    const noBody = method === "HEAD" || r.status === 101 || r.status === 204 || r.status === 205 || r.status === 304;
    const res = new Response(noBody ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
    Object.defineProperty(res, "url", { value: r.url });
    Object.defineProperty(res, "redirected", { value: r.url !== url });
    return res;
  };

  // ------------------------------------------------------------------ XMLHttpRequest
  // Version asynchrone, suffisante pour les plugins et pour hls.js (segments en arraybuffer).
  const EVENTS = ["readystatechange", "loadstart", "progress", "load", "error", "abort", "timeout", "loadend"];

  class NativeXHR extends EventTarget {
    constructor() {
      super();
      this.readyState = 0;
      this.status = 0;
      this.statusText = "";
      this.responseURL = "";
      this.responseType = "";
      this.timeout = 0;
      this.withCredentials = false;
      this.upload = new EventTarget();
      for (const n of EVENTS) this["on" + n] = null;
      this._headers = [];
      this._respHeaders = [];
      this._bytes = null;
      this._sent = false;
      this._done = false;
    }

    _emit(type, loaded, total) {
      const ev = /^(loadstart|progress|load|error|abort|timeout|loadend)$/.test(type)
        ? new ProgressEvent(type, { lengthComputable: total > 0, loaded: loaded || 0, total: total || 0 })
        : new Event(type);
      const h = this["on" + type];
      if (typeof h === "function") { try { h.call(this, ev); } catch (e) { setTimeout(() => { throw e; }); } }
      this.dispatchEvent(ev);
    }
    _state(n) { this.readyState = n; this._emit("readystatechange"); }

    open(method, url, async) {
      if (async === false) throw new DOMException("Les requêtes synchrones ne sont pas prises en charge.", "InvalidAccessError");
      this._method = String(method).toUpperCase();
      this._url = new URL(url, location.href).href;
      this._headers = [];
      this._sent = false;
      this._done = false;
      this._bytes = null;
      this._text = undefined;
      this.status = 0;
      this.statusText = "";
      this._state(1);
    }

    setRequestHeader(name, value) {
      if (this.readyState !== 1 || this._sent) throw new DOMException("setRequestHeader exige l'état OPENED.", "InvalidStateError");
      this._headers.push([String(name), String(value)]);
    }

    overrideMimeType() {}

    send(body) {
      if (this.readyState !== 1 || this._sent) throw new DOMException("send exige l'état OPENED.", "InvalidStateError");
      this._sent = true;
      this._id = "x" + ++seq;
      this._emit("loadstart", 0, 0);
      this._run(body == null ? null : body).catch(() => this._fail("error"));
    }

    async _run(body) {
      let headers = this._headers;
      let bytes = null;
      if (body != null && this._method !== "GET" && this._method !== "HEAD") {
        const b = await toBytes(typeof Document !== "undefined" && body instanceof Document ? new XMLSerializer().serializeToString(body) : body);
        bytes = b.bytes;
        if (b.type && !hasHeader(headers, "content-type")) headers = headers.concat([["content-type", b.type]]);
      }
      const req = { id: this._id, url: this._url, method: this._method, headers, body: bytes, timeout: this.timeout, redirect: "follow" };
      const r = await transport(req);
      if (this._done) return;
      if (r.error) return this._fail(r.error === "timeout" ? "timeout" : "error");
      this.status = r.status;
      this.statusText = r.statusText || "";
      this.responseURL = r.url || this._url;
      this._respHeaders = r.headers || [];
      this._bytes = r.body || new Uint8Array(0);
      this._state(2);
      this._state(3);
      this._emit("progress", this._bytes.byteLength, this._bytes.byteLength);
      this._done = true;
      this._state(4);
      this._emit("load", this._bytes.byteLength, this._bytes.byteLength);
      this._emit("loadend", this._bytes.byteLength, this._bytes.byteLength);
    }

    _fail(type) {
      if (this._done) return;
      this._done = true;
      this.status = 0;
      this._state(4);
      this._emit(type, 0, 0);
      this._emit("loadend", 0, 0);
    }

    abort() {
      if (this._sent && !this._done) {
        this._done = true;
        bridge.abort(this._id);
        this.status = 0;
        this._state(4);
        this._emit("abort", 0, 0);
        this._emit("loadend", 0, 0);
      }
      this.readyState = 0;
    }

    getResponseHeader(name) {
      if (this.readyState < 2) return null;
      const n = String(name).toLowerCase();
      const v = this._respHeaders.filter(([k]) => k.toLowerCase() === n).map(([, val]) => val);
      return v.length ? v.join(", ") : null;
    }
    getAllResponseHeaders() {
      if (this.readyState < 2) return "";
      return this._respHeaders.map(([k, v]) => k.toLowerCase() + ": " + v + "\r\n").join("");
    }

    get responseText() {
      if (this.responseType !== "" && this.responseType !== "text") throw new DOMException("responseText n'est lisible qu'avec responseType vide ou « text ».", "InvalidStateError");
      if (this.readyState !== 4 || !this._bytes) return "";
      if (this._text === undefined) {
        const m = /charset=([^;\s]+)/i.exec(this.getResponseHeader("content-type") || "");
        let dec;
        try { dec = new TextDecoder(m ? m[1].replace(/["']/g, "") : "utf-8"); } catch (e) { dec = new TextDecoder("utf-8"); }
        this._text = dec.decode(this._bytes);
      }
      return this._text;
    }

    get response() {
      const t = this.responseType;
      if (this.readyState !== 4 || !this._bytes) return t === "" || t === "text" ? "" : null;
      if (t === "arraybuffer") {
        if (!this._ab) this._ab = this._bytes.buffer.slice(this._bytes.byteOffset, this._bytes.byteOffset + this._bytes.byteLength);
        return this._ab;
      }
      if (t === "blob") return new Blob([this._bytes], { type: this.getResponseHeader("content-type") || "" });
      if (t === "json") { try { return JSON.parse(new TextDecoder().decode(this._bytes)); } catch (e) { return null; } }
      if (t === "document") return null;
      return this.responseText;
    }
  }
  for (const [name, n] of [["UNSENT", 0], ["OPENED", 1], ["HEADERS_RECEIVED", 2], ["LOADING", 3], ["DONE", 4]]) {
    NativeXHR[name] = n;
    NativeXHR.prototype[name] = n;
  }
  window.XMLHttpRequest = NativeXHR;
})();
