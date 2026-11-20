// Source d'exemple de Riochi : un plugin au même format que ceux de Weebox
// (classe Provider avec getSettings, search, findEpisodes, findEpisodeServer).
// Les titres sont inventés. Les deux flux sont des vidéos de test publiques
// (Big Buck Bunny), pas du vrai contenu. Elle sert à vérifier que le chargeur de plugins marche.

class DemoProvider {
  constructor() {
    this.catalog = [
      { id: "lanternes", title: "Les Lanternes d'Aube", episodes: 4, description: "Exemple : une apprentie allumeuse de lanternes veille sur une ville qui ne dort jamais." },
      { id: "vent", title: "Cartographe du Vent", episodes: 3, description: "Exemple : un cartographe dessine les routes que seul le vent connaît." },
      { id: "marees", title: "Atelier des Marées", episodes: 5, description: "Exemple : dans un port lointain, un atelier répare les horloges de la mer." },
    ];
    this.hls = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
    this.mp4 = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
  }

  getSettings() {
    return { episodeServers: ["default"], supportsDub: false };
  }

  async search(opts) {
    const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const q = norm(opts && opts.query);
    return this.catalog
      .filter((a) => norm(a.title).indexOf(q) >= 0)
      .map((a) => ({ id: a.id, title: a.title, description: a.description, url: "demo://" + a.id }));
  }

  async findEpisodes(id) {
    const anime = this.catalog.find((a) => a.id === id);
    if (!anime) throw new Error("anime inconnu : " + id);
    const out = [];
    for (let n = 1; n <= anime.episodes; n += 1) {
      out.push({ id: id + "/" + n, number: n, title: "Épisode " + n, url: "demo://" + id + "/" + n });
    }
    return out;
  }

  async findEpisodeServer(episode, server) {
    return {
      server: "Démo",
      headers: {},
      videoSources: [
        { url: this.hls, type: "m3u8", quality: "HLS", label: "Démo", subtitles: [] },
        { url: this.mp4, type: "mp4", quality: "MP4", label: "Démo", subtitles: [] },
      ],
    };
  }
}

window.RIOCHI_DEMO = {
  id: "demo-riochi",
  name: "Démo Riochi",
  version: "1.0.0",
  type: "onlinestream-provider",
  language: "javascript",
  lang: "fr",
  languages: { sub: ["fr"], dub: [] },
  description: "Source d'exemple : trois titres inventés et une vidéo de test.",
  author: "Riochi",
  payload: String(DemoProvider).replace("class DemoProvider", "class Provider"),
};
