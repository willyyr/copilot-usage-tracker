// Extension: usage-tracker
// Tracks token usage per model across all GitHub Copilot CLI sessions.
// Data persists in ~/.copilot/usage-tracker/usage.json

import { joinSession } from "@github/copilot-sdk/extension";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFileSync } from "node:child_process";

// ── Storage ──────────────────────────────────────────────────────────────────
const DATA_DIR = join(homedir(), ".copilot", "usage-tracker");
const DATA_FILE = join(DATA_DIR, "usage.json");

function ensureDir() {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function loadData() {
    ensureDir();
    if (!existsSync(DATA_FILE)) return { sessions: [] };
    try {
        return JSON.parse(readFileSync(DATA_FILE, "utf-8"));
    } catch {
        return { sessions: [] };
    }
}

function saveData(data) {
    ensureDir();
    writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

// ── In-memory tracking for current session ───────────────────────────────────
const currentSession = {
    trackerRecordId: randomUUID(),
    id: null,
    startTime: new Date().toISOString(),
    cwd: process.cwd(),
    calls: [],           // per-API-call records from assistant.usage
    shutdownData: null,   // populated from session.shutdown
    persistedState: "none", // "none" | "partial" | "final"
};

// Promise-based gate so onSessionEnd can wait for session.shutdown to arrive.
let _resolveShutdownGate = null;
const _shutdownGate = new Promise((resolve) => { _resolveShutdownGate = resolve; });

function buildSessionRecord(shutdownData = currentSession.shutdownData) {
    const record = {
        trackerRecordId: currentSession.trackerRecordId,
        id: currentSession.id,
        startTime: currentSession.startTime,
        endTime: new Date().toISOString(),
        cwd: currentSession.cwd,
        calls: currentSession.calls,
    };

    // Merge shutdown metrics if available (authoritative per-model breakdown)
    if (shutdownData) {
        record.endTime = shutdownData.timestamp || record.endTime;
        record.totalPremiumRequests = shutdownData.totalPremiumRequests;
        record.totalApiDurationMs = shutdownData.totalApiDurationMs;
        record.modelMetrics = shutdownData.modelMetrics;
        record.shutdownType = shutdownData.shutdownType;
        record.codeChanges = shutdownData.codeChanges;
    }

    return record;
}

// Persist session data to disk. Partial records are upgraded in place when
// authoritative shutdown metrics arrive later in the lifecycle.
function persistSession(shutdownData = currentSession.shutdownData) {
    const nextState = shutdownData ? "final" : "partial";
    // Never downgrade final → partial; allow final → final so a later
    // shutdown event can overwrite stale data (e.g. from --resume replay).
    if (currentSession.persistedState === "final" && nextState === "partial") return;
    if (currentSession.persistedState === nextState && nextState === "partial") return;

    const record = buildSessionRecord(shutdownData);

    try {
        const data = loadData();
        const existingIndex = data.sessions.findIndex((sess) => sess.trackerRecordId === currentSession.trackerRecordId);

        if (existingIndex >= 0) {
            data.sessions[existingIndex] = record;
        } else {
            data.sessions.push(record);
        }

        saveData(data);
        currentSession.shutdownData = shutdownData ?? currentSession.shutdownData;
        currentSession.persistedState = nextState;
    } catch {
        // Silently fail — don't break shutdown
    }
}

// ── SIGTERM handler: last-resort flush ───────────────────────────────────────
process.on("SIGTERM", () => {
    persistSession();
    process.exit(0);
});

// ── Formatting helpers ───────────────────────────────────────────────────────
function fmtNum(n) {
    return n.toLocaleString("en-US");
}

function fmtDate(iso) {
    return new Date(iso).toLocaleDateString("en-US", {
        year: "numeric", month: "short", day: "numeric",
    });
}

function fmtDateTime(iso) {
    return new Date(iso).toLocaleString("en-US", {
        year: "numeric", month: "short", day: "numeric",
        hour: "2-digit", minute: "2-digit",
    });
}

function fmtPct(n) {
    return `${n.toFixed(1)}%`;
}

function fmtUsd(n) {
    const fractionDigits = n < 1 ? 4 : 2;
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: fractionDigits,
        maximumFractionDigits: fractionDigits,
    }).format(n);
}

function padCell(value, width, align = "left") {
    const text = String(value);
    return align === "right" ? text.padStart(width) : text.padEnd(width);
}

function renderTable(headers, rows, aligns = []) {
    const widths = headers.map((header, index) => {
        const rowWidth = rows.reduce((max, row) => Math.max(max, String(row[index] ?? "").length), 0);
        return Math.max(String(header).length, rowWidth);
    });
    const headerLine = headers.map((header, index) => padCell(header, widths[index], aligns[index])).join("  ");
    const separatorLine = widths.map(width => "-".repeat(width)).join("  ");
    const bodyLines = rows.map(row => row.map((cell, index) => padCell(cell ?? "", widths[index], aligns[index])).join("  "));
    return [headerLine, separatorLine, ...bodyLines].join("\n");
}

function renderBarGraph(value, width = 28) {
    const filled = Math.max(0, Math.min(width, Math.round(value * width)));
    return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function buildDateRangeLabel(sessions) {
    const dates = sessions.map(session => new Date(session.startTime)).sort((a, b) => a - b);
    return `${fmtDate(dates[0].toISOString())} -> ${fmtDate(dates[dates.length - 1].toISOString())}`;
}

const PUBLIC_TOKEN_PRICING = [
    {
        canonicalModel: "gpt-5.4",
        aliases: ["gpt-5.4", "gpt-5.4-2026-03-05"],
        sourceLabel: "OpenAI GPT-5.4 pricing",
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.4",
        ratesPerMillion: { input: 2.50, output: 15.00, cacheRead: 0.25 },
    },
    {
        canonicalModel: "gpt-5.4-mini",
        aliases: ["gpt-5.4-mini", "gpt-5.4-mini-2026-03-17"],
        sourceLabel: "OpenAI GPT-5.4 mini pricing",
        sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.4-mini",
        ratesPerMillion: { input: 0.75, output: 4.50, cacheRead: 0.075 },
    },
    {
        canonicalModel: "gpt-5.3-codex",
        aliases: ["gpt-5.3-codex"],
        sourceLabel: "OpenAI API pricing",
        sourceUrl: "https://developers.openai.com/api/docs/pricing",
        ratesPerMillion: { input: 1.75, output: 14.00, cacheRead: 0.175 },
    },
    {
        canonicalModel: "claude-opus-4.6",
        aliases: ["claude-opus-4.6"],
        sourceLabel: "Anthropic Claude pricing",
        sourceUrl: "https://docs.anthropic.com/en/docs/about-claude/pricing",
        ratesPerMillion: { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
    },
    {
        canonicalModel: "claude-opus-4.5",
        aliases: ["claude-opus-4.5"],
        sourceLabel: "Anthropic Claude pricing",
        sourceUrl: "https://docs.anthropic.com/en/docs/about-claude/pricing",
        ratesPerMillion: { input: 5.00, output: 25.00, cacheRead: 0.50, cacheWrite: 6.25 },
    },
    {
        canonicalModel: "claude-sonnet-4.6",
        aliases: ["claude-sonnet-4.6"],
        sourceLabel: "Anthropic Claude pricing",
        sourceUrl: "https://docs.anthropic.com/en/docs/about-claude/pricing",
        ratesPerMillion: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    },
    {
        canonicalModel: "claude-sonnet-4.5",
        aliases: ["claude-sonnet-4.5"],
        sourceLabel: "Anthropic Claude pricing",
        sourceUrl: "https://docs.anthropic.com/en/docs/about-claude/pricing",
        ratesPerMillion: { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
    },
    {
        canonicalModel: "claude-haiku-4.5",
        aliases: ["claude-haiku-4.5"],
        sourceLabel: "Anthropic Claude pricing",
        sourceUrl: "https://docs.anthropic.com/en/docs/about-claude/pricing",
        ratesPerMillion: { input: 1.00, output: 5.00, cacheRead: 0.10, cacheWrite: 1.25 },
    },
];

const PRICING_BY_MODEL = PUBLIC_TOKEN_PRICING.reduce((index, entry) => {
    for (const alias of entry.aliases) index[alias] = entry;
    return index;
}, {});

function lookupPricing(model) {
    return PRICING_BY_MODEL[model] || null;
}

function estimateModelRawCost(modelSummary) {
    const pricing = lookupPricing(modelSummary.model);
    if (!pricing) {
        return {
            available: false,
            amount: null,
            coverage: "No exact public source",
            sourceLabel: "N/A",
            sourceUrl: null,
        };
    }

    const tokenBuckets = [
        { key: "input", label: "input", tokens: modelSummary.inputTokens },
        { key: "output", label: "output", tokens: modelSummary.outputTokens },
        { key: "cacheRead", label: "cache-read", tokens: modelSummary.cacheReadTokens },
        { key: "cacheWrite", label: "cache-write", tokens: modelSummary.cacheWriteTokens },
    ];
    const missingRates = tokenBuckets
        .filter(bucket => bucket.tokens > 0 && pricing.ratesPerMillion[bucket.key] == null)
        .map(bucket => bucket.label);

    if (missingRates.length > 0) {
        return {
            available: false,
            amount: null,
            coverage: `Missing ${missingRates.join(", ")} pricing`,
            sourceLabel: pricing.sourceLabel,
            sourceUrl: pricing.sourceUrl,
        };
    }

    const amount = tokenBuckets.reduce((sum, bucket) => {
        const rate = pricing.ratesPerMillion[bucket.key];
        if (rate == null) return sum;
        return sum + (bucket.tokens / 1_000_000) * rate;
    }, 0);

    return {
        available: true,
        amount,
        coverage: "Exact cited pricing",
        sourceLabel: pricing.sourceLabel,
        sourceUrl: pricing.sourceUrl,
    };
}

// ── Aggregation ──────────────────────────────────────────────────────────────
function aggregateSessions(sessions, label, dateRange) {
    const byModel = {};
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
    let totalRequests = 0, totalCost = 0;
    const sessionCount = sessions.length;

    for (const sess of sessions) {
        // Prefer shutdown modelMetrics (most accurate) over per-call data
        if (sess.modelMetrics && Object.keys(sess.modelMetrics).length > 0) {
            for (const [model, m] of Object.entries(sess.modelMetrics)) {
                if (!byModel[model]) {
                    byModel[model] = { requests: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
                }
                byModel[model].requests += m.requests?.count ?? 0;
                byModel[model].cost += m.requests?.cost ?? 0;
                byModel[model].inputTokens += m.usage?.inputTokens ?? 0;
                byModel[model].outputTokens += m.usage?.outputTokens ?? 0;
                byModel[model].cacheReadTokens += m.usage?.cacheReadTokens ?? 0;
                byModel[model].cacheWriteTokens += m.usage?.cacheWriteTokens ?? 0;
                totalInput += m.usage?.inputTokens ?? 0;
                totalOutput += m.usage?.outputTokens ?? 0;
                totalCacheRead += m.usage?.cacheReadTokens ?? 0;
                totalCacheWrite += m.usage?.cacheWriteTokens ?? 0;
                totalRequests += m.requests?.count ?? 0;
                totalCost += m.requests?.cost ?? 0;
            }
        } else if (sess.calls?.length) {
            // Fallback: aggregate from per-call data
            for (const c of sess.calls) {
                const model = c.model || "unknown";
                if (!byModel[model]) {
                    byModel[model] = { requests: 0, cost: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
                }
                byModel[model].requests += 1;
                byModel[model].cost += c.cost ?? 0;
                byModel[model].inputTokens += c.inputTokens ?? 0;
                byModel[model].outputTokens += c.outputTokens ?? 0;
                byModel[model].cacheReadTokens += c.cacheReadTokens ?? 0;
                byModel[model].cacheWriteTokens += c.cacheWriteTokens ?? 0;
                totalInput += c.inputTokens ?? 0;
                totalOutput += c.outputTokens ?? 0;
                totalCacheRead += c.cacheReadTokens ?? 0;
                totalCacheWrite += c.cacheWriteTokens ?? 0;
                totalRequests += 1;
                totalCost += c.cost ?? 0;
            }
        }
    }

    const models = Object.entries(byModel)
        .map(([model, metrics]) => ({
            model,
            ...metrics,
            requestShare: totalRequests === 0 ? 0 : metrics.requests / totalRequests,
            totalTokens: metrics.inputTokens + metrics.outputTokens + metrics.cacheReadTokens + metrics.cacheWriteTokens,
        }))
        .sort((a, b) => b.requests - a.requests || b.totalTokens - a.totalTokens);

    const pricingRows = models.map(model => ({
        ...model,
        estimate: estimateModelRawCost(model),
    }));
    const coveredRequests = pricingRows.reduce((sum, row) => sum + (row.estimate.available ? row.requests : 0), 0);
    const estimatedRawCost = pricingRows.reduce((sum, row) => sum + (row.estimate.available ? row.estimate.amount : 0), 0);
    const pricingCoveragePct = totalRequests === 0 ? 0 : (coveredRequests / totalRequests) * 100;

    const lines = [];
    lines.push(`=== ${label} ===`);
    lines.push("");

    const metricsRows = [
        ["Sessions", fmtNum(sessionCount)],
        ["API calls", fmtNum(totalRequests)],
        ["Premium requests (cost)", totalCost.toFixed(1)],
        ["Input tokens", fmtNum(totalInput)],
        ["Output tokens", fmtNum(totalOutput)],
        ["Cache-read tokens", fmtNum(totalCacheRead)],
        ["Cache-write tokens", fmtNum(totalCacheWrite)],
        ["Raw token cost estimate", fmtUsd(estimatedRawCost)],
        ["Pricing coverage", `${fmtPct(pricingCoveragePct)} of requests (${fmtNum(coveredRequests)} / ${fmtNum(totalRequests)})`],
        ["Date range", dateRange],
    ];
    lines.push("Metrics");
    lines.push(renderTable(["Metric", "Value"], metricsRows));

    if (models.length === 0) {
        lines.push("");
        lines.push("No model usage recorded yet.");
        return lines.join("\n");
    }

    lines.push("");
    lines.push("By model");
    lines.push(renderTable(
        ["Model", "Requests", "Share", "Premium Cost", "Input", "Output", "Cache Read", "Cache Write"],
        models.map(model => [
            model.model,
            fmtNum(model.requests),
            fmtPct(model.requestShare * 100),
            model.cost.toFixed(1),
            fmtNum(model.inputTokens),
            fmtNum(model.outputTokens),
            fmtNum(model.cacheReadTokens),
            fmtNum(model.cacheWriteTokens),
        ]),
        ["left", "right", "right", "right", "right", "right", "right", "right"],
    ));

    lines.push("");
    lines.push("Request share by model");
    const graphNameWidth = Math.max(...models.map(model => model.model.length), "Model".length);
    for (const model of models) {
        lines.push(
            `${model.model.padEnd(graphNameWidth)}  ${renderBarGraph(model.requestShare)}  ${fmtPct(model.requestShare * 100).padStart(6)} (${fmtNum(model.requests)})`,
        );
    }

    lines.push("");
    lines.push("Raw token pricing estimate");
    lines.push(`Estimated total (cited models only): ${fmtUsd(estimatedRawCost)}`);
    lines.push(`Coverage: ${fmtPct(pricingCoveragePct)} of requests (${fmtNum(coveredRequests)} / ${fmtNum(totalRequests)})`);
    lines.push(renderTable(
        ["Model", "Raw Est.", "Coverage", "Source"],
        pricingRows.map(row => [
            row.model,
            row.estimate.available ? fmtUsd(row.estimate.amount) : "N/A",
            row.estimate.coverage,
            row.estimate.sourceLabel,
        ]),
    ));

    const citedSources = pricingRows.reduce((sources, row) => {
        if (row.estimate.sourceUrl && !sources.some(source => source.url === row.estimate.sourceUrl)) {
            sources.push({ label: row.estimate.sourceLabel, url: row.estimate.sourceUrl });
        }
        return sources;
    }, []);

    if (citedSources.length > 0) {
        lines.push("");
        lines.push("Sources");
        for (const [index, source] of citedSources.entries()) {
            lines.push(`[${index + 1}] ${source.label} - ${source.url}`);
        }
        lines.push("Method: raw estimate = token counts x official USD-per-1M-token rates. Models without an exact public source stay excluded from the estimate.");
        lines.push("Note: OpenAI sources list cached-input pricing but not a separate cache-write rate, so any nonzero cache-write tokens on those models are marked N/A.");
    }

    return lines.join("\n");
}

// ── Date range helpers ───────────────────────────────────────────────────────
function startOfDay(d) {
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x;
}

function filterByRange(sessions, range) {
    const now = new Date();
    let from, to;

    switch (range) {
        case "today":
            from = startOfDay(now);
            to = now;
            break;
        case "yesterday": {
            const y = new Date(now);
            y.setDate(y.getDate() - 1);
            from = startOfDay(y);
            to = startOfDay(now);
            break;
        }
        case "week": {
            const w = new Date(now);
            w.setDate(w.getDate() - 7);
            from = startOfDay(w);
            to = now;
            break;
        }
        case "month": {
            const m = new Date(now);
            m.setDate(m.getDate() - 30);
            from = startOfDay(m);
            to = now;
            break;
        }
        case "all":
        default:
            return sessions;
    }

    return sessions.filter(s => {
        const d = new Date(s.startTime);
        return d >= from && d <= to;
    });
}

// ── GitHub Copilot Quota API (undocumented, best-effort) ─────────────────────
function getGitHubTokenWithSource() {
    // Prefer `gh auth token` scoped to github.com — this returns the interactive
    // user's token and avoids leaking GHES tokens to api.github.com.
    try {
        const token = execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"],
        }).trim();
        if (token) return { token, source: "gh-cli" };
    } catch {
        // gh CLI not available or not authenticated for github.com
    }

    // Fallback to env vars — these may belong to a bot/automation account, so
    // the quota shown could differ from the interactive CLI user's quota.
    const envToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (envToken) return { token: envToken, source: "env" };

    return null;
}

async function fetchCopilotQuota() {
    if (typeof globalThis.fetch !== "function") return null;
    const resolved = getGitHubTokenWithSource();
    if (!resolved) return null;
    const { token, source: tokenSource } = resolved;

    // Try /copilot_internal/user first — works for all plan types and returns
    // richer data (plan name, overage info, percent_remaining).
    try {
        const resp = await fetch("https://api.github.com/copilot_internal/user", {
            headers: {
                Authorization: `token ${token}`,
                Accept: "application/json",
                "X-GitHub-Api-Version": "2025-05-01",
                "User-Agent": "copilot-cli-usage-tracker/1.0",
            },
            signal: AbortSignal.timeout?.(8000),
        });
        if (resp.ok) {
            const data = await resp.json();
            const pi = data?.quota_snapshots?.premium_interactions;
            if (pi && pi.entitlement !== undefined) {
                const entitlement = pi.entitlement;
                const remaining = pi.remaining ?? Math.round(entitlement * (pi.percent_remaining ?? 100) / 100);
                const used = entitlement - remaining;
                return {
                    used,
                    remaining,
                    quota: entitlement,
                    resetAt: data.quota_reset_date_utc ?? data.quota_reset_date ?? "",
                    unlimited: pi.unlimited ?? false,
                    overagePermitted: pi.overage_permitted ?? false,
                    overageCount: pi.overage_count ?? 0,
                    plan: data.copilot_plan ?? "unknown",
                    tokenSource,
                };
            }
        }
    } catch {
        // Endpoint not available or timed out
    }

    // Fallback: /copilot_internal/v2/token — may return the same
    // quota_snapshots shape or the older limited_user_quotas shape.
    try {
        const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
            headers: {
                Authorization: `token ${token}`,
                Accept: "application/json",
                "Editor-Version": "copilot-cli/1.0",
                "Editor-Plugin-Version": "usage-tracker/1.0",
            },
            signal: AbortSignal.timeout?.(8000),
        });
        if (resp.ok) {
            const data = await resp.json();

            // Try quota_snapshots first (same shape as /copilot_internal/user)
            const pi = data?.quota_snapshots?.premium_interactions;
            if (pi && pi.entitlement !== undefined) {
                const entitlement = pi.entitlement;
                const remaining = pi.remaining ?? Math.round(entitlement * (pi.percent_remaining ?? 100) / 100);
                const used = entitlement - remaining;
                return {
                    used,
                    remaining,
                    quota: entitlement,
                    resetAt: data.quota_reset_date_utc ?? data.quota_reset_date ?? "",
                    unlimited: pi.unlimited ?? false,
                    overagePermitted: pi.overage_permitted ?? false,
                    overageCount: pi.overage_count ?? 0,
                    plan: data.copilot_plan ?? "individual",
                    tokenSource,
                };
            }

            // Older shape: limited_user_quotas.copilot_premium_interaction.storage
            const cpi = data?.limited_user_quotas?.copilot_premium_interaction;
            const storage = cpi?.storage;
            if (storage && storage.quota !== undefined) {
                return {
                    used: storage.used ?? 0,
                    remaining: storage.remaining ?? 0,
                    quota: storage.quota,
                    resetAt: cpi?.quota_reset_at ?? "",
                    unlimited: false,
                    overagePermitted: false,
                    overageCount: 0,
                    plan: "individual",
                    tokenSource,
                };
            }
        }
    } catch {
        // Endpoint not available or timed out
    }

    return null;
}

function formatQuotaSection(quota) {
    const PLAN_LABELS = {
        free: "Free", individual: "Pro", individual_pro: "Pro+",
        business: "Business", enterprise: "Enterprise",
    };
    const planLabel = PLAN_LABELS[quota.plan] ?? quota.plan;
    const lines = [];

    lines.push("GitHub Copilot Premium Request Quota (live)");

    if (quota.unlimited) {
        const kvRows = [
            ["Plan", `${planLabel} (unlimited)`],
            ["Included", `${fmtNum(quota.quota)} premium requests (no cap — overage allowed)`],
        ];
        if (quota.resetAt) {
            try { kvRows.push(["Resets", fmtDate(quota.resetAt)]); }
            catch { kvRows.push(["Resets", quota.resetAt]); }
        }
        kvRows.push(["Note", "API does not track real-time usage for unlimited plans"]);
        kvRows.push(["", "See https://github.com/settings/copilot for actual usage"]);
        const keyWidth = Math.max(...kvRows.map(([k]) => k.length));
        lines.push(kvRows.map(([k, v]) => `  ${k.padEnd(keyWidth)}  ${v}`).join("\n"));
    } else {
        const pctUsed = quota.quota > 0 ? quota.used / quota.quota : 0;
        const kvRows = [
            ["Plan", planLabel],
            ["Premium used", `${fmtNum(quota.used)} / ${fmtNum(quota.quota)}`],
            ["Remaining", fmtNum(quota.remaining)],
            ["Usage", `${fmtPct(pctUsed * 100)}  ${renderBarGraph(pctUsed)}`],
        ];
        if (quota.overagePermitted) {
            kvRows.push(["Overage", `enabled (${fmtNum(quota.overageCount)} overage requests)`]);
        }
        if (quota.resetAt) {
            try { kvRows.push(["Resets", fmtDate(quota.resetAt)]); }
            catch { kvRows.push(["Resets", quota.resetAt]); }
        }
        const keyWidth = Math.max(...kvRows.map(([k]) => k.length));
        lines.push(kvRows.map(([k, v]) => `  ${k.padEnd(keyWidth)}  ${v}`).join("\n"));
    }

    lines.push("  Source: api.github.com/copilot_internal (undocumented — may change)");
    if (quota.tokenSource === "env") {
        lines.push("  ⚠ Using GITHUB_TOKEN/GH_TOKEN env var — quota may not match your CLI user");
    }
    return lines.join("\n");
}

// ── Event handler: captures session.start during init (the only event that ──
// ── may fire before session.on() listeners are registered).                ──
// ── assistant.usage and session.shutdown are handled exclusively via        ──
// ── session.on() to avoid double-capture and stale-replay issues.          ──
function handleEvent(event) {
    try {
        if (event.type === "session.start") {
            currentSession.id = event.data.sessionId;
            currentSession.startTime = event.data.startTime || event.timestamp;
        }
    } catch {
        // Never let event handling crash the extension
    }
}

// ── Session setup ────────────────────────────────────────────────────────────
// Use onEvent to capture events fired during joinSession() (e.g. session.start).
// Use hooks.onSessionEnd as the guaranteed persistence path — the CLI waits for
// the hook's RPC response before completing shutdown, so we write at least a
// partial record there and upgrade it if session.shutdown arrives later.
const session = await joinSession({
    onEvent: handleEvent,
    hooks: {
        onSessionStart: async (input) => {
            currentSession.id = input?.sessionId ?? currentSession.id;
            currentSession.startTime = input?.startTime ?? currentSession.startTime;
            currentSession.cwd = input?.cwd ?? currentSession.cwd;
        },
        onSessionEnd: async (input, _invocation) => {
            // The input may carry the same authoritative metrics as session.shutdown.
            if (input && !currentSession.shutdownData) {
                const candidate = {
                    timestamp: input.timestamp || new Date().toISOString(),
                    ...(typeof input === "object" ? input : {}),
                };
                if (candidate.modelMetrics || candidate.totalPremiumRequests != null) {
                    currentSession.shutdownData = candidate;
                }
            }

            // session.shutdown is an async event that may arrive just after (or
            // just before) this hook fires.  Give it a brief window to land so
            // we can persist the authoritative modelMetrics instead of a partial
            // calls-only record.
            if (!currentSession.shutdownData) {
                await Promise.race([
                    _shutdownGate,
                    new Promise((r) => setTimeout(r, 500)),
                ]);
            }

            persistSession();
        },
    },
    tools: [
        {
            name: "usage_report",
            description: "Show token usage report across all Copilot CLI sessions, broken down by model. Supports filtering by time range. Use this when the user asks about their token usage, model usage, or costs. IMPORTANT: Always display the full output verbatim to the user inside a code block. Do not summarize, truncate, or rephrase the output.",
            parameters: {
                type: "object",
                properties: {
                    range: {
                        type: "string",
                        description: "Time range to filter: 'today', 'yesterday', 'week', 'month', or 'all' (default: 'all')",
                        enum: ["today", "yesterday", "week", "month", "all"],
                    },
                },
            },
            skipPermission: true,
            handler: async (args) => {
                const data = loadData();
                const range = args.range || "all";
                const filtered = filterByRange(data.sessions, range);
                const labels = {
                    today: "Today's Usage",
                    yesterday: "Yesterday's Usage",
                    week: "Last 7 Days",
                    month: "Last 30 Days",
                    all: "All-Time Usage",
                };

                // Start quota fetch in parallel with local data formatting
                const quotaPromise = fetchCopilotQuota().catch(() => null);

                const parts = [];

                if (filtered.length === 0) {
                    parts.push(`No usage data found for range: ${range}. Usage tracking starts from the first session after this extension was installed.`);
                } else {
                    parts.push(aggregateSessions(filtered, labels[range], buildDateRangeLabel(filtered)));
                }

                const quota = await quotaPromise;
                if (quota) {
                    parts.push("");
                    parts.push(formatQuotaSection(quota));
                }

                return parts.join("\n");
            },
        },
        {
            name: "usage_sessions",
            description: "List individual session usage records with per-session model breakdown. Shows recent sessions first. IMPORTANT: Always display the full output verbatim to the user inside a code block. Do not summarize, truncate, or rephrase the output.",
            parameters: {
                type: "object",
                properties: {
                    limit: {
                        type: "number",
                        description: "Number of recent sessions to show (default: 10)",
                    },
                    range: {
                        type: "string",
                        description: "Time range filter: 'today', 'yesterday', 'week', 'month', or 'all' (default: 'all')",
                        enum: ["today", "yesterday", "week", "month", "all"],
                    },
                },
            },
            skipPermission: true,
            handler: async (args) => {
                const data = loadData();
                const range = args.range || "all";
                const limit = args.limit || 10;
                let filtered = filterByRange(data.sessions, range);
                filtered = filtered.slice(-limit).reverse();

                if (filtered.length === 0) {
                    return `No sessions found for range: ${range}.`;
                }

                const lines = [`═══ Recent Sessions (${filtered.length}) ═══`, ""];

                for (const sess of filtered) {
                    const totalIn = Object.values(sess.modelMetrics || {}).reduce((s, m) => s + (m.usage?.inputTokens ?? 0), 0)
                                 || sess.calls?.reduce((s, c) => s + (c.inputTokens ?? 0), 0) || 0;
                    const totalOut = Object.values(sess.modelMetrics || {}).reduce((s, m) => s + (m.usage?.outputTokens ?? 0), 0)
                                  || sess.calls?.reduce((s, c) => s + (c.outputTokens ?? 0), 0) || 0;
                    const models = Object.keys(sess.modelMetrics || {});
                    if (models.length === 0 && sess.calls?.length) {
                        for (const c of sess.calls) {
                            if (c.model && !models.includes(c.model)) models.push(c.model);
                        }
                    }

                    lines.push(`▸ ${fmtDateTime(sess.startTime)}  [${sess.id?.slice(0, 8) || "?"}]`);
                    lines.push(`  Models: ${models.join(", ") || "none"}  |  Input: ${fmtNum(totalIn)}  Output: ${fmtNum(totalOut)}`);
                    if (sess.cwd) lines.push(`  Dir: ${sess.cwd}`);
                    lines.push("");
                }

                return lines.join("\n");
            },
        },
        {
            name: "usage_export",
            description: "Export usage data as CSV for further analysis in Excel or other tools. IMPORTANT: When returning CSV content directly (no output_path), display the full output verbatim to the user inside a code block. Do not summarize or truncate.",
            parameters: {
                type: "object",
                properties: {
                    range: {
                        type: "string",
                        description: "Time range filter: 'today', 'yesterday', 'week', 'month', or 'all'",
                        enum: ["today", "yesterday", "week", "month", "all"],
                    },
                    output_path: {
                        type: "string",
                        description: "File path to write the CSV to. If omitted, returns CSV content directly.",
                    },
                },
            },
            skipPermission: true,
            handler: async (args) => {
                const data = loadData();
                const range = args.range || "all";
                const filtered = filterByRange(data.sessions, range);

                const rows = [["date", "session_id", "model", "requests", "cost", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"].join(",")];

                for (const sess of filtered) {
                    const date = sess.startTime?.split("T")[0] || "unknown";
                    const sid = sess.id || "unknown";

                    if (sess.modelMetrics && Object.keys(sess.modelMetrics).length > 0) {
                        for (const [model, m] of Object.entries(sess.modelMetrics)) {
                            rows.push([
                                date, sid, model,
                                m.requests?.count ?? 0,
                                m.requests?.cost ?? 0,
                                m.usage?.inputTokens ?? 0,
                                m.usage?.outputTokens ?? 0,
                                m.usage?.cacheReadTokens ?? 0,
                                m.usage?.cacheWriteTokens ?? 0,
                            ].join(","));
                        }
                    } else if (sess.calls?.length) {
                        // Aggregate calls by model for this session
                        const byModel = {};
                        for (const c of sess.calls) {
                            const model = c.model || "unknown";
                            if (!byModel[model]) byModel[model] = { requests: 0, cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
                            byModel[model].requests += 1;
                            byModel[model].cost += c.cost ?? 0;
                            byModel[model].input += c.inputTokens ?? 0;
                            byModel[model].output += c.outputTokens ?? 0;
                            byModel[model].cacheRead += c.cacheReadTokens ?? 0;
                            byModel[model].cacheWrite += c.cacheWriteTokens ?? 0;
                        }
                        for (const [model, m] of Object.entries(byModel)) {
                            rows.push([date, sid, model, m.requests, m.cost, m.input, m.output, m.cacheRead, m.cacheWrite].join(","));
                        }
                    }
                }

                const csv = rows.join("\n");

                if (args.output_path) {
                    writeFileSync(args.output_path, csv, "utf-8");
                    return `CSV exported to ${args.output_path} (${rows.length - 1} rows)`;
                }

                return csv;
            },
        },
        {
            name: "usage_clear",
            description: "Clear all stored usage data. Use with caution - this cannot be undone.",
            parameters: {
                type: "object",
                properties: {
                    confirm: {
                        type: "boolean",
                        description: "Must be true to confirm deletion",
                    },
                },
                required: ["confirm"],
            },
            handler: async (args) => {
                if (!args.confirm) return "Aborted. Pass confirm: true to clear all usage data.";
                saveData({ sessions: [] });
                return "All usage data has been cleared.";
            },
        },
    ],
});

// Register event handlers post-joinSession.  handleEvent (onEvent) only
// handles session.start; all other events are captured exclusively here
// to avoid the double-fire duplication that occurred when both paths ran.

session.on("assistant.usage", (event) => {
    try {
        const d = event.data || {};
        currentSession.calls.push({
            timestamp: event.timestamp,
            model: d.model,
            inputTokens: d.inputTokens ?? 0,
            outputTokens: d.outputTokens ?? 0,
            cacheReadTokens: d.cacheReadTokens ?? 0,
            cacheWriteTokens: d.cacheWriteTokens ?? 0,
            cost: d.cost ?? 0,
            duration: d.duration ?? 0,
            initiator: d.initiator,
        });
    } catch {
        // Never crash on usage event
    }
});

session.on("session.shutdown", (event) => {
    try {
        currentSession.shutdownData = {
            timestamp: event.timestamp,
            ...(event.data || {}),
        };
        persistSession(currentSession.shutdownData);
        // Unblock onSessionEnd if it is waiting for shutdown data
        if (_resolveShutdownGate) _resolveShutdownGate();
    } catch {
        // Never crash on shutdown
    }
});

await session.log("📊 Usage tracker active — use `usage_report` to see your token usage");
