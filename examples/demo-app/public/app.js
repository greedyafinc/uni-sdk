// Frontend for demo-app. Talks to the local Bun server over JSON.

const log = document.getElementById("log");
const modelsList = document.getElementById("models");

function setLog(text) {
  log.textContent = text;
}

function appendLog(lines) {
  if (lines?.length) log.textContent = lines.join("\n");
}

async function postJson(path) {
  const r = await fetch(path, { method: "POST" });
  return r.json();
}

const handlers = {
  "list-models": async () => {
    setLog("");
    modelsList.innerHTML = "";
    const data = await postJson("/list-models");
    for (const m of data.models ?? []) {
      const li = document.createElement("li");
      if (m.color) li.style.setProperty("--logo-bg", `${m.color}22`);

      const img = document.createElement("img");
      img.className = "logo";
      img.src = m.logo;
      img.alt = m.owned_by;

      const id = document.createElement("span");
      id.className = "id";
      id.textContent = m.id;

      const meta = document.createElement("span");
      meta.className = "row-meta";
      meta.textContent = `${m.type} · ${m.owned_by}`;

      li.append(img, id, meta);
      modelsList.appendChild(li);
    }
    appendLog(data.log);
  },

  "get-usage": async () => {
    setLog("");
    modelsList.innerHTML = "";
    const data = await postJson("/usage");
    appendLog(data.log);
  },

  "chat-completion": async () => {
    setLog("");
    modelsList.innerHTML = "";
    const data = await postJson("/chat-completion");
    appendLog(data.log);
  },

  response: async () => {
    setLog("");
    modelsList.innerHTML = "";
    const data = await postJson("/response");
    appendLog(data.log);
  },

  message: async () => {
    setLog("");
    modelsList.innerHTML = "";
    const data = await postJson("/message");
    appendLog(data.log);
  },

  "test-refresh": async () => {
    setLog("");
    const data = await postJson("/test-refresh");
    appendLog(data.log);
  },

  signout: async () => {
    try {
      await postJson("/signout");
    } catch {}
    document.getElementById("signed-in").hidden = true;
    document.getElementById("farewell").hidden = false;
  },
};

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const fn = handlers[action];
  if (!fn) return;
  btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    setLog(`error: ${err?.message ?? err}`);
  } finally {
    btn.disabled = false;
  }
});

async function init() {
  const me = await (await fetch("/me")).json();
  document.getElementById("avatar").textContent = (me.user_id.trim()[0] ?? "?").toUpperCase();
  document.getElementById("user-id").textContent = me.user_id;
  document.getElementById("client-id").textContent = `client: ${me.client_id}`;
  document.getElementById("signed-in").hidden = false;
}

init().catch((e) => setLog(`init error: ${e?.message ?? e}`));
