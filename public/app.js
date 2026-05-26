const elements = {
  curlInput: document.querySelector("#curlInput"),
  parseButton: document.querySelector("#parseButton"),
  toggleCurlButton: document.querySelector("#toggleCurlButton"),
  clearAllButton: document.querySelector("#clearAllButton"),
  methodSelect: document.querySelector("#methodSelect"),
  urlInput: document.querySelector("#urlInput"),
  copyCurlButton: document.querySelector("#copyCurlButton"),
  sendButton: document.querySelector("#sendButton"),
  ignoreTlsInput: document.querySelector("#ignoreTlsInput"),
  tokenState: document.querySelector("#tokenState"),
  addHeaderButton: document.querySelector("#addHeaderButton"),
  headersTable: document.querySelector("#headersTable"),
  bodyInput: document.querySelector("#bodyInput"),
  formatBodyButton: document.querySelector("#formatBodyButton"),
  responseStatus: document.querySelector("#responseStatus"),
  responseTime: document.querySelector("#responseTime"),
  responseSize: document.querySelector("#responseSize"),
  responseSummary: document.querySelector("#responseSummary"),
  responseOutput: document.querySelector("#responseOutput"),
  responseSearchInput: document.querySelector("#responseSearchInput"),
  toggleWrapButton: document.querySelector("#toggleWrapButton"),
  copyResponseButton: document.querySelector("#copyResponseButton"),
  downloadResponseButton: document.querySelector("#downloadResponseButton"),
  addParamButton: document.querySelector("#addParamButton"),
  paramsTable: document.querySelector("#paramsTable"),
  clearHistoryButton: document.querySelector("#clearHistoryButton"),
  historyList: document.querySelector("#historyList"),
  bodyState: document.querySelector("#bodyState"),
  minifyBodyButton: document.querySelector("#minifyBodyButton"),
  expectedStatusInput: document.querySelector("#expectedStatusInput"),
  containsInput: document.querySelector("#containsInput"),
  jsonPathInput: document.querySelector("#jsonPathInput"),
  runChecksButton: document.querySelector("#runChecksButton"),
  checksResult: document.querySelector("#checksResult"),
  tabs: document.querySelectorAll("[data-response-tab]"),
  leftPanel: document.querySelector(".left-panel"),
  curlPanel: document.querySelector(".curl-panel")
};

const state = {
  params: [],
  headers: [],
  response: null,
  responseTab: "json",
  responseText: "Ready.",
  curlExpanded: false,
  responseWrap: false,
  history: JSON.parse(localStorage.getItem("mini-postman-history") || "[]")
};

function createParam(name = "", value = "", enabled = true) {
  return {
    id: crypto.randomUUID(),
    name,
    value,
    enabled
  };
}

function createHeader(name = "", value = "", enabled = true) {
  return {
    id: crypto.randomUUID(),
    name,
    value,
    enabled
  };
}

function normalizeCurl(input) {
  return input.replace(/\r/g, "").replace(/\\\n\s*/g, " ").trim();
}

function latestCurlCommand(input) {
  const matches = [...String(input || "").matchAll(/(?:^|\n)\s*curl\s+/gi)];
  if (!matches.length) return input;
  return input.slice(matches[matches.length - 1].index).trim();
}

function tokenizeCommand(input) {
  const tokens = [];
  let current = "";
  let quote = null;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function parseHeaderLine(line) {
  const separatorIndex = line.indexOf(":");
  if (separatorIndex === -1) return null;
  const name = line.slice(0, separatorIndex).trim();
  const value = line.slice(separatorIndex + 1).trim();
  if (!name) return null;
  return { name, value };
}

function extractBearerToken(value) {
  const match = String(value || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function flagValue(tokens, index, flag) {
  if (tokens[index] === flag) return { value: tokens[index + 1], skip: 1 };
  if (tokens[index].startsWith(`${flag}=`)) return { value: tokens[index].slice(flag.length + 1), skip: 0 };
  return null;
}

function parseCurl(input) {
  const tokens = tokenizeCommand(normalizeCurl(latestCurlCommand(input)));
  const result = {
    method: "",
    url: "",
    headers: [],
    bodyParts: [],
    token: ""
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (index === 0 && token.toLowerCase() === "curl") continue;

    const headerValue = flagValue(tokens, index, "-H") || flagValue(tokens, index, "--header");
    if (headerValue) {
      const header = parseHeaderLine(headerValue.value || "");
      if (header) {
        const bearerToken = header.name.toLowerCase() === "authorization" ? extractBearerToken(header.value) : "";
        if (bearerToken) result.token = bearerToken;
        if (!bearerToken) result.headers.push(createHeader(header.name, header.value, true));
      }
      index += headerValue.skip;
      continue;
    }

    const requestValue = flagValue(tokens, index, "-X") || flagValue(tokens, index, "--request");
    if (requestValue) {
      result.method = String(requestValue.value || "").toUpperCase();
      index += requestValue.skip;
      continue;
    }

    const urlValue = flagValue(tokens, index, "--url");
    if (urlValue) {
      result.url = urlValue.value || "";
      index += urlValue.skip;
      continue;
    }

    const cookieValue = flagValue(tokens, index, "-b") || flagValue(tokens, index, "--cookie");
    if (cookieValue) {
      result.headers.push(createHeader("cookie", cookieValue.value || "", true));
      index += cookieValue.skip;
      continue;
    }

    const dataValue =
      flagValue(tokens, index, "--data-raw") ||
      flagValue(tokens, index, "--data-binary") ||
      flagValue(tokens, index, "--data") ||
      flagValue(tokens, index, "-d");
    if (dataValue) {
      result.bodyParts.push(dataValue.value || "");
      index += dataValue.skip;
      continue;
    }

    if (token === "-I" || token === "--head") {
      result.method = "HEAD";
      continue;
    }

    if (token.startsWith("http://") || token.startsWith("https://")) {
      result.url = token;
    }
  }

  return {
    method: result.method || (result.bodyParts.length ? "POST" : "GET"),
    url: result.url,
    headers: mergeDuplicateHeaders(result.headers),
    body: result.bodyParts.length > 1 ? result.bodyParts.join("&") : result.bodyParts[0] || "",
    token: result.token
  };
}

function mergeDuplicateHeaders(headers) {
  const merged = [];
  for (const header of headers) {
    const existing = merged.find((item) => item.name.toLowerCase() === header.name.toLowerCase());
    if (existing && header.name.toLowerCase() === "cookie") {
      existing.value = `${existing.value}; ${header.value}`;
    } else {
      merged.push(header);
    }
  }
  return merged;
}

function loadSettings() {
  elements.ignoreTlsInput.checked = localStorage.getItem("mini-postman-ignore-tls") === "true";
  updateTokenState();
}

function saveTlsSetting() {
  localStorage.setItem("mini-postman-ignore-tls", String(elements.ignoreTlsInput.checked));
}

function updateTokenState() {
  elements.tokenState.textContent = "auto token";
  elements.tokenState.className = "status-pill ok";
}

function updateMethodStyle() {
  elements.methodSelect.className = `method-${elements.methodSelect.value.toLowerCase()}`;
}

function applyParsedCurl(parsed) {
  elements.methodSelect.value = parsed.method;
  elements.urlInput.value = parsed.url;
  elements.bodyInput.value = parsed.body;
  state.headers = parsed.headers;
  syncParamsFromUrl(parsed.url);

  if (parsed.token) {
    updateTokenState();
  }

  renderHeaders();
}

function renderParams() {
  elements.paramsTable.innerHTML = "";

  if (!state.params.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No query params";
    elements.paramsTable.append(empty);
    return;
  }

  for (const param of state.params) {
    const row = document.createElement("div");
    row.className = "param-row";

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = param.enabled;
    enabled.addEventListener("change", () => {
      param.enabled = enabled.checked;
    });

    const name = document.createElement("input");
    name.type = "text";
    name.value = param.name;
    name.placeholder = "param";
    name.addEventListener("input", () => {
      param.name = name.value;
    });

    const value = document.createElement("input");
    value.type = "text";
    value.value = param.value;
    value.placeholder = "value";
    value.className = "param-value";
    value.addEventListener("input", () => {
      param.value = value.value;
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.textContent = "x";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      state.params = state.params.filter((item) => item.id !== param.id);
      renderParams();
    });

    row.append(enabled, name, value, remove);
    elements.paramsTable.append(row);
  }
}

function renderHeaders() {
  elements.headersTable.innerHTML = "";

  if (!state.headers.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No headers";
    elements.headersTable.append(empty);
    return;
  }

  for (const header of state.headers) {
    const row = document.createElement("div");
    row.className = "header-row";

    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = header.enabled;
    enabled.addEventListener("change", () => {
      header.enabled = enabled.checked;
    });

    const name = document.createElement("input");
    name.type = "text";
    name.value = header.name;
    name.placeholder = "header";
    name.addEventListener("input", () => {
      header.name = name.value;
    });

    const value = document.createElement("input");
    value.type = "text";
    value.value = header.value;
    value.placeholder = "value";
    value.className = "header-value";
    value.addEventListener("input", () => {
      header.value = value.value;
      if (header.name.toLowerCase() === "authorization") {
        const bearerToken = extractBearerToken(value.value);
        if (bearerToken) {
          updateTokenState();
        }
      }
    });

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "icon-button";
    remove.textContent = "x";
    remove.title = "Remove";
    remove.addEventListener("click", () => {
      state.headers = state.headers.filter((item) => item.id !== header.id);
      renderHeaders();
    });

    row.append(enabled, name, value, remove);
    elements.headersTable.append(row);
  }
}

function buildHeadersObject() {
  const headers = {};
  for (const header of state.headers) {
    const name = header.name.trim();
    if (!header.enabled || !name) continue;
    headers[name] = header.value;
  }
  return headers;
}

function formatJsonText(text) {
  return JSON.stringify(JSON.parse(text), null, 2);
}

function minifyJsonText(text) {
  return JSON.stringify(JSON.parse(text));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function parseUrlParts(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function syncParamsFromUrl(url) {
  const parsed = parseUrlParts(url);
  if (!parsed) {
    state.params = [];
    renderParams();
    return;
  }

  state.params = [...parsed.searchParams.entries()].map(([name, value]) => createParam(name, value, true));
  parsed.search = "";
  elements.urlInput.value = parsed.toString();
  renderParams();
}

function buildRequestUrl() {
  const rawUrl = elements.urlInput.value.trim();
  const parsed = parseUrlParts(rawUrl);
  if (!parsed) return rawUrl;

  parsed.search = "";
  for (const param of state.params) {
    if (!param.enabled || !param.name.trim()) continue;
    parsed.searchParams.append(param.name.trim(), param.value);
  }
  return parsed.toString();
}

function buildCurlCommand() {
  const lines = [`curl ${shellQuote(buildRequestUrl())}`];
  const method = elements.methodSelect.value;
  if (method && method !== "GET") lines.push(`  -X ${shellQuote(method)}`);

  for (const header of state.headers) {
    if (!header.enabled || !header.name.trim()) continue;
    lines.push(`  -H ${shellQuote(`${header.name.trim()}: ${header.value}`)}`);
  }

  const body = elements.bodyInput.value;
  if (body && !["GET", "HEAD"].includes(method)) {
    lines.push(`  --data-raw ${shellQuote(body)}`);
  }
  if (elements.ignoreTlsInput.checked) lines.push("  --insecure");
  return lines.join(" \\\n");
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[char]));
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function updateResponseOutput(text = state.responseText) {
  state.responseText = String(text ?? "");
  const query = elements.responseSearchInput.value.trim();

  if (!query) {
    elements.responseOutput.textContent = state.responseText;
    return;
  }

  const pattern = new RegExp(escapeRegExp(query), "gi");
  elements.responseOutput.innerHTML = escapeHtml(state.responseText).replace(pattern, (match) => `<mark>${match}</mark>`);
  const firstMatch = elements.responseOutput.querySelector("mark");
  if (firstMatch) firstMatch.scrollIntoView({ block: "center", inline: "nearest" });
}

function setResponseStatus(payload, pending = false) {
  if (pending) {
    elements.responseStatus.textContent = "sending";
    elements.responseStatus.className = "status-pill warn";
    elements.responseTime.textContent = "0 ms";
    elements.responseSummary.textContent = "waiting";
    return;
  }

  if (!payload) return;

  if (payload.error) {
    elements.responseStatus.textContent = "error";
    elements.responseStatus.className = "status-pill error";
  } else {
    elements.responseStatus.textContent = `${payload.status} ${payload.statusText || ""}`.trim();
    elements.responseStatus.className = `status-pill ${payload.ok ? "ok" : "warn"}`;
  }

  elements.responseTime.textContent = `${payload.durationMs || 0} ms`;
  elements.responseSize.textContent = formatBytes(payload.size || payload.body?.length || 0);
  elements.responseSummary.textContent = summarizeResponse(payload);
}

function renderResponse() {
  const response = state.response;
  if (!response) return;
  elements.responseOutput.classList.remove("table-mode");

  if (response.error) {
    updateResponseOutput([
      response.error,
      response.code ? `Code: ${response.code}` : "",
      response.cause ? `Cause: ${response.cause}` : "",
      response.hint ? `Hint: ${response.hint}` : ""
    ].filter(Boolean).join("\n"));
    return;
  }

  if (state.responseTab === "headers") {
    updateResponseOutput(JSON.stringify(response.headers || {}, null, 2));
    return;
  }

  if (state.responseTab === "table") {
    renderResponseTable(response);
    return;
  }

  if (state.responseTab === "raw") {
    updateResponseOutput(response.binary
      ? `Binary response (${formatBytes(response.size)}), base64:\n${response.bodyBase64}`
      : response.body || "");
    return;
  }

  try {
    updateResponseOutput(formatJsonText(response.body || "null"));
  } catch {
    updateResponseOutput(response.body || "");
  }
}

function summarizeResponse(response) {
  if (!response || response.error) return "no body";
  if (response.binary) return "binary";

  try {
    const json = JSON.parse(response.body || "null");
    if (Array.isArray(json)) return `${json.length} items`;
    if (json && Array.isArray(json.content)) return `${json.content.length} content items`;
    if (json && typeof json === "object") return `${Object.keys(json).length} keys`;
    return typeof json;
  } catch {
    return response.contentType || "text";
  }
}

function tableRowsFromResponse(response) {
  try {
    const json = JSON.parse(response.body || "null");
    if (Array.isArray(json)) return json;
    if (json && Array.isArray(json.content)) return json.content;
    if (json && typeof json === "object") return [json];
  } catch {
    return [];
  }
  return [];
}

function primitiveCell(value) {
  if (value == null) return "";
  if (typeof value === "object") {
    if ("code" in value) return value.code;
    if ("name" in value) return value.name;
    if ("id" in value) return value.id;
    return JSON.stringify(value);
  }
  return String(value);
}

function renderResponseTable(response) {
  const query = elements.responseSearchInput.value.trim().toLowerCase();
  const allRows = tableRowsFromResponse(response);
  const rows = query
    ? allRows.filter((row) => JSON.stringify(row).toLowerCase().includes(query))
    : allRows;
  elements.responseOutput.classList.add("table-mode");

  if (!rows.length) {
    elements.responseOutput.innerHTML = `<div class="empty-state">No tabular data</div>`;
    state.responseText = "";
    return;
  }

  const columns = [...new Set(rows.flatMap((row) => row && typeof row === "object" && !Array.isArray(row) ? Object.keys(row) : ["value"]))].slice(0, 12);
  const visibleRows = rows.slice(0, 100);
  const headerHtml = columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const rowsHtml = visibleRows.map((row) => {
    const source = row && typeof row === "object" && !Array.isArray(row) ? row : { value: row };
    return `<tr>${columns.map((column) => {
      const value = primitiveCell(source[column]);
      return `<td title="${escapeHtml(value)}">${escapeHtml(value)}</td>`;
    }).join("")}</tr>`;
  }).join("");
  const limitText = query ? `Found ${rows.length} of ${allRows.length} rows` : `Showing ${Math.min(visibleRows.length, rows.length)} of ${rows.length} rows`;
  const limitNote = `<div class="table-note">${escapeHtml(limitText)}</div>`;

  elements.responseOutput.innerHTML = `<div class="table-wrap">${limitNote}<table class="data-table"><thead><tr>${headerHtml}</tr></thead><tbody>${rowsHtml}</tbody></table></div>`;
  state.responseText = JSON.stringify(rows, null, 2);
}

function updateBodyState() {
  const body = elements.bodyInput.value.trim();
  if (!body) {
    elements.bodyState.textContent = "empty";
    elements.bodyState.className = "mini-state muted";
    return;
  }

  try {
    JSON.parse(body);
    elements.bodyState.textContent = "valid json";
    elements.bodyState.className = "mini-state ok";
  } catch {
    elements.bodyState.textContent = "invalid json";
    elements.bodyState.className = "mini-state error";
  }
}

function pathSegments(path) {
  return String(path || "")
    .replace(/^\$\./, "")
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
}

function getJsonPathValue(data, path) {
  let current = data;
  for (const segment of pathSegments(path)) {
    if (current == null || !(segment in Object(current))) return undefined;
    current = current[segment];
  }
  return current;
}

function renderCheckRow(pass, label, detail) {
  const className = pass ? "pass" : "fail";
  return `<div class="check-row ${className}"><span>${pass ? "PASS" : "FAIL"}</span><div><strong>${escapeHtml(label)}</strong><small>${escapeHtml(detail)}</small></div></div>`;
}

function runChecks() {
  const response = state.response;
  if (!response) {
    elements.checksResult.textContent = "No response yet";
    return;
  }

  const checks = [];
  const expectedStatus = elements.expectedStatusInput.value.trim();
  const contains = elements.containsInput.value.trim();
  const jsonPath = elements.jsonPathInput.value.trim();

  if (expectedStatus) {
    const pass = Number(expectedStatus) === Number(response.status);
    checks.push(renderCheckRow(pass, "Status", `expected ${expectedStatus}, got ${response.status || "none"}`));
  }

  if (contains) {
    const haystack = response.body || state.responseText || "";
    const pass = haystack.includes(contains);
    checks.push(renderCheckRow(pass, "Contains", pass ? `found "${contains}"` : `missing "${contains}"`));
  }

  if (jsonPath) {
    let parsed;
    try {
      parsed = JSON.parse(response.body || "null");
      const value = getJsonPathValue(parsed, jsonPath);
      const pass = value !== undefined;
      checks.push(renderCheckRow(pass, "JSON path", pass ? `${jsonPath} = ${primitiveCell(value)}` : `${jsonPath} not found`));
    } catch {
      checks.push(renderCheckRow(false, "JSON path", "response is not JSON"));
    }
  }

  if (!checks.length) {
    elements.checksResult.textContent = "No checks configured";
    return;
  }

  elements.checksResult.innerHTML = checks.join("");
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function addHistoryEntry(request) {
  const entry = {
    id: crypto.randomUUID(),
    method: request.method,
    url: request.url,
    params: state.params,
    headers: state.headers.filter((header) => header.name.toLowerCase() !== "authorization"),
    body: request.body,
    createdAt: Date.now()
  };

  state.history = [entry, ...state.history.filter((item) => item.url !== entry.url || item.method !== entry.method)].slice(0, 20);
  localStorage.setItem("mini-postman-history", JSON.stringify(state.history));
  renderHistory();
}

function renderHistory() {
  elements.historyList.innerHTML = "";

  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "No requests";
    elements.historyList.append(empty);
    return;
  }

  for (const item of state.history) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "history-item";
    button.title = item.url;
    button.addEventListener("click", () => {
      elements.methodSelect.value = item.method;
      elements.urlInput.value = item.url;
      syncParamsFromUrl(item.url);
      elements.bodyInput.value = item.body || "";
      state.params = (item.params || state.params || []).map((param) => createParam(param.name, param.value, param.enabled));
      state.headers = (item.headers || []).map((header) => createHeader(header.name, header.value, header.enabled));
      renderParams();
      renderHeaders();
    });

    const method = document.createElement("span");
    method.className = "history-method";
    method.textContent = item.method;

    const url = document.createElement("span");
    url.className = "history-url";
    url.textContent = item.url;

    button.append(method, url);
    elements.historyList.append(button);
  }
}

async function sendRequest() {
  const request = {
    method: elements.methodSelect.value,
    url: buildRequestUrl(),
    headers: buildHeadersObject(),
    body: elements.bodyInput.value,
    ignoreTls: elements.ignoreTlsInput.checked
  };

  if (!request.url) {
    elements.urlInput.focus();
    return;
  }

  elements.sendButton.disabled = true;
  updateResponseOutput("Sending...");
  setResponseStatus(null, true);

  try {
    const response = await fetch("/api/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    });

    state.response = await response.json();
    setResponseStatus(state.response);
    renderResponse();
    runChecks();

    if (!state.response.error) addHistoryEntry(request);
  } catch (error) {
    state.response = { error: error.message };
    setResponseStatus(state.response);
    renderResponse();
  } finally {
    elements.sendButton.disabled = false;
  }
}

function clearAll() {
  elements.curlInput.value = "";
  elements.urlInput.value = "";
  elements.bodyInput.value = "";
  updateTokenState();
  state.headers = [];
  state.params = [];
  state.response = null;
  updateResponseOutput("Ready.");
  elements.responseStatus.textContent = "idle";
  elements.responseStatus.className = "status-pill muted";
  elements.responseTime.textContent = "0 ms";
  elements.responseSize.textContent = "0 B";
  elements.responseSummary.textContent = "ready";
  elements.checksResult.textContent = "No checks yet";
  renderHeaders();
  renderParams();
}

elements.parseButton.addEventListener("click", () => {
  if (!elements.curlInput.value.trim()) return;
  applyParsedCurl(parseCurl(elements.curlInput.value));
});

elements.toggleCurlButton.addEventListener("click", () => {
  state.curlExpanded = !state.curlExpanded;
  elements.leftPanel.classList.toggle("curl-expanded", state.curlExpanded);
  elements.curlPanel.classList.toggle("expanded", state.curlExpanded);
  elements.toggleCurlButton.textContent = state.curlExpanded ? "Collapse" : "Expand";
});

elements.curlInput.addEventListener("paste", (event) => {
  const pastedText = event.clipboardData?.getData("text") || "";
  if (!/^\s*curl\s+/i.test(pastedText)) return;

  event.preventDefault();
  elements.curlInput.value = pastedText.trim();
  applyParsedCurl(parseCurl(pastedText));
});

elements.sendButton.addEventListener("click", sendRequest);
elements.methodSelect.addEventListener("change", updateMethodStyle);
elements.copyCurlButton.addEventListener("click", async () => {
  const curl = buildCurlCommand();
  try {
    await navigator.clipboard.writeText(curl);
    elements.copyCurlButton.textContent = "Copied";
    setTimeout(() => {
      elements.copyCurlButton.textContent = "cURL";
    }, 1200);
  } catch {
    elements.curlInput.value = curl;
  }
});
elements.clearAllButton.addEventListener("click", clearAll);
elements.ignoreTlsInput.addEventListener("change", saveTlsSetting);
elements.urlInput.addEventListener("blur", () => {
  if (elements.urlInput.value.includes("?")) {
    syncParamsFromUrl(elements.urlInput.value);
  }
});

elements.bodyInput.addEventListener("input", updateBodyState);

elements.responseSearchInput.addEventListener("input", () => {
  if (state.responseTab === "table") renderResponse();
  else updateResponseOutput();
});

elements.toggleWrapButton.addEventListener("click", () => {
  state.responseWrap = !state.responseWrap;
  elements.responseOutput.classList.toggle("wrap", state.responseWrap);
  elements.toggleWrapButton.classList.toggle("active", state.responseWrap);
});

elements.copyResponseButton.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.responseText);
    elements.copyResponseButton.textContent = "Copied";
    setTimeout(() => {
      elements.copyResponseButton.textContent = "Copy";
    }, 1200);
  } catch {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(elements.responseOutput);
    selection.removeAllRanges();
    selection.addRange(range);
  }
});

elements.downloadResponseButton.addEventListener("click", () => {
  const blob = new Blob([state.responseText || ""], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.href = url;
  link.download = `response-${timestamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
});

elements.addHeaderButton.addEventListener("click", () => {
  state.headers.push(createHeader());
  renderHeaders();
});

elements.addParamButton.addEventListener("click", () => {
  state.params.push(createParam());
  renderParams();
});

elements.formatBodyButton.addEventListener("click", () => {
  try {
    elements.bodyInput.value = formatJsonText(elements.bodyInput.value);
    updateBodyState();
  } catch {
    elements.bodyInput.focus();
  }
});

elements.minifyBodyButton.addEventListener("click", () => {
  try {
    elements.bodyInput.value = minifyJsonText(elements.bodyInput.value);
    updateBodyState();
  } catch {
    elements.bodyInput.focus();
  }
});

for (const input of [elements.expectedStatusInput, elements.containsInput, elements.jsonPathInput]) {
  input.addEventListener("input", runChecks);
}

elements.runChecksButton.addEventListener("click", runChecks);

elements.clearHistoryButton.addEventListener("click", () => {
  state.history = [];
  localStorage.removeItem("mini-postman-history");
  renderHistory();
});

for (const tab of elements.tabs) {
  tab.addEventListener("click", () => {
    state.responseTab = tab.dataset.responseTab;
    elements.tabs.forEach((item) => item.classList.toggle("active", item === tab));
    renderResponse();
  });
}

document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    sendRequest();
  }
});

loadSettings();
updateResponseOutput("Ready.");
updateBodyState();
updateMethodStyle();
renderHeaders();
renderParams();
renderHistory();
