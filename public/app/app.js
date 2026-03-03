import {
  apiFetch,
  badgeClassForStatus,
  bindModalSystem,
  closeModal,
  fetchBackendHealth,
  formatDateTime,
  getToken,
  initTabs,
  renderSkeletonRows,
  setToken,
  showToast
} from "/shared/ui.js";

const HEALTH_POLL_MS = 10_000;
const AI_PERMISSION_KEYS = [
  "readScene",
  "createGeometry",
  "editGeometry",
  "materials",
  "booleans",
  "templates",
  "delete",
  "cards",
  "agents",
  "skills",
  "grid",
  "export"
];
const REYMESHY_PREF_KEY = "app.reymeshy.enabled";
const REYMESHY_JOB_POLL_INTERVAL_MS = 500;
const REYMESHY_JOB_POLL_TIMEOUT_MS = 45_000;
const HYBRID_DISPATCH_JOB_POLL_INTERVAL_MS = 1500;
const HYBRID_DISPATCH_JOB_POLL_TIMEOUT_MS = 240_000;

function loadReyMeshyTogglePreference() {
  try {
    return localStorage.getItem(REYMESHY_PREF_KEY) === "true";
  } catch {
    return false;
  }
}

function saveReyMeshyTogglePreference(enabled) {
  try {
    localStorage.setItem(REYMESHY_PREF_KEY, enabled ? "true" : "false");
  } catch {
    // Ignore storage failures; UI state still works in-memory.
  }
}

function sampleReyMeshyMesh() {
  return {
    vertices: [
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
      1, 1, 0
    ],
    indices: [0, 1, 2, 1, 3, 2],
    uvs: []
  };
}

function waitFor(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function runReyMeshyCleanupJob(mesh, onProgress) {
  const created = await apiFetch("/api/reymeshy/jobs", {
    method: "POST",
    body: { mesh }
  });

  const jobId = created?.job?.id;
  if (!jobId) {
    throw new Error("No se pudo crear el job de ReyMeshy.");
  }

  if (typeof onProgress === "function") {
    onProgress({ jobId, status: created?.job?.status || "queued" });
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < REYMESHY_JOB_POLL_TIMEOUT_MS) {
    const polled = await apiFetch(`/api/reymeshy/jobs/${encodeURIComponent(jobId)}`);
    const job = polled?.job || {};
    const status = typeof job.status === "string" ? job.status : "queued";

    if (typeof onProgress === "function") {
      onProgress({ jobId, status });
    }

    if (status === "succeeded") {
      return {
        summary: {
          inputTriangles: job?.input?.triangles ?? null,
          outputTriangles: job?.output?.outputTriangles ?? null,
          remeshedTriangles: job?.output?.remeshedTriangles ?? null
        }
      };
    }

    if (status === "failed") {
      throw new Error(job?.error?.message || job?.error?.code || "cleanup failed");
    }

    await waitFor(REYMESHY_JOB_POLL_INTERVAL_MS);
  }

  throw new Error("ReyMeshy timeout: el job no finalizo a tiempo.");
}

function toHybridDispatchSummary(response, category) {
  return {
    ok: Boolean(response?.ok),
    mode: response?.mode || "-",
    category: response?.category || category,
    provider: response?.provider || null,
    latencyMs: response?.latencyMs ?? null,
    budget: response?.budget || null,
    bus: response?.bus || null,
    result: response?.result ?? null
  };
}

function toHybridDispatchSummaryFromJob(job, category) {
  const output = job?.output || null;
  return {
    ok: job?.status === "succeeded",
    mode: output?.routeMode || "-",
    category: output?.category || category,
    provider: output?.providerId ? { id: output.providerId, name: output.providerName || output.providerId } : null,
    latencyMs: output?.latencyMs ?? null,
    budget: output?.budget || null,
    bus: output?.bus || null,
    result: output?.result ?? null,
    job: {
      id: job?.id || null,
      status: job?.status || "unknown",
      createdAt: job?.createdAt || null,
      startedAt: job?.startedAt || null,
      finishedAt: job?.finishedAt || null,
      error: job?.error || null
    }
  };
}

function collectHybridDispatchLinks(result) {
  const links = [];
  const meshy = result && typeof result === "object" ? result.meshy : null;
  const artifacts = meshy && typeof meshy === "object" ? meshy.artifacts : null;
  const modelUrls = artifacts && typeof artifacts === "object" ? artifacts.modelUrls : null;

  if (modelUrls && typeof modelUrls === "object") {
    const preferredFormats = ["glb", "obj", "fbx", "usdz"];
    for (const format of preferredFormats) {
      const url = modelUrls[format];
      if (typeof url === "string" && url.trim().length > 0) {
        links.push({
          label: `Download ${format.toUpperCase()}`,
          url: url.trim()
        });
      }
    }

    for (const [format, rawUrl] of Object.entries(modelUrls)) {
      if (preferredFormats.includes(String(format).toLowerCase())) {
        continue;
      }
      if (typeof rawUrl === "string" && rawUrl.trim().length > 0) {
        links.push({
          label: `Download ${String(format).toUpperCase()}`,
          url: rawUrl.trim()
        });
      }
    }
  }

  const thumbnailUrl = artifacts && typeof artifacts === "object" ? artifacts.thumbnailUrl : null;
  if (typeof thumbnailUrl === "string" && thumbnailUrl.trim().length > 0) {
    links.push({
      label: "Preview PNG",
      url: thumbnailUrl.trim()
    });
  }

  return links;
}

async function runHybridDispatchJob(input, onProgress) {
  const created = await apiFetch("/api/mcp/execute", {
    method: "POST",
    body: {
      tool: "hybrid.dispatch",
      async: true,
      input
    }
  });

  const jobId = created?.job?.id;
  if (!jobId) {
    throw new Error("No se pudo crear el job de hybrid.dispatch.");
  }

  if (typeof onProgress === "function") {
    onProgress({ jobId, status: created?.job?.status || "queued", job: created?.job || null });
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < HYBRID_DISPATCH_JOB_POLL_TIMEOUT_MS) {
    const polled = await apiFetch(`/api/mcp/hybrid/jobs/${encodeURIComponent(jobId)}?includeResult=1`);
    const job = polled?.job || {};
    const status = typeof job.status === "string" ? job.status : "queued";

    if (typeof onProgress === "function") {
      onProgress({ jobId, status, job });
    }

    if (status === "succeeded") {
      return job;
    }

    if (status === "failed") {
      throw new Error(job?.error?.message || "Hybrid dispatch job failed");
    }

    await waitFor(HYBRID_DISPATCH_JOB_POLL_INTERVAL_MS);
  }

  throw new Error("Hybrid dispatch timeout: el job no finalizo a tiempo.");
}

function defaultAiPermissions() {
  return {
    readScene: false,
    createGeometry: false,
    editGeometry: false,
    materials: false,
    booleans: false,
    templates: false,
    delete: false,
    cards: false,
    agents: false,
    skills: false,
    grid: false,
    export: false
  };
}

function normalizeAiPermissions(input) {
  const base = defaultAiPermissions();
  if (!input || typeof input !== "object") {
    return base;
  }
  for (const key of AI_PERMISSION_KEYS) {
    if (typeof input[key] === "boolean") {
      base[key] = input[key];
    }
  }
  return base;
}

function aiPermissionsProfile(kind) {
  const base = defaultAiPermissions();
  if (kind === "safe") {
    return {
      ...base,
      readScene: true
    };
  }
  if (kind === "modeling" || kind === "builder") {
    return {
      ...base,
      readScene: true,
      createGeometry: true,
      editGeometry: true,
      materials: true,
      booleans: true,
      templates: true,
      grid: true
    };
  }
  if (kind === "agents") {
    return {
      ...base,
      readScene: true,
      cards: true,
      agents: true,
      skills: true,
      grid: true
    };
  }
  return {
    ...base,
    readScene: true,
    createGeometry: true,
    editGeometry: true,
    materials: true,
    booleans: true,
    templates: true,
    delete: true,
    cards: true,
    agents: true,
    skills: true,
    grid: true,
    export: true
  };
}

function aiPermissionsEqual(left, right) {
  for (const key of AI_PERMISSION_KEYS) {
    if (Boolean(left[key]) !== Boolean(right[key])) {
      return false;
    }
  }
  return true;
}

function detectAiPermissionsProfile(permissions) {
  if (aiPermissionsEqual(permissions, aiPermissionsProfile("safe"))) {
    return "safe";
  }
  if (aiPermissionsEqual(permissions, aiPermissionsProfile("modeling"))) {
    return "modeling";
  }
  if (aiPermissionsEqual(permissions, aiPermissionsProfile("agents"))) {
    return "agents";
  }
  if (aiPermissionsEqual(permissions, aiPermissionsProfile("full"))) {
    return "full";
  }
  if (Object.values(permissions).every((value) => value === false)) {
    return "off";
  }
  return "custom";
}

function profileLabel(profile) {
  if (profile === "safe") {
    return "Modo Seguro";
  }
  if (profile === "modeling") {
    return "Modo Modelado";
  }
  if (profile === "agents") {
    return "Modo Agentes";
  }
  if (profile === "full") {
    return "Full Manual";
  }
  if (profile === "off") {
    return "Bloqueada";
  }
  return "Custom";
}

const state = {
  token: getToken(),
  me: null,
  featuredCard: null,
  ownedCards: [],
  marketListings: [],
  trainingJobs: [],
  memories: [],
  agents: [],
  creatorStatus: null,
  aiConfig: null,
  aiPermissionsDraft: defaultAiPermissions(),
  aiPermissionsSync: "local-only",
  reymeshyEnabled: loadReyMeshyTogglePreference(),
  reymeshyStatus: null,
  reymeshyBusy: false,
  reymeshyLastOutput: "Sin ejecucion.",
  hybridStatus: null,
  hybridDispatchBusy: false,
  hybridDispatchLastOutput: "Sin ejecucion.",
  hybridDispatchJobId: "",
  hybridDispatchJobStatus: "",
  hybridDispatchLinks: [],
  projects: [],
  vaultAssets: [],
  vaultProjectAssets: [],
  vaultSelectedProjectId: "",
  localEvents: [],
  lastDuelResult: null,
  healthTimer: null,
  clockTimer: null
};

const elements = {
  layoutRoot: document.querySelector(".app-layout"),
  sidebar: document.getElementById("app-sidebar"),
  sidebarOverlay: document.getElementById("app-sidebar-overlay"),
  navToggle: document.getElementById("app-nav-toggle"),
  nav: document.getElementById("app-nav"),
  panels: Array.from(document.querySelectorAll(".app-panel")),
  healthBadge: document.getElementById("app-health-badge"),
  clock: document.getElementById("app-clock"),
  profileMini: document.getElementById("app-profile-mini"),
  authBtn: document.getElementById("app-auth-btn"),
  authSwitcher: document.getElementById("app-auth-switcher"),
  loginForm: document.getElementById("app-login-form"),
  registerForm: document.getElementById("app-register-form"),
  feedRefreshBtn: document.getElementById("app-feed-refresh-btn"),
  activityList: document.getElementById("app-activity-list"),
  createDeckBtn: document.getElementById("app-create-deck-btn"),
  openEditorBtn: document.getElementById("app-open-editor-btn"),
  duelQuickBtn: document.getElementById("app-duel-btn"),
  homeStatCards: document.getElementById("home-stat-cards"),
  homeStatJobs: document.getElementById("home-stat-jobs"),
  homeStatMemories: document.getElementById("home-stat-memories"),
  homeStatAgents: document.getElementById("home-stat-agents"),
  homeJobsList: document.getElementById("home-jobs-list"),
  featuredFrame: document.getElementById("featured-card-frame"),
  featuredRarity: document.getElementById("featured-rarity"),
  featuredName: document.getElementById("featured-name"),
  featuredClass: document.getElementById("featured-class"),
  featuredAtk: document.getElementById("featured-atk"),
  featuredDef: document.getElementById("featured-def"),
  featuredSpd: document.getElementById("featured-spd"),
  featuredMeta: document.getElementById("featured-meta"),
  memoryCount: document.getElementById("memory-count"),
  memoryRefreshBtn: document.getElementById("memory-refresh-btn"),
  memoryForm: document.getElementById("memory-form"),
  memoryList: document.getElementById("memory-list"),
  inventoryCount: document.getElementById("inventory-count"),
  inventoryRefreshBtn: document.getElementById("inventory-refresh-btn"),
  inventoryCardList: document.getElementById("inventory-card-list"),
  marketListingList: document.getElementById("market-listing-list"),
  listingForm: document.getElementById("listing-form"),
  duelForm: document.getElementById("duel-form"),
  duelPool: document.getElementById("duel-card-pool"),
  duelResult: document.getElementById("duel-result"),
  agentsCount: document.getElementById("agents-count"),
  agentsRefreshBtn: document.getElementById("agents-refresh-btn"),
  agentsList: document.getElementById("agents-list"),
  agentsCreateForm: document.getElementById("agents-create-form"),
  creatorsStatusCard: document.getElementById("creators-status-card"),
  creatorsApplyForm: document.getElementById("creators-apply-form"),
  creatorsRedeemForm: document.getElementById("creators-redeem-form"),
  cardCreateForm: document.getElementById("card-create-form"),
  cardUpdateForm: document.getElementById("card-update-form"),
  aiConfigForm: document.getElementById("ai-config-form"),
  aiProvider: document.getElementById("ai-provider"),
  aiModel: document.getElementById("ai-model"),
  aiEndpoint: document.getElementById("ai-endpoint"),
  aiApiKey: document.getElementById("ai-api-key"),
  aiTemperature: document.getElementById("ai-temperature"),
  aiMaxTokens: document.getElementById("ai-max-tokens"),
  aiSystemPrompt: document.getElementById("ai-system-prompt"),
  aiEnabled: document.getElementById("ai-enabled"),
  aiStatus: document.getElementById("ai-config-status"),
  aiMaskedKey: document.getElementById("ai-config-masked-key"),
  aiConfigTestForm: document.getElementById("ai-config-test-form"),
  aiTestPrompt: document.getElementById("ai-test-prompt"),
  aiTestOutput: document.getElementById("ai-config-test-output"),
  aiClearKeyBtn: document.getElementById("ai-config-clear-key-btn"),
  aiPermissionsForm: document.getElementById("ai-permissions-form"),
  aiPermissionsSync: document.getElementById("ai-permissions-sync"),
  aiPolicyState: document.getElementById("ai-policy-state"),
  aiPermissionsHint: document.getElementById("ai-permissions-hint"),
  aiDisablePermissionsBtn: document.getElementById("ai-permissions-disable-btn"),
  aiPermissionsSafeBtn: document.getElementById("ai-permissions-safe-btn"),
  aiPermissionsBuilderBtn: document.getElementById("ai-permissions-builder-btn"),
  aiPermissionsAgentsBtn: document.getElementById("ai-permissions-agents-btn"),
  aiPermissionsFullBtn: document.getElementById("ai-permissions-full-btn"),
  aiPermissionButtons: Array.from(document.querySelectorAll("[data-ai-perm-key]")),
  reymeshyForm: document.getElementById("reymeshy-form"),
  reymeshyEnabled: document.getElementById("reymeshy-enabled"),
  reymeshyStatus: document.getElementById("reymeshy-status"),
  reymeshyTestBtn: document.getElementById("reymeshy-test-btn"),
  reymeshyOutput: document.getElementById("reymeshy-output"),
  hybridBrokerForm: document.getElementById("hybrid-broker-form"),
  hybridLocalEnabled: document.getElementById("hybrid-local-enabled"),
  hybridApiEnabled: document.getElementById("hybrid-api-enabled"),
  hybridPreferLocal: document.getElementById("hybrid-prefer-local"),
  hybridStatusText: document.getElementById("hybrid-status"),
  hybridBudgetText: document.getElementById("hybrid-budget"),
  hybridProviderToggles: document.getElementById("hybrid-provider-toggles"),
  hybridRefreshBtn: document.getElementById("hybrid-refresh-btn"),
  hybridSaveBtn: document.getElementById("hybrid-save-btn"),
  hybridBudgetResetBtn: document.getElementById("hybrid-budget-reset-btn"),
  hybridDispatchForm: document.getElementById("hybrid-dispatch-form"),
  hybridDispatchCategory: document.getElementById("hybrid-dispatch-category"),
  hybridDispatchProviderId: document.getElementById("hybrid-dispatch-provider-id"),
  hybridDispatchPrompt: document.getElementById("hybrid-dispatch-prompt"),
  hybridDispatchPayload: document.getElementById("hybrid-dispatch-payload"),
  hybridDispatchAsync: document.getElementById("hybrid-dispatch-async"),
  hybridDispatchStatus: document.getElementById("hybrid-dispatch-status"),
  hybridDispatchRunBtn: document.getElementById("hybrid-dispatch-run-btn"),
  hybridDispatchClearBtn: document.getElementById("hybrid-dispatch-clear-btn"),
  hybridDispatchOutput: document.getElementById("hybrid-dispatch-output"),
  hybridDispatchLinks: document.getElementById("hybrid-dispatch-links"),
  vaultAssetForm: document.getElementById("vault-asset-form"),
  vaultAssetType: document.getElementById("vault-asset-type"),
  vaultAssetName: document.getElementById("vault-asset-name"),
  vaultAssetTags: document.getElementById("vault-asset-tags"),
  vaultAssetDedupe: document.getElementById("vault-asset-dedupe"),
  vaultUploadForm: document.getElementById("vault-upload-form"),
  vaultUploadAssetId: document.getElementById("vault-upload-asset-id"),
  vaultUploadRole: document.getElementById("vault-upload-role"),
  vaultUploadFile: document.getElementById("vault-upload-file"),
  vaultLinkForm: document.getElementById("vault-link-form"),
  vaultLinkProjectId: document.getElementById("vault-link-project-id"),
  vaultLinkAssetId: document.getElementById("vault-link-asset-id"),
  vaultLinkEmbedMode: document.getElementById("vault-link-embed-mode"),
  vaultLinkOverrides: document.getElementById("vault-link-overrides"),
  vaultRefreshBtn: document.getElementById("vault-refresh-btn"),
  vaultAssetsList: document.getElementById("vault-assets-list"),
  vaultProjectAssetsList: document.getElementById("vault-project-assets-list")
};

function assertDomBindings() {
  for (const [name, value] of Object.entries(elements)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        throw new Error(`Missing required DOM collection: ${name}`);
      }
      continue;
    }

    if (!value) {
      throw new Error(`Missing required DOM element: ${name}`);
    }
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isAuthed() {
  return Boolean(state.token);
}

function setAuthLocks() {
  const locked = !isAuthed();
  for (const block of document.querySelectorAll(".auth-gated")) {
    block.classList.toggle("is-locked", locked);
  }
}

function setSidebarOpen(open) {
  const next = Boolean(open);
  elements.layoutRoot.classList.toggle("sidebar-open", next);
  elements.navToggle.setAttribute("aria-expanded", String(next));
}

function setActiveSection(sectionId) {
  for (const item of elements.nav.querySelectorAll(".app-nav-item")) {
    item.classList.toggle("active", item.getAttribute("data-section") === sectionId);
  }

  for (const panel of elements.panels) {
    panel.classList.toggle("active", panel.getAttribute("data-panel") === sectionId);
  }

  setSidebarOpen(false);
}

function updateClock() {
  elements.clock.textContent = new Date().toLocaleTimeString();
}

async function refreshHealth() {
  const result = await fetchBackendHealth();
  const healthPill = elements.healthBadge.closest(".app-health-pill");
  if (result.online) {
    elements.healthBadge.className = "ui-badge success";
    elements.healthBadge.textContent = "Backend online";
    healthPill?.classList.add("is-online");
    healthPill?.classList.remove("is-offline");
  } else {
    elements.healthBadge.className = "ui-badge error";
    elements.healthBadge.textContent = "Backend offline";
    healthPill?.classList.add("is-offline");
    healthPill?.classList.remove("is-online");
  }
}

function renderProfileMini() {
  if (!state.me) {
    elements.profileMini.innerHTML = `
      <span class="app-avatar">?</span>
      <div>
        <strong>Guest</strong>
        <p>No session</p>
      </div>
    `;
    return;
  }

  const initial = String(state.me.username || "U").charAt(0).toUpperCase();
  elements.profileMini.innerHTML = `
    <span class="app-avatar">${escapeHtml(initial)}</span>
    <div>
      <strong>${escapeHtml(state.me.username)} · ${escapeHtml(state.me.role)}</strong>
      <p>CP ${state.me.creativePoints ?? "-"} · ELO ${state.me.elo ?? "-"}</p>
    </div>
  `;
}

function updateAuthButton() {
  if (isAuthed()) {
    elements.authBtn.textContent = "Logout";
    elements.authBtn.removeAttribute("data-open-modal");
  } else {
    elements.authBtn.textContent = "Sign In";
    elements.authBtn.setAttribute("data-open-modal", "app-auth-modal");
  }
}

function setFeaturedCard(card) {
  state.featuredCard = card;
  const rarityRaw = String(card?.rarity || "legendary").toLowerCase();
  const rarity = ["common", "rare", "epic", "legendary"].includes(rarityRaw) ? rarityRaw : "legendary";
  elements.featuredFrame.className = `featured-card-frame rarity-${rarity}`;
  elements.featuredRarity.textContent = rarity;
  elements.featuredName.textContent = card?.name || "Imperial Sentinel";
  elements.featuredClass.textContent = `Class: ${card?.cardClass || "guardian"}`;
  elements.featuredAtk.textContent = String(card?.baseStats?.attack ?? 12);
  elements.featuredDef.textContent = String(card?.baseStats?.defense ?? 14);
  elements.featuredSpd.textContent = String(card?.baseStats?.speed ?? 6);
  const source = card?.ownerUserId ? "from your collection" : "from global catalog";
  const date = card?.createdAt ? ` · ${formatDateTime(card.createdAt)}` : "";
  elements.featuredMeta.textContent = `${card?.id ? `Card #${card.id}` : "Preset card"} ${source}${date}`;
}

function pushLocalEvent(event) {
  state.localEvents.unshift({
    ...event,
    timestamp: event.timestamp || new Date().toISOString()
  });

  if (state.localEvents.length > 20) {
    state.localEvents = state.localEvents.slice(0, 20);
  }
}

function buildActivityItems() {
  const items = [];

  for (const event of state.localEvents) {
    items.push(event);
  }

  for (const job of state.trainingJobs.slice(0, 4)) {
    items.push({
      title: `Training ${job.mode}`,
      description: `status=${job.status} · ${job.errorMessage || "ok"}`,
      status: job.status || "info",
      timestamp: job.updatedAt || job.createdAt || ""
    });
  }

  for (const memory of state.memories.slice(0, 3)) {
    items.push({
      title: `Memory ${memory.scope}`,
      description: memory.text.slice(0, 88),
      status: "info",
      timestamp: memory.updatedAt || memory.createdAt || ""
    });
  }

  for (const listing of state.marketListings.slice(0, 3)) {
    items.push({
      title: `Market · ${listing.cardName || listing.cardId}`,
      description: `${listing.sellerName || "seller"} · ${listing.priceCredits} credits`,
      status: "info",
      timestamp: listing.createdAt || ""
    });
  }

  if (state.creatorStatus?.application?.status) {
    items.push({
      title: "Creator Application",
      description: `status=${state.creatorStatus.application.status}`,
      status: state.creatorStatus.application.status === "approved" ? "success" : "warning",
      timestamp: state.creatorStatus.application.updatedAt || state.creatorStatus.application.createdAt || ""
    });
  }

  items.push({
    title: "Purchase licenses timeline",
    description: "Coming Soon: feed completo de compras y licencias.",
    status: "warning",
    timestamp: ""
  });

  return items.sort((a, b) => {
    const aTs = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const bTs = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return bTs - aTs;
  });
}

function renderActivityFeed() {
  elements.activityList.innerHTML = "";
  const items = buildActivityItems();
  if (items.length === 0) {
    elements.activityList.innerHTML = '<li class="activity-item"><p>No activity yet.</p></li>';
    return;
  }

  for (const item of items.slice(0, 10)) {
    const badge = badgeClassForStatus(item.status);
    const li = document.createElement("li");
    li.className = "activity-item";
    li.innerHTML = `
      <div class="activity-item-top">
        <strong>${escapeHtml(item.title)}</strong>
        <span class="ui-badge ${badge}">${escapeHtml(item.status || "info")}</span>
      </div>
      <p>${escapeHtml(item.description)}</p>
      <p class="mono">${escapeHtml(item.timestamp ? formatDateTime(item.timestamp) : "n/a")}</p>
    `;
    elements.activityList.appendChild(li);
  }
}

function renderHomeStats() {
  elements.homeStatCards.textContent = String(state.ownedCards.length);
  elements.homeStatJobs.textContent = String(state.trainingJobs.length);
  elements.homeStatMemories.textContent = String(state.memories.length);
  elements.homeStatAgents.textContent = String(state.agents.length);
}

function renderHomeJobs() {
  elements.homeJobsList.innerHTML = "";

  if (!isAuthed()) {
    elements.homeJobsList.innerHTML = '<li class="activity-item"><p class="mono">Sign in to load your training queue.</p></li>';
    return;
  }

  if (state.trainingJobs.length === 0) {
    elements.homeJobsList.innerHTML = '<li class="activity-item"><p class="mono">No training jobs yet.</p></li>';
    return;
  }

  for (const job of state.trainingJobs.slice(0, 8)) {
    const li = document.createElement("li");
    li.className = "activity-item";
    const status = badgeClassForStatus(job.status || "info");
    li.innerHTML = `
      <div class="activity-item-top">
        <strong>${escapeHtml(job.mode)} · ${escapeHtml(job.platform || "web")}</strong>
        <span class="ui-badge ${status}">${escapeHtml(job.status || "unknown")}</span>
      </div>
      <p>${escapeHtml(job.errorMessage || "No issues reported")}</p>
      <p class="mono">${escapeHtml(formatDateTime(job.updatedAt || job.createdAt))}</p>
    `;
    elements.homeJobsList.appendChild(li);
  }
}

function renderMemories() {
  elements.memoryCount.textContent = `${state.memories.length} memories`;
  elements.memoryList.innerHTML = "";

  if (state.memories.length === 0) {
    elements.memoryList.innerHTML = '<li class="activity-item"><p>No memories yet.</p></li>';
    return;
  }

  for (const memory of state.memories) {
    const li = document.createElement("li");
    li.className = "activity-item";
    li.innerHTML = `
      <div class="activity-item-top">
        <strong>${escapeHtml(memory.scope)} memory</strong>
        <span class="ui-badge info">${escapeHtml(memory.scope)}</span>
      </div>
      <p>${escapeHtml(memory.text)}</p>
      <p class="mono">id: ${escapeHtml(memory.id)} · ${escapeHtml(formatDateTime(memory.updatedAt || memory.createdAt))}</p>
      <div class="item-actions"></div>
    `;

    const actions = li.querySelector(".item-actions");
    if (isAuthed()) {
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "ui-btn ui-btn-danger";
      deleteBtn.type = "button";
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", async () => {
        try {
          await apiFetch(`/api/memory/${memory.id}`, { method: "DELETE" });
          showToast("Memory deleted", { variant: "info" });
          await refreshMainData();
        } catch (error) {
          handleError(error);
        }
      });
      actions.appendChild(deleteBtn);
    }

    elements.memoryList.appendChild(li);
  }
}

function fillCardSelect(selectId, cards) {
  const select = document.getElementById(selectId);
  if (!select) {
    return;
  }

  if (cards.length === 0) {
    select.innerHTML = '<option value="">No cards</option>';
    return;
  }

  select.innerHTML = cards
    .map((card) => `<option value="${escapeHtml(card.id)}">${escapeHtml(card.name)} (${escapeHtml(card.rarity)})</option>`)
    .join("");
}

function renderOwnedCardsAndInventory() {
  elements.inventoryCount.textContent = `${state.ownedCards.length} cards`;
  elements.inventoryCardList.innerHTML = "";

  if (state.ownedCards.length === 0) {
    elements.inventoryCardList.innerHTML = '<li class="activity-item"><p>No owned cards.</p></li>';
  } else {
    for (const card of state.ownedCards.slice(0, 40)) {
      const li = document.createElement("li");
      li.className = "activity-item";
      li.innerHTML = `
        <div class="activity-item-top">
          <strong>${escapeHtml(card.name)}</strong>
          <span class="ui-badge ${badgeClassForStatus(card.rarity === "legendary" ? "success" : "info")}">${escapeHtml(card.rarity)}</span>
        </div>
        <p>class=${escapeHtml(card.cardClass)} · summon=${card.summonCost} · energy=${card.energy}</p>
        <p class="mono">atk ${card.baseStats?.attack ?? "-"} / def ${card.baseStats?.defense ?? "-"} / spd ${card.baseStats?.speed ?? "-"}</p>
      `;
      elements.inventoryCardList.appendChild(li);
    }
  }

  fillCardSelect("listing-card-id", state.ownedCards);
  fillCardSelect("card-update-id", state.ownedCards);
  renderDuelCardPool();
}

function renderMarketListings() {
  elements.marketListingList.innerHTML = "";
  if (state.marketListings.length === 0) {
    elements.marketListingList.innerHTML = '<li class="activity-item"><p>No listings available.</p></li>';
    return;
  }

  for (const listing of state.marketListings.slice(0, 40)) {
    const li = document.createElement("li");
    li.className = "activity-item";
    li.innerHTML = `
      <div class="activity-item-top">
        <strong>${escapeHtml(listing.cardName || listing.cardId)}</strong>
        <span class="ui-badge info">${escapeHtml(String(listing.priceCredits))} credits</span>
      </div>
      <p>seller=${escapeHtml(listing.sellerName || listing.sellerUserId)}</p>
      <p class="mono">${escapeHtml(formatDateTime(listing.createdAt))}</p>
      <div class="item-actions"></div>
    `;

    const canBuy = isAuthed() && state.me?.id && listing.sellerUserId !== state.me.id;
    const actions = li.querySelector(".item-actions");

    const buyBtn = document.createElement("button");
    buyBtn.type = "button";
    buyBtn.className = "ui-btn ui-btn-secondary";
    buyBtn.textContent = "Buy";
    buyBtn.disabled = !canBuy;
    buyBtn.addEventListener("click", async () => {
      if (!canBuy) {
        return;
      }
      try {
        const response = await apiFetch(`/api/marketplace/listings/${listing.id}/buy`, {
          method: "POST",
          body: {}
        });
        pushLocalEvent({
          title: "Marketplace purchase",
          description: `card=${listing.cardName || listing.cardId} · license=${response.licenseHash?.slice(0, 10) || "-"}`,
          status: "success"
        });
        showToast("Purchase completed", { variant: "success" });
        await refreshMainData();
      } catch (error) {
        handleError(error);
      }
    });
    actions.appendChild(buyBtn);

    elements.marketListingList.appendChild(li);
  }
}

function renderDuelCardPool() {
  elements.duelPool.innerHTML = "";
  if (state.ownedCards.length === 0) {
    elements.duelPool.innerHTML = '<p class="mono">No cards available for duels.</p>';
    return;
  }

  for (const [index, card] of state.ownedCards.slice(0, 20).entries()) {
    const checked = index < 3 ? "checked" : "";
    const wrapper = document.createElement("label");
    wrapper.className = "check-item";
    wrapper.innerHTML = `
      <input type="checkbox" name="duel-card" value="${escapeHtml(card.id)}" ${checked} />
      <span>${escapeHtml(card.name)} (${escapeHtml(card.rarity)})</span>
    `;
    elements.duelPool.appendChild(wrapper);
  }
}

function renderDuelResult() {
  if (!state.lastDuelResult) {
    elements.duelResult.innerHTML = '<p class="mono">No duel executed yet.</p>';
    return;
  }

  const duel = state.lastDuelResult;
  const isWin = duel.result === "win" || duel.result === "victory";
  const badge = badgeClassForStatus(isWin ? "success" : "warning");
  elements.duelResult.innerHTML = `
    <div class="activity-item-top">
      <strong>Result: ${escapeHtml(duel.result)}</strong>
      <span class="ui-badge ${badge}">${escapeHtml(duel.aiLevel)}</span>
    </div>
    <p>ELO Delta: ${duel.eloDelta} · Reward: ${duel.creativePointsReward}</p>
    <p class="mono">updated ${escapeHtml(formatDateTime(new Date().toISOString()))}</p>
  `;
}

function renderAgents() {
  elements.agentsCount.textContent = `${state.agents.length} agents`;
  elements.agentsList.innerHTML = "";
  if (state.agents.length === 0) {
    elements.agentsList.innerHTML = '<li class="activity-item"><p>No agents found.</p></li>';
    return;
  }

  for (const agent of state.agents.slice(0, 40)) {
    const li = document.createElement("li");
    li.className = "activity-item";
    li.innerHTML = `
      <div class="activity-item-top">
        <strong>${escapeHtml(agent.name)}</strong>
        <span class="ui-badge ${badgeClassForStatus(agent.status)}">${escapeHtml(agent.status)}</span>
      </div>
      <p>role=${escapeHtml(agent.role)} · scope=${escapeHtml(agent.memoryScope || "-")}</p>
      <p class="mono">id: ${escapeHtml(agent.id)}</p>
    `;
    elements.agentsList.appendChild(li);
  }
}

function renderCreatorStatus() {
  if (!state.creatorStatus) {
    elements.creatorsStatusCard.innerHTML = '<p class="mono">No session.</p>';
    return;
  }

  const app = state.creatorStatus.application;
  const roles = Array.isArray(state.creatorStatus.roles) ? state.creatorStatus.roles.join(", ") : "-";
  const permissions = Array.isArray(state.creatorStatus.permissions) ? state.creatorStatus.permissions.length : 0;
  elements.creatorsStatusCard.innerHTML = `
    <div class="activity-item-top">
      <strong>Application: ${escapeHtml(app?.status || "none")}</strong>
      <span class="ui-badge ${badgeClassForStatus(app?.status || "info")}">${escapeHtml(app?.status || "none")}</span>
    </div>
    <p>${escapeHtml(app?.message || "No application message")}</p>
    <p class="mono">roles: ${escapeHtml(roles)}</p>
    <p class="mono">permissions: ${permissions}</p>
  `;
}

function renderAiConfig() {
  const cfg = state.aiConfig;
  if (!cfg) {
    elements.aiProvider.value = "openai-compatible";
    elements.aiModel.value = "gpt-4.1-mini";
    elements.aiEndpoint.value = "https://api.openai.com/v1/chat/completions";
    elements.aiTemperature.value = "0.2";
    elements.aiMaxTokens.value = "600";
    elements.aiSystemPrompt.value = "";
    elements.aiEnabled.checked = false;
    elements.aiApiKey.value = "";
    elements.aiStatus.textContent = isAuthed() ? "No AI config loaded." : "Sign in to configure provider.";
    elements.aiMaskedKey.textContent = "API key: not configured";
    elements.aiTestOutput.textContent = "No test executed.";
    state.aiPermissionsDraft = defaultAiPermissions();
    state.aiPermissionsSync = "local-only";
    renderAiPermissions();
    return;
  }

  elements.aiProvider.value = cfg.provider || "openai-compatible";
  elements.aiModel.value = cfg.model || "gpt-4.1-mini";
  elements.aiEndpoint.value = cfg.endpoint || "";
  elements.aiTemperature.value = String(cfg.temperature ?? 0.2);
  elements.aiMaxTokens.value = String(cfg.maxTokens ?? 600);
  elements.aiSystemPrompt.value = cfg.systemPrompt || "";
  elements.aiEnabled.checked = Boolean(cfg.enabled);
  elements.aiApiKey.value = "";

  const status = cfg.enabled ? "enabled" : "disabled";
  const providerLine = `${cfg.provider || "provider?"} / ${cfg.model || "model?"}`;
  const updated = cfg.updatedAt ? ` · updated ${formatDateTime(cfg.updatedAt)}` : "";
  elements.aiStatus.textContent = `AI config ${status}: ${providerLine}${updated}`;

  const hasKey = Boolean(cfg.hasApiKey);
  const label = cfg.keysLabel ? ` (${cfg.keysLabel})` : "";
  elements.aiMaskedKey.textContent = hasKey ? `API key: stored${label}` : "API key: not configured";
  state.aiPermissionsDraft = normalizeAiPermissions(cfg.permissions);
  state.aiPermissionsSync = "synced";
  renderAiPermissions();
}

function renderAiPermissions() {
  const enabledCount = Object.values(state.aiPermissionsDraft).filter(Boolean).length;
  const totalCount = AI_PERMISSION_KEYS.length;
  const profile = detectAiPermissionsProfile(state.aiPermissionsDraft);

  const syncLabel =
    state.aiPermissionsSync === "synced"
      ? "backend synced"
      : state.aiPermissionsSync === "error"
        ? "sync error"
        : "local-only";
  elements.aiPermissionsSync.textContent = `Sync: ${syncLabel} · enabled ${enabledCount}/${totalCount}`;
  elements.aiPermissionsSync.className = `mono ${state.aiPermissionsSync === "synced" ? "sync-synced" : state.aiPermissionsSync === "error" ? "sync-error" : ""}`.trim();

  if (enabledCount === 0) {
    elements.aiPolicyState.className = "mono ai-policy-state state-off";
    elements.aiPolicyState.textContent = "Policy: bloqueada (0 permisos)";
  } else if (profile === "custom") {
    elements.aiPolicyState.className = "mono ai-policy-state state-custom";
    elements.aiPolicyState.textContent = `Policy: custom · ${enabledCount}/${totalCount}`;
  } else {
    elements.aiPolicyState.className = "mono ai-policy-state state-on";
    elements.aiPolicyState.textContent = `Policy: activa · ${profileLabel(profile)}`;
  }

  if (!isAuthed()) {
    elements.aiPermissionsHint.textContent = "Inicia sesion para sincronizar permisos al backend.";
  } else if (!Boolean(state.aiConfig?.enabled)) {
    elements.aiPermissionsHint.textContent = "Activa 'Enable this config' para que la AI use estos permisos.";
  } else if (enabledCount === 0) {
    elements.aiPermissionsHint.textContent = "AI habilitada pero policy en rojo: ninguna tool podra ejecutarse.";
  } else if (state.aiPermissionsSync !== "synced") {
    elements.aiPermissionsHint.textContent = "Permisos modificados localmente. Pulsa Save Permissions para sincronizar.";
  } else {
    elements.aiPermissionsHint.textContent = `Perfil activo: ${profileLabel(profile)}.`;
  }

  for (const button of elements.aiPermissionButtons) {
    const key = button.getAttribute("data-ai-perm-key");
    if (!key || !Object.prototype.hasOwnProperty.call(state.aiPermissionsDraft, key)) {
      continue;
    }

    const enabled = Boolean(state.aiPermissionsDraft[key]);
    button.classList.toggle("on", enabled);
    button.classList.toggle("off", !enabled);
    button.setAttribute("aria-pressed", String(enabled));
    const labelNode = button.querySelector("strong");
    if (labelNode) {
      labelNode.textContent = enabled ? "ON" : "OFF";
    }
  }
}

function renderReyMeshyPanel() {
  elements.reymeshyEnabled.checked = Boolean(state.reymeshyEnabled);

  const status = state.reymeshyStatus;
  if (!isAuthed()) {
    elements.reymeshyStatus.textContent = "Estado: inicia sesion para usar ReyMeshy.";
    elements.reymeshyTestBtn.disabled = true;
  } else if (!status) {
    elements.reymeshyStatus.textContent = "Estado: pendiente.";
    elements.reymeshyTestBtn.disabled = !state.reymeshyEnabled;
  } else if (status.error) {
    elements.reymeshyStatus.textContent = `Estado: error ${status.error}`;
    elements.reymeshyTestBtn.disabled = true;
  } else if (!status.enabledByServer) {
    elements.reymeshyStatus.textContent = "Estado: desactivado por servidor.";
    elements.reymeshyTestBtn.disabled = true;
  } else {
    const execName = status.sidecar?.executable || "sidecar";
    const pending = Number.isFinite(status?.queue?.pending) ? status.queue.pending : 0;
    const running = Number.isFinite(status?.queue?.running) ? status.queue.running : 0;
    const vramEnabled = Boolean(status?.vram?.enabled);
    const vramConstrained = Boolean(status?.vram?.constrained);
    const vramHealthy = status?.vram?.healthy !== false;
    const vramReason = typeof status?.vram?.reason === "string" ? status.vram.reason : "";

    if (vramEnabled && vramConstrained) {
      elements.reymeshyStatus.textContent = `Estado: VRAM constrained (${vramReason || "policy active"})`;
      elements.reymeshyTestBtn.disabled = true;
    } else if (vramEnabled && !vramHealthy) {
      elements.reymeshyStatus.textContent = "Estado: VRAM Sentinel no disponible (fail-open).";
      elements.reymeshyTestBtn.disabled = !state.reymeshyEnabled;
    } else {
      elements.reymeshyStatus.textContent = `Estado: listo (${execName}) | cola p=${pending} r=${running}`;
      elements.reymeshyTestBtn.disabled = !state.reymeshyEnabled;
    }
  }

  if (state.reymeshyBusy) {
    elements.reymeshyTestBtn.disabled = true;
  }

  elements.reymeshyOutput.textContent = state.reymeshyLastOutput || "Sin ejecucion.";
}

function normalizeCsvTags(raw) {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0)
    .filter((value, index, all) => all.indexOf(value) === index);
}

function syncVaultSelectors() {
  const projectOptions = state.projects
    .map(
      (project) =>
        `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name || project.id.slice(0, 8))}</option>`
    )
    .join("");
  elements.vaultLinkProjectId.innerHTML = projectOptions || '<option value="">No projects</option>';

  if (!state.vaultSelectedProjectId && state.projects.length > 0) {
    state.vaultSelectedProjectId = state.projects[0].id;
  }
  elements.vaultLinkProjectId.value = state.vaultSelectedProjectId || "";

  const assetOptions = state.vaultAssets
    .map((asset) => `<option value="${escapeHtml(asset.id)}">${escapeHtml(asset.name || asset.id.slice(0, 8))}</option>`)
    .join("");

  elements.vaultUploadAssetId.innerHTML = assetOptions || '<option value="">No assets</option>';
  elements.vaultLinkAssetId.innerHTML = assetOptions || '<option value="">No assets</option>';
}

function renderVaultPanel() {
  syncVaultSelectors();

  if (!isAuthed()) {
    elements.vaultAssetsList.innerHTML = '<li class="activity-item"><p class="mono">Inicia sesion para ver Asset Vault.</p></li>';
    elements.vaultProjectAssetsList.innerHTML = '<li class="activity-item"><p class="mono">Project assets bloqueado sin sesion.</p></li>';
    return;
  }

  if (!Array.isArray(state.vaultAssets) || state.vaultAssets.length === 0) {
    elements.vaultAssetsList.innerHTML = '<li class="activity-item"><p class="mono">Vault vacio. Crea el primer asset record.</p></li>';
  } else {
    elements.vaultAssetsList.innerHTML = state.vaultAssets
      .map((asset) => {
        const tags = Array.isArray(asset.tags) ? asset.tags.join(", ") : "-";
        return `
          <li class="activity-item">
            <div class="activity-item-top">
              <strong>${escapeHtml(asset.name || "asset")}</strong>
              <span class="ui-badge info">${escapeHtml(asset.type || "type?")}</span>
            </div>
            <p class="mono">id: ${escapeHtml(asset.id)}</p>
            <p>files=${escapeHtml(asset.filesCount ?? 0)} · tags=${escapeHtml(tags)}</p>
            <div class="item-actions">
              <button class="ui-btn ui-btn-secondary vault-link-inline-btn" type="button" data-vault-link-asset-id="${escapeHtml(asset.id)}">Add to Project</button>
            </div>
          </li>
        `;
      })
      .join("");
  }

  if (!Array.isArray(state.vaultProjectAssets) || state.vaultProjectAssets.length === 0) {
    elements.vaultProjectAssetsList.innerHTML =
      '<li class="activity-item"><p class="mono">Este proyecto no tiene assets linkeados.</p></li>';
  } else {
    elements.vaultProjectAssetsList.innerHTML = state.vaultProjectAssets
      .map((entry) => {
        const link = entry.link || {};
        const asset = entry.asset || {};
        return `
          <li class="activity-item">
            <div class="activity-item-top">
              <strong>${escapeHtml(asset.name || "asset")}</strong>
              <span class="ui-badge success">${escapeHtml(link.embedMode || "reference")}</span>
            </div>
            <p class="mono">assetId=${escapeHtml(link.assetId || asset.id || "-")}</p>
            <p>type=${escapeHtml(asset.type || "-")} · files=${escapeHtml(asset.filesCount ?? 0)}</p>
          </li>
        `;
      })
      .join("");
  }
}

function renderHybridPanel() {
  const status = state.hybridStatus;
  if (!isAuthed()) {
    elements.hybridStatusText.textContent = "Estado broker: inicia sesion para administrar toggles.";
    elements.hybridBudgetText.textContent = "Budget: sin sesion";
    elements.hybridProviderToggles.innerHTML = "";
    elements.hybridSaveBtn.disabled = true;
    return;
  }

  elements.hybridSaveBtn.disabled = false;

  if (!status || status.error) {
    elements.hybridStatusText.textContent = `Estado broker: ${status?.error ? `error ${status.error}` : "sin datos"}`;
    elements.hybridBudgetText.textContent = "Budget: --";
    elements.hybridProviderToggles.innerHTML = '<p class="mono">Sin providers disponibles.</p>';
    return;
  }

  const toggles = status.hybrid?.toggles || {};
  elements.hybridLocalEnabled.checked = Boolean(toggles.localEngineEnabled);
  elements.hybridApiEnabled.checked = Boolean(toggles.apiEngineEnabled);
  elements.hybridPreferLocal.checked = Boolean(toggles.preferLocalOverApi);

  const providersMeta = status.providersMeta || {};
  const processControlEnabled = Boolean(status.hybrid?.processControl?.enabledByEnv);
  elements.hybridStatusText.textContent = `Estado broker: providers=${providersMeta.providersCount ?? 0} · config=${providersMeta.version || "n/a"} · redis=${status.resultBus?.connected ? "online" : "offline"} · runtimeCtl=${processControlEnabled ? "on" : "off"}`;

  const budget = status.budget || {};
  elements.hybridBudgetText.textContent = `Budget ${budget.day || "-"}: $${Number(budget.spentUsd || 0).toFixed(2)} / $${Number(
    budget.dailyBudgetUsd || 0
  ).toFixed(2)} (restante $${Number(budget.remainingUsd || 0).toFixed(2)})`;

  const providerToggles = toggles.providers || {};
  const providers = Array.isArray(status.providers) ? status.providers : [];
  elements.hybridProviderToggles.innerHTML = providers
    .map((provider) => {
      const id = String(provider.id || "");
      const checked = providerToggles[id] !== false;
      const label = `${provider.name || id} [${provider.mode || "?"}]`;
      return `
        <label class="check-item">
          <input type="checkbox" data-hybrid-provider-id="${escapeHtml(id)}" ${checked ? "checked" : ""} />
          <span>${escapeHtml(label)}</span>
        </label>
      `;
    })
    .join("");
}

function renderHybridDispatchProviderOptions() {
  const selectedCategory = elements.hybridDispatchCategory.value || "GEOMETRY_3D";
  const providers = Array.isArray(state.hybridStatus?.providers) ? state.hybridStatus.providers : [];
  const currentValue = elements.hybridDispatchProviderId.value || "";
  const filtered = providers.filter((provider) => String(provider?.category || "") === selectedCategory);

  const options = [
    '<option value="">auto (router decide)</option>',
    ...filtered.map((provider) => {
      const id = String(provider.id || "");
      const mode = String(provider.mode || "?");
      const name = String(provider.name || id);
      return `<option value="${escapeHtml(id)}">${escapeHtml(name)} [${escapeHtml(mode)}]</option>`;
    })
  ];
  elements.hybridDispatchProviderId.innerHTML = options.join("");

  if (currentValue && filtered.some((provider) => String(provider.id || "") === currentValue)) {
    elements.hybridDispatchProviderId.value = currentValue;
  } else {
    elements.hybridDispatchProviderId.value = "";
  }
}

function renderHybridDispatchPanel() {
  elements.hybridDispatchOutput.textContent = state.hybridDispatchLastOutput || "Sin ejecucion.";
  const links = Array.isArray(state.hybridDispatchLinks) ? state.hybridDispatchLinks : [];
  if (links.length === 0) {
    elements.hybridDispatchLinks.innerHTML = "";
  } else {
    elements.hybridDispatchLinks.innerHTML = links
      .map((entry) => {
        const label = escapeHtml(entry.label || "artifact");
        const href = escapeHtml(entry.url || "#");
        return `<a class="ui-btn ui-btn-secondary" href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`;
      })
      .join("");
  }

  if (!isAuthed()) {
    elements.hybridDispatchStatus.textContent = "Estado dispatch: inicia sesion para ejecutar.";
    elements.hybridDispatchRunBtn.disabled = true;
    elements.hybridDispatchAsync.disabled = true;
    renderHybridDispatchProviderOptions();
    return;
  }

  if (!state.hybridStatus || state.hybridStatus.error) {
    elements.hybridDispatchStatus.textContent = "Estado dispatch: broker no disponible.";
    elements.hybridDispatchRunBtn.disabled = true;
    elements.hybridDispatchAsync.disabled = true;
    renderHybridDispatchProviderOptions();
    return;
  }

  elements.hybridDispatchRunBtn.disabled = Boolean(state.hybridDispatchBusy);
  elements.hybridDispatchAsync.disabled = Boolean(state.hybridDispatchBusy);

  if (state.hybridDispatchBusy) {
    const jobSuffix = state.hybridDispatchJobId ? ` job=${state.hybridDispatchJobId.slice(0, 8)} (${state.hybridDispatchJobStatus || "queued"})` : "";
    elements.hybridDispatchStatus.textContent = `Estado dispatch: ejecutando...${jobSuffix}`;
  } else if (state.hybridDispatchJobId) {
    elements.hybridDispatchStatus.textContent = `Estado dispatch: ultimo job ${state.hybridDispatchJobId.slice(0, 8)} (${state.hybridDispatchJobStatus || "-"})`;
  } else {
    elements.hybridDispatchStatus.textContent = "Estado dispatch: listo.";
  }

  renderHybridDispatchProviderOptions();
}

function updateQuickActionsState() {
  if (!isAuthed()) {
    elements.duelQuickBtn.disabled = true;
    elements.duelQuickBtn.setAttribute("data-tooltip", "Inicia sesion para habilitar duelos");
    return;
  }

  if (state.ownedCards.length === 0) {
    elements.duelQuickBtn.disabled = true;
    elements.duelQuickBtn.setAttribute("data-tooltip", "Necesitas cartas propias para iniciar duelo");
    return;
  }

  elements.duelQuickBtn.disabled = false;
  elements.duelQuickBtn.setAttribute("data-tooltip", "Ejecuta duelo rapido (novato)");
}

function handleError(error) {
  const status = error?.status ? ` [${error.status}]` : "";
  showToast(`${error.message || "Error inesperado"}${status}`, { variant: "error", durationMs: 3600 });
  if (error?.status === 401) {
    logout(false);
  }
}
async function loadProfile() {
  if (!isAuthed()) {
    state.me = null;
    return;
  }
  state.me = await apiFetch("/api/me");
}

async function loadOwnedCards() {
  if (!isAuthed() || !state.me?.id) {
    state.ownedCards = [];
    return;
  }
  const response = await apiFetch(`/api/cards?ownerUserId=${encodeURIComponent(state.me.id)}`);
  state.ownedCards = Array.isArray(response?.items) ? response.items : [];
}

async function loadFeaturedCard() {
  if (state.ownedCards.length > 0) {
    setFeaturedCard(state.ownedCards[0]);
    return;
  }
  const response = await apiFetch("/api/cards", { token: state.token || "" });
  const cards = Array.isArray(response?.items) ? response.items : [];
  setFeaturedCard(cards[0] || null);
}

async function loadTrainingJobs() {
  if (!isAuthed()) {
    state.trainingJobs = [];
    return;
  }
  const response = await apiFetch("/api/training/jobs");
  state.trainingJobs = Array.isArray(response?.items) ? response.items : [];
}

async function loadMarketListings() {
  const response = await apiFetch("/api/marketplace/listings", { token: state.token || "" });
  state.marketListings = Array.isArray(response?.items) ? response.items : [];
}

async function loadMemories() {
  if (!isAuthed()) {
    state.memories = [];
    return;
  }
  const response = await apiFetch("/api/memory?limit=30&offset=0");
  state.memories = Array.isArray(response?.items) ? response.items : [];
}

async function loadAgents() {
  if (!isAuthed()) {
    state.agents = [];
    return;
  }
  const response = await apiFetch("/api/agents");
  state.agents = Array.isArray(response?.items) ? response.items : [];
}

async function loadCreatorStatus() {
  if (!isAuthed()) {
    state.creatorStatus = null;
    return;
  }
  state.creatorStatus = await apiFetch("/api/creators/status");
}

async function loadAiConfig() {
  if (!isAuthed()) {
    state.aiConfig = null;
    return;
  }
  state.aiConfig = await apiFetch("/api/me/ai-config");
}

async function loadReyMeshyStatus() {
  if (!isAuthed()) {
    state.reymeshyStatus = null;
    return;
  }
  try {
    state.reymeshyStatus = await apiFetch("/api/reymeshy/status");
  } catch (error) {
    state.reymeshyStatus = {
      error: error?.message || "status unavailable"
    };
  }
}

async function loadProjects() {
  if (!isAuthed()) {
    state.projects = [];
    state.vaultSelectedProjectId = "";
    return;
  }

  try {
    const response = await apiFetch("/api/projects?limit=200&offset=0");
    state.projects = Array.isArray(response?.items) ? response.items : [];
    if (!state.vaultSelectedProjectId && state.projects.length > 0) {
      state.vaultSelectedProjectId = state.projects[0].id;
    }
  } catch (error) {
    state.projects = [];
    state.vaultSelectedProjectId = "";
    throw error;
  }
}

async function loadVaultAssets() {
  if (!isAuthed()) {
    state.vaultAssets = [];
    return;
  }

  try {
    const response = await apiFetch("/api/vault/assets?limit=100&offset=0");
    state.vaultAssets = Array.isArray(response?.items) ? response.items : [];
  } catch (error) {
    state.vaultAssets = [];
    throw error;
  }
}

async function loadVaultProjectAssets() {
  if (!isAuthed() || !state.vaultSelectedProjectId) {
    state.vaultProjectAssets = [];
    return;
  }

  try {
    const response = await apiFetch(`/api/vault/projects/${encodeURIComponent(state.vaultSelectedProjectId)}/assets?includeFiles=0`);
    state.vaultProjectAssets = Array.isArray(response?.items) ? response.items : [];
  } catch (error) {
    state.vaultProjectAssets = [];
    throw error;
  }
}

async function loadHybridStatus() {
  if (!isAuthed()) {
    state.hybridStatus = null;
    return;
  }

  try {
    state.hybridStatus = await apiFetch("/api/mcp/hybrid/status");
  } catch (error) {
    state.hybridStatus = {
      error: error?.message || "status unavailable"
    };
  }
}

function renderAll() {
  updateAuthButton();
  renderProfileMini();
  setAuthLocks();
  updateQuickActionsState();
  renderHomeStats();
  renderHomeJobs();
  renderActivityFeed();
  renderMemories();
  renderOwnedCardsAndInventory();
  renderMarketListings();
  renderDuelResult();
  renderAgents();
  renderCreatorStatus();
  renderAiConfig();
  renderReyMeshyPanel();
  renderHybridPanel();
  renderHybridDispatchPanel();
  renderVaultPanel();
}

async function refreshMainData() {
  await loadProfile();
  await Promise.all([
    loadOwnedCards(),
    loadTrainingJobs(),
    loadMarketListings(),
    loadMemories(),
    loadAgents(),
    loadCreatorStatus(),
    loadAiConfig(),
    loadReyMeshyStatus(),
    loadProjects().catch(() => {}),
    loadVaultAssets().catch(() => {}),
    loadHybridStatus()
  ]);
  await loadVaultProjectAssets().catch(() => {});
  await loadFeaturedCard();
  renderAll();
}

async function login(username, password) {
  const response = await apiFetch("/api/auth/login", {
    method: "POST",
    body: { username, password },
    token: ""
  });
  state.token = response.token;
  setToken(state.token);
  closeModal("app-auth-modal");
  showToast(`Bienvenido ${response.user?.username || username}`, { variant: "success" });
  await refreshMainData();
}

async function register(username, password) {
  const response = await apiFetch("/api/auth/register", {
    method: "POST",
    body: { username, password },
    token: ""
  });
  state.token = response.token;
  setToken(state.token);
  closeModal("app-auth-modal");
  showToast(`Cuenta creada ${response.user?.username || username}`, { variant: "success" });
  await refreshMainData();
}

function logout(showMessage = true) {
  state.token = "";
  setToken("");
  state.me = null;
  state.trainingJobs = [];
  state.ownedCards = [];
  state.memories = [];
  state.agents = [];
  state.creatorStatus = null;
  state.aiConfig = null;
  state.aiPermissionsDraft = defaultAiPermissions();
  state.aiPermissionsSync = "local-only";
  state.reymeshyStatus = null;
  state.reymeshyBusy = false;
  state.reymeshyLastOutput = "Sin ejecucion.";
  state.hybridStatus = null;
  state.hybridDispatchBusy = false;
  state.hybridDispatchLastOutput = "Sin ejecucion.";
  state.hybridDispatchJobId = "";
  state.hybridDispatchJobStatus = "";
  state.hybridDispatchLinks = [];
  state.projects = [];
  state.vaultAssets = [];
  state.vaultProjectAssets = [];
  state.vaultSelectedProjectId = "";
  state.lastDuelResult = null;
  updateAuthButton();
  renderAll();
  setFeaturedCard(null);
  if (showMessage) {
    showToast("Sesion cerrada", { variant: "info" });
  }
}

function getSelectedDuelCardIds() {
  return Array.from(elements.duelPool.querySelectorAll("input[name='duel-card']:checked")).map((item) => item.value);
}

async function startDuel(aiLevel, cardIds) {
  if (!isAuthed()) {
    showToast("Inicia sesion para iniciar duelo", { variant: "warning" });
    return;
  }
  if (!Array.isArray(cardIds) || cardIds.length < 1 || cardIds.length > 10) {
    showToast("Selecciona entre 1 y 10 cartas", { variant: "warning" });
    return;
  }

  try {
    const response = await apiFetch("/api/duels/ai", {
      method: "POST",
      body: {
        aiLevel,
        cardIds
      }
    });

    state.lastDuelResult = response;
    if (state.me && response.user) {
      state.me.elo = response.user.elo;
      state.me.creativePoints = response.user.creativePoints;
    }

    pushLocalEvent({
      title: `Duel ${response.result}`,
      description: `ai=${response.aiLevel} · eloDelta=${response.eloDelta} · reward=${response.creativePointsReward}`,
      status: response.result === "win" || response.result === "victory" ? "success" : "warning"
    });

    renderDuelResult();
    renderProfileMini();
    renderActivityFeed();
    showToast(`Duel ${response.result}`, { variant: "success" });
  } catch (error) {
    handleError(error);
  }
}
function bindEvents() {
  elements.navToggle.addEventListener("click", () => {
    const isOpen = elements.layoutRoot.classList.contains("sidebar-open");
    setSidebarOpen(!isOpen);
  });

  elements.sidebarOverlay.addEventListener("click", () => {
    setSidebarOpen(false);
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 1180) {
      setSidebarOpen(false);
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      setSidebarOpen(false);
    }
  });

  elements.nav.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const item = target ? target.closest(".app-nav-item") : null;
    if (!item) {
      return;
    }
    setActiveSection(item.getAttribute("data-section") || "home");
  });

  elements.authBtn.addEventListener("click", (event) => {
    if (!isAuthed()) {
      return;
    }
    event.preventDefault();
    logout(true);
  });

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = document.getElementById("app-login-username").value.trim();
    const password = document.getElementById("app-login-password").value;
    try {
      await login(username, password);
    } catch (error) {
      handleError(error);
    }
  });

  elements.registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = document.getElementById("app-register-username").value.trim();
    const password = document.getElementById("app-register-password").value;
    try {
      await register(username, password);
    } catch (error) {
      handleError(error);
    }
  });

  elements.feedRefreshBtn.addEventListener("click", async () => {
    renderSkeletonRows(elements.activityList, 5);
    renderSkeletonRows(elements.homeJobsList, 4);
    try {
      await refreshMainData();
      showToast("Feed updated", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.createDeckBtn.addEventListener("click", () => {
    setActiveSection("editor");
  });

  elements.openEditorBtn.addEventListener("click", () => {
    setActiveSection("editor");
  });

  elements.duelQuickBtn.addEventListener("click", async () => {
    const cardIds = state.ownedCards.slice(0, 3).map((item) => item.id);
    await startDuel("novato", cardIds);
    setActiveSection("duelos");
  });

  elements.memoryRefreshBtn.addEventListener("click", async () => {
    try {
      await loadMemories();
      renderMemories();
      renderHomeStats();
      renderActivityFeed();
      showToast("Memories refreshed", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.memoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const scope = document.getElementById("memory-scope").value;
    const projectId = document.getElementById("memory-project-id").value.trim();
    const agentId = document.getElementById("memory-agent-id").value.trim();
    const text = document.getElementById("memory-text").value.trim();
    const metadataRaw = document.getElementById("memory-metadata").value.trim();

    let metadata = {};
    if (metadataRaw.length > 0) {
      try {
        metadata = JSON.parse(metadataRaw);
      } catch {
        showToast("Metadata JSON invalido", { variant: "error" });
        return;
      }
    }

    try {
      await apiFetch("/api/memory", {
        method: "POST",
        body: {
          scope,
          projectId: projectId || undefined,
          agentId: agentId || undefined,
          text,
          metadata
        }
      });
      elements.memoryForm.reset();
      document.getElementById("memory-metadata").value = "{}";
      showToast("Memory saved", { variant: "success" });
      await refreshMainData();
    } catch (error) {
      handleError(error);
    }
  });

  elements.inventoryRefreshBtn.addEventListener("click", async () => {
    try {
      await Promise.all([loadOwnedCards(), loadMarketListings()]);
      renderOwnedCardsAndInventory();
      renderMarketListings();
      renderHomeStats();
      renderActivityFeed();
      updateQuickActionsState();
      showToast("Inventory refreshed", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.listingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const cardId = document.getElementById("listing-card-id").value;
    const price = Number(document.getElementById("listing-price").value);

    if (!cardId) {
      showToast("Selecciona una carta", { variant: "warning" });
      return;
    }

    try {
      await apiFetch("/api/marketplace/listings", {
        method: "POST",
        body: {
          cardId,
          priceCredits: price
        }
      });
      pushLocalEvent({
        title: "Listing published",
        description: `cardId=${cardId} · price=${price}`,
        status: "success"
      });
      showToast("Listing created", { variant: "success" });
      await refreshMainData();
    } catch (error) {
      handleError(error);
    }
  });

  elements.duelForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const aiLevel = document.getElementById("duel-ai-level").value;
    const cardIds = getSelectedDuelCardIds();
    await startDuel(aiLevel, cardIds);
  });
  elements.cardCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const abilities = document
      .getElementById("card-abilities")
      .value.split(",")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);

    try {
      await apiFetch("/api/cards", {
        method: "POST",
        body: {
          name: document.getElementById("card-name").value.trim(),
          rarity: document.getElementById("card-rarity").value,
          cardClass: document.getElementById("card-class").value.trim(),
          abilities,
          summonCost: Number(document.getElementById("card-summon-cost").value),
          energy: Number(document.getElementById("card-energy").value),
          baseStats: {
            attack: Number(document.getElementById("card-atk").value),
            defense: Number(document.getElementById("card-def").value),
            speed: Number(document.getElementById("card-spd").value)
          }
        }
      });

      showToast("Card created", { variant: "success" });
      pushLocalEvent({
        title: "Card created",
        description: document.getElementById("card-name").value.trim(),
        status: "success"
      });
      await refreshMainData();
    } catch (error) {
      handleError(error);
    }
  });

  elements.cardUpdateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const cardId = document.getElementById("card-update-id").value;
    if (!cardId) {
      showToast("Selecciona una carta", { variant: "warning" });
      return;
    }

    try {
      await apiFetch(`/api/cards/${cardId}/stats`, {
        method: "PUT",
        body: {
          attack: Number(document.getElementById("card-update-atk").value),
          defense: Number(document.getElementById("card-update-def").value),
          speed: Number(document.getElementById("card-update-spd").value)
        }
      });

      showToast("Card stats updated", { variant: "success" });
      await refreshMainData();
    } catch (error) {
      handleError(error);
    }
  });

  elements.agentsRefreshBtn.addEventListener("click", async () => {
    try {
      await loadAgents();
      renderAgents();
      renderHomeStats();
      showToast("Agents refreshed", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.agentsCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const name = document.getElementById("agent-name").value.trim();
    const role = document.getElementById("agent-role").value.trim();
    const memoryScope = document.getElementById("agent-memory-scope").value;
    const detail = document.getElementById("agent-detail").value.trim();

    try {
      await apiFetch("/api/agents", {
        method: "POST",
        body: {
          name,
          role,
          memoryScope,
          detail: detail || undefined
        }
      });
      elements.agentsCreateForm.reset();
      showToast("Agent created", { variant: "success" });
      await refreshMainData();
    } catch (error) {
      handleError(error);
    }
  });

  elements.creatorsApplyForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    try {
      await apiFetch("/api/creators/apply", {
        method: "POST",
        body: {
          message: document.getElementById("creators-apply-message").value.trim() || undefined
        }
      });
      showToast("Creator application submitted", { variant: "success" });
      await refreshMainData();
    } catch (error) {
      handleError(error);
    }
  });

  elements.creatorsRedeemForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const code = document.getElementById("creators-invite-code").value.trim();
    if (!code) {
      showToast("Ingresa un codigo", { variant: "warning" });
      return;
    }

    try {
      await apiFetch("/api/creators/redeem-invite", {
        method: "POST",
        body: { code }
      });
      showToast("Invite redeemed", { variant: "success" });
      await refreshMainData();
    } catch (error) {
      handleError(error);
    }
  });

  elements.aiConfigForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const payload = {
      provider: elements.aiProvider.value.trim(),
      model: elements.aiModel.value.trim(),
      endpoint: elements.aiEndpoint.value.trim() || undefined,
      apiKey: elements.aiApiKey.value.trim() || undefined,
      temperature: Number(elements.aiTemperature.value),
      maxTokens: Number(elements.aiMaxTokens.value),
      systemPrompt: elements.aiSystemPrompt.value.trim(),
      enabled: elements.aiEnabled.checked
    };

    try {
      state.aiConfig = await apiFetch("/api/me/ai-config", {
        method: "PUT",
        body: payload
      });
      state.aiPermissionsSync = "synced";
      renderAiConfig();
      showToast("AI config saved", { variant: "success" });
    } catch (error) {
      state.aiPermissionsSync = "error";
      handleError(error);
    }
  });

  elements.aiClearKeyBtn.addEventListener("click", async () => {
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    try {
      state.aiConfig = await apiFetch("/api/me/ai-config", {
        method: "PUT",
        body: {
          provider: elements.aiProvider.value.trim(),
          model: elements.aiModel.value.trim(),
          endpoint: elements.aiEndpoint.value.trim() || undefined,
          temperature: Number(elements.aiTemperature.value),
          maxTokens: Number(elements.aiMaxTokens.value),
          systemPrompt: elements.aiSystemPrompt.value.trim(),
          enabled: false,
          clearApiKey: true
        }
      });
      state.aiPermissionsSync = "synced";
      renderAiConfig();
      showToast("API key removed", { variant: "info" });
    } catch (error) {
      state.aiPermissionsSync = "error";
      handleError(error);
    }
  });

  elements.aiConfigTestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    try {
      const result = await apiFetch("/api/me/ai-config/test", {
        method: "POST",
        body: {
          prompt: elements.aiTestPrompt.value.trim()
        }
      });
      elements.aiTestOutput.textContent = `${result.output}\n\nprovider=${result.provider} model=${result.model} duration=${result.durationMs}ms`;
      showToast("Provider test OK", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.reymeshyEnabled.addEventListener("change", () => {
    state.reymeshyEnabled = elements.reymeshyEnabled.checked;
    saveReyMeshyTogglePreference(state.reymeshyEnabled);
    renderReyMeshyPanel();
    showToast(`ReyMeshy ${state.reymeshyEnabled ? "activado" : "desactivado"} en esta app`, {
      variant: "info"
    });
  });

  elements.reymeshyTestBtn.addEventListener("click", async () => {
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }
    if (!state.reymeshyEnabled) {
      showToast("Activa el toggle de ReyMeshy para ejecutar cleanup", { variant: "warning" });
      return;
    }

    try {
      state.reymeshyBusy = true;
      state.reymeshyLastOutput = "Creando job de cleanup...";
      renderReyMeshyPanel();
      let response;
      try {
        response = await runReyMeshyCleanupJob(sampleReyMeshyMesh(), ({ jobId, status }) => {
          state.reymeshyLastOutput = `Job ${String(jobId).slice(0, 8)}: ${status}...`;
          renderReyMeshyPanel();
        });
      } catch (error) {
        if (error?.status === 404 || error?.status === 405) {
          response = await apiFetch("/api/reymeshy/cleanup", {
            method: "POST",
            body: {
              mesh: sampleReyMeshyMesh()
            }
          });
        } else {
          throw error;
        }
      }
      state.reymeshyLastOutput = `OK input=${response.summary?.inputTriangles ?? "-"} tris -> output=${response.summary?.outputTriangles ?? "-"} tris`;
      pushLocalEvent({
        title: "ReyMeshy cleanup",
        description: state.reymeshyLastOutput,
        status: "success"
      });
      renderActivityFeed();
      showToast("ReyMeshy cleanup ejecutado", { variant: "success" });
    } catch (error) {
      state.reymeshyLastOutput = `Error: ${error?.message || "cleanup failed"}`;
      handleError(error);
    } finally {
      state.reymeshyBusy = false;
      renderReyMeshyPanel();
    }
  });

  for (const button of elements.aiPermissionButtons) {
    button.addEventListener("click", () => {
      const key = button.getAttribute("data-ai-perm-key");
      if (!key || !Object.prototype.hasOwnProperty.call(state.aiPermissionsDraft, key)) {
        return;
      }
      state.aiPermissionsDraft[key] = !state.aiPermissionsDraft[key];
      state.aiPermissionsSync = "local-only";
      renderAiPermissions();
    });
  }

  elements.aiDisablePermissionsBtn.addEventListener("click", () => {
    state.aiPermissionsDraft = defaultAiPermissions();
    state.aiPermissionsSync = "local-only";
    renderAiPermissions();
  });

  function applyPermissionProfile(profile) {
    state.aiPermissionsDraft = aiPermissionsProfile(profile);
    state.aiPermissionsSync = "local-only";
    renderAiPermissions();
    showToast(`Perfil aplicado: ${profileLabel(profile)}`, { variant: "info" });
  }

  elements.aiPermissionsSafeBtn.addEventListener("click", () => {
    applyPermissionProfile("safe");
  });

  elements.aiPermissionsBuilderBtn.addEventListener("click", () => {
    applyPermissionProfile("modeling");
  });

  elements.aiPermissionsAgentsBtn.addEventListener("click", () => {
    applyPermissionProfile("agents");
  });

  elements.aiPermissionsFullBtn.addEventListener("click", () => {
    applyPermissionProfile("full");
  });

  elements.aiPermissionsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    try {
      const payload = {
        permissions: normalizeAiPermissions(state.aiPermissionsDraft)
      };
      const response = await apiFetch("/api/me/ai-config/permissions", {
        method: "PUT",
        body: payload
      });
      state.aiConfig = response;
      state.aiPermissionsDraft = normalizeAiPermissions(response.permissions);
      state.aiPermissionsSync = "synced";
      renderAiConfig();
      showToast("AI permissions saved", { variant: "success" });
    } catch (error) {
      state.aiPermissionsSync = "error";
      renderAiPermissions();
      handleError(error);
    }
  });

  elements.hybridRefreshBtn.addEventListener("click", async () => {
    try {
      await loadHybridStatus();
      renderHybridPanel();
      renderHybridDispatchPanel();
      showToast("Hybrid broker refreshed", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.hybridBudgetResetBtn.addEventListener("click", async () => {
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const accepted = window.confirm("Resetear budget diario híbrido a $0.00 para hoy?");
    if (!accepted) {
      return;
    }

    try {
      const reset = await apiFetch("/api/mcp/hybrid/budget/reset", {
        method: "POST",
        body: {
          reason: "manual reset from app settings"
        }
      });
      await loadHybridStatus();
      renderHybridPanel();
      renderHybridDispatchPanel();
      showToast(
        `Budget reset ${reset?.day || "-"}: ${Number(reset?.previousSpentUsd || 0).toFixed(2)} -> ${Number(
          reset?.budget?.spentUsd || 0
        ).toFixed(2)}`,
        { variant: "success" }
      );
    } catch (error) {
      handleError(error);
    }
  });

  elements.hybridBrokerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const providersPatch = {};
    for (const checkbox of elements.hybridProviderToggles.querySelectorAll("[data-hybrid-provider-id]")) {
      const providerId = checkbox.getAttribute("data-hybrid-provider-id");
      if (!providerId) {
        continue;
      }
      providersPatch[providerId] = Boolean(checkbox.checked);
    }

    try {
      const update = await apiFetch("/api/mcp/hybrid/toggles", {
        method: "PUT",
        body: {
          localEngineEnabled: elements.hybridLocalEnabled.checked,
          apiEngineEnabled: elements.hybridApiEnabled.checked,
          preferLocalOverApi: elements.hybridPreferLocal.checked,
          providers: providersPatch
        }
      });
      await loadHybridStatus();
      renderHybridPanel();
      renderHybridDispatchPanel();
      const runtimeControl = update?.runtimeControl || null;
      if (runtimeControl?.action === "stop-local-runtimes") {
        showToast(`Hybrid toggles guardados · runtime stop ${runtimeControl.stoppedTargets || 0}`, { variant: "success" });
        return;
      }
      if (runtimeControl?.action === "skipped" && runtimeControl?.reason === "disabled_by_env") {
        showToast("Hybrid toggles guardados · runtimeCtl desactivado por servidor", { variant: "info" });
        return;
      }
      showToast("Hybrid toggles guardados", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.hybridDispatchCategory.addEventListener("change", () => {
    renderHybridDispatchProviderOptions();
  });

  elements.hybridDispatchClearBtn.addEventListener("click", () => {
    state.hybridDispatchLastOutput = "Sin ejecucion.";
    state.hybridDispatchJobId = "";
    state.hybridDispatchJobStatus = "";
    state.hybridDispatchLinks = [];
    elements.hybridDispatchPayload.value = "{}";
    elements.hybridDispatchPrompt.value = "";
    renderHybridDispatchPanel();
  });

  elements.hybridDispatchForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }
    if (!state.hybridStatus || state.hybridStatus.error) {
      showToast("Hybrid broker no disponible", { variant: "warning" });
      return;
    }

    const category = elements.hybridDispatchCategory.value || "GEOMETRY_3D";
    const providerIdRaw = elements.hybridDispatchProviderId.value.trim();
    const promptRaw = elements.hybridDispatchPrompt.value.trim();
    const payloadRaw = elements.hybridDispatchPayload.value.trim() || "{}";
    const runAsync = Boolean(elements.hybridDispatchAsync.checked);

    let payload = {};
    try {
      payload = JSON.parse(payloadRaw);
    } catch {
      showToast("Payload JSON invalido", { variant: "error" });
      return;
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      showToast("Payload debe ser un objeto JSON", { variant: "error" });
      return;
    }

    if (promptRaw.length > 0 && typeof payload.prompt !== "string") {
      payload.prompt = promptRaw;
    }

    const input = {
      category,
      payload
    };
    if (providerIdRaw.length > 0) {
      input.providerId = providerIdRaw;
    }
    if (promptRaw.length > 0) {
      input.prompt = promptRaw;
    }

    try {
      state.hybridDispatchBusy = true;
      state.hybridDispatchJobId = "";
      state.hybridDispatchJobStatus = "";
      state.hybridDispatchLinks = [];
      state.hybridDispatchLastOutput = "Ejecutando hybrid.dispatch...";
      renderHybridDispatchPanel();

      let summary;
      if (runAsync) {
        const job = await runHybridDispatchJob(input, ({ jobId, status }) => {
          state.hybridDispatchJobId = String(jobId || "");
          state.hybridDispatchJobStatus = String(status || "queued");
          state.hybridDispatchLastOutput = `Hybrid dispatch job ${state.hybridDispatchJobId || "-"}: ${state.hybridDispatchJobStatus}`;
          renderHybridDispatchPanel();
        });
        summary = toHybridDispatchSummaryFromJob(job, category);
      } else {
        const response = await apiFetch("/api/mcp/execute", {
          method: "POST",
          body: {
            tool: "hybrid.dispatch",
            async: false,
            input
          }
        });
        summary = toHybridDispatchSummary(response, category);
      }

      state.hybridDispatchLastOutput = JSON.stringify(summary, null, 2);
      state.hybridDispatchLinks = collectHybridDispatchLinks(summary?.result || null);

      await loadHybridStatus();
      renderHybridPanel();
      renderHybridDispatchPanel();
      if (state.hybridDispatchLinks.length > 0) {
        showToast("Hybrid dispatch completado · artifact links listos", { variant: "success" });
      } else {
        showToast("Hybrid dispatch ejecutado", { variant: "success" });
      }
    } catch (error) {
      state.hybridDispatchLinks = [];
      state.hybridDispatchLastOutput = `Error: ${error?.message || "hybrid.dispatch failed"}`;
      renderHybridDispatchPanel();
      handleError(error);
    } finally {
      state.hybridDispatchBusy = false;
      renderHybridDispatchPanel();
    }
  });

  elements.vaultRefreshBtn.addEventListener("click", async () => {
    try {
      await Promise.all([loadProjects(), loadVaultAssets()]);
      await loadVaultProjectAssets();
      renderVaultPanel();
      showToast("Vault refreshed", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.vaultLinkProjectId.addEventListener("change", async () => {
    state.vaultSelectedProjectId = elements.vaultLinkProjectId.value || "";
    try {
      await loadVaultProjectAssets();
      renderVaultPanel();
    } catch (error) {
      handleError(error);
    }
  });

  elements.vaultAssetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    try {
      const payload = {
        type: elements.vaultAssetType.value,
        name: elements.vaultAssetName.value.trim(),
        tags: normalizeCsvTags(elements.vaultAssetTags.value),
        source: "import",
        dedupeHash: elements.vaultAssetDedupe.value.trim() || undefined
      };
      await apiFetch("/api/vault/assets", {
        method: "POST",
        body: payload
      });
      elements.vaultAssetForm.reset();
      elements.vaultAssetType.value = "model";
      await loadVaultAssets();
      syncVaultSelectors();
      renderVaultPanel();
      showToast("Asset record creado", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.vaultUploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const assetId = elements.vaultUploadAssetId.value;
    const role = elements.vaultUploadRole.value.trim() || "file";
    const file = elements.vaultUploadFile.files && elements.vaultUploadFile.files[0] ? elements.vaultUploadFile.files[0] : null;

    if (!assetId) {
      showToast("Selecciona un asset", { variant: "warning" });
      return;
    }
    if (!file) {
      showToast("Selecciona un archivo", { variant: "warning" });
      return;
    }

    try {
      const response = await fetch(`/api/vault/upload?assetId=${encodeURIComponent(assetId)}&role=${encodeURIComponent(role)}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${state.token}`,
          "x-client-platform": "web",
          "x-file-name": file.name,
          "x-file-mime": file.type || "application/octet-stream",
          "Content-Type": "application/octet-stream"
        },
        body: file
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const message = body?.error || `Upload failed (${response.status})`;
        throw new Error(message);
      }

      elements.vaultUploadForm.reset();
      elements.vaultUploadRole.value = "model";
      await Promise.all([loadVaultAssets(), loadVaultProjectAssets()]);
      renderVaultPanel();
      showToast(body?.deduped ? "Archivo ya existia (dedupe)" : "Archivo subido al vault", {
        variant: body?.deduped ? "info" : "success"
      });
    } catch (error) {
      handleError(error);
    }
  });

  elements.vaultLinkForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!isAuthed()) {
      showToast("Inicia sesion primero", { variant: "warning" });
      return;
    }

    const projectId = elements.vaultLinkProjectId.value;
    const assetId = elements.vaultLinkAssetId.value;
    const embedMode = elements.vaultLinkEmbedMode.value || "reference";
    if (!projectId || !assetId) {
      showToast("Selecciona project y asset", { variant: "warning" });
      return;
    }

    let overrides = {};
    const overridesRaw = elements.vaultLinkOverrides.value.trim();
    if (overridesRaw.length > 0) {
      try {
        overrides = JSON.parse(overridesRaw);
      } catch {
        showToast("Overrides JSON invalido", { variant: "error" });
        return;
      }
    }

    try {
      await apiFetch(`/api/vault/assets/${encodeURIComponent(assetId)}/link`, {
        method: "POST",
        body: {
          projectId,
          embedMode,
          overrides
        }
      });
      state.vaultSelectedProjectId = projectId;
      await loadVaultProjectAssets();
      renderVaultPanel();
      showToast("Asset linkeado al proyecto", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.vaultAssetsList.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target ? target.closest(".vault-link-inline-btn") : null;
    if (!button) {
      return;
    }

    const assetId = button.getAttribute("data-vault-link-asset-id");
    if (!assetId) {
      return;
    }

    if (!state.vaultSelectedProjectId) {
      showToast("Crea o selecciona un proyecto antes de linkear", { variant: "warning" });
      return;
    }

    try {
      await apiFetch(`/api/vault/assets/${encodeURIComponent(assetId)}/link`, {
        method: "POST",
        body: {
          projectId: state.vaultSelectedProjectId,
          embedMode: "reference",
          overrides: {}
        }
      });
      await loadVaultProjectAssets();
      renderVaultPanel();
      showToast("Asset agregado al proyecto", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });
}

async function bootstrap() {
  assertDomBindings();
  bindModalSystem();
  initTabs(elements.authSwitcher);
  bindEvents();

  setFeaturedCard(null);
  renderAll();
  updateClock();
  state.clockTimer = window.setInterval(updateClock, 1000);

  await refreshHealth();
  state.healthTimer = window.setInterval(() => {
    void refreshHealth();
  }, HEALTH_POLL_MS);

  renderSkeletonRows(elements.activityList, 5);
  renderSkeletonRows(elements.homeJobsList, 4);
  try {
    await refreshMainData();
  } catch (error) {
    handleError(error);
  }
}

bootstrap();
