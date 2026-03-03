import {
  apiFetch,
  badgeClassForStatus,
  fetchBackendHealth,
  formatDateTime,
  getClientPlatform,
  getToken,
  initTabs,
  renderSkeletonRows,
  setClientPlatform,
  setToken,
  showToast
} from "/shared/ui.js";

const POLL_MS = 2800;
const TAB_MODULE_MAP = {
  agentEditor: "agentEditor",
  connection: "connection",
  rules: "rulesConsole",
  skills: "skillsCatalog",
  tools: "tools",
  memory: "memory",
  training: "training",
  trainingOps: "trainingOps",
  sandbox: "sandbox",
  marketplace: "marketplace"
};

function newWorkspace() {
  return {
    agents: [],
    skills: [],
    tools: [],
    memories: [],
    templates: [],
    globalRules: [],
    projectRules: [],
    agentDetails: {},
    errors: {},
    selectedProjectId: "",
    selectedAgentId: "",
    selectedSkillId: "",
    selectedToolKey: "",
    selectedTemplateId: "",
    lastSkillRun: null,
    lastSandbox: null,
    lastImport: null,
    trainingOpsMetrics: null,
    trainingOpsAlerts: [],
    trainingOpsDlqItems: []
  };
}

const state = {
  token: getToken(),
  me: null,
  acsHome: null,
  projects: [],
  jobs: [],
  workspace: newWorkspace(),
  pollTimer: null,
  healthTimer: null
};

const elements = {
  health: document.getElementById("console-health"),
  platformSelect: document.getElementById("console-platform-select"),
  authSwitcher: document.getElementById("console-auth-switcher"),
  moduleSwitcher: document.getElementById("console-module-switcher"),
  moduleTabs: document.getElementById("console-module-tabs"),
  authPanels: document.getElementById("console-auth-panels"),
  loginForm: document.getElementById("console-login-form"),
  registerForm: document.getElementById("console-register-form"),
  authNote: document.getElementById("console-auth-note"),
  logoutBtn: document.getElementById("console-logout-btn"),
  refreshBtn: document.getElementById("console-refresh-btn"),
  acsRefreshBtn: document.getElementById("console-acs-refresh-btn"),
  modulesRefreshBtn: document.getElementById("console-modules-refresh-btn"),
  modulesStatus: document.getElementById("console-modules-status"),
  profileCard: document.getElementById("console-profile-card"),
  acsSummary: document.getElementById("console-acs-summary"),
  acsCounts: document.getElementById("console-acs-counts"),
  acsModules: document.getElementById("console-acs-modules"),
  acsTraining: document.getElementById("console-acs-training"),
  contextProject: document.getElementById("console-context-project"),
  contextAgent: document.getElementById("console-context-agent"),
  projectForm: document.getElementById("console-project-form"),
  projectList: document.getElementById("console-project-list"),
  projectCount: document.getElementById("console-project-count"),
  trainingForm: document.getElementById("console-training-form"),
  trainingList: document.getElementById("console-job-list"),
  trainingCount: document.getElementById("console-job-count"),
  trainingOpsMetrics: document.getElementById("console-training-ops-metrics"),
  trainingOpsAlerts: document.getElementById("console-training-ops-alerts"),
  trainingOpsDlqList: document.getElementById("console-training-ops-dlq-list"),
  trainingOpsDlqLimit: document.getElementById("console-training-ops-dlq-limit"),
  trainingOpsDlqOffset: document.getElementById("console-training-ops-dlq-offset"),
  trainingOpsRemoveOriginal: document.getElementById("console-training-ops-remove-original"),
  trainingOpsRefreshMetricsBtn: document.getElementById("console-training-ops-refresh-metrics"),
  trainingOpsRefreshDlqBtn: document.getElementById("console-training-ops-refresh-dlq"),
  trainingOpsBatchRequeueBtn: document.getElementById("console-training-ops-dlq-batch-requeue"),
  agentCreateForm: document.getElementById("console-agent-create-form"),
  agentCreateName: document.getElementById("console-agent-create-name"),
  agentCreateRole: document.getElementById("console-agent-create-role"),
  agentCreateMemoryScope: document.getElementById("console-agent-create-memory-scope"),
  agentList: document.getElementById("console-agent-list"),
  agentConnectForm: document.getElementById("console-agent-connect-form"),
  connectAgentId: document.getElementById("console-connect-agent-id"),
  connectProvider: document.getElementById("console-connect-provider"),
  connectModel: document.getElementById("console-connect-model"),
  connectApiKey: document.getElementById("console-connect-api-key"),
  agentDisconnectBtn: document.getElementById("console-agent-disconnect-btn"),
  connectionState: document.getElementById("console-connection-state"),
  projectRuleForm: document.getElementById("console-project-rule-form"),
  ruleTitle: document.getElementById("console-rule-title"),
  ruleContent: document.getElementById("console-rule-content"),
  ruleEnforcement: document.getElementById("console-rule-enforcement"),
  rulePriority: document.getElementById("console-rule-priority"),
  rulesGlobalList: document.getElementById("console-rules-global-list"),
  rulesProjectList: document.getElementById("console-rules-project-list"),
  skillTestsForm: document.getElementById("console-skill-tests-form"),
  skillId: document.getElementById("console-skill-id"),
  skillMaxTests: document.getElementById("console-skill-max-tests"),
  skillTestsOutput: document.getElementById("console-skill-tests-output"),
  skillsList: document.getElementById("console-skills-list"),
  agentToolForm: document.getElementById("console-agent-tool-form"),
  toolAgentId: document.getElementById("console-tool-agent-id"),
  toolKey: document.getElementById("console-tool-key"),
  toolConfig: document.getElementById("console-tool-config"),
  toolAllowed: document.getElementById("console-tool-allowed"),
  toolsList: document.getElementById("console-tools-list"),
  memoryCreateForm: document.getElementById("console-memory-create-form"),
  memoryScope: document.getElementById("console-memory-scope"),
  memoryText: document.getElementById("console-memory-text"),
  memoryMetadata: document.getElementById("console-memory-metadata"),
  memoryList: document.getElementById("console-memory-list"),
  sandboxForm: document.getElementById("console-sandbox-form"),
  sandboxAgentId: document.getElementById("console-sandbox-agent-id"),
  sandboxInput: document.getElementById("console-sandbox-input"),
  sandboxOutput: document.getElementById("console-sandbox-output"),
  templateImportForm: document.getElementById("console-template-import-form"),
  importTemplateId: document.getElementById("console-import-template-id"),
  importName: document.getElementById("console-import-name"),
  marketplaceOutput: document.getElementById("console-marketplace-output"),
  marketplaceList: document.getElementById("console-marketplace-list")
};

function assertDomBindings() {
  for (const [name, value] of Object.entries(elements)) {
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

function moduleInfoByKey() {
  const map = new Map();
  if (!Array.isArray(state.acsHome?.modules)) {
    return map;
  }
  for (const item of state.acsHome.modules) {
    if (item?.key) {
      map.set(item.key, item);
    }
  }
  return map;
}

function tabAllowed(tabId) {
  const key = TAB_MODULE_MAP[tabId];
  if (!key) {
    return { allowed: true, reason: null };
  }
  const info = moduleInfoByKey().get(key);
  if (!info) {
    return { allowed: true, reason: null };
  }
  return {
    allowed: Boolean(info.available),
    reason: typeof info.reason === "string" ? info.reason : null
  };
}

function requireTab(tabId) {
  const info = tabAllowed(tabId);
  if (info.allowed) {
    return true;
  }
  showToast(info.reason || `Module ${tabId} blocked`, { variant: "warning" });
  return false;
}

function handleError(error) {
  const status = error?.status ? ` [${error.status}]` : "";
  showToast(`${error.message || "Error inesperado"}${status}`, { variant: "error", durationMs: 3800 });
  if (error?.status === 401) {
    logout(false);
  }
}

function setSessionEnabled(enabled) {
  const forms = [
    elements.projectForm,
    elements.trainingForm,
    elements.agentCreateForm,
    elements.agentConnectForm,
    elements.projectRuleForm,
    elements.skillTestsForm,
    elements.agentToolForm,
    elements.memoryCreateForm,
    elements.sandboxForm,
    elements.templateImportForm
  ];
  for (const form of forms) {
    form.classList.toggle("console-disabled", !enabled);
  }
  elements.logoutBtn.classList.toggle("hidden", !enabled);
  elements.authNote.textContent = enabled ? "Sesion activa. Operaciones habilitadas." : "Sin sesion activa.";
}

function setWorkspaceStatus(text, variant = "info") {
  elements.modulesStatus.className = `ui-badge ${variant}`;
  elements.modulesStatus.textContent = text;
}

function renderProfile() {
  if (!state.me) {
    elements.profileCard.className = "console-empty";
    elements.profileCard.textContent = "Inicia sesion para cargar perfil.";
    return;
  }

  const roles = Array.isArray(state.me.roles) ? state.me.roles.join(", ") : state.me.role ?? "-";
  const permissionsCount = Array.isArray(state.me.permissions) ? state.me.permissions.length : 0;

  elements.profileCard.className = "console-profile-grid";
  elements.profileCard.innerHTML = `
    <article class="console-profile-cell"><strong>User</strong><span>${escapeHtml(state.me.username)}</span></article>
    <article class="console-profile-cell"><strong>Primary Role</strong><span>${escapeHtml(state.me.role)}</span></article>
    <article class="console-profile-cell"><strong>Roles</strong><span>${escapeHtml(roles)}</span></article>
    <article class="console-profile-cell"><strong>Permissions</strong><span>${permissionsCount}</span></article>
    <article class="console-profile-cell"><strong>Creative Points</strong><span>${state.me.creativePoints ?? "-"}</span></article>
    <article class="console-profile-cell"><strong>ELO</strong><span>${state.me.elo ?? "-"}</span></article>
    <article class="console-profile-cell"><strong>Platform</strong><span>${escapeHtml(state.me.platform || getClientPlatform())}</span></article>
  `;
}

function renderAcsHome() {
  if (!state.acsHome) {
    elements.acsSummary.className = "console-empty";
    elements.acsSummary.textContent = "Inicia sesion para cargar ACS Home.";
    elements.acsCounts.innerHTML = "";
    elements.acsModules.innerHTML = "";
    elements.acsTraining.innerHTML = "";
    return;
  }

  const creator = state.acsHome.creator || {};
  const roles = Array.isArray(state.acsHome?.user?.roles) ? state.acsHome.user.roles.join(", ") : "-";

  elements.acsSummary.className = "console-profile-grid";
  elements.acsSummary.innerHTML = `
    <article class="console-profile-cell"><strong>Client Platform</strong><span>${escapeHtml(state.acsHome.platform || "web")}</span></article>
    <article class="console-profile-cell"><strong>Creator</strong><span>${creator.isApprovedCreator ? "approvedCreator" : "user"} (${escapeHtml(creator.applicationStatus || "none")})</span></article>
    <article class="console-profile-cell"><strong>Roles</strong><span>${escapeHtml(roles)}</span></article>
    <article class="console-profile-cell"><strong>Permissions</strong><span>${Array.isArray(state.acsHome?.user?.permissions) ? state.acsHome.user.permissions.length : 0}</span></article>
  `;

  const counts = state.acsHome.counts && typeof state.acsHome.counts === "object" ? state.acsHome.counts : {};
  elements.acsCounts.innerHTML = "";
  const entries = Object.entries(counts);
  if (entries.length === 0) {
    elements.acsCounts.innerHTML = '<article class="console-chip"><strong>Counts</strong><span>Not requested</span></article>';
  } else {
    for (const [key, value] of entries) {
      const node = document.createElement("article");
      node.className = "console-chip";
      node.innerHTML = `<strong>${escapeHtml(key)}</strong><span>${escapeHtml(value)}</span>`;
      elements.acsCounts.appendChild(node);
    }
  }

  elements.acsModules.innerHTML = "";
  const modules = Array.isArray(state.acsHome.modules) ? state.acsHome.modules : [];
  if (modules.length === 0) {
    elements.acsModules.innerHTML = '<li class="console-item"><p class="console-item-meta">No modules reported.</p></li>';
  } else {
    for (const module of modules) {
      const li = document.createElement("li");
      li.className = "console-item";
      li.innerHTML = `
        <div class="console-item-top">
          <div>
            <h3 class="console-item-title">${escapeHtml(module.title || module.key || "module")}</h3>
            <p class="console-item-meta mono">key: ${escapeHtml(module.key || "-")}</p>
            <p class="console-module-line">${escapeHtml(module.reason || "ready")}</p>
          </div>
          <span class="ui-badge ${module.available ? "success" : "warning"}">${module.available ? "available" : "blocked"}</span>
        </div>
      `;
      elements.acsModules.appendChild(li);
    }
  }

  elements.acsTraining.innerHTML = "";
  const modes = Array.isArray(state.acsHome.trainingModes) ? state.acsHome.trainingModes : [];
  if (modes.length === 0) {
    elements.acsTraining.innerHTML = '<li class="console-item"><p class="console-item-meta">No training mode rules.</p></li>';
  } else {
    for (const mode of modes) {
      const li = document.createElement("li");
      li.className = "console-item";
      li.innerHTML = `
        <div class="console-item-top">
          <div>
            <h3 class="console-item-title">${escapeHtml(mode.mode || "mode")}</h3>
            <p class="console-item-meta mono">requiredPlatform: ${escapeHtml(mode.requiredPlatform || "any")}</p>
          </div>
          <span class="ui-badge ${mode.allowed ? "success" : "warning"}">${mode.allowed ? "allowed" : "desktop-only"}</span>
        </div>
      `;
      elements.acsTraining.appendChild(li);
    }
  }

  updateModuleTabAvailability();
}

function renderProjects() {
  elements.projectCount.textContent = `${state.projects.length} items`;
  elements.projectList.innerHTML = "";
  if (state.projects.length === 0) {
    elements.projectList.innerHTML = '<li class="console-item"><p class="console-item-meta">No hay proyectos.</p></li>';
    return;
  }

  for (const project of state.projects) {
    const li = document.createElement("li");
    li.className = "console-item";
    li.innerHTML = `
      <div class="console-item-top">
        <div>
          <h3 class="console-item-title">${escapeHtml(project.name || "Untitled")}</h3>
          <p class="console-item-meta">${escapeHtml(project.description || "Sin descripcion")}</p>
          <p class="console-item-meta mono">id: ${escapeHtml(project.id)}</p>
        </div>
        <span class="ui-badge ${badgeClassForStatus(project.status)}">${escapeHtml(project.status || "unknown")}</span>
      </div>
      <div class="console-item-actions"></div>
    `;

    if (String(project.status) === "active") {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ui-btn ui-btn-secondary";
      button.textContent = "Archive";
      button.addEventListener("click", async () => {
        try {
          await apiFetch(`/api/projects/${project.id}`, { method: "DELETE" });
          showToast("Proyecto archivado", { variant: "success" });
          await loadProjects();
          await loadProjectRules();
          renderWorkspace();
        } catch (error) {
          handleError(error);
        }
      });
      li.querySelector(".console-item-actions").appendChild(button);
    }

    elements.projectList.appendChild(li);
  }
}

function renderJobs() {
  elements.trainingCount.textContent = `${state.jobs.length} items`;
  elements.trainingList.innerHTML = "";
  if (state.jobs.length === 0) {
    elements.trainingList.innerHTML = '<li class="console-item"><p class="console-item-meta">No hay training jobs.</p></li>';
    return;
  }

  for (const job of state.jobs) {
    const li = document.createElement("li");
    li.className = "console-item";
    li.innerHTML = `
      <div class="console-item-top">
        <div>
          <h3 class="console-item-title">${escapeHtml(job.mode)} - ${escapeHtml(job.platform)}</h3>
          <p class="console-item-meta">${escapeHtml(job.errorMessage || "Sin error")}</p>
          <p class="console-item-meta mono">id: ${escapeHtml(job.id)} | updated: ${escapeHtml(formatDateTime(job.updatedAt))}</p>
        </div>
        <span class="ui-badge ${badgeClassForStatus(job.status)}">${escapeHtml(job.status || "unknown")}</span>
      </div>
      <div class="console-item-actions"></div>
    `;

    if (["queued", "running"].includes(String(job.status))) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ui-btn ui-btn-danger";
      button.textContent = "Cancel";
      button.addEventListener("click", async () => {
        try {
          await apiFetch(`/api/training/jobs/${job.id}/cancel`, { method: "POST", body: {} });
          showToast("Training cancelado", { variant: "info" });
          await loadJobs();
        } catch (error) {
          handleError(error);
        }
      });
      li.querySelector(".console-item-actions").appendChild(button);
    }

    elements.trainingList.appendChild(li);
  }
}

function optionize(items, valueKey, labelFn) {
  return items.map((item) => ({ value: String(item[valueKey]), label: labelFn(item) }));
}

function fillSelect(select, options, selected, emptyLabel) {
  select.innerHTML = "";
  if (options.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.appendChild(option);
    return "";
  }

  for (const item of options) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    select.appendChild(option);
  }

  const values = new Set(options.map((item) => item.value));
  const resolved = values.has(selected) ? selected : options[0].value;
  select.value = resolved;
  return resolved;
}

function renderWorkspaceSelectors() {
  const projectOptions = optionize(
    state.projects.filter((project) => String(project.status) === "active"),
    "id",
    (project) => `${project.name || "Untitled"} (${project.id.slice(0, 8)})`
  );
  state.workspace.selectedProjectId = fillSelect(elements.contextProject, projectOptions, state.workspace.selectedProjectId, "No projects");

  const agentOptions = optionize(state.workspace.agents, "id", (agent) => `${agent.name || "Agent"} [${agent.status || "unknown"}]`);
  state.workspace.selectedAgentId = fillSelect(elements.contextAgent, agentOptions, state.workspace.selectedAgentId, "No agents");
  elements.connectAgentId.value = fillSelect(elements.connectAgentId, agentOptions, state.workspace.selectedAgentId, "No agents");
  elements.toolAgentId.value = fillSelect(elements.toolAgentId, agentOptions, state.workspace.selectedAgentId, "No agents");
  elements.sandboxAgentId.value = fillSelect(elements.sandboxAgentId, agentOptions, state.workspace.selectedAgentId, "No agents");

  const skillOptions = optionize(state.workspace.skills, "id", (skill) => `${skill.name}@${skill.version} (${skill.environment})`);
  state.workspace.selectedSkillId = fillSelect(elements.skillId, skillOptions, state.workspace.selectedSkillId, "No skills");

  const toolOptions = optionize(state.workspace.tools, "key", (tool) => `${tool.key} (${tool.enabledForUser ? "enabled" : "blocked"})`);
  state.workspace.selectedToolKey = fillSelect(elements.toolKey, toolOptions, state.workspace.selectedToolKey, "No tools");

  const templateOptions = optionize(
    state.workspace.templates,
    "id",
    (template) => `${template.name || "Template"} [${template.templateKey || "keyless"} v${template.version || "-"}]`
  );
  state.workspace.selectedTemplateId = fillSelect(elements.importTemplateId, templateOptions, state.workspace.selectedTemplateId, "No templates");
}

function renderAgents() {
  elements.agentList.innerHTML = "";
  if (state.workspace.errors.agents) {
    elements.agentList.innerHTML = `<li class="console-item"><p class="console-item-meta">${escapeHtml(state.workspace.errors.agents)}</p></li>`;
    return;
  }
  if (state.workspace.agents.length === 0) {
    elements.agentList.innerHTML = '<li class="console-item"><p class="console-item-meta">No hay agentes.</p></li>';
    return;
  }

  for (const agent of state.workspace.agents) {
    const li = document.createElement("li");
    li.className = "console-item";
    li.innerHTML = `
      <div class="console-item-top">
        <div>
          <h3 class="console-item-title">${escapeHtml(agent.name || "Agent")}</h3>
          <p class="console-item-meta">role=${escapeHtml(agent.role || "-")} · memory=${escapeHtml(agent.memoryScope || "-")}</p>
          <p class="console-item-meta mono">id: ${escapeHtml(agent.id)}</p>
        </div>
        <span class="ui-badge ${badgeClassForStatus(agent.status)}">${escapeHtml(agent.status || "unknown")}</span>
      </div>
      <div class="console-item-actions">
        <button type="button" class="ui-btn ui-btn-secondary" data-agent-action="select" data-agent-id="${escapeHtml(agent.id)}">Select</button>
        <button type="button" class="ui-btn ui-btn-secondary" data-agent-action="detail" data-agent-id="${escapeHtml(agent.id)}">Detail</button>
        <button type="button" class="ui-btn ui-btn-secondary" data-agent-action="duplicate" data-agent-id="${escapeHtml(agent.id)}">Duplicate</button>
        <button type="button" class="ui-btn ui-btn-secondary" data-agent-action="suspend" data-agent-id="${escapeHtml(agent.id)}">Suspend</button>
        <button type="button" class="ui-btn ui-btn-danger" data-agent-action="delete" data-agent-id="${escapeHtml(agent.id)}">Delete</button>
      </div>
    `;
    elements.agentList.appendChild(li);
  }
}

function renderConnection() {
  const agentId = state.workspace.selectedAgentId;
  if (!agentId) {
    elements.connectionState.className = "console-empty";
    elements.connectionState.textContent = "No agent selected.";
    return;
  }
  const detail = state.workspace.agentDetails[agentId];
  if (!detail || !detail.connection) {
    elements.connectionState.className = "console-empty";
    elements.connectionState.textContent = "Load agent detail to inspect connection state.";
    return;
  }

  const connection = detail.connection;
  elements.connectionState.className = "console-profile-grid";
  elements.connectionState.innerHTML = `
    <article class="console-profile-cell"><strong>Status</strong><span>${escapeHtml(connection.status || detail.status || "unknown")}</span></article>
    <article class="console-profile-cell"><strong>Provider / Model</strong><span>${escapeHtml(connection.provider || "-")} / ${escapeHtml(connection.model || "-")}</span></article>
    <article class="console-profile-cell"><strong>keysRef</strong><span>${escapeHtml(connection.keysRef || "none")}</span></article>
    <article class="console-profile-cell"><strong>Connected At</strong><span>${escapeHtml(formatDateTime(connection.connectedAt))}</span></article>
  `;
}

function renderRules() {
  elements.rulesGlobalList.innerHTML = "";
  if (state.workspace.errors.rulesGlobal) {
    elements.rulesGlobalList.innerHTML = `<li class="console-item"><p class="console-item-meta">${escapeHtml(state.workspace.errors.rulesGlobal)}</p></li>`;
  } else if (state.workspace.globalRules.length === 0) {
    elements.rulesGlobalList.innerHTML = '<li class="console-item"><p class="console-item-meta">No global rules visible.</p></li>';
  } else {
    for (const rule of state.workspace.globalRules) {
      const li = document.createElement("li");
      li.className = "console-item";
      li.innerHTML = `
        <div class="console-item-top">
          <div>
            <h3 class="console-item-title">${escapeHtml(rule.title)}</h3>
            <p class="console-item-meta">${escapeHtml(rule.content)}</p>
            <p class="console-item-meta mono">priority=${escapeHtml(rule.priority)} · active=${escapeHtml(rule.active)}</p>
          </div>
          <span class="ui-badge ${rule.enforcement === "hard" ? "warning" : "info"}">${escapeHtml(rule.enforcement)}</span>
        </div>
      `;
      elements.rulesGlobalList.appendChild(li);
    }
  }

  elements.rulesProjectList.innerHTML = "";
  if (state.workspace.errors.rulesProject) {
    elements.rulesProjectList.innerHTML = `<li class="console-item"><p class="console-item-meta">${escapeHtml(state.workspace.errors.rulesProject)}</p></li>`;
    return;
  }
  if (state.workspace.projectRules.length === 0) {
    elements.rulesProjectList.innerHTML = '<li class="console-item"><p class="console-item-meta">No project rules for selected project.</p></li>';
    return;
  }

  for (const rule of state.workspace.projectRules) {
    const li = document.createElement("li");
    li.className = "console-item";
    li.innerHTML = `
      <div class="console-item-top">
        <div>
          <h3 class="console-item-title">${escapeHtml(rule.title)}</h3>
          <p class="console-item-meta">${escapeHtml(rule.content)}</p>
          <p class="console-item-meta mono">project=${escapeHtml(rule.projectId)} · priority=${escapeHtml(rule.priority)}</p>
        </div>
        <span class="ui-badge ${rule.enforcement === "hard" ? "warning" : "info"}">${escapeHtml(rule.enforcement)}</span>
      </div>
    `;
    elements.rulesProjectList.appendChild(li);
  }
}

function renderSkills() {
  if (state.workspace.lastSkillRun) {
    const run = state.workspace.lastSkillRun;
    elements.skillTestsOutput.className = "console-profile-grid";
    elements.skillTestsOutput.innerHTML = `
      <article class="console-profile-cell"><strong>Skill</strong><span>${escapeHtml(run.skillId || "-")}</span></article>
      <article class="console-profile-cell"><strong>Status</strong><span>${escapeHtml(run.status || "-")}</span></article>
      <article class="console-profile-cell"><strong>Passed / Failed</strong><span>${escapeHtml(run.passed)} / ${escapeHtml(run.failed)}</span></article>
      <article class="console-profile-cell"><strong>Total</strong><span>${escapeHtml(run.total)}</span></article>
    `;
  } else {
    elements.skillTestsOutput.className = "console-empty";
    elements.skillTestsOutput.textContent = "Run tests to see validation results.";
  }

  elements.skillsList.innerHTML = "";
  if (state.workspace.errors.skills) {
    elements.skillsList.innerHTML = `<li class="console-item"><p class="console-item-meta">${escapeHtml(state.workspace.errors.skills)}</p></li>`;
    return;
  }
  if (state.workspace.skills.length === 0) {
    elements.skillsList.innerHTML = '<li class="console-item"><p class="console-item-meta">No skills available.</p></li>';
    return;
  }

  for (const skill of state.workspace.skills) {
    const li = document.createElement("li");
    li.className = "console-item";
    li.innerHTML = `
      <div class="console-item-top">
        <div>
          <h3 class="console-item-title">${escapeHtml(skill.name)} @ ${escapeHtml(skill.version)}</h3>
          <p class="console-item-meta">${escapeHtml(skill.description || "")}</p>
          <p class="console-item-meta mono">env=${escapeHtml(skill.environment)} · tools=${escapeHtml((skill.requiredTools || []).length)}</p>
        </div>
        <span class="ui-badge ${badgeClassForStatus(skill.status)}">${escapeHtml(skill.status || "unknown")}</span>
      </div>
    `;
    elements.skillsList.appendChild(li);
  }
}

function renderTools() {
  elements.toolsList.innerHTML = "";
  if (state.workspace.errors.tools) {
    elements.toolsList.innerHTML = `<li class="console-item"><p class="console-item-meta">${escapeHtml(state.workspace.errors.tools)}</p></li>`;
    return;
  }
  if (state.workspace.tools.length === 0) {
    elements.toolsList.innerHTML = '<li class="console-item"><p class="console-item-meta">No tools registry entries.</p></li>';
    return;
  }

  for (const tool of state.workspace.tools) {
    const li = document.createElement("li");
    li.className = "console-item";
    li.innerHTML = `
      <div class="console-item-top">
        <div>
          <h3 class="console-item-title">${escapeHtml(tool.key)}</h3>
          <p class="console-item-meta">${escapeHtml(tool.description || "")}</p>
          <p class="console-item-meta mono">requiredPermission=${escapeHtml(tool.requiredPermission || "-")}</p>
        </div>
        <span class="ui-badge ${tool.enabledForUser ? "success" : "warning"}">${tool.enabledForUser ? "enabled" : "blocked"}</span>
      </div>
    `;
    elements.toolsList.appendChild(li);
  }
}

function renderMemories() {
  elements.memoryList.innerHTML = "";
  if (state.workspace.errors.memories) {
    elements.memoryList.innerHTML = `<li class="console-item"><p class="console-item-meta">${escapeHtml(state.workspace.errors.memories)}</p></li>`;
    return;
  }
  if (state.workspace.memories.length === 0) {
    elements.memoryList.innerHTML = '<li class="console-item"><p class="console-item-meta">No memories.</p></li>';
    return;
  }

  for (const memory of state.workspace.memories) {
    const li = document.createElement("li");
    li.className = "console-item";
    li.innerHTML = `
      <div class="console-item-top">
        <div>
          <h3 class="console-item-title">${escapeHtml(memory.scope)} memory</h3>
          <p class="console-item-meta">${escapeHtml(memory.text)}</p>
          <p class="console-item-meta mono">id=${escapeHtml(memory.id)} · ${escapeHtml(formatDateTime(memory.updatedAt || memory.createdAt))}</p>
        </div>
        <span class="ui-badge info">${escapeHtml(memory.scope)}</span>
      </div>
      <div class="console-item-actions"><button type="button" class="ui-btn ui-btn-danger" data-memory-delete-id="${escapeHtml(memory.id)}">Delete</button></div>
    `;
    elements.memoryList.appendChild(li);
  }
}

function renderSandbox() {
  if (!state.workspace.lastSandbox) {
    elements.sandboxOutput.className = "console-empty";
    elements.sandboxOutput.textContent = "Run sandbox checks to validate rules/tools/skills integrity.";
    return;
  }
  const run = state.workspace.lastSandbox;
  elements.sandboxOutput.className = "console-profile-grid";
  elements.sandboxOutput.innerHTML = `
    <article class="console-profile-cell"><strong>Status</strong><span>${escapeHtml(run.status || "unknown")}</span></article>
    <article class="console-profile-cell"><strong>Test Id</strong><span>${escapeHtml(run.testId || "-")}</span></article>
    <article class="console-profile-cell"><strong>Issues</strong><span>${Array.isArray(run.issues) ? run.issues.length : 0}</span></article>
    <article class="console-profile-cell"><strong>Hard Rules</strong><span>${escapeHtml(run.checks?.hardRules)}</span></article>
  `;
}

function renderMarketplace() {
  if (!state.workspace.lastImport) {
    elements.marketplaceOutput.className = "console-empty";
    elements.marketplaceOutput.textContent = "Import status appears here.";
  } else {
    const info = state.workspace.lastImport;
    elements.marketplaceOutput.className = "console-profile-grid";
    elements.marketplaceOutput.innerHTML = `
      <article class="console-profile-cell"><strong>Template</strong><span>${escapeHtml(info.templateId || "-")}</span></article>
      <article class="console-profile-cell"><strong>Imported Agent</strong><span>${escapeHtml(info.agentId || "-")}</span></article>
      <article class="console-profile-cell"><strong>Status</strong><span>${escapeHtml(info.status || "-")}</span></article>
      <article class="console-profile-cell"><strong>Version</strong><span>${escapeHtml(info.templateVersion || "-")}</span></article>
    `;
  }

  elements.marketplaceList.innerHTML = "";
  if (state.workspace.errors.templates) {
    elements.marketplaceList.innerHTML = `<li class="console-item"><p class="console-item-meta">${escapeHtml(state.workspace.errors.templates)}</p></li>`;
    return;
  }
  if (state.workspace.templates.length === 0) {
    elements.marketplaceList.innerHTML = '<li class="console-item"><p class="console-item-meta">No templates available.</p></li>';
    return;
  }

  for (const template of state.workspace.templates) {
    const li = document.createElement("li");
    li.className = "console-item";
    li.innerHTML = `
      <div class="console-item-top">
        <div>
          <h3 class="console-item-title">${escapeHtml(template.name || "Template")}</h3>
          <p class="console-item-meta">${escapeHtml(template.description || "")}</p>
          <p class="console-item-meta mono">id=${escapeHtml(template.id)} · key=${escapeHtml(template.templateKey || "-")} · v=${escapeHtml(template.version || "-")}</p>
        </div>
        <span class="ui-badge info">imports ${escapeHtml(template.importsCount || 0)}</span>
      </div>
      <div class="console-item-actions"><button type="button" class="ui-btn ui-btn-secondary" data-template-import-id="${escapeHtml(template.id)}">Quick Import</button></div>
    `;
    elements.marketplaceList.appendChild(li);
  }
}

function parseBoundedInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const rounded = Math.trunc(numeric);
  return Math.min(max, Math.max(min, rounded));
}

function trainingOpsQueryFromInputs() {
  const limit = parseBoundedInteger(elements.trainingOpsDlqLimit.value, 20, 1, 200);
  const offset = parseBoundedInteger(elements.trainingOpsDlqOffset.value, 0, 0, 20_000);
  elements.trainingOpsDlqLimit.value = String(limit);
  elements.trainingOpsDlqOffset.value = String(offset);
  return { limit, offset };
}

function renderTrainingOps() {
  const metricsError = state.workspace.errors.trainingOpsMetrics;
  const metrics = state.workspace.trainingOpsMetrics;
  if (metricsError) {
    elements.trainingOpsMetrics.className = "console-empty";
    elements.trainingOpsMetrics.textContent = metricsError;
  } else if (!metrics) {
    elements.trainingOpsMetrics.className = "console-empty";
    elements.trainingOpsMetrics.textContent = "Training queue metrics pending.";
  } else {
    elements.trainingOpsMetrics.className = "console-profile-grid";
    elements.trainingOpsMetrics.innerHTML = `
      <article class="console-profile-cell"><strong>Backend</strong><span>${escapeHtml(metrics.backend || "-")}</span></article>
      <article class="console-profile-cell"><strong>Queue</strong><span>${escapeHtml(metrics.queueName || "-")}</span></article>
      <article class="console-profile-cell"><strong>DLQ</strong><span>${escapeHtml(metrics.dlqName || "-")}</span></article>
      <article class="console-profile-cell"><strong>Updated</strong><span>${escapeHtml(formatDateTime(metrics.timestamp))}</span></article>
      <article class="console-profile-cell"><strong>Main waiting/active</strong><span>${escapeHtml(metrics.queue?.waiting ?? 0)} / ${escapeHtml(metrics.queue?.active ?? 0)}</span></article>
      <article class="console-profile-cell"><strong>Main failed/delayed</strong><span>${escapeHtml(metrics.queue?.failed ?? 0)} / ${escapeHtml(metrics.queue?.delayed ?? 0)}</span></article>
      <article class="console-profile-cell"><strong>DLQ waiting/active</strong><span>${escapeHtml(metrics.dlq?.waiting ?? 0)} / ${escapeHtml(metrics.dlq?.active ?? 0)}</span></article>
      <article class="console-profile-cell"><strong>DLQ failed/delayed</strong><span>${escapeHtml(metrics.dlq?.failed ?? 0)} / ${escapeHtml(metrics.dlq?.delayed ?? 0)}</span></article>
    `;
  }

  elements.trainingOpsAlerts.innerHTML = "";
  const alerts = Array.isArray(state.workspace.trainingOpsAlerts) ? state.workspace.trainingOpsAlerts : [];
  if (alerts.length === 0) {
    elements.trainingOpsAlerts.innerHTML = '<li class="console-item"><p class="console-item-meta">No queue alerts.</p></li>';
  } else {
    for (const alert of alerts) {
      const li = document.createElement("li");
      li.className = "console-item";
      li.innerHTML = `<p class="console-item-meta">${escapeHtml(alert)}</p>`;
      elements.trainingOpsAlerts.appendChild(li);
    }
  }

  elements.trainingOpsDlqList.innerHTML = "";
  if (state.workspace.errors.trainingOpsDlq) {
    elements.trainingOpsDlqList.innerHTML = `<li class="console-item"><p class="console-item-meta">${escapeHtml(state.workspace.errors.trainingOpsDlq)}</p></li>`;
    return;
  }

  const items = Array.isArray(state.workspace.trainingOpsDlqItems) ? state.workspace.trainingOpsDlqItems : [];
  if (items.length === 0) {
    elements.trainingOpsDlqList.innerHTML = '<li class="console-item"><p class="console-item-meta">DLQ empty.</p></li>';
    return;
  }

  for (const item of items) {
    const li = document.createElement("li");
    li.className = "console-item";
    li.innerHTML = `
      <div class="console-item-top">
        <div>
          <h3 class="console-item-title">${escapeHtml(item.payload?.jobId || "unknown-job")}</h3>
          <p class="console-item-meta">${escapeHtml(item.payload?.reason || "no reason")}</p>
          <p class="console-item-meta mono">dlq=${escapeHtml(item.id)} · state=${escapeHtml(item.state)} · attempts=${escapeHtml(item.attemptsMade)}</p>
          <p class="console-item-meta mono">failedAt=${escapeHtml(formatDateTime(item.payload?.failedAt))}</p>
        </div>
        <span class="ui-badge ${badgeClassForStatus(item.state)}">${escapeHtml(item.state || "unknown")}</span>
      </div>
      <div class="console-item-actions">
        <button type="button" class="ui-btn ui-btn-secondary" data-training-ops-requeue-id="${escapeHtml(item.id)}">Requeue</button>
      </div>
    `;
    elements.trainingOpsDlqList.appendChild(li);
  }
}

function renderWorkspace() {
  renderWorkspaceSelectors();
  renderAgents();
  renderConnection();
  renderRules();
  renderSkills();
  renderTools();
  renderMemories();
  renderTrainingOps();
  renderSandbox();
  renderMarketplace();
}

function updateModuleTabAvailability() {
  for (const tab of elements.moduleTabs.querySelectorAll("[data-tab]")) {
    const id = tab.getAttribute("data-tab");
    const info = tabAllowed(id);
    tab.disabled = !info.allowed;
    tab.title = info.allowed ? "" : info.reason || `${id} blocked`;
  }
}

async function refreshHealth() {
  const result = await fetchBackendHealth();
  if (result.online) {
    elements.health.className = "ui-badge success";
    elements.health.textContent = "Backend online";
  } else {
    elements.health.className = "ui-badge error";
    elements.health.textContent = "Backend offline";
  }
}

async function loadProfile() {
  state.me = await apiFetch("/api/me");
  renderProfile();
}

async function loadAcsHome() {
  state.acsHome = await apiFetch("/api/me/acs-home?includeCounts=true");
  renderAcsHome();
}

async function loadProjects() {
  const response = await apiFetch("/api/projects?limit=30&offset=0");
  state.projects = Array.isArray(response?.items) ? response.items : [];
  renderProjects();
}

async function loadJobs() {
  const response = await apiFetch("/api/training/jobs");
  state.jobs = Array.isArray(response?.items) ? response.items : [];
  renderJobs();
}

async function loadTrainingOpsMetrics() {
  try {
    const response = await apiFetch("/api/admin/training/queue-metrics");
    state.workspace.trainingOpsMetrics = response;
    state.workspace.trainingOpsAlerts = Array.isArray(response?.alerts) ? response.alerts : [];
    state.workspace.errors.trainingOpsMetrics = null;
  } catch (error) {
    state.workspace.trainingOpsMetrics = null;
    state.workspace.trainingOpsAlerts = [];
    state.workspace.errors.trainingOpsMetrics = error.message || String(error);
  }
}

async function loadTrainingOpsDlq() {
  const { limit, offset } = trainingOpsQueryFromInputs();
  try {
    const response = await apiFetch(`/api/admin/training/dlq?limit=${encodeURIComponent(limit)}&offset=${encodeURIComponent(offset)}`);
    state.workspace.trainingOpsDlqItems = Array.isArray(response?.items) ? response.items : [];
    state.workspace.errors.trainingOpsDlq = null;
  } catch (error) {
    state.workspace.trainingOpsDlqItems = [];
    state.workspace.errors.trainingOpsDlq = error.message || String(error);
  }
}

async function loadSafe(key, runner, fallback = []) {
  try {
    const value = await runner();
    state.workspace[key] = value;
    state.workspace.errors[key] = null;
  } catch (error) {
    state.workspace[key] = fallback;
    state.workspace.errors[key] = error.message || String(error);
  }
}

async function loadAgents() {
  await loadSafe("agents", async () => {
    const response = await apiFetch("/api/agents");
    return Array.isArray(response?.items) ? response.items : [];
  });
}

async function loadSkills() {
  await loadSafe("skills", async () => {
    const response = await apiFetch("/api/skills");
    return Array.isArray(response?.items) ? response.items : [];
  });
}

async function loadTools() {
  await loadSafe("tools", async () => {
    const response = await apiFetch("/api/tools");
    return Array.isArray(response?.items) ? response.items : [];
  });
}

async function loadMemories() {
  await loadSafe("memories", async () => {
    const response = await apiFetch("/api/memory?limit=30&offset=0");
    return Array.isArray(response?.items) ? response.items : [];
  });
}

async function loadTemplates() {
  await loadSafe("templates", async () => {
    const response = await apiFetch("/api/agent-marketplace/templates");
    return Array.isArray(response?.items) ? response.items : [];
  });
}

async function loadGlobalRules() {
  try {
    const response = await apiFetch("/api/rules/global");
    state.workspace.globalRules = Array.isArray(response?.items) ? response.items : [];
    state.workspace.errors.rulesGlobal = null;
  } catch (error) {
    state.workspace.globalRules = [];
    state.workspace.errors.rulesGlobal = error.message || String(error);
  }
}

async function loadProjectRules() {
  const projectId = state.workspace.selectedProjectId;
  if (!projectId) {
    state.workspace.projectRules = [];
    state.workspace.errors.rulesProject = "Select a project to view project rules.";
    return;
  }

  try {
    const response = await apiFetch(`/api/rules/project?projectId=${encodeURIComponent(projectId)}`);
    state.workspace.projectRules = Array.isArray(response?.items) ? response.items : [];
    state.workspace.errors.rulesProject = null;
  } catch (error) {
    state.workspace.projectRules = [];
    state.workspace.errors.rulesProject = error.message || String(error);
  }
}

async function loadAgentDetail(agentId) {
  if (!agentId) {
    return;
  }
  try {
    state.workspace.agentDetails[agentId] = await apiFetch(`/api/agents/${agentId}`);
  } catch (error) {
    state.workspace.errors.agents = error.message || String(error);
  }
}

async function loadWorkspace() {
  if (!state.token) {
    state.workspace = newWorkspace();
    renderWorkspace();
    setWorkspaceStatus("Workspace disabled (no session)", "warning");
    return;
  }

  setWorkspaceStatus("Loading workspace...", "info");
  await Promise.all([loadAgents(), loadSkills(), loadTools(), loadMemories(), loadTemplates(), loadGlobalRules()]);
  renderWorkspaceSelectors();
  await loadProjectRules();
  if (state.workspace.selectedAgentId) {
    await loadAgentDetail(state.workspace.selectedAgentId);
  }
  if (tabAllowed("trainingOps").allowed) {
    await Promise.all([loadTrainingOpsMetrics(), loadTrainingOpsDlq()]);
  } else {
    state.workspace.trainingOpsMetrics = null;
    state.workspace.trainingOpsAlerts = [];
    state.workspace.trainingOpsDlqItems = [];
    state.workspace.errors.trainingOpsMetrics = null;
    state.workspace.errors.trainingOpsDlq = null;
  }
  renderWorkspace();
  setWorkspaceStatus("Workspace ready", "success");
}

async function loadDashboard() {
  await Promise.all([loadProfile(), loadAcsHome(), loadProjects(), loadJobs()]);
  renderWorkspaceSelectors();
  await loadWorkspace();
}

function stopPollingJobs() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function startPollingJobs() {
  stopPollingJobs();
  state.pollTimer = window.setInterval(() => {
    if (!state.token) {
      return;
    }
    loadJobs().catch(handleError);
  }, POLL_MS);
}

function clearDashboard() {
  state.me = null;
  state.acsHome = null;
  state.projects = [];
  state.jobs = [];
  state.workspace = newWorkspace();
  renderProfile();
  renderAcsHome();
  renderProjects();
  renderJobs();
  renderWorkspace();
}

function logout(showMessage = true) {
  state.token = "";
  setToken("");
  stopPollingJobs();
  setSessionEnabled(false);
  clearDashboard();
  if (showMessage) {
    showToast("Sesion cerrada", { variant: "info" });
  }
}

async function importTemplate(templateId, nameOverride) {
  if (!requireTab("marketplace")) {
    return;
  }
  const payload = {};
  if (nameOverride && nameOverride.trim().length > 0) {
    payload.nameOverride = nameOverride.trim();
  }
  state.workspace.lastImport = await apiFetch(`/api/agent-marketplace/templates/${templateId}/import`, {
    method: "POST",
    body: payload
  });
  showToast("Template importado", { variant: "success" });
  await loadWorkspace();
}

function bindWorkspaceEvents() {
  initTabs(elements.moduleSwitcher);

  elements.contextProject.addEventListener("change", async () => {
    state.workspace.selectedProjectId = elements.contextProject.value;
    await loadProjectRules();
    renderRules();
  });

  elements.contextAgent.addEventListener("change", async () => {
    state.workspace.selectedAgentId = elements.contextAgent.value;
    renderWorkspaceSelectors();
    await loadAgentDetail(state.workspace.selectedAgentId);
    renderConnection();
  });

  elements.agentCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireTab("agentEditor")) {
      return;
    }
    try {
      await apiFetch("/api/agents", {
        method: "POST",
        body: {
          name: elements.agentCreateName.value.trim(),
          role: elements.agentCreateRole.value.trim(),
          memoryScope: elements.agentCreateMemoryScope.value
        }
      });
      elements.agentCreateForm.reset();
      elements.agentCreateRole.value = "assistant";
      elements.agentCreateMemoryScope.value = "private";
      showToast("Agent creado", { variant: "success" });
      await loadWorkspace();
    } catch (error) {
      handleError(error);
    }
  });

  elements.agentList.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const actionNode = target?.closest("[data-agent-action]");
    if (!actionNode) {
      return;
    }

    const action = actionNode.getAttribute("data-agent-action");
    const agentId = actionNode.getAttribute("data-agent-id");
    if (!action || !agentId) {
      return;
    }

    try {
      if (action === "select") {
        state.workspace.selectedAgentId = agentId;
        renderWorkspaceSelectors();
        await loadAgentDetail(agentId);
        renderConnection();
        return;
      }
      if (action === "detail") {
        await loadAgentDetail(agentId);
        state.workspace.selectedAgentId = agentId;
        renderWorkspaceSelectors();
        renderConnection();
        showToast("Agent detail loaded", { variant: "info" });
        return;
      }
      if (action === "duplicate") {
        if (!requireTab("agentEditor")) {
          return;
        }
        await apiFetch(`/api/agents/${agentId}/duplicate`, { method: "POST", body: {} });
        showToast("Agent duplicado", { variant: "success" });
        await loadWorkspace();
        return;
      }
      if (action === "suspend") {
        if (!requireTab("agentEditor")) {
          return;
        }
        await apiFetch(`/api/agents/${agentId}/suspend`, { method: "POST", body: {} });
        showToast("Agent suspendido", { variant: "info" });
        await loadWorkspace();
        return;
      }
      if (action === "delete") {
        if (!requireTab("agentEditor")) {
          return;
        }
        if (!window.confirm("Delete agent permanently?")) {
          return;
        }
        await apiFetch(`/api/agents/${agentId}`, { method: "DELETE" });
        showToast("Agent eliminado", { variant: "success" });
        if (state.workspace.selectedAgentId === agentId) {
          state.workspace.selectedAgentId = "";
        }
        await loadWorkspace();
      }
    } catch (error) {
      handleError(error);
    }
  });

  elements.agentConnectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireTab("connection")) {
      return;
    }
    const agentId = elements.connectAgentId.value || state.workspace.selectedAgentId;
    if (!agentId) {
      showToast("Selecciona un agente", { variant: "warning" });
      return;
    }
    const apiKey = elements.connectApiKey.value.trim();
    if (apiKey.length < 8) {
      showToast("API key invalida (min 8 chars)", { variant: "warning" });
      return;
    }

    try {
      await apiFetch(`/api/agents/${agentId}/connect`, {
        method: "POST",
        body: {
          provider: elements.connectProvider.value,
          model: elements.connectModel.value.trim(),
          apiKey,
          params: {}
        }
      });
      elements.connectApiKey.value = "";
      state.workspace.selectedAgentId = agentId;
      showToast("Agent conectado", { variant: "success" });
      await loadWorkspace();
    } catch (error) {
      handleError(error);
    }
  });

  elements.agentDisconnectBtn.addEventListener("click", async () => {
    if (!requireTab("connection")) {
      return;
    }
    const agentId = elements.connectAgentId.value || state.workspace.selectedAgentId;
    if (!agentId) {
      showToast("Selecciona un agente", { variant: "warning" });
      return;
    }
    try {
      await apiFetch(`/api/agents/${agentId}/disconnect`, { method: "POST", body: {} });
      showToast("Agent desconectado", { variant: "info" });
      await loadWorkspace();
    } catch (error) {
      handleError(error);
    }
  });

  elements.projectRuleForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireTab("rules")) {
      return;
    }
    const projectId = state.workspace.selectedProjectId;
    if (!projectId) {
      showToast("Selecciona un proyecto", { variant: "warning" });
      return;
    }

    try {
      await apiFetch("/api/rules/project", {
        method: "POST",
        body: {
          projectId,
          title: elements.ruleTitle.value.trim(),
          content: elements.ruleContent.value.trim(),
          enforcement: elements.ruleEnforcement.value,
          priority: Number(elements.rulePriority.value),
          active: true
        }
      });
      elements.projectRuleForm.reset();
      elements.ruleEnforcement.value = "soft";
      elements.rulePriority.value = "50";
      showToast("Project rule creada", { variant: "success" });
      await loadProjectRules();
      renderRules();
    } catch (error) {
      handleError(error);
    }
  });

  elements.skillTestsForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireTab("skills")) {
      return;
    }
    const skillId = elements.skillId.value;
    if (!skillId) {
      showToast("Selecciona una skill", { variant: "warning" });
      return;
    }
    try {
      state.workspace.lastSkillRun = await apiFetch(`/api/skills/${skillId}/tests/run`, {
        method: "POST",
        body: {
          maxTests: Number(elements.skillMaxTests.value)
        }
      });
      renderSkills();
      showToast("Skill tests ejecutados", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.agentToolForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireTab("tools")) {
      return;
    }

    const agentId = elements.toolAgentId.value || state.workspace.selectedAgentId;
    if (!agentId) {
      showToast("Selecciona un agente", { variant: "warning" });
      return;
    }

    let config = {};
    const raw = elements.toolConfig.value.trim();
    if (raw.length > 0) {
      try {
        config = JSON.parse(raw);
      } catch {
        showToast("Config JSON invalida", { variant: "error" });
        return;
      }
    }

    try {
      await apiFetch(`/api/agents/${agentId}/tools`, {
        method: "POST",
        body: {
          updates: [
            {
              toolKey: elements.toolKey.value,
              allowed: elements.toolAllowed.value === "true",
              config
            }
          ]
        }
      });
      showToast("Tool assignment actualizado", { variant: "success" });
      await loadAgentDetail(agentId);
      renderConnection();
    } catch (error) {
      handleError(error);
    }
  });

  elements.memoryCreateForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireTab("memory")) {
      return;
    }

    let metadata = {};
    const raw = elements.memoryMetadata.value.trim();
    if (raw.length > 0) {
      try {
        metadata = JSON.parse(raw);
      } catch {
        showToast("Metadata JSON invalido", { variant: "error" });
        return;
      }
    }

    const scope = elements.memoryScope.value;
    const payload = {
      scope,
      text: elements.memoryText.value.trim(),
      metadata
    };

    if (scope === "project") {
      if (!state.workspace.selectedProjectId) {
        showToast("Selecciona un proyecto para scope=project", { variant: "warning" });
        return;
      }
      payload.projectId = state.workspace.selectedProjectId;
    }
    if (scope === "agent") {
      if (!state.workspace.selectedAgentId) {
        showToast("Selecciona un agente para scope=agent", { variant: "warning" });
        return;
      }
      payload.agentId = state.workspace.selectedAgentId;
    }

    try {
      await apiFetch("/api/memory", { method: "POST", body: payload });
      elements.memoryText.value = "";
      elements.memoryMetadata.value = "{}";
      showToast("Memory creada", { variant: "success" });
      await loadMemories();
      renderMemories();
    } catch (error) {
      handleError(error);
    }
  });

  elements.memoryList.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const actionNode = target?.closest("[data-memory-delete-id]");
    if (!actionNode) {
      return;
    }
    if (!requireTab("memory")) {
      return;
    }

    const memoryId = actionNode.getAttribute("data-memory-delete-id");
    if (!memoryId) {
      return;
    }

    try {
      await apiFetch(`/api/memory/${memoryId}`, { method: "DELETE" });
      showToast("Memory eliminada", { variant: "info" });
      await loadMemories();
      renderMemories();
    } catch (error) {
      handleError(error);
    }
  });

  elements.sandboxForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!requireTab("sandbox")) {
      return;
    }

    const agentId = elements.sandboxAgentId.value || state.workspace.selectedAgentId;
    if (!agentId) {
      showToast("Selecciona un agente", { variant: "warning" });
      return;
    }

    let dryRunInput = {};
    const raw = elements.sandboxInput.value.trim();
    if (raw.length > 0) {
      try {
        dryRunInput = JSON.parse(raw);
      } catch {
        showToast("dryRunInput JSON invalido", { variant: "error" });
        return;
      }
    }

    try {
      state.workspace.lastSandbox = await apiFetch(`/api/agents/${agentId}/sandbox-test`, {
        method: "POST",
        body: {
          dryRunInput
        }
      });
      renderSandbox();
      showToast("Sandbox test ejecutado", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.templateImportForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const templateId = elements.importTemplateId.value;
    if (!templateId) {
      showToast("Selecciona un template", { variant: "warning" });
      return;
    }
    try {
      await importTemplate(templateId, elements.importName.value);
    } catch (error) {
      handleError(error);
    }
  });

  elements.marketplaceList.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const actionNode = target?.closest("[data-template-import-id]");
    if (!actionNode) {
      return;
    }
    const templateId = actionNode.getAttribute("data-template-import-id");
    if (!templateId) {
      return;
    }
    try {
      await importTemplate(templateId, "");
    } catch (error) {
      handleError(error);
    }
  });

  elements.trainingOpsRefreshMetricsBtn.addEventListener("click", async () => {
    if (!requireTab("trainingOps")) {
      return;
    }
    try {
      await loadTrainingOpsMetrics();
      renderTrainingOps();
      showToast("Training queue metrics refreshed", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.trainingOpsRefreshDlqBtn.addEventListener("click", async () => {
    if (!requireTab("trainingOps")) {
      return;
    }
    try {
      await loadTrainingOpsDlq();
      renderTrainingOps();
      showToast("Training DLQ refreshed", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.trainingOpsBatchRequeueBtn.addEventListener("click", async () => {
    if (!requireTab("trainingOps")) {
      return;
    }
    const removeOriginal = elements.trainingOpsRemoveOriginal.value === "true";
    const { limit, offset } = trainingOpsQueryFromInputs();
    try {
      const result = await apiFetch("/api/admin/training/dlq/requeue-batch", {
        method: "POST",
        body: {
          limit,
          offset,
          removeOriginal,
          states: ["waiting", "delayed", "failed", "active"]
        }
      });
      await Promise.all([loadTrainingOpsMetrics(), loadTrainingOpsDlq(), loadJobs()]);
      renderTrainingOps();
      const requeued = Number(result?.requeued ?? 0);
      const failed = Number(result?.failed ?? 0);
      showToast(`DLQ batch requeue: requeued=${requeued} failed=${failed}`, { variant: failed > 0 ? "warning" : "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.trainingOpsDlqList.addEventListener("click", async (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const actionNode = target?.closest("[data-training-ops-requeue-id]");
    if (!actionNode) {
      return;
    }
    if (!requireTab("trainingOps")) {
      return;
    }
    const dlqJobId = actionNode.getAttribute("data-training-ops-requeue-id");
    if (!dlqJobId) {
      return;
    }
    try {
      await apiFetch(`/api/admin/training/dlq/${encodeURIComponent(dlqJobId)}/requeue`, {
        method: "POST",
        body: {
          removeOriginal: elements.trainingOpsRemoveOriginal.value === "true"
        }
      });
      await Promise.all([loadTrainingOpsMetrics(), loadTrainingOpsDlq(), loadJobs()]);
      renderTrainingOps();
      showToast("DLQ job requeued", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });
}

function bindEvents() {
  initTabs(elements.authSwitcher);
  bindWorkspaceEvents();

  elements.platformSelect.value = getClientPlatform();
  elements.platformSelect.addEventListener("change", async () => {
    const next = setClientPlatform(elements.platformSelect.value);
    elements.platformSelect.value = next;
    showToast(`Platform set to ${next}`, { variant: "info" });
    if (!state.token) {
      return;
    }
    try {
      await Promise.all([loadProfile(), loadAcsHome(), loadJobs()]);
      await loadWorkspace();
    } catch (error) {
      handleError(error);
    }
  });

  elements.loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = document.getElementById("console-login-username").value.trim();
    const password = document.getElementById("console-login-password").value;

    try {
      const response = await apiFetch("/api/auth/login", {
        method: "POST",
        body: { username, password },
        token: ""
      });
      state.token = response.token;
      setToken(state.token);
      setSessionEnabled(true);
      renderSkeletonRows(elements.profileCard, 5);
      await loadDashboard();
      startPollingJobs();
      showToast(`Sesion iniciada: ${response.user?.username || username}`, { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const username = document.getElementById("console-register-username").value.trim();
    const password = document.getElementById("console-register-password").value;

    try {
      const response = await apiFetch("/api/auth/register", {
        method: "POST",
        body: { username, password },
        token: ""
      });
      state.token = response.token;
      setToken(state.token);
      setSessionEnabled(true);
      renderSkeletonRows(elements.profileCard, 5);
      await loadDashboard();
      startPollingJobs();
      showToast(`Cuenta creada: ${response.user?.username || username}`, { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.logoutBtn.addEventListener("click", () => logout(true));

  elements.refreshBtn.addEventListener("click", async () => {
    if (!state.token) {
      showToast("Inicia sesion primero", { variant: "info" });
      return;
    }
    try {
      await loadDashboard();
      showToast("Datos actualizados", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.acsRefreshBtn.addEventListener("click", async () => {
    if (!state.token) {
      showToast("Inicia sesion primero", { variant: "info" });
      return;
    }
    try {
      await loadAcsHome();
      await loadWorkspace();
      showToast("ACS Home actualizado", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.modulesRefreshBtn.addEventListener("click", async () => {
    if (!state.token) {
      showToast("Inicia sesion primero", { variant: "info" });
      return;
    }
    try {
      await loadWorkspace();
      showToast("Workspace actualizado", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.projectForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.token) {
      showToast("Inicia sesion primero", { variant: "info" });
      return;
    }

    const name = document.getElementById("console-project-name").value.trim();
    const description = document.getElementById("console-project-description").value.trim();

    try {
      await apiFetch("/api/projects", {
        method: "POST",
        body: {
          name,
          description: description || undefined
        }
      });
      elements.projectForm.reset();
      await loadProjects();
      await loadProjectRules();
      renderWorkspace();
      showToast("Proyecto creado", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });

  elements.trainingForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!state.token) {
      showToast("Inicia sesion primero", { variant: "info" });
      return;
    }
    if (!requireTab("training")) {
      return;
    }

    const mode = document.getElementById("console-training-mode").value;
    const configRaw = document.getElementById("console-training-config").value.trim();
    let config = {};
    if (configRaw.length > 0) {
      try {
        config = JSON.parse(configRaw);
      } catch {
        showToast("Config JSON invalida", { variant: "error" });
        return;
      }
    }

    try {
      await apiFetch("/api/training/jobs", {
        method: "POST",
        body: { mode, config }
      });
      await loadJobs();
      showToast("Training job creado", { variant: "success" });
    } catch (error) {
      handleError(error);
    }
  });
}

async function bootstrap() {
  assertDomBindings();
  bindEvents();
  await refreshHealth();
  state.healthTimer = window.setInterval(refreshHealth, 10_000);

  renderProjects();
  renderJobs();
  renderAcsHome();
  renderWorkspace();
  setSessionEnabled(Boolean(state.token));

  if (state.token) {
    renderSkeletonRows(elements.profileCard, 5);
    try {
      await loadDashboard();
      startPollingJobs();
      showToast("Sesion restaurada", { variant: "info" });
    } catch (error) {
      handleError(error);
    }
  } else {
    renderProfile();
    setWorkspaceStatus("Workspace disabled (no session)", "warning");
  }
}

bootstrap();
