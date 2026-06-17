const keyEl = document.getElementById("key");
const modelEl = document.getElementById("model");
const statusEl = document.getElementById("status");

chrome.storage.local.get(["ageeApiKey", "ageeModel"]).then(({ ageeApiKey, ageeModel }) => {
  if (ageeApiKey) keyEl.value = ageeApiKey;
  modelEl.value = ageeModel || "claude-opus-4-8";
});

document.getElementById("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    ageeApiKey: keyEl.value.trim(),
    ageeModel: modelEl.value.trim() || "claude-opus-4-8",
  });
  statusEl.textContent = "Saved ✓";
  setTimeout(() => (statusEl.textContent = ""), 1500);
});
