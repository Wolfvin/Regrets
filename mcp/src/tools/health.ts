/**
 * Tool handler for regrets_health — return health report for all clusters.
 *
 * Reads .regret files, audit.log, and manifest.json to compute per-cluster
 * health scores (0-100), labels (SOLID/GOOD/UNSTABLE/FRAGILE/NEW), and
 * confidence (HIGH/MEDIUM/LOW).
 *
 * This replicates the logic from scripts/health.js but as a programmatic
 * tool handler rather than a CLI script.
 */

import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, join, basename } from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { structuredError } from "./structuredError.js";

// ─── Zod schema ──────────────────────────────────────────────────────────────

export const healthToolSchema = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory containing the regrets/ folder. Default: process.cwd()"
    ),
  sortBy: z
    .enum(["health", "fragile", "age", "confidence"])
    .optional()
    .describe(
      "Sort order for results. 'health' = healthiest first (default), 'fragile' = worst first, 'age' = oldest first, 'confidence' = lowest confidence first."
    ),
};

// ─── Confidence computation (mirrors confidence.js) ─────────────────────────

function inputCountFactor(inputCount: number): number {
  if (inputCount <= 1) return 0.1;
  if (inputCount <= 3) return 0.4;
  if (inputCount <= 6) return 0.7;
  return 1.0;
}

function captureAgeFactor(ageDays: number): number {
  if (ageDays < 1) return 0.5;
  if (ageDays <= 7) return 0.8;
  return 1.0;
}

function driftHistoryFactor(hasDriftOrUpdate: boolean): number {
  return hasDriftOrUpdate ? 0.6 : 1.0;
}

function confidenceLabel(score: number): "HIGH" | "MEDIUM" | "LOW" {
  if (score >= 0.8) return "HIGH";
  if (score >= 0.5) return "MEDIUM";
  return "LOW";
}

function computeConfidence(opts: {
  inputCount: number;
  ageDays: number;
  hasDriftOrUpdate: boolean;
}): { score: number; label: "HIGH" | "MEDIUM" | "LOW" } {
  const f1 = inputCountFactor(opts.inputCount);
  const f2 = captureAgeFactor(opts.ageDays);
  const f3 = driftHistoryFactor(opts.hasDriftOrUpdate);
  const score = f1 * 0.5 + f2 * 0.2 + f3 * 0.3;
  return {
    score: Math.round(score * 1000) / 1000,
    label: confidenceLabel(score),
  };
}

// ─── Audit log parsing ──────────────────────────────────────────────────────

interface AuditEntry {
  updates: number;
  drifts: number;
  history: Array<{ type: string; date: string }>;
}

function parseAuditLog(auditLogPath: string): Record<string, AuditEntry> {
  const events: Record<string, AuditEntry> = {};
  try {
    if (!existsSync(auditLogPath)) return events;
    const content = readFileSync(auditLogPath, "utf8").trim();
    if (!content) return events;

    const blocks = content.split("\n\n").filter(Boolean);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const header = lines[0];
      const parts = header.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const type = parts[1];
      const id = parts[2];
      if (!id) continue;
      if (!events[id])
        events[id] = { updates: 0, drifts: 0, history: [] };
      if (type === "UPDATE") events[id].updates++;
      if (type === "DRIFT") events[id].drifts++;
      events[id].history.push({ type, date: parts[0] });
    }
  } catch {
    // audit.log doesn't exist or can't be read
  }
  return events;
}

function parseAuditForDrift(
  auditLogPath: string
): Record<string, boolean> {
  const result: Record<string, boolean> = {};
  try {
    if (!existsSync(auditLogPath)) return result;
    const content = readFileSync(auditLogPath, "utf8").trim();
    if (!content) return result;

    const blocks = content.split("\n\n").filter(Boolean);
    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const header = lines[0];
      const parts = header.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const type = parts[1].toLowerCase();
      const id = parts[2];
      if (!id) continue;
      if (type.includes("drift") || type.includes("update")) {
        result[id] = true;
      }
    }
  } catch {
    // ignore
  }
  return result;
}

// ─── Regret file metadata parsing ───────────────────────────────────────────

function parseRegretMeta(content: string): Record<string, string> {
  const meta: Record<string, string> = {};
  const metaSection = content.split("\n---\n")[0];
  for (const line of metaSection.split("\n")) {
    const colonIdx = line.indexOf(": ");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx);
    const val = line.slice(colonIdx + 2).trim();
    meta[key] = val;
  }
  return meta;
}

// ─── Health scoring (mirrors health.js) ─────────────────────────────────────

function scoreCluster(opts: {
  updates: number;
  drifts: number;
  ageDays: number;
}): number {
  let score = 100;
  score -= opts.updates * 15;
  score -= opts.drifts * 25;
  if (opts.ageDays < 3) score -= 10;
  if (opts.ageDays > 30) score += 5;
  return Math.max(0, Math.min(100, score));
}

type HealthLabel = "SOLID" | "GOOD" | "UNSTABLE" | "FRAGILE" | "NEW";

function healthLabel(score: number, isNew: boolean): HealthLabel {
  if (isNew) return "NEW";
  if (score >= 90) return "SOLID";
  if (score >= 70) return "GOOD";
  if (score >= 50) return "UNSTABLE";
  return "FRAGILE";
}

// ─── Handler ────────────────────────────────────────────────────────────────

interface ClusterHealth {
  id: string;
  score: number;
  label: HealthLabel;
  isNew: boolean;
  ageDays: number;
  updates: number;
  drifts: number;
  confidence: string;
  confidenceScore: number;
  inputCount: number;
}

export async function handleHealth(
  args: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const { cwd, sortBy = "health" } = args as {
      cwd?: string;
      sortBy?: "health" | "fragile" | "age" | "confidence";
    };

    const workDir = resolve(cwd ?? process.cwd());
    const regretDir = join(workDir, "regrets");
    const manifestPath = join(workDir, "regrets/manifest.json");
    const auditLogPath = join(regretDir, "audit.log");

    // Load manifest for input counts
    let manifest: { clusters: Array<{ id: string; inputs?: unknown[] }> } = {
      clusters: [],
    };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      // No manifest — confidence will use inputCount = 0
    }

    const inputCountMap: Record<string, number> = {};
    for (const c of manifest.clusters || []) {
      inputCountMap[c.id] = (c.inputs || []).length;
    }

    // Discover .regret files
    let regretFiles: string[] = [];
    try {
      regretFiles = readdirSync(regretDir).filter((f) =>
        f.endsWith(".regret")
      );
    } catch {
      return structuredError({
        type: "DIRECTORY_NOT_FOUND",
        message: "regrets/ directory not found. Run capture first.",
      });
    }

    if (!regretFiles.length) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { clusters: [], note: "No .regret files found." },
              null,
              2
            ),
          },
        ],
      };
    }

    const auditData = parseAuditLog(auditLogPath);
    const driftMap = parseAuditForDrift(auditLogPath);
    const now = Date.now();

    const clusters: ClusterHealth[] = regretFiles.map((f) => {
      const id = basename(f, ".regret");
      const content = readFileSync(join(regretDir, f), "utf8");
      const meta = parseRegretMeta(content);
      const audit = auditData[id] ?? {
        updates: 0,
        drifts: 0,
        history: [],
      };
      const captured = meta.captured
        ? new Date(meta.captured).getTime()
        : now;
      const ageHours = (now - captured) / (1000 * 60 * 60);
      const ageDays = Math.floor(ageHours / 24);
      const isNew =
        ageHours < 72 && audit.updates === 0 && audit.drifts === 0;
      const score = scoreCluster({
        updates: audit.updates,
        drifts: audit.drifts,
        ageDays,
      });
      const label = healthLabel(score, isNew);
      const inputCount = inputCountMap[id] ?? 0;
      const hasDriftOrUpdate = !!driftMap[id];
      const conf = computeConfidence({
        inputCount,
        ageDays,
        hasDriftOrUpdate,
      });

      return {
        id,
        score,
        label,
        isNew,
        ageDays,
        updates: audit.updates,
        drifts: audit.drifts,
        confidence: conf.label,
        confidenceScore: conf.score,
        inputCount,
      };
    });

    // Sort
    const sorted = [...clusters].sort((a, b) => {
      if (sortBy === "fragile") return a.score - b.score;
      if (sortBy === "age") return b.ageDays - a.ageDays;
      if (sortBy === "confidence") return a.confidenceScore - b.confidenceScore;
      return b.score - a.score; // default: healthiest first
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ clusters: sorted }, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return structuredError({
      type: "HEALTH_ERROR",
      message: `Failed to compute health report: ${message}`,
    });
  }
}
