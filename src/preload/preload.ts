import { contextBridge, ipcRenderer } from "electron";

/**
 * Runs before the page's own scripts in every main-frame document of every window.
 *
 * It asks the main process what this frame is, so the decision is made from the URL Chromium
 * reports and by the same code that checks every print call. The preload is sandboxed and imports
 * nothing of its own, so it holds no policy that could drift from the main process.
 *
 * - An allowlisted POS page gets `window.GoopterPOS`, the same shape the iOS and Android apps give
 *   it (SPEC §3.1). No `window.goopterPrinter`: this app has no Bluetooth.
 * - The app's own screens get `window.goopterShell`.
 * - Anything else gets nothing.
 */
type Role =
  | { role: "pos"; version: string; protocolVersions: number[] }
  | { role: "shell" }
  | { role: null };

type PrintReply = { response: unknown } | { error: string };

const role = ipcRenderer.sendSync("goopter:frame-role") as Role;

if (role.role === "pos") {
  // contextBridge copies this object into the page as a frozen, read-only, non-configurable
  // property: a page that can be persuaded to replace GoopterPOS could send prints elsewhere.
  contextBridge.exposeInMainWorld("GoopterPOS", {
    version: role.version,
    protocolVersions: role.protocolVersions,
    // Resolves for every outcome the store can act on, rejects only when the call is malformed
    // (SPEC §3.3). The main process re-checks the calling frame's origin.
    print: async (envelope: unknown) => {
      const reply = (await ipcRenderer.invoke("goopter:print", envelope)) as PrintReply;
      if ("error" in reply) throw new Error(reply.error);
      return reply.response;
    },
  });
} else if (role.role === "shell") {
  contextBridge.exposeInMainWorld("goopterShell", {
    submitStore: (raw: unknown) => ipcRenderer.invoke("shell:submit-store", String(raw)),
    retry: () => ipcRenderer.invoke("shell:retry"),
    changeStore: () => ipcRenderer.invoke("shell:change-store"),
    home: () => ipcRenderer.invoke("shell:home"),
    readLog: () => ipcRenderer.invoke("shell:read-log"),
    closeLog: () => ipcRenderer.invoke("shell:close-log"),
    logPath: () => ipcRenderer.invoke("shell:log-path"),
    setLogMenuOpen: (open: unknown) => ipcRenderer.invoke("shell:log-menu", open === true),
    getKiosk: () => ipcRenderer.invoke("shell:get-kiosk"),
    // Passed through as given: the main process refuses anything but a boolean.
    setKiosk: (value: unknown) => ipcRenderer.invoke("shell:set-kiosk", value),
  });
}
