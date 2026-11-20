"use strict";
const { contextBridge, ipcRenderer } = require("electron");

// Seule porte d'entrée du rendu vers le système : des requêtes HTTP(S), rien d'autre.
contextBridge.exposeInMainWorld("__riochiNative", {
  request: (req) => ipcRenderer.invoke("riochi:http", req),
  abort: (id) => ipcRenderer.send("riochi:abort", id),
});
