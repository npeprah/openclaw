/**
 * Smart Model Router — OpenClaw Plugin v6
 *
 * Fixes vs v5:
 *  1. Colored ANSI labels in TUI, bold-text labels on WhatsApp/SMS
 *  2. Automatic fallback when a model returns a token/quota error
 *  3. Model identity injected into system prompt so WhatsApp knows which model routed it
 *  4. Label injection consolidated in `message_sending` only (no more double-label race)
 *  5. Per-request routing state so concurrent sessions don't bleed into each other
 */

// ── ANSI color palette ────────────────────────────────────────────────────────

const ANSI = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  cyan:    "\x1b[36m",   // haiku  — fast/cheap
  magenta: "\x1b[35m",   // sonnet — power
  yellow:  "\x1b[33m",   // gemini — ultra-cheap
  green:   "\x1b[32m",   // fallback indicator
  red:     "\x1b[31m",   // error/warning
} as const;

const MODEL_COLOR: Record<string, string> = {
  "anthropic/claude-sonnet-4-6":  ANSI.magenta,
  "anthropic/claude-haiku-4-5":   ANSI.cyan,
  "google/gemini-2.0-flash-lite": ANSI.yellow,
};

// ── Defaults ──────────────────────────────────────────────────────────────────

const DEFAULT_TASKS: Record<string, { model: string; description: string }> = {
  debugging:   { model: "anthropic/claude-sonnet-4-6",  description: "Fixing bugs and errors" },
  analysis:    { model: "anthropic/claude-sonnet-4-6",  description: "Deep analysis, research, architecture" },
  coding:      { model: "anthropic/claude-sonnet-4-6",  description: "Writing code, scripts, plugins" },
  math:        { model: "anthropic/claude-sonnet-4-6",  description: "Math, calculations, formulas" },
  writing:     { model: "anthropic/claude-haiku-4-5",   description: "Essays, reports, long-form content" },
  summary:     { model: "anthropic/claude-haiku-4-5",   description: "Summarizing content" },
  email:       { model: "google/gemini-2.0-flash-lite", description: "Email drafting and summaries" },
  search:      { model: "google/gemini-2.0-flash-lite", description: "Web lookups, news, quick facts" },
  translation: { model: "google/gemini-2.0-flash-lite", description: "Translating text" },
  chat:        { model: "google/gemini-2.0-flash-lite", description: "General conversation" },
};

/**
 * Ordered fallback chain — when a model fails due to quota/tokens,
 * the router tries the next model down the list.
 */
const FALLBACK_CHAIN: string[] = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-haiku-4-5",
  "google/gemini-2.0-flash-lite",
];

const MODEL_ALIASES: Record<string, string> = {
  opus:   "anthropic/claude-sonnet-4-6",
  sonnet: "anthropic/claude-sonnet-4-6",
  haiku:  "anthropic/claude-haiku-4-5",
  flash:  "google/gemini-2.0-flash-lite",
  gemini: "google/gemini-2.0-flash-lite",
  claude: "anthropic/claude-sonnet-4-6",
};

const MODEL_DISPLAY: Record<string, string> = {
  "anthropic/claude-sonnet-4-6":  "sonnet-4.6",
  "anthropic/claude-haiku-4-5":   "haiku-4.5",
  "google/gemini-2.0-flash-lite": "gemini-flash-lite",
};

// ── Task patterns ─────────────────────────────────────────────────────────────

const TASK_PATTERNS: Array<{ task: string; patterns: RegExp[] }> = [
  { task: "debugging", patterns: [
    /\b(debug|fix (this|the|a|my)|error|bug|issue|broken|not working|crash|exception|traceback)\b/i,
  ]},
  { task: "analysis", patterns: [
    /\b(analyze|analyse|architecture|compare|pros and cons|deep dive|step.?by.?step|algorithm|optimize|security|audit|review)\b/i,
  ]},
  { task: "coding", patterns: [
    /\b(write|create|build|implement|make|generate)\s+(a\s+)?(script|function|class|app|plugin|program|tool|component|module|api|endpoint|cli|bot)\b/i,
    /\b(code|coding|program|programming|typescript|javascript|python|nodejs|bash|rust|golang|ruby|php|java|sql)\b/i,
    /\b(npm|pip|git|docker|kubernetes|deploy|github)\b/i,
  ]},
  { task: "math", patterns: [
    /\b(calculate|compute|equation|formula|statistics|percentage|convert|how many|how much)\b/i,
  ]},
  { task: "writing", patterns: [
    /\b(write a (report|essay|plan|proposal|document|guide|tutorial|blog|article|story|cover letter|resume))\b/i,
    /\b(draft|outline|long.?form)\b/i,
  ]},
  { task: "email", patterns: [
    /\b(email|e-mail|reply to|draft.*email|email.*draft|write.*email|newsletter)\b/i,
  ]},
  { task: "summary", patterns: [
    /\b(summar|summarize|summarise|tldr|tl;dr|key points|highlights|overview|condense)\b/i,
  ]},
  { task: "translation", patterns: [
    /\b(translat|to (spanish|french|german|chinese|japanese|arabic|portuguese|italian|korean|hindi)|in (spanish|french|german|chinese|japanese|arabic|portuguese|italian|korean|hindi))\b/i,
  ]},
  { task: "search", patterns: [
    /\b(search|look up|find out|what is|who is|when did|where is|news|latest|recent)\b/i,
  ]},
];

// ── Types ─────────────────────────────────────────────────────────────────────

interface Routing {
  model: string;
  task: string;
  overridden: boolean;
  overrideAlias?: string;
  fallbackFrom?: string;   // set when we fell back from another model
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractOverride(text: string): { alias: string; model: string } | null {
  const m = text.match(/@(\w+)\s*$/i);
  if (!m) return null;
  const model = MODEL_ALIASES[m[1].toLowerCase()];
  return model ? { alias: m[1].toLowerCase(), model } : null;
}

function classify(text: string, taskMap: Record<string, string>): { task: string; model: string } {
  if (text.length > 1000) return { task: "analysis", model: taskMap["analysis"] };
  for (const { task, patterns } of TASK_PATTERNS) {
    for (const p of patterns) {
      if (p.test(text)) return { task, model: taskMap[task] ?? DEFAULT_TASKS[task].model };
    }
  }
  return { task: "chat", model: taskMap["chat"] ?? DEFAULT_TASKS["chat"].model };
}

/**
 * Detect quota / token exhaustion errors vs regular model errors.
 * Covers OpenAI-style, Anthropic-style, and Google-style error messages.
 */
function isQuotaError(err: any): boolean {
  const msg: string = (err?.message ?? err?.error?.message ?? String(err)).toLowerCase();
  return (
    msg.includes("rate limit") ||
    msg.includes("quota") ||
    msg.includes("token limit") ||
    msg.includes("context length") ||
    msg.includes("overloaded") ||
    msg.includes("capacity") ||
    msg.includes("429") ||
    (err?.status === 429) ||
    (err?.statusCode === 429)
  );
}

/**
 * Split a full "provider/model" string for use with OpenClaw's model resolution.
 * OpenClaw prepends the currently-active provider to modelOverride, so passing
 * "google/gemini-2.0-flash-lite" yields "anthropic/google/gemini-2.0-flash-lite".
 * We fix this by always passing BOTH providerOverride and modelOverride together.
 */
function splitModel(full: string): { provider: string; slug: string } {
  const slash = full.indexOf("/");
  return slash !== -1 ? full.slice(slash + 1) : full;
}

/**
 * Returns the next model in the fallback chain after `currentModel`.
 * Returns null if we've exhausted all options.
 */
function nextFallback(currentModel: string, triedModels: Set<string>): string | null {
  for (const m of FALLBACK_CHAIN) {
    if (!triedModels.has(m)) return m;
  }
  return null;
}

/**
 * Build the label string for prepending to messages.
 * - TUI / terminal: ANSI colored
 * - WhatsApp / SMS / other: plain bold markdown
 */
function makeLabel(r: Routing, channel?: string): string {
  const name    = MODEL_DISPLAY[r.model] ?? r.model.split("/").pop() ?? r.model;
  const isAnsi  = !channel || channel === "tui" || channel === "terminal" || channel === "cli";
  const color   = MODEL_COLOR[r.model] ?? ANSI.cyan;

  let tag: string;
  if (r.fallbackFrom) {
    const fromName = MODEL_DISPLAY[r.fallbackFrom] ?? r.fallbackFrom.split("/").pop();
    tag = `[${name} ↩ fallback from ${fromName}]`;
  } else if (r.overridden) {
    tag = `[${name} @${r.overrideAlias}]`;
  } else {
    tag = `[${name} · ${r.task}]`;
  }

  if (isAnsi) {
    return `${color}${ANSI.bold}${tag}${ANSI.reset}`;
  }
  // WhatsApp / SMS — use markdown bold (WhatsApp renders *bold*)
  return `*${tag}*`;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export default function register(api: any) {
  const getCfg = () => {
    const raw      = api.config?.plugins?.entries?.["smart-router"]?.config ?? {};
    const overrides: Record<string, string> = raw.tasks ?? {};
    const taskMap: Record<string, string>   = {};
    for (const [task, def] of Object.entries(DEFAULT_TASKS)) {
      taskMap[task] = overrides[task] ?? def.model;
    }
    return {
      enabled: raw.enabled !== false,
      debug:   raw.debug === true,
      taskMap,
    };
  };

  // Per-request state — keyed by request ID so concurrent requests don't bleed
  const requestState = new Map<string, { routing: Routing; tried: Set<string> }>();

  // ── 1. Pick model ────────────────────────────────────────────────────────────
  api.on("before_model_resolve", async (event: any, ctx: any) => {
    const cfg = getCfg();
    if (!cfg.enabled) return;

    const text: string = event.prompt ?? "";
    if (!text) return;

    const reqId = ctx.requestId ?? ctx.id ?? "default";
    const tried = new Set<string>();

    const override = extractOverride(text);
    let routing: Routing;

    if (override) {
      routing = {
        model:         override.model,
        task:          "override",
        overridden:    true,
        overrideAlias: override.alias,
      };
    } else {
      const { task, model } = classify(text, cfg.taskMap);
      routing = { model, task, overridden: false };
    }

    tried.add(routing.model);
    requestState.set(reqId, { routing, tried });

    if (cfg.debug) {
      api.logger.info(`[smart-router] req=${reqId} model=${routing.model} task=${routing.task}`);
    }

    const { provider, slug } = splitModel(routing.model);
    return { providerOverride: provider, modelOverride: slug };
  });

  // ── 2. Inject identity into system prompt ────────────────────────────────────
  //   This is what makes WhatsApp (and any channel) aware of routing.
  //   We do NOT ask the model to print a label here — that's handled in
  //   message_sending so it's always consistent regardless of model compliance.
  api.on("before_prompt_build", async (event: any, ctx: any) => {
    const cfg = getCfg();
    if (!cfg.enabled) return;

    const reqId   = ctx.requestId ?? ctx.id ?? "default";
    const state   = requestState.get(reqId);
    if (!state) return;

    const { routing } = state;
    const name        = MODEL_DISPLAY[routing.model] ?? routing.model.split("/").pop() ?? routing.model;
    const taskNote    = routing.overridden
      ? `manually selected via @${routing.overrideAlias}`
      : `auto-routed for task: ${routing.task}`;

    // Give the model self-knowledge so it can answer questions about routing
    return {
      prependContext: [
        `[Smart Router] You are responding as: ${name} (${routing.model})`,
        `Routing decision: ${taskNote}.`,
        `If the user asks which model you are, or about smart routing, tell them:`,
        `  • Model: ${name}`,
        `  • Task detected: ${routing.task}`,
        `  • Routing: ${taskNote}`,
        `Do NOT print a label prefix yourself — the router handles that display separately.`,
        "",
      ].join("\n"),
    };
  });

  // ── 3. Prepend colored label to every outgoing message ───────────────────────
  api.on("message_sending", async (event: any, ctx: any) => {
    const cfg = getCfg();
    if (!cfg.enabled) return;
    if (typeof event.content !== "string" || !event.content) return;

    const reqId   = ctx.requestId ?? ctx.id ?? "default";
    const state   = requestState.get(reqId);
    if (!state) return;

    // Detect channel so we can pick ANSI vs markdown formatting
    // Log the raw channel value so we can see what OpenClaw actually sends
    const channel: string | undefined = ctx.channel ?? ctx.source ?? undefined;
    if (cfg.debug) api.logger.info(`[smart-router] channel=${JSON.stringify(channel)}`);

    // WhatsApp/SMS channels are the only ones that can't render ANSI.
    // Default to ANSI for everything else (TUI, web, unknown).
    const isPlainText = channel === "whatsapp" || channel === "sms" || channel === "twilio";
    const label = isPlainText ? makeLabel(state.routing, "whatsapp") : makeLabel(state.routing, "tui");

    // Guard: don't double-label (ANSI labels start with \x1b, markdown with *)
    if (event.content.startsWith("\x1b") || event.content.startsWith("*[")) return;

    // Clean up request state once we've sent the response
    requestState.delete(reqId);

    return { content: label + "\n" + event.content };
  });

  // ── 4. Token / quota fallback ────────────────────────────────────────────────
  api.on("model_error", async (event: any, ctx: any) => {
    const cfg = getCfg();
    if (!cfg.enabled) return;
    if (!isQuotaError(event.error)) return;   // only handle quota/token errors

    const reqId = ctx.requestId ?? ctx.id ?? "default";
    const state = requestState.get(reqId);
    if (!state) return;

    const { routing, tried } = state;
    const failedModel = routing.model;
    const next = nextFallback(failedModel, tried);

    if (!next) {
      if (cfg.debug) {
        api.logger.warn(`[smart-router] All models exhausted for req=${reqId}`);
      }
      requestState.delete(reqId);
      return; // let the error propagate naturally
    }

    tried.add(next);
    const newRouting: Routing = {
      model:        next,
      task:         routing.task,
      overridden:   false,
      fallbackFrom: failedModel,
    };
    requestState.set(reqId, { routing: newRouting, tried });

    if (cfg.debug) {
      api.logger.warn(
        `[smart-router] quota hit on ${failedModel}, falling back to ${next} (req=${reqId})`
      );
    }

    // Retry with explicit provider so OpenClaw doesn't double-prefix the model
    const { provider: nextProvider, slug: nextSlug } = splitModel(next);
    return { retryWithModel: nextSlug, providerOverride: nextProvider };
  });

  // ── /smartrouter command ─────────────────────────────────────────────────────
  api.registerCommand({
    name:        "smartrouter",
    description: "Smart Router: status, tasks, aliases, set task=model",
    acceptsArgs: true,
    handler: (ctx: any) => {
      const cfg  = getCfg();
      const args = (ctx.args ?? "").trim();

      if (args === "tasks") {
        const lines = ["⚡ Smart Router — Task → Model Map", ""];
        for (const [task, def] of Object.entries(DEFAULT_TASKS)) {
          const model   = cfg.taskMap[task] ?? def.model;
          const display = MODEL_DISPLAY[model] ?? model.split("/").pop();
          const custom  = cfg.taskMap[task] && cfg.taskMap[task] !== def.model;
          lines.push(`  ${task.padEnd(12)} → ${display}${custom ? " ✏️" : ""}`);
        }
        lines.push("", "✏️ = customized  |  /smartrouter set <task>=<model>");
        return { text: lines.join("\n") };
      }

      if (args === "aliases") {
        const lines = ["⚡ Model Aliases", ""];
        for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
          lines.push(`  @${alias.padEnd(8)} → ${MODEL_DISPLAY[model] ?? model.split("/").pop()}`);
        }
        lines.push("", "Usage: append @alias to the end of any message");
        return { text: lines.join("\n") };
      }

      if (args === "fallback") {
        const lines = ["⚡ Fallback Chain (in order)", ""];
        FALLBACK_CHAIN.forEach((m, i) => {
          lines.push(`  ${i + 1}. ${MODEL_DISPLAY[m] ?? m}`);
        });
        lines.push("", "If a model hits quota/token limits it falls to the next.");
        return { text: lines.join("\n") };
      }

      if (args.startsWith("set ")) {
        const pair = args.slice(4).trim();
        const eq   = pair.indexOf("=");
        if (eq === -1) return { text: "Usage: /smartrouter set <task>=<model>" };

        const task = pair.slice(0, eq).trim().toLowerCase();
        let model  = pair.slice(eq + 1).trim();
        if (MODEL_ALIASES[model.toLowerCase()]) model = MODEL_ALIASES[model.toLowerCase()];

        if (!DEFAULT_TASKS[task]) {
          return { text: `❌ Unknown task: ${task}\nValid tasks: ${Object.keys(DEFAULT_TASKS).join(", ")}` };
        }

        try {
          const fs      = require("fs");
          const cfgPath = `${process.env.HOME}/.openclaw/openclaw.json`;
          const raw     = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          raw.plugins                                         ??= {};
          raw.plugins.entries                                 ??= {};
          raw.plugins.entries["smart-router"]                 ??= {};
          raw.plugins.entries["smart-router"].config          ??= {};
          raw.plugins.entries["smart-router"].config.tasks    ??= {};
          raw.plugins.entries["smart-router"].config.tasks[task] = model;
          fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2));
          return {
            text: `✅ ${task} → ${MODEL_DISPLAY[model] ?? model.split("/").pop()}\n\nRestart: openclaw gateway restart`,
          };
        } catch (e: any) {
          return { text: `❌ ${e.message}` };
        }
      }

      return {
        text: [
          `⚡ Smart Router — ${cfg.enabled ? "ON 🟢" : "OFF 🔴"}`,
          "",
          "  /smartrouter tasks                — task→model map",
          "  /smartrouter aliases              — @alias shortcuts",
          "  /smartrouter fallback             — fallback chain order",
          "  /smartrouter set <task>=<model>   — override a task's model",
          "",
          "Inline override: add @sonnet / @haiku / @flash to end of any message",
          "",
          "Label colors (TUI):  magenta=sonnet  cyan=haiku  yellow=gemini",
        ].join("\n"),
      };
    },
  });
}
