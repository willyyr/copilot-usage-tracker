// Extension: usage-tracker
// Tracks token usage per model across all GitHub Copilot CLI sessions.
// Data persists in ~/.copilot/usage-tracker/usage.json

import { joinSession } from "@github/copilot-sdk/extension";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
    id: null,
    startTime: new Date().toISOString(),
    cwd: process.cwd(),
    calls: [],           // per-API-call records from assistant.usage
    modelMetrics: null,   // populated from session.shutdown
    persisted: false,     // guard against double-write
};

// Persist session data to disk (idempotent via persisted flag)
function persistSession(shutdownData) {
    if (currentSession.persisted) return;
    currentSession.persisted = true;

    const record = {
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

    try {
        const data = loadData();
        data.sessions.push(record);
        saveData(data);
    } catch {
        // Silently fail — don't break shutdown
    }
}

// ── SIGTERM handler: last-resort flush ───────────────────────────────────────
process.on("SIGTERM", () => {
    persistSession(null);
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

// ── Aggregation ──────────────────────────────────────────────────────────────
function aggregateSessions(sessions, label) {
    const byModel = {};
    let totalInput = 0, totalOutput = 0, totalCacheRead = 0, totalCacheWrite = 0;
    let totalRequests = 0, totalCost = 0, totalDurationMs = 0;
    let sessionCount = sessions.length;

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
                totalDurationMs += c.duration ?? 0;
            }
        }
    }

    // Build output
    const lines = [];
    lines.push(`═══ ${label} ═══`);
    lines.push(`Sessions: ${sessionCount}  |  API calls: ${fmtNum(totalRequests)}  |  Premium requests (cost): ${totalCost.toFixed(1)}`);
    lines.push(`Total tokens → Input: ${fmtNum(totalInput)}  Output: ${fmtNum(totalOutput)}  Cache-read: ${fmtNum(totalCacheRead)}  Cache-write: ${fmtNum(totalCacheWrite)}`);
    lines.push("");

    // Sort models by total tokens desc
    const sorted = Object.entries(byModel).sort((a, b) => {
        const aTotal = a[1].inputTokens + a[1].outputTokens;
        const bTotal = b[1].inputTokens + b[1].outputTokens;
        return bTotal - aTotal;
    });

    if (sorted.length === 0) {
        lines.push("No model usage recorded yet.");
        return lines.join("\n");
    }

    // Table header
    const hdr = [
        "Model".padEnd(30),
        "Calls".padStart(7),
        "Cost".padStart(8),
        "Input Tok".padStart(14),
        "Output Tok".padStart(14),
        "Cache Read".padStart(14),
        "Cache Write".padStart(14),
    ];
    lines.push(hdr.join("  "));
    lines.push("─".repeat(hdr.join("  ").length));

    for (const [model, m] of sorted) {
        lines.push([
            model.padEnd(30),
            fmtNum(m.requests).padStart(7),
            m.cost.toFixed(1).padStart(8),
            fmtNum(m.inputTokens).padStart(14),
            fmtNum(m.outputTokens).padStart(14),
            fmtNum(m.cacheReadTokens).padStart(14),
            fmtNum(m.cacheWriteTokens).padStart(14),
        ].join("  "));
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

// ── Event handler: captures ALL events including early ones like session.start ─
function handleEvent(event) {
    try {
        if (event.type === "session.start") {
            currentSession.id = event.data.sessionId;
            currentSession.startTime = event.data.startTime || event.timestamp;
        } else if (event.type === "assistant.usage") {
            currentSession.calls.push({
                timestamp: event.timestamp,
                model: event.data.model,
                inputTokens: event.data.inputTokens ?? 0,
                outputTokens: event.data.outputTokens ?? 0,
                cacheReadTokens: event.data.cacheReadTokens ?? 0,
                cacheWriteTokens: event.data.cacheWriteTokens ?? 0,
                cost: event.data.cost ?? 0,
                duration: event.data.duration ?? 0,
                initiator: event.data.initiator,
            });
        } else if (event.type === "session.shutdown") {
            currentSession.modelMetrics = event.data.modelMetrics;
            persistSession({
                timestamp: event.timestamp,
                ...event.data,
            });
        }
    } catch {
        // Never let event handling crash the extension
    }
}

// ── Session setup ────────────────────────────────────────────────────────────
// Use onEvent to capture events fired during joinSession() (e.g. session.start).
// Use hooks.onSessionEnd as the guaranteed persistence path — the CLI waits for
// the hook's RPC response before completing shutdown, so the write always finishes.
const session = await joinSession({
    onEvent: handleEvent,
    hooks: {
        onSessionEnd: async (_input, _invocation) => {
            persistSession(null);
        },
    },
    tools: [
        {
            name: "usage_report",
            description: "Show token usage report across all Copilot CLI sessions, broken down by model. Supports filtering by time range. Use this when the user asks about their token usage, model usage, or costs.",
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

                if (filtered.length === 0) {
                    return `No usage data found for range: ${range}. Usage tracking starts from the first session after this extension was installed.`;
                }

                let report = aggregateSessions(filtered, labels[range]);

                // Show date range
                const dates = filtered.map(s => new Date(s.startTime)).sort((a, b) => a - b);
                report += `\n\nDate range: ${fmtDate(dates[0].toISOString())} → ${fmtDate(dates[dates.length - 1].toISOString())}`;

                return report;
            },
        },
        {
            name: "usage_sessions",
            description: "List individual session usage records with per-session model breakdown. Shows recent sessions first.",
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
            description: "Export usage data as CSV for further analysis in Excel or other tools.",
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

// Also register event handler post-joinSession as backup (catches events
// that arrive after session creation but are missed by onEvent for any reason)
session.on("session.shutdown", (event) => {
    try {
        currentSession.modelMetrics = event.data?.modelMetrics;
        persistSession({
            timestamp: event.timestamp,
            ...(event.data || {}),
        });
    } catch {
        // Never crash on shutdown
    }
});

await session.log("📊 Usage tracker active — use `usage_report` to see your token usage");
