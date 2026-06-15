/**
 * Tool handler for regrets_status — quick snapshot of Regrets state.
 *
 * Returns safeToRefactor (YES/PARTIAL/NO) along with coverage, health
 * counts, and confidence counts. This replicates the logic from
 * scripts/status.js but as a programmatic tool handler.
 */

import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "fs";
import { resolve, join } from "path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { structuredError } from "./structuredError.js";

// ─── Zod schema ──────────────────────────────────────────────────────────────

export const statusToolSchema = {
  cwd: z
    .string()
    .optional()
    .describe(
      "Working directory containing the regrets/ folder. Default: process.cwd()"
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
}): { label: "HIGH" | "MEDIUM" | "LOW" } {
  const f1 = inputCountFactor(opts.inputCount);
  const f2 = captureAgeFactor(opts.ageDays);
  const f3 = driftHistoryFactor(opts.hasDriftOrUpdate);
  const score = f1 * 0.5 + f2 * 0.2 + f3 * 0.3;
  return { label: confidenceLabel(score) };
}

// ─── Audit log parsing ──────────────────────────────────────────────────────

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

function parseAuditCounts(
  auditLogPath: string
): Record<string, { updates: number; drifts: number }> {
  const result: Record<string, { updates: number; drifts: number }> = {};
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
      const type = parts[1];
      const id = parts[2];
      if (!id) continue;
      if (!result[id]) result[id] = { updates: 0, drifts: 0 };
      if (type === "UPDATE") result[id].updates++;
      if (type === "DRIFT") result[id].drifts++;
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

// ─── Health scoring ─────────────────────────────────────────────────────────

type HealthLabel = "SOLID" | "GOOD" | "UNSTABLE" | "FRAGILE" | "NEW";

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

function healthLabel(score: number, isNew: boolean): HealthLabel {
  if (isNew) return "NEW";
  if (score >= 90) return "SOLID";
  if (score >= 70) return "GOOD";
  if (score >= 50) return "UNSTABLE";
  return "FRAGILE";
}

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleStatus(
  args: Record<string, unknown>
): Promise<CallToolResult> {
  try {
    const { cwd } = args as { cwd?: string };

    const workDir = resolve(cwd ?? process.cwd());
    const regretDir = join(workDir, "regrets");
    const manifestPath = join(workDir, "regrets/manifest.json");
    const auditLogPath = join(regretDir, "audit.log");
    const chainsJsonPath = join(regretDir, "chains.json");
    const chainsDir = join(regretDir, "chains");

    // Check if installed
    const isInstalled = existsSync(manifestPath);

    if (!isInstalled) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                installed: false,
                clusters: 0,
                captured: 0,
                lastCapture: null,
                health: {},
                confidence: {},
                safeToRefactor: "NO",
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // Load manifest
    let manifest: { clusters: Array<{ id: string; inputs?: unknown[] }> };
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch {
      return structuredError({
        type: "MANIFEST_CORRUPT",
        message: "manifest.json is corrupt or invalid JSON",
      });
    }

    const clusters = manifest.clusters || [];
    const clusterCount = clusters.length;

    // Parse .regret files
    const regretMetas: Record<string, Record<string, string>> = {};
    let regretFiles: string[] = [];
    try {
      regretFiles = readdirSync(regretDir).filter((f) =>
        f.endsWith(".regret")
      );
      for (const f of regretFiles) {
        const content = readFileSync(join(regretDir, f), "utf8");
        regretMetas[f.replace(".regret", "")] = parseRegretMeta(content);
      }
    } catch {
      /* no regrets/ dir or no .regret files */
    }

    // Compute metrics
    const driftMap = parseAuditForDrift(auditLogPath);
    const auditData = parseAuditCounts(auditLogPath);
    const now = Date.now();

    let latestCaptureTime = 0;
    const healthCounts: Record<HealthLabel, number> = {
      SOLID: 0,
      GOOD: 0,
      UNSTABLE: 0,
      FRAGILE: 0,
      NEW: 0,
    };
    const confidenceCounts: Record<string, number> = {
      HIGH: 0,
      MEDIUM: 0,
      LOW: 0,
    };
    const skippedClusters: string[] = [];

    for (const cluster of clusters) {
      const meta = regretMetas[cluster.id];
      const hasRegret = !!meta?.fingerprint;

      if (!hasRegret) {
        skippedClusters.push(cluster.id);
        healthCounts.FRAGILE++;
        confidenceCounts.LOW++;
        continue;
      }

      const captured = meta.captured
        ? new Date(meta.captured).getTime()
        : now;
      if (captured > latestCaptureTime) latestCaptureTime = captured;

      const ageHours = (now - captured) / (1000 * 60 * 60);
      const ageDays = Math.floor(ageHours / 24);
      const audit = auditData[cluster.id] || { updates: 0, drifts: 0 };
      const isNew =
        ageHours < 72 && audit.updates === 0 && audit.drifts === 0;
      const score = scoreCluster({
        updates: audit.updates,
        drifts: audit.drifts,
        ageDays,
      });
      const health = healthLabel(score, isNew);
      healthCounts[health] = (healthCounts[health] || 0) + 1;

      const inputCount = (cluster.inputs || []).length;
      const hasDriftOrUpdate = !!driftMap[cluster.id];
      const confidence = computeConfidence({
        inputCount,
        ageDays,
        hasDriftOrUpdate,
      });
      confidenceCounts[confidence.label] =
        (confidenceCounts[confidence.label] || 0) + 1;
    }

    // Coverage
    const capturedCount = clusterCount - skippedClusters.length;
    const coveragePct =
      clusterCount > 0
        ? Math.round((capturedCount / clusterCount) * 100)
        : 0;

    const lastCaptureISO =
      latestCaptureTime > 0
        ? new Date(latestCaptureTime).toISOString()
        : null;

    // Chain awareness
    let chainsDefined = 0;
    let chainsCaptured = 0;
    const chainsUncaptured: string[] = [];
    let chainsSection = false;

    if (existsSync(chainsJsonPath)) {
      chainsSection = true;
      try {
        const chainsJson = JSON.parse(readFileSync(chainsJsonPath, "utf8"));
        const chainList = chainsJson.chains || [];
        chainsDefined = chainList.length;
        for (const chain of chainList) {
          const chainFile = join(chainsDir, `${chain.id}.chain`);
          if (existsSync(chainFile)) {
            chainsCaptured++;
          } else {
            chainsUncaptured.push(chain.id);
          }
        }
      } catch {
        chainsSection = false;
      }
    }

    const hasUncapturedChains = chainsSection && chainsUncaptured.length > 0;

    // safeToRefactor logic (same as status.js)
    const hasFragile =
      healthCounts.FRAGILE > 0 || healthCounts.UNSTABLE > 0;
    const hasLow = confidenceCounts.LOW > 0;
    const hasGood = healthCounts.GOOD > 0 || healthCounts.NEW > 0;
    const hasMedium = confidenceCounts.MEDIUM > 0;

    let safeToRefactor: "YES" | "PARTIAL" | "NO";
    if (hasFragile || hasLow) {
      safeToRefactor = "NO";
    } else if (hasGood || hasMedium || hasUncapturedChains) {
      safeToRefactor = "PARTIAL";
    } else if (clusterCount > 0 && capturedCount === clusterCount) {
      safeToRefactor = "YES";
    } else {
      safeToRefactor = "NO";
    }

    // If uncaptured chains exist, max PARTIAL
    if (hasUncapturedChains && safeToRefactor === "YES") {
      safeToRefactor = "PARTIAL";
    }

    const result: Record<string, unknown> = {
      installed: true,
      clusters: clusterCount,
      captured: capturedCount,
      skipped: skippedClusters.length,
      lastCapture: lastCaptureISO,
      coverage: coveragePct,
      health: healthCounts,
      confidence: confidenceCounts,
      safeToRefactor,
    };

    if (chainsSection) {
      result.chains = { defined: chainsDefined, captured: chainsCaptured };
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return structuredError({
      type: "STATUS_ERROR",
      message: `Failed to compute status: ${message}`,
    });
  }
}
