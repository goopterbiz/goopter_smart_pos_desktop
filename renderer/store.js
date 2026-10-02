"use strict";
const form = document.getElementById("form");
const input = document.getElementById("store");
const address = document.getElementById("address");
const error = document.getElementById("error");

// The input's width follows what's typed, or the placeholder when empty, so the address reads as
// one continuous URL (C7).
function resize() {
  const length = input.value.length || input.placeholder.length;
  input.size = Math.min(63, Math.max(4, length));
}

input.addEventListener("input", () => {
  address.classList.remove("invalid");
  resize();
});

resize();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  const result = await window.goopterShell.submitStore(input.value);
  if (result && result.error) {
    error.textContent = result.error;
    address.classList.add("invalid");
  }
});
