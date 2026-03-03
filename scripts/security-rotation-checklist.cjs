#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

const repoRoot = process.cwd();
const envPath = path.join(repoRoot, ".env");

const sensitiveVariables = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "MESHY_AI_API_KEY",
  "RUNWAY_GEN2_API_KEY",
  "ELEVENLABS_API_KEY",
  "FAL_AI_API_KEY",
  "HUGGINGFACE_API_KEY",
  "PINATA_API_KEY",
  "NGROK_API_KEY",
  "GITHUB_TOKEN",
  "MODELSLAB_API_KEY",
  "NEURAL4D_API_KEY",
  "SQL_SERVER_PASSWORD",
  "SQL_PASSWORD",
  "JWT_SECRET",
  "VAULT_SECRET"
];

function maskValue(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.length <= 10) {
    return `${normalized.slice(0, 2)}...${normalized.slice(-2)}`;
  }
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function parseEnvFile(raw) {
  const out = {};
  const lines = String(raw || "").split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim().replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

function isPlaceholder(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return [
    "changeme",
    "change_me",
    "change-this",
    "change_this_in_production",
    "sk-...",
    "sk-ant-...",
    "ai...",
    "msy_...",
    "..."
  ].some((token) => normalized.includes(token));
}

function main() {
  if (!fs.existsSync(envPath)) {
    console.error(`[security] .env not found at ${envPath}`);
    process.exitCode = 1;
    return;
  }

  const raw = fs.readFileSync(envPath, "utf8");
  const envMap = parseEnvFile(raw);
  const active = [];

  for (const variable of sensitiveVariables) {
    const value = envMap[variable];
    if (typeof value !== "string") {
      continue;
    }
    if (isPlaceholder(value)) {
      continue;
    }
    active.push({
      variable,
      value: maskValue(value)
    });
  }

  if (active.length === 0) {
    console.log("[security] rotation checklist: no active sensitive values found in .env.");
    return;
  }

  console.log("[security] rotation checklist (active sensitive values in .env):");
  for (const item of active) {
    console.log(` - ${item.variable}: ${item.value}`);
  }
  console.log("[security] next step: rotate each key in provider dashboard and update .env / vault.");
}

main();

