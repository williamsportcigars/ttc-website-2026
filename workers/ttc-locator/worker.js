var STORES_KEY = "locator:stores";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, "");
    const cors = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }
    if (p.endsWith("/api/stores")) return withCors(await handleStores(request, env, url), cors);
    if (p.endsWith("/admin") || p === "" || p === "/") return html(ADMIN_HTML);
    return new Response("Not found", { status: 404 });
  }
};

function corsHeaders(request) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  };
}
function withCors(resp, cors) {
  const headers = new Headers(resp.headers);
  for (const [k, v] of Object.entries(cors)) headers.set(k, v);
  return new Response(resp.body, { status: resp.status, headers });
}
function html(body) {
  return new Response(body, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } });
}
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
function authed(request, env) {
  if (!env.AUTH_TOKEN) return false;
  return (request.headers.get("authorization") || "") === `Bearer ${env.AUTH_TOKEN}`;
}
function clean(v) {
  return v === undefined || v === null ? "" : String(v).trim();
}
function cleanUrl(v) {
  const s = clean(v);
  return /^https?:\/\//i.test(s) ? s : "";
}
async function getStores(env) {
  return (await env.TTC_LOCATOR_KV.get(STORES_KEY, "json")) || [];
}
async function putStores(env, stores) {
  await env.TTC_LOCATOR_KV.put(STORES_KEY, JSON.stringify(stores));
}

async function handleStores(request, env, url) {
  if (request.method === "GET") {
    const stores = await getStores(env);
    stores.sort((a, b) => (a.city || "").localeCompare(b.city || "") || (a.name || "").localeCompare(b.name || ""));
    return json(stores);
  }
  if (!authed(request, env)) return json({ error: "unauthorized" }, 401);

  if (request.method === "POST") {
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const name = clean(body.name);
    const address = clean(body.address);
    const city = clean(body.city);
    if (!name || !address || !city) return json({ error: "name, address, and city are required" }, 400);
    const stores = await getStores(env);
    const store = {
      id: crypto.randomUUID().slice(0, 8),
      name,
      address,
      city,
      state: clean(body.state) || "PA",
      zip: clean(body.zip),
      phone: clean(body.phone),
      website: cleanUrl(body.website),
      lat: body.lat !== undefined && body.lat !== "" ? Number(body.lat) : undefined,
      lng: body.lng !== undefined && body.lng !== "" ? Number(body.lng) : undefined,
      notes: clean(body.notes),
      ts: Date.now()
    };
    stores.push(store);
    await putStores(env, stores);
    return json({ ok: true, store });
  }

  if (request.method === "PATCH") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    let body;
    try { body = await request.json(); } catch { return json({ error: "bad json" }, 400); }
    const stores = await getStores(env);
    const store = stores.find((s) => s.id === id);
    if (!store) return json({ error: "not found" }, 404);
    for (const f of ["name", "address", "city", "state", "zip", "phone", "website", "notes"]) {
      if (body[f] !== undefined) store[f] = f === "website" ? cleanUrl(body[f]) : clean(body[f]);
    }
    for (const f of ["lat", "lng"]) {
      if (body[f] !== undefined) store[f] = body[f] === "" ? undefined : Number(body[f]);
    }
    await putStores(env, stores);
    return json({ ok: true, store });
  }

  if (request.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id) return json({ error: "id required" }, 400);
    const stores = (await getStores(env)).filter((s) => s.id !== id);
    await putStores(env, stores);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
}

var ADMIN_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Third Rule — Store Locator Admin</title>
<style>
  :root { --mint:#259f8a; --black:#001b16; --forest:#033d33; --warm:#f7fffe; --border:#9dd4c8; --text:#001b16; }
  * { box-sizing: border-box; }
  body { font-family: Georgia, serif; background: var(--warm); color: var(--text); margin: 0; padding: 2rem; }
  h1 { font-family: 'Josefin Sans', sans-serif; font-size: 1.4rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--forest); }
  .token-row { display: flex; gap: 0.5rem; margin-bottom: 1.5rem; max-width: 480px; }
  input, textarea { font-family: Georgia, serif; padding: 10px 12px; border: 1px solid var(--border); border-radius: 3px; font-size: 0.9rem; width: 100%; }
  button { font-family: 'Josefin Sans', sans-serif; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; background: var(--mint); color: white; border: none; padding: 10px 18px; border-radius: 3px; cursor: pointer; font-weight: 600; }
  button.secondary { background: transparent; color: var(--forest); border: 1px solid var(--border); }
  button.danger { background: #b03020; }
  .form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; max-width: 640px; margin-bottom: 1rem; }
  .form-grid .full { grid-column: 1 / -1; }
  label { font-family: 'Josefin Sans', sans-serif; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--forest); display: block; margin-bottom: 4px; }
  table { width: 100%; border-collapse: collapse; margin-top: 2rem; }
  th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 0.9rem; }
  th { font-family: 'Josefin Sans', sans-serif; font-size: 10px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--forest); }
  .row-actions button { margin-right: 6px; padding: 6px 12px; font-size: 10px; }
  #status { font-family: 'Josefin Sans', sans-serif; font-size: 11px; letter-spacing: 0.05em; margin: 0.5rem 0; min-height: 1.2em; }
  #status.err { color: #b03020; }
  #status.ok { color: var(--mint); }
</style>
</head>
<body>
<h1>The Third Rule — Store Locator Admin</h1>
<div class="token-row">
  <input id="token" type="password" placeholder="Admin token">
  <button onclick="saveToken()">Save Token</button>
</div>

<div class="form-grid">
  <div class="full"><label>Store Name *</label><input id="f-name" placeholder="e.g. Main Street Cigars"></div>
  <div class="full"><label>Address *</label><input id="f-address" placeholder="123 Main St"></div>
  <div><label>City *</label><input id="f-city" placeholder="Harrisburg"></div>
  <div><label>State</label><input id="f-state" value="PA"></div>
  <div><label>Zip</label><input id="f-zip" placeholder="17101"></div>
  <div><label>Phone</label><input id="f-phone" placeholder="(717) 555-0100"></div>
  <div class="full"><label>Website</label><input id="f-website" placeholder="https://..."></div>
  <div class="full"><label>Notes (optional, shown to customers)</label><input id="f-notes" placeholder="e.g. Ask for it at the counter"></div>
  <div class="full">
    <button id="save-btn" onclick="saveStore()">Add Store</button>
    <button class="secondary" onclick="clearForm()">Clear</button>
  </div>
</div>
<div id="status"></div>

<table>
  <thead><tr><th>Name</th><th>City</th><th>Address</th><th>Phone</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>

<script>
const apiBase = location.origin + "/api/stores";
let editId = null;
function $(id){ return document.getElementById(id); }
function saveToken(){ localStorage.setItem("ttc_locator_token", $("token").value); setStatus("Token saved.", "ok"); }
function hdrs(){ return { "content-type": "application/json", authorization: "Bearer " + (localStorage.getItem("ttc_locator_token")||"") }; }
function setStatus(msg, cls){ const el = $("status"); el.textContent = msg; el.className = cls||""; }
window.addEventListener("load", ()=>{ $("token").value = localStorage.getItem("ttc_locator_token") || ""; load(); });

function clearForm(){
  editId = null;
  ["name","address","city","zip","phone","website","notes"].forEach(f => $("f-"+f).value = "");
  $("f-state").value = "PA";
  $("save-btn").textContent = "Add Store";
}

async function saveStore(){
  const body = {
    name: $("f-name").value.trim(),
    address: $("f-address").value.trim(),
    city: $("f-city").value.trim(),
    state: $("f-state").value.trim() || "PA",
    zip: $("f-zip").value.trim(),
    phone: $("f-phone").value.trim(),
    website: $("f-website").value.trim(),
    notes: $("f-notes").value.trim()
  };
  if(!body.name || !body.address || !body.city){ setStatus("Name, address, and city are required.", "err"); return; }
  const url = editId ? apiBase + "?id=" + editId : apiBase;
  const method = editId ? "PATCH" : "POST";
  const r = await fetch(url, { method, headers: hdrs(), body: JSON.stringify(body) });
  if(r.status === 401){ setStatus("Wrong token.", "err"); return; }
  const data = await r.json();
  if(!r.ok || !data.ok){ setStatus(data.error || "Something went wrong.", "err"); return; }
  setStatus((editId ? "Updated" : "Added") + " — live within a few seconds.", "ok");
  clearForm();
  load();
}

async function editStore(id, store){
  editId = id;
  $("f-name").value = store.name || "";
  $("f-address").value = store.address || "";
  $("f-city").value = store.city || "";
  $("f-state").value = store.state || "PA";
  $("f-zip").value = store.zip || "";
  $("f-phone").value = store.phone || "";
  $("f-website").value = store.website || "";
  $("f-notes").value = store.notes || "";
  $("save-btn").textContent = "Update Store";
  window.scrollTo({top:0, behavior:"smooth"});
}

async function delStore(id){
  if(!confirm("Remove this store?")) return;
  const r = await fetch(apiBase + "?id=" + id, { method: "DELETE", headers: hdrs() });
  if(r.status === 401){ setStatus("Wrong token.", "err"); return; }
  load();
}

async function load(){
  const r = await fetch(apiBase, { cache: "no-store" });
  const stores = await r.json();
  const rows = $("rows");
  rows.innerHTML = "";
  for(const s of stores){
    const tr = document.createElement("tr");
    tr.innerHTML = "<td>" + escapeHtml(s.name) + "</td><td>" + escapeHtml(s.city) + ", " + escapeHtml(s.state||"PA") + "</td><td>" + escapeHtml(s.address) + "</td><td>" + escapeHtml(s.phone||"") + "</td>" +
      "<td class='row-actions'><button class='secondary' data-edit='" + s.id + "'>Edit</button><button class='danger' data-del='" + s.id + "'>Delete</button></td>";
    rows.appendChild(tr);
    tr.querySelector("[data-edit]").addEventListener("click", ()=> editStore(s.id, s));
    tr.querySelector("[data-del]").addEventListener("click", ()=> delStore(s.id));
  }
  if(stores.length === 0){ rows.innerHTML = "<tr><td colspan='5' style='color:#88a;'>No stores yet — add your first one above.</td></tr>"; }
}
function escapeHtml(s){ return String(s==null?"":s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
<\/script>
</body>
</html>`;
