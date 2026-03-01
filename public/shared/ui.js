export const TOKEN_KEY = "rey30_frontend_token";
export const CLIENT_PLATFORM_KEY = "rey30_client_platform";
export const CLIENT_PLATFORMS = ["desktop", "mobile", "web"];

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

export function setToken(token) {
  if (token && token.length > 0) {
    localStorage.setItem(TOKEN_KEY, token);
  } else {
    localStorage.removeItem(TOKEN_KEY);
  }
}

function normalizeClientPlatform(raw) {
  const value = String(raw || "")
    .trim()
    .toLowerCase();
  if (CLIENT_PLATFORMS.includes(value)) {
    return value;
  }
  return "web";
}

function detectBrowserPlatform() {
  if (typeof navigator === "undefined") {
    return "web";
  }
  const userAgent = navigator.userAgent.toLowerCase();
  if (userAgent.includes("android") || userAgent.includes("iphone") || userAgent.includes("ipad") || userAgent.includes("mobile")) {
    return "mobile";
  }
  return "web";
}

function firstValidationDetail(details) {
  if (!details || typeof details !== "object") {
    return "";
  }

  const detailObject = details;
  if (Array.isArray(detailObject.formErrors) && detailObject.formErrors.length > 0) {
    return String(detailObject.formErrors[0]);
  }

  if (detailObject.fieldErrors && typeof detailObject.fieldErrors === "object") {
    for (const value of Object.values(detailObject.fieldErrors)) {
      if (Array.isArray(value) && value.length > 0) {
        return String(value[0]);
      }
    }
  }

  return "";
}

function readQueryPlatform() {
  if (typeof window === "undefined") {
    return "";
  }
  const params = new URLSearchParams(window.location.search);
  const value = params.get("platform");
  if (!value) {
    return "";
  }
  return normalizeClientPlatform(value);
}

export function getClientPlatform() {
  const fromQuery = readQueryPlatform();
  if (fromQuery) {
    try {
      localStorage.setItem(CLIENT_PLATFORM_KEY, fromQuery);
    } catch {
      // ignore storage failures
    }
    return fromQuery;
  }

  try {
    const saved = localStorage.getItem(CLIENT_PLATFORM_KEY);
    if (saved) {
      return normalizeClientPlatform(saved);
    }
  } catch {
    // ignore storage failures
  }

  return detectBrowserPlatform();
}

export function setClientPlatform(platform) {
  const normalized = normalizeClientPlatform(platform);
  try {
    localStorage.setItem(CLIENT_PLATFORM_KEY, normalized);
  } catch {
    // ignore storage failures
  }
  return normalized;
}

function parseErrorMessage(body, status = 0) {
  if (!body || typeof body !== "object") {
    if (status === 401) {
      return "Unauthorized. Login required or token expired.";
    }
    if (status === 403) {
      return "Forbidden.";
    }
    return "Request failed";
  }

  const requiredPlatform = typeof body.requiredPlatform === "string" ? body.requiredPlatform : "";
  const currentPlatform = typeof body.currentPlatform === "string" ? body.currentPlatform : "";
  const missingPermission = typeof body.permission === "string" ? body.permission : "";
  const missingPermissions = Array.isArray(body.permissions) ? body.permissions.filter((entry) => typeof entry === "string") : [];
  const validationDetail = firstValidationDetail(body.details);

  if (status === 403 && requiredPlatform) {
    return currentPlatform
      ? `Platform denied. Required=${requiredPlatform}, current=${currentPlatform}.`
      : `Platform denied. Required=${requiredPlatform}.`;
  }

  if (status === 403 && missingPermission) {
    return `Missing permission: ${missingPermission}`;
  }

  if (status === 403 && missingPermissions.length > 0) {
    return `Missing permissions: ${missingPermissions.join(", ")}`;
  }

  if (validationDetail) {
    return validationDetail;
  }

  if (typeof body.error === "string") {
    return body.error;
  }

  if (status === 401) {
    return "Unauthorized. Login required or token expired.";
  }
  if (status === 403) {
    return "Forbidden.";
  }

  return "Request failed";
}

export async function apiFetch(path, options = {}) {
  const token = options.token ?? getToken();
  const platform = options.platform ?? getClientPlatform();
  const headers = {
    "Content-Type": "application/json",
    "x-client-platform": platform,
    ...(options.headers || {})
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await response.json() : null;

  if (!response.ok) {
    const error = new Error(parseErrorMessage(body, response.status));
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

let toastRoot = null;

function ensureToastRoot() {
  if (toastRoot) {
    return toastRoot;
  }

  toastRoot = document.createElement("div");
  toastRoot.className = "ui-toast-root";
  toastRoot.id = "ui-toast-root";
  document.body.appendChild(toastRoot);
  return toastRoot;
}

export function showToast(message, options = {}) {
  const root = ensureToastRoot();
  const toast = document.createElement("div");
  const variant = options.variant || "info";

  toast.className = `ui-toast ${variant}`;
  toast.textContent = message;
  root.appendChild(toast);

  const duration = options.durationMs ?? 2600;
  window.setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(10px)";
    window.setTimeout(() => {
      toast.remove();
    }, 180);
  }, duration);
}

export function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) {
    return;
  }

  modal.classList.add("open");
  modal.setAttribute("aria-hidden", "false");
  document.body.style.overflow = "hidden";
}

export function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (!modal) {
    return;
  }

  modal.classList.remove("open");
  modal.setAttribute("aria-hidden", "true");
  document.body.style.overflow = "";
}

export function bindModalSystem() {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    const openTrigger = target.closest("[data-open-modal]");
    if (openTrigger) {
      const modalId = openTrigger.getAttribute("data-open-modal");
      if (modalId) {
        openModal(modalId);
      }
      return;
    }

    const closeTrigger = target.closest("[data-close-modal]");
    if (closeTrigger) {
      const modalId = closeTrigger.getAttribute("data-close-modal");
      if (modalId) {
        closeModal(modalId);
      }
      return;
    }

    const backdrop = target.closest(".ui-modal-backdrop");
    if (backdrop) {
      const modal = backdrop.closest(".ui-modal");
      if (modal && modal.id) {
        closeModal(modal.id);
      }
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }

    const opened = document.querySelector(".ui-modal.open");
    if (opened instanceof HTMLElement && opened.id) {
      closeModal(opened.id);
    }
  });
}

export function initTabs(container, onChange) {
  if (!container) {
    return;
  }

  const tabs = Array.from(container.querySelectorAll("[data-tab]"));
  const panels = Array.from(container.querySelectorAll("[data-tab-panel]"));

  function activate(tabId) {
    tabs.forEach((tab) => {
      tab.classList.toggle("active", tab.getAttribute("data-tab") === tabId);
    });

    panels.forEach((panel) => {
      panel.classList.toggle("hidden", panel.getAttribute("data-tab-panel") !== tabId);
    });

    if (typeof onChange === "function") {
      onChange(tabId);
    }
  }

  container.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const tab = target ? target.closest("[data-tab]") : null;
    if (!tab) {
      return;
    }
    activate(tab.getAttribute("data-tab"));
  });

  const defaultTab = tabs.find((tab) => tab.classList.contains("active"))?.getAttribute("data-tab") || tabs[0]?.getAttribute("data-tab");
  if (defaultTab) {
    activate(defaultTab);
  }
}

export function renderSkeletonRows(container, rows = 3) {
  if (!container) {
    return;
  }

  const parts = [];
  for (let index = 0; index < rows; index += 1) {
    const width = index % 2 === 0 ? "84%" : "62%";
    parts.push(`<div class="ui-skeleton" style="height: 14px; width: ${width}; margin-bottom: 10px;"></div>`);
  }

  container.innerHTML = parts.join("");
}

export function badgeClassForStatus(statusRaw) {
  const status = String(statusRaw || "").toLowerCase();
  if (status === "succeeded" || status === "active" || status === "online") {
    return "success";
  }
  if (status === "queued" || status === "running" || status === "warning") {
    return "warning";
  }
  if (status === "failed" || status === "archived" || status === "offline") {
    return "error";
  }
  return "info";
}

export async function fetchBackendHealth() {
  try {
    const response = await fetch("/health", {
      method: "GET",
      headers: {
        "x-client-platform": getClientPlatform()
      }
    });
    if (!response.ok) {
      return { online: false, payload: null };
    }
    const payload = await response.json();
    return { online: Boolean(payload?.ok), payload };
  } catch {
    return { online: false, payload: null };
  }
}

export function formatDateTime(iso) {
  if (!iso) {
    return "-";
  }
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
