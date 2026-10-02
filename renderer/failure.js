"use strict";
const params = new URLSearchParams(location.search);
const url = params.get("url") || "";
document.getElementById("url").textContent = url;
document.getElementById("error").textContent = params.get("error") || "";

document.getElementById("retry").addEventListener("click", () => window.goopterShell.retry());
document.getElementById("change").addEventListener("click", () => {
  const ok = window.confirm(
    "Change the store this till opens?\n\nThis signs out of " + (url || "the current store") + " and clears its saved data.",
  );
  if (ok) window.goopterShell.changeStore();
});
