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
  aiPermissionButtons: Array.from(document.querySelectorAll("[data-ai-perm-key]"))
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
}

async function refreshMainData() {
  await loadProfile();
  await Promise.all([loadOwnedCards(), loadTrainingJobs(), loadMarketListings(), loadMemories(), loadAgents(), loadCreatorStatus(), loadAiConfig()]);
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
