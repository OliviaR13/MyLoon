const MANIFEST_URL = "../manifest.json";
const RAW_BASE = "https://raw.githubusercontent.com/OliviaR13/MyLoon/main/";

const state = { plugins: [], category: "全部", query: "" };

const $ = (s) => document.querySelector(s);

function esc(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}

function toast(message) {
  let el = $(".toast");
  if (!el) {
    el = document.createElement("div");
    el.className = "toast";
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 1800);
}

function normalizePlugin(p) {
  return {
    id: p.id || p.file,
    name: p.name || p.file,
    file: p.file,
    version: p.version || "未标注",
    author: p.author || "MyLoon",
    category: p.category || "其他",
    icon: p.icon || "",
    description: p.description || "Loon 插件",
  };
}

function matches(p) {
  const q = state.query.trim().toLowerCase();
  const categoryOK = state.category === "全部" || p.category === state.category;
  if (!categoryOK) return false;
  if (!q) return true;
  return [p.name, p.description, p.author, p.category]
    .join(" ").toLowerCase().includes(q);
}

function renderFilters() {
  const categories = ["全部", ...new Set(state.plugins.map(p => p.category))];
  $("#filters").innerHTML = categories.map(c =>
    `<button class="filter ${c === state.category ? "active" : ""}" data-category="${esc(c)}">${esc(c)}</button>`
  ).join("");

  document.querySelectorAll(".filter").forEach(btn => {
    btn.addEventListener("click", () => {
      state.category = btn.dataset.category;
      renderFilters();
      render();
    });
  });
}

function installPlugin(plugin) {
  const rawURL = RAW_BASE + plugin.file;
  const loonURL = "loon://install?url=" + encodeURIComponent(rawURL);
  window.location.href = loonURL;
  setTimeout(() => toast("已尝试调用 Loon 安装"), 250);
}

function render() {
  const visible = state.plugins.filter(matches);
  $("#countText").textContent = `${visible.length} / ${state.plugins.length} 个插件`;
  $("#pluginGrid").innerHTML = visible.map(p => `
    <article class="card">
      <div class="card-top">
        ${p.icon ? `<img class="plugin-icon" src="${esc(p.icon)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">` : `<div class="plugin-icon"></div>`}
        <span class="version">${esc(p.version)}</span>
      </div>
      <h2>${esc(p.name)}</h2>
      <p class="desc">${esc(p.description)}</p>
      <div class="card-bottom">
        <span class="category">${esc(p.category)} · ${esc(p.author)}</span>
        <button class="install" data-id="${esc(p.id)}">安装</button>
      </div>
    </article>
  `).join("");

  $("#empty").classList.toggle("hidden", visible.length !== 0);
  document.querySelectorAll(".install").forEach(btn => {
    btn.addEventListener("click", () => {
      const p = state.plugins.find(x => x.id === btn.dataset.id);
      if (p) installPlugin(p);
    });
  });
}

async function loadManifest(showToast = false) {
  try {
    const response = await fetch(`${MANIFEST_URL}?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    state.plugins = (data.plugins || []).map(normalizePlugin);
    state.category = "全部";
    renderFilters();
    render();
    $("#updatedText").textContent = data.generatedAt
      ? `更新于 ${new Date(data.generatedAt).toLocaleDateString("zh-CN")}`
      : "";
    if (showToast) toast("插件清单已刷新");
  } catch (error) {
    $("#countText").textContent = "清单加载失败";
    $("#pluginGrid").innerHTML = "";
    $("#empty").classList.remove("hidden");
    $("#empty h2").textContent = "暂时无法加载插件";
    $("#empty p").textContent = "请检查 GitHub Pages / manifest.json 是否可访问。";
    if (showToast) toast("刷新失败");
    console.error(error);
  }
}

$("#searchInput").addEventListener("input", e => {
  state.query = e.target.value;
  render();
});

$("#refreshBtn").addEventListener("click", () => loadManifest(true));

document.addEventListener("keydown", e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    $("#searchInput").focus();
  }
});

loadManifest();
