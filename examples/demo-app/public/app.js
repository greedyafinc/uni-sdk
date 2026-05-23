// Frontend for demo-app. Talks to the local Bun server over JSON.

const log = document.getElementById("log");
const modelsList = document.getElementById("models");

// Selected model used by the LLM action buttons.
const state = {
  selected: { id: "auto", logo: null, color: null, owned_by: "" },
  models: [],
  streamCtl: null,
};

async function runStream(path, label) {
  if (state.streamCtl) state.streamCtl.abort();
  modelsList.innerHTML = "";
  log.textContent = `[${label}] streaming with ${state.selected.id}…\n`;
  const ctl = new AbortController();
  state.streamCtl = ctl;
  let r;
  try {
    r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: state.selected.id }),
      signal: ctl.signal,
    });
  } catch (e) {
    log.textContent += `\nfetch failed: ${e?.message ?? e}`;
    state.streamCtl = null;
    return;
  }
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf("\n\n");
      while (sep !== -1) {
        const frame = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        const lines = frame.split("\n");
        let evt;
        let data = "";
        for (const l of lines) {
          if (l.startsWith("event:")) evt = l.slice(6).trim();
          else if (l.startsWith("data:")) data += l.slice(5).trimStart();
        }
        if (evt === "done") {
          log.textContent += "\n[done]";
        } else if (evt === "error") {
          log.textContent += `\n[error] ${data}`;
        } else if (data) {
          try {
            log.textContent += JSON.parse(data);
          } catch {
            log.textContent += data;
          }
        }
        sep = buf.indexOf("\n\n");
      }
    }
  } catch (e) {
    if (e?.name !== "AbortError") log.textContent += `\nstream error: ${e?.message ?? e}`;
  } finally {
    state.streamCtl = null;
  }
}

function setLog(text) {
  log.textContent = text;
}

function appendLog(lines) {
  if (lines?.length) log.textContent = lines.join("\n");
}

async function postJson(path, body) {
  const r = await fetch(path, {
    method: "POST",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return r.json();
}

// ─── Custom dropdown ───────────────────────────────────────────────────────────

const ddButton = document.getElementById("dd-button");
const ddMenu = document.getElementById("dd-menu");
const ddLabel = document.getElementById("dd-label");
const ddLogo = document.getElementById("dd-logo");

function setSelected(option) {
  state.selected = option;
  ddLabel.textContent = option.id;
  if (option.logo) {
    ddLogo.src = option.logo;
    ddLogo.alt = option.owned_by ?? "";
    ddLogo.hidden = false;
  } else {
    ddLogo.hidden = true;
    ddLogo.removeAttribute("src");
  }
  closeMenu();
}

function openMenu() {
  ddMenu.hidden = false;
  ddButton.setAttribute("aria-expanded", "true");
}

function closeMenu() {
  ddMenu.hidden = true;
  ddButton.setAttribute("aria-expanded", "false");
}

ddButton.addEventListener("click", (e) => {
  e.stopPropagation();
  if (ddMenu.hidden) openMenu();
  else closeMenu();
});

document.addEventListener("click", (e) => {
  if (!ddMenu.contains(e.target) && !ddButton.contains(e.target)) closeMenu();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});

function renderMenu(models) {
  ddMenu.innerHTML = "";
  for (const m of models) {
    const li = document.createElement("li");
    li.setAttribute("role", "option");
    li.className = "dd-item";
    if (m.id === state.selected.id) li.classList.add("dd-item-selected");
    if (m.color) li.style.setProperty("--logo-bg", `${m.color}22`);

    if (m.logo) {
      const img = document.createElement("img");
      img.className = "dd-item-logo";
      img.src = m.logo;
      img.alt = m.owned_by ?? "";
      li.appendChild(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "dd-item-logo dd-item-logo-empty";
      ph.textContent = "✨";
      li.appendChild(ph);
    }

    const id = document.createElement("span");
    id.className = "dd-item-id";
    id.textContent = m.id;
    li.appendChild(id);

    if (m.owned_by) {
      const meta = document.createElement("span");
      meta.className = "dd-item-meta";
      meta.textContent = m.owned_by;
      li.appendChild(meta);
    }

    li.addEventListener("click", () => setSelected(m));
    ddMenu.appendChild(li);
  }
}

// ─── Action handlers ───────────────────────────────────────────────────────────

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
    const data = await postJson("/chat-completion", { model: state.selected.id });
    appendLog(data.log);
  },

  response: async () => {
    setLog("");
    modelsList.innerHTML = "";
    const data = await postJson("/response", { model: state.selected.id });
    appendLog(data.log);
  },

  message: async () => {
    setLog("");
    modelsList.innerHTML = "";
    const data = await postJson("/message", { model: state.selected.id });
    appendLog(data.log);
  },

  "chat-stream": () => runStream("/chat-stream", "chat.completions"),
  "response-stream": () => runStream("/response-stream", "responses"),
  "message-stream": () => runStream("/message-stream", "messages"),

  "abort-stream": () => {
    if (state.streamCtl) {
      state.streamCtl.abort();
      log.textContent += "\n[aborted by user]";
    }
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

// ─── Boot ──────────────────────────────────────────────────────────────────────

async function loadModelsForDropdown() {
  try {
    const data = await postJson("/list-models");
    const fromServer = (data.models ?? []).filter((m) => m.type === "text");
    // Issue acceptance requires `model: "auto"` to be exercisable. The server
    // usually surfaces it, but guarantee its presence here so the demo always
    // can route via auto regardless of upstream catalog drift.
    const hasAuto = fromServer.some((m) => m.id === "auto");
    state.models = hasAuto
      ? fromServer
      : [{ id: "auto", logo: null, color: null, owned_by: "" }, ...fromServer];
    renderMenu(state.models);
    const auto = state.models.find((m) => m.id === "auto") ?? state.models[0];
    if (auto) setSelected(auto);
  } catch (err) {
    ddLabel.textContent = `failed: ${err?.message ?? err}`;
  }
}

async function init() {
  const me = await (await fetch("/me")).json();
  document.getElementById("avatar").textContent = (me.user_id.trim()[0] ?? "?").toUpperCase();
  document.getElementById("user-id").textContent = me.user_id;
  document.getElementById("client-id").textContent = `client: ${me.client_id}`;
  document.getElementById("signed-in").hidden = false;
  await loadModelsForDropdown();
}

init().catch((e) => setLog(`init error: ${e?.message ?? e}`));
