const $ = (id) => document.getElementById(id);
const LANGS = [
  ["", "Auto (browser default)"],
  ["en-US", "English (US)"],
  ["en-GB", "English (UK)"],
  ["es-ES", "Spanish"],
  ["fr-FR", "French"],
  ["de-DE", "German"],
  ["pt-BR", "Portuguese (BR)"],
  ["it-IT", "Italian"],
  ["nl-NL", "Dutch"],
  ["hi-IN", "Hindi"],
  ["ar-SA", "Arabic"],
  ["am-ET", "Amharic"],
  ["zh-CN", "Chinese (Mandarin)"],
  ["ja-JP", "Japanese"],
  ["ko-KR", "Korean"],
  ["ru-RU", "Russian"],
];

const sel = $("lang");
for (const [v, t] of LANGS) {
  const o = document.createElement("option");
  o.value = v;
  o.textContent = t;
  sel.appendChild(o);
}

chrome.storage.local.get(["ageeApiKey", "ageeModel", "ageeLang"]).then(({ ageeApiKey, ageeModel, ageeLang }) => {
  if (ageeApiKey) $("key").value = ageeApiKey;
  $("model").value = ageeModel || "claude-opus-4-8";
  sel.value = ageeLang || "";
});

$("save").addEventListener("click", async () => {
  await chrome.storage.local.set({
    ageeApiKey: $("key").value.trim(),
    ageeModel: $("model").value.trim() || "claude-opus-4-8",
    ageeLang: sel.value,
  });
  $("status").textContent = "Saved ✓";
  setTimeout(() => ($("status").textContent = ""), 1500);
});
