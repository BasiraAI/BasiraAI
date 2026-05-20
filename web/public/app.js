// Basira demo — vanilla JS, talks to /api/* on the same origin.

const $ = (sel) => document.querySelector(sel);

const shortAddr = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : "—");
const fmtSol = (n) => `${Number(n).toFixed(4)} SOL`;
const fmtTs = (ts) => {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString();
};

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const ALL_ACTIONS = ["Transfer", "Swap", "Stake", "ContractCall"];

let cluster = "localnet";

async function api(path, opts = {}) {
  const r = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

function explorerLink(kind, value) {
  const base = `https://explorer.solana.com/${kind}/${value}`;
  if (cluster === "localnet") {
    return `${base}?cluster=custom&customUrl=http%3A%2F%2F127.0.0.1%3A8899`;
  }
  return `${base}?cluster=${cluster}`;
}

// Random pubkey-shaped string for the recipient field.
async function randomPubkeyB58() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return b58encode(bytes);
}

const B58_ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function b58encode(bytes) {
  if (bytes.length === 0) return "";
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let num = BigInt(0);
  for (const b of bytes) num = (num << 8n) + BigInt(b);
  let out = "";
  while (num > 0n) {
    const rem = Number(num % 58n);
    num = num / 58n;
    out = B58_ALPHA[rem] + out;
  }
  return B58_ALPHA[0].repeat(zeros) + out;
}

// ── rule builder ──────────────────────────────────────────────────────────────

// In-memory model for the policy builder, edited by the UI before "save".
// Each item is one of:
//   { type: "MaxValue", lamports: "1000000000" }       (string-encoded lamports)
//   { type: "AllowedActions", actions: ["Transfer"] }
//   { type: "RatePerWindow", windowSeconds: 60, max: 3 }
let pendingRules = [];

function defaultRule(type) {
  switch (type) {
    case "MaxValue":
      return { type: "MaxValue", lamports: String(1_000_000_000) };
    case "AllowedActions":
      return { type: "AllowedActions", actions: ["Transfer"] };
    case "RatePerWindow":
      return { type: "RatePerWindow", windowSeconds: 60, max: 3 };
  }
  throw new Error(`unknown rule type ${type}`);
}

function rulesFromAgent(agent) {
  if (!agent.policy || !agent.policy.rules) return [];
  return agent.policy.rules.map((r) => {
    switch (r.type) {
      case "MaxValue":
        return { type: "MaxValue", lamports: r.lamports };
      case "AllowedActions":
        return { type: "AllowedActions", actions: r.actions.slice() };
      case "RatePerWindow":
        return {
          type: "RatePerWindow",
          windowSeconds: r.windowSeconds,
          max: r.max,
        };
      default:
        return null;
    }
  }).filter(Boolean);
}

function renderRuleBuilder() {
  const root = $("#rules-builder");
  if (pendingRules.length === 0) {
    root.innerHTML = `<div class="muted rule-empty">no rules yet — add at least one before saving</div>`;
    return;
  }
  root.innerHTML = pendingRules
    .map((rule, i) => {
      let body = "";
      if (rule.type === "MaxValue") {
        const sol = Number(rule.lamports) / 1_000_000_000;
        body = `
          <label>
            Limit (SOL)
            <input type="number" min="0" step="0.1" value="${sol}" data-rule-field="lamports-sol" />
          </label>
        `;
      } else if (rule.type === "AllowedActions") {
        body = `<div class="rule-checks">
          ${ALL_ACTIONS.map(
            (a) =>
              `<label class="check"><input type="checkbox" data-rule-action="${a}" ${
                rule.actions.includes(a) ? "checked" : ""
              } /> ${a}</label>`
          ).join("")}
        </div>`;
      } else if (rule.type === "RatePerWindow") {
        body = `
          <label>
            Window (s)
            <input type="number" min="0" step="1" value="${rule.windowSeconds}" data-rule-field="windowSeconds" />
          </label>
          <label>
            Max
            <input type="number" min="0" step="1" value="${rule.max}" data-rule-field="max" />
          </label>
        `;
      }
      return `
        <div class="rule-row" data-rule-index="${i}">
          <div class="rule-header">
            <span class="rule-tag">rule ${i}</span>
            <span class="rule-type">${rule.type}</span>
            <button type="button" class="rule-remove" data-remove="${i}">remove</button>
          </div>
          <div class="rule-body">${body}</div>
        </div>
      `;
    })
    .join("");

  // wire field inputs
  root.querySelectorAll(".rule-row").forEach((row) => {
    const i = Number(row.dataset.ruleIndex);
    const rule = pendingRules[i];
    row.querySelectorAll("input[data-rule-field]").forEach((input) => {
      input.addEventListener("input", () => {
        const field = input.dataset.ruleField;
        if (field === "lamports-sol") {
          const sol = Number(input.value);
          rule.lamports = String(Math.floor(sol * 1_000_000_000));
        } else if (field === "windowSeconds") {
          rule.windowSeconds = Number(input.value);
        } else if (field === "max") {
          rule.max = Number(input.value);
        }
      });
    });
    row.querySelectorAll("input[data-rule-action]").forEach((cb) => {
      cb.addEventListener("change", () => {
        const a = cb.dataset.ruleAction;
        if (cb.checked && !rule.actions.includes(a)) rule.actions.push(a);
        else if (!cb.checked) rule.actions = rule.actions.filter((x) => x !== a);
      });
    });
    row.querySelector(".rule-remove").addEventListener("click", () => {
      pendingRules.splice(i, 1);
      renderRuleBuilder();
    });
  });
}

$("#add-rule-btn").addEventListener("click", () => {
  const type = $("#add-rule-type").value;
  pendingRules.push(defaultRule(type));
  renderRuleBuilder();
});

$("#save-policy-btn").addEventListener("click", async () => {
  const btn = $("#save-policy-btn");
  const result = $("#policy-result");
  btn.disabled = true;
  btn.textContent = "saving…";
  result.textContent = "";
  try {
    if (pendingRules.length === 0) throw new Error("add at least one rule");
    const r = await api("/api/agent/policy", {
      method: "POST",
      body: JSON.stringify({ rules: pendingRules }),
    });
    result.innerHTML = `<span class="result-ok">policy saved · tx <code>${shortAddr(
      r.tx
    )}</code></span>`;
    await refresh();
  } catch (e) {
    result.innerHTML = `<span class="result-bad">error: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "save policy";
  }
});

// ── status / footer ───────────────────────────────────────────────────────────

async function loadStatus() {
  const s = await api("/api/status");
  cluster = s.cluster;
  $("#env").textContent = `${s.cluster} · ${shortAddr(s.payer)}`;
  $("#program-id").textContent = shortAddr(s.programId);
  $("#payer").textContent = shortAddr(s.payer);
  $("#balance").textContent = `${s.payerBalanceSol.toFixed(2)} SOL`;
  $("#vault").innerHTML = `<a href="${explorerLink(
    "address",
    s.vaultPda
  )}" target="_blank">${shortAddr(s.vaultPda)}</a> · ${s.vaultBalanceSol.toFixed(
    2
  )} SOL`;
  $("#policy-authority").textContent = shortAddr(s.policyAuthority);
}

// ── agent panel ───────────────────────────────────────────────────────────────

async function loadAgent() {
  const agent = await api("/api/agent");
  const el = $("#agent-body");

  if (!agent.exists) {
    el.innerHTML = `
      <div class="muted">No agent registered for this authority yet.</div>
      <p class="muted-sm">Build a rule list in the <strong>Policy Rules</strong> panel below, then click <em>register agent</em>.</p>
      <form id="register-form">
        <label>Name<input name="name" value="demo-agent" /></label>
        <button type="submit">register agent</button>
      </form>
    `;
    $("#register-form").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const form = ev.target;
      if (pendingRules.length === 0) {
        alert("add at least one rule first");
        return;
      }
      try {
        await api("/api/agent/register", {
          method: "POST",
          body: JSON.stringify({
            name: form.elements.name.value,
            rules: pendingRules,
          }),
        });
        await refresh();
      } catch (e) {
        alert("register failed: " + e.message);
      }
    });

    // For first-time use, seed the builder with a sensible starter set so the
    // user can hit "register agent" right away.
    if (pendingRules.length === 0) {
      pendingRules = [
        defaultRule("MaxValue"),
        defaultRule("AllowedActions"),
        defaultRule("RatePerWindow"),
      ];
      renderRuleBuilder();
    }
    return;
  }

  // Existing agent — render summary + sync the builder with on-chain rules.
  const rules = (agent.policy && agent.policy.rules) || [];
  const rulesHtml = rules.length
    ? `<ol class="rule-summary">
         ${rules.map((r) => `<li>${r.summary}</li>`).join("")}
       </ol>`
    : `<div class="muted">no policy</div>`;

  const windowSummary =
    agent.windows && agent.windows.length
      ? agent.windows
          .map((w) => `rule ${w.ruleIndex}: ${w.count} in window`)
          .join(" · ")
      : "no rate-limit windows";

  el.innerHTML = `
    <div class="kv">
      <div class="k">name</div><div class="v"><strong>${agent.name}</strong></div>
      <div class="k">agent pda</div><div class="v"><a href="${explorerLink(
        "address",
        agent.pubkey
      )}" target="_blank"><code>${agent.pubkey}</code></a></div>
      <div class="k">authority</div><div class="v"><code>${shortAddr(
        agent.authority
      )}</code></div>
      <div class="k">policy authority</div><div class="v"><code>${shortAddr(
        agent.policyAuthority
      )}</code></div>
      <div class="k">vault pda</div><div class="v">
        <a href="${explorerLink("address", agent.vaultPda)}" target="_blank"><code>${shortAddr(
          agent.vaultPda
        )}</code></a>
        · ${fmtSol(agent.vaultBalanceSol)}
        <button id="fund-btn" class="inline">+ fund 1 SOL</button>
      </div>
      <div class="k">policy</div><div class="v">${
        agent.policy
          ? `v${agent.policy.version} · ${rules.length} rule${
              rules.length === 1 ? "" : "s"
            }`
          : "—"
      }</div>
      <div class="k">rules</div><div class="v">${rulesHtml}</div>
      <div class="k">rate state</div><div class="v muted-sm">${windowSummary}</div>
      <div class="k">intents</div><div class="v">${agent.intentCount}</div>
    </div>
  `;

  $("#fund-btn").addEventListener("click", async (ev) => {
    ev.preventDefault();
    const btn = ev.currentTarget;
    btn.disabled = true;
    btn.textContent = "funding…";
    try {
      await api("/api/agent/vault/fund", {
        method: "POST",
        body: JSON.stringify({ sol: 1 }),
      });
      await refresh();
    } catch (e) {
      alert("fund failed: " + e.message);
      btn.disabled = false;
      btn.textContent = "+ fund 1 SOL";
    }
  });

  // Sync builder with on-chain rules the first time we see them, so editing
  // starts from the live policy (not blank). After the user has touched the
  // builder, leave it alone.
  if (!loadAgent._initialized) {
    pendingRules = rulesFromAgent(agent);
    renderRuleBuilder();
    loadAgent._initialized = true;
  }
}

// ── intents table ─────────────────────────────────────────────────────────────

async function loadIntents() {
  const xs = await api("/api/intents");
  const el = $("#intents");
  if (!xs.length) {
    el.innerHTML = `<div class="muted">no intents yet</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th><th>action</th><th>value</th><th>recipient</th>
          <th>status</th><th>reason</th><th>submitted</th><th>pda</th><th></th>
        </tr>
      </thead>
      <tbody>
        ${xs
          .slice()
          .reverse()
          .map(
            (i) => `
          <tr data-seq="${i.seq}">
            <td>${i.seq}</td>
            <td>${i.actionType}</td>
            <td>${fmtSol(i.valueSol)}</td>
            <td class="muted-sm">${
              i.recipient && i.recipient !== SYSTEM_PROGRAM
                ? `<code>${shortAddr(i.recipient)}</code>`
                : "—"
            }</td>
            <td><span class="status ${i.status}">${i.status}</span></td>
            <td class="muted-sm">${i.rejectionReason ?? ""}</td>
            <td class="muted-sm">${fmtTs(i.submittedAt)}</td>
            <td><a href="${explorerLink(
              "address",
              i.pubkey
            )}" target="_blank"><code>${shortAddr(i.pubkey)}</code></a></td>
            <td class="row-action">${
              i.status === "Approved"
                ? `<button data-execute="${i.seq}">execute</button>`
                : ""
            }</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
  el.querySelectorAll("button[data-execute]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const seq = btn.dataset.execute;
      btn.disabled = true;
      btn.textContent = "executing…";
      try {
        await api(`/api/intent/${seq}/execute`, { method: "POST" });
        await refresh();
      } catch (e) {
        alert("execute failed: " + e.message);
        btn.disabled = false;
        btn.textContent = "execute";
      }
    });
  });
}

// ── receipts table ────────────────────────────────────────────────────────────

async function loadReceipts() {
  const xs = await api("/api/receipts");
  const el = $("#receipts");
  if (!xs.length) {
    el.innerHTML = `<div class="muted">no receipts yet</div>`;
    return;
  }
  el.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>intent #</th><th>action</th><th>value</th><th>recipient</th>
          <th>executed</th><th>receipt pda</th>
        </tr>
      </thead>
      <tbody>
        ${xs
          .slice()
          .reverse()
          .map(
            (r) => `
          <tr>
            <td>${r.intentSeq}</td>
            <td>${r.actionType}</td>
            <td>${fmtSol(r.valueSol)}</td>
            <td class="muted-sm">${
              r.recipient && r.recipient !== SYSTEM_PROGRAM
                ? `<code>${shortAddr(r.recipient)}</code>`
                : "—"
            }</td>
            <td class="muted-sm">${fmtTs(r.executedAt)}</td>
            <td><a href="${explorerLink(
              "address",
              r.pubkey
            )}" target="_blank"><code>${shortAddr(r.pubkey)}</code></a></td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>
  `;
}

// ── intent form ───────────────────────────────────────────────────────────────

function toggleRecipientField() {
  const action = document.querySelector("#intent-form select[name=action]").value;
  const row = $("#recipient-row");
  row.style.display = action === "Transfer" ? "" : "none";
}

document
  .querySelector("#intent-form select[name=action]")
  .addEventListener("change", toggleRecipientField);

$("#recipient-random").addEventListener("click", async (ev) => {
  ev.preventDefault();
  const input = document.querySelector("#intent-form input[name=recipient]");
  input.value = await randomPubkeyB58();
});

$("#intent-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const form = ev.target;
  const action = form.elements.action.value;
  const valueSol = Number(form.elements.value.value);
  const recipient = form.elements.recipient.value.trim() || null;
  const autoExecute = form.elements.autoExecute.checked;
  const btn = $("#submit-btn");
  const result = $("#last-result");
  btn.disabled = true;
  btn.textContent = "submitting…";
  result.textContent = "";
  try {
    const r = await api("/api/intent", {
      method: "POST",
      body: JSON.stringify({ action, valueSol, recipient, autoExecute }),
    });
    const status = r.intent.status;
    const cls = status === "Rejected" ? "result-bad" : "result-ok";
    let html = `<span class="${cls}">intent #${r.seq} → <strong>${status}</strong></span>`;
    if (r.intent.rejectionReason) {
      html += ` — <span class="muted">${r.intent.rejectionReason}</span>`;
    }
    if (r.executeTx) {
      html += ` · executed → receipt <code>${shortAddr(
        r.receipt.pubkey
      )}</code> → recipient <code>${shortAddr(r.receipt.recipient)}</code>`;
    }
    result.innerHTML = html;
    await refresh();
  } catch (e) {
    result.innerHTML = `<span class="result-bad">error: ${e.message}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = "submit";
  }
});

// ── refresh loop ──────────────────────────────────────────────────────────────

async function refresh() {
  await Promise.all([loadStatus(), loadAgent(), loadIntents(), loadReceipts()]);
}

toggleRecipientField();
renderRuleBuilder();
refresh().catch((e) => {
  console.error(e);
  $("#agent-body").innerHTML = `<div class="result-bad">api error: ${e.message}<br/><span class="muted">is the validator running and the program deployed?</span></div>`;
});

setInterval(() => {
  refresh().catch(() => {});
}, 4000);
