#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const repoRoot = process.cwd();

const detectors = [
  { id: "openai", regex: /sk-proj-[A-Za-z0-9_-]{20,}/g },
  { id: "openai-legacy", regex: /sk-[A-Za-z0-9]{32,}/g },
  { id: "anthropic", regex: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { id: "github-classic", regex: /ghp_[A-Za-z0-9]{36,}/g },
  { id: "github-fine-grained", regex: /github_pat_[A-Za-z0-9_]{20,}/g },
  { id: "huggingface", regex: /hf_[A-Za-z0-9]{20,}/g },
  { id: "google-api", regex: /AIza[0-9A-Za-z\-_]{20,}/g },
  { id: "meshy", regex: /msy_[A-Za-z0-9]{16,}/g },
  { id: "runway-style", regex: /\bkey_[A-Fa-f0-9]{32,}\b/g },
  { id: "slack", regex: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { id: "jwt", regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { id: "bearer-token", regex: /\bBearer\s+[A-Za-z0-9._-]{24,}\b/g },
  {
    id: "sensitive-env-assignment",
    regex:
      /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|MESHY_AI_API_KEY|RUNWAY_GEN2_API_KEY|ELEVENLABS_API_KEY|FAL_AI_API_KEY|GITHUB_TOKEN|HUGGINGFACE_API_KEY|PINATA_API_KEY|NGROK_API_KEY|MODELSLAB_API_KEY|NEURAL4D_API_KEY)\s*=\s*([A-Za-z0-9._:-]{20,})/g
  },
  { id: "private-key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g }
];

const skipPrefixes = ["node_modules/", "dist/", ".git/"];
const allowlistPatterns = [
  /^#\s*[A-Z0-9_]+\s*=/,
  /unit-test-token/i,
  /example/i,
  /\.\.\./
];

function isLikelyText(buffer) {
  const max = Math.min(buffer.length, 4096);
  for (let i = 0; i < max; i += 1) {
    if (buffer[i] === 0) {
      return false;
    }
  }
  return true;
}

function maskSecret(value) {
  if (value.length <= 12) {
    return `${value.slice(0, 2)}...${value.slice(-2)}`;
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function shouldAllowLine(line) {
  const normalized = String(line || "");
  return allowlistPatterns.some((pattern) => pattern.test(normalized));
}

function isSkipped(filePath) {
  return skipPrefixes.some((prefix) => filePath.startsWith(prefix));
}

function getTrackedFiles() {
  const raw = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot });
  return raw
    .toString("utf8")
    .split("\0")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function scanFile(filePath) {
  const absolutePath = path.join(repoRoot, filePath);
  let contentBuffer;
  try {
    contentBuffer = fs.readFileSync(absolutePath);
  } catch {
    return [];
  }

  if (!isLikelyText(contentBuffer)) {
    return [];
  }

  const lines = contentBuffer.toString("utf8").split(/\r?\n/);
  const findings = [];

  for (let lineNumber = 0; lineNumber < lines.length; lineNumber += 1) {
    const line = lines[lineNumber];
    if (shouldAllowLine(line)) {
      continue;
    }

    for (const detector of detectors) {
      detector.regex.lastIndex = 0;
      let match = detector.regex.exec(line);
      while (match) {
        const tokenRaw = detector.id === "sensitive-env-assignment" ? match[1] : match[0];
        if (typeof tokenRaw === "string" && tokenRaw.trim().length > 0) {
          findings.push({
            filePath,
            lineNumber: lineNumber + 1,
            detector: detector.id,
            token: maskSecret(tokenRaw.trim())
          });
        }
        match = detector.regex.exec(line);
      }
    }
  }

  return findings;
}

function main() {
  const files = getTrackedFiles();
  const findings = [];

  for (const filePath of files) {
    if (isSkipped(filePath)) {
      continue;
    }
    findings.push(...scanFile(filePath));
  }

  if (findings.length === 0) {
    console.log("[security] secret scan passed (no high-confidence secrets found).");
    return;
  }

  console.error("[security] secret scan failed. Found potential leaked secrets:");
  for (const finding of findings) {
    console.error(
      ` - ${finding.filePath}:${finding.lineNumber} [${finding.detector}] ${finding.token}`
    );
  }
  process.exitCode = 1;
}

main();
