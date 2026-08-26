const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("franklinStartup", {
  onState: (callback) => {
    if (typeof callback !== "function") return;
    ipcRenderer.on("franklin:startup-state", (_event, state) => callback(state));
  },
  retry: () => ipcRenderer.invoke("franklin:startup-retry"),
});
