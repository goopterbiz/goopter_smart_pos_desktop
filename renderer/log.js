"use strict";
// Read-only on purpose (SPEC §11.1): every control that could sit next to a log is a way to change
// the system while trying to describe it. Home, Change store and Window mode (C6) are the exceptions,
// and they sit in the ⋯ menu, away from the log itself.
const body = document.getElementById("entries");
const more = document.getElementById("more");
const menu = document.getElementById("menu");
const kioskItem = document.getElementById("mode-kiosk");
const windowItem = document.getElementById("mode-window");

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

// The tick follows aria-checked (style.css).
function showMode(kiosk) {
  kioskItem.setAttribute("aria-checked", String(kiosk === true));
  windowItem.setAttribute("aria-checked", String(kiosk === false));
}

async function openMenu() {
  menu.hidden = false;
  more.classList.add("open");
  more.setAttribute("aria-expanded", "true");
  // The main process lets Esc through to this page only while the menu is open.
  window.goopterShell.setLogMenuOpen(true);
  showMode(await window.goopterShell.getKiosk());
}

function closeMenu() {
  if (menu.hidden) return;
  menu.hidden = true;
  more.classList.remove("open");
  more.setAttribute("aria-expanded", "false");
  window.goopterShell.setLogMenuOpen(false);
}

async function chooseMode(kiosk) {
  closeMenu();
  try {
    await window.goopterShell.setKiosk(kiosk);
    showMode(kiosk);
  } catch {
    showMode(await window.goopterShell.getKiosk());
  }
}

more.addEventListener("click", () => (menu.hidden ? openMenu() : closeMenu()));
document.addEventListener("click", (event) => {
  if (!more.parentElement.contains(event.target)) closeMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !menu.hidden) {
    event.preventDefault();
    closeMenu();
    more.focus();
  }
});
document.getElementById("home").addEventListener("click", () => {
  closeMenu();
  window.goopterShell.home();
});
document.getElementById("change").addEventListener("click", () => {
  closeMenu();
  if (window.confirm("Change the store this till opens?\n\nThis signs out of the current store and clears its saved data.")) {
    window.goopterShell.changeStore();
  }
});
kioskItem.addEventListener("click", () => chooseMode(true));
windowItem.addEventListener("click", () => chooseMode(false));

window.goopterShell.logPath().then((where) => {
  document.getElementById("where").textContent = where;
});
render();
