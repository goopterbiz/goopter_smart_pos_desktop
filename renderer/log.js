"use strict";
// Read-only on purpose (SPEC §11.1): every control that could sit next to a log is a way to change
// the system while trying to describe it. Home and Change store are the two exceptions.
const body = document.getElementById("entries");

async function render() {
  const entries = await window.goopterShell.readLog();
  body.replaceChildren();
  if (entries.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 7;
    cell.textContent = "The log is empty. A launched entry should be here: an empty log means the log itself is broken.";
    return;
  }
  for (const e of entries) {
    const row = body.insertRow();
    const values = [
      new Date(e.timestamp).toLocaleString(), e.event, e.origin, e.target ?? "",
      e.bytes ?? "", e.durationMs ?? "", e.outcome,
    ];
    values.forEach((value, index) => {
      const cell = row.insertCell();
      cell.textContent = String(value);
      if (index === 6) cell.className = "outcome";
    });
  }
}

document.getElementById("refresh").addEventListener("click", render);
document.getElementById("done").addEventListener("click", () => window.goopterShell.closeLog());
document.getElementById("home").addEventListener("click", () => window.goopterShell.home());
document.getElementById("change").addEventListener("click", () => {
  if (window.confirm("Change the store this till opens?\n\nThis signs out of the current store and clears its saved data.")) {
    window.goopterShell.changeStore();
  }
});
render();
