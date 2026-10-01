"use strict";
const form = document.getElementById("form");
const input = document.getElementById("store");
const error = document.getElementById("error");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  error.textContent = "";
  const result = await window.goopterShell.submitStore(input.value);
  if (result && result.error) error.textContent = result.error;
});
