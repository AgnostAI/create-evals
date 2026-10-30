import type { AgentModel, Finding, PromptLine, RuleId, SourceLoc, ToolDef, ToolParam } from "../core/types.js";
import { lineText } from "../scan/project.js";
import { functionRules, generalPromptRules } from "./function-rules.js";
import { effectOf, isExecSink, isFsRead, isFsWrite, PII_FIELDS, words, type Effect } from "./effects.js";

type Draft = Omit<Finding, "id" | "evidence" | "symbols"> & { symbols?: string[] };

const MONEY_PARAM = /amount|price|total|credit|refund|percent|discount|fee|balance|budget|cost|usd|cents/i;
const PATH_PARAM = /^(path|filePath|filepath|file|filename|fileName|dir|directory|target|dest|destination)$/;
const DEST_PARAM = /^(to|recipient|recipients|email|url|uploadUrl|webhook|webhookUrl|endpoint|destination|address)$/i;
const DANGEROUS_FLAGS = /^(force|hard|overwrite|skipVerify|noVerify|recursive|purge|prune|all)$/;
const SECRET_PARAM = /^(private_?key|privateKey|secret(_?key)?|password|passphrase|mnemonic|seed_?phrase|api_?key|apiKey|access_?token|accessToken|auth_?token|authToken)$/i;
const CODE_PARAM = /^(command|cmd|script|code|sql|query|where|statement|expression|shell)$/i;

const AUTONOMY = /never ask|without (asking|check-?ins|confirmation|permission|approval)|act first|fully autonomous|move fast|single reply|don'?t wait|whenever you notice|proactively|just get (it|the task) done/i;
const CAUTION = /approval|approve|careful|confirm|permission|verify|opted|opt-in|consent|manager|never (delete|share|reveal)|only\b/i;
const POLICY = /\b(needs? (a |an )?[\w']*\s?(approval|confirmation|sign-?off|review)|requires? (approval|confirmation|a manager|sign-?off|review)|must (not|never|be approved|be confirmed)|never|always (ask|confirm|check|verify)|approv(al|e)|confirm(ation)?|verif(y|ied)|opted|opt-in|consent|at most|no more than|only (if|when|after|for|to|with) [\w ]*(who|that|which|have|has|are|is)?)\b|\b(over|above|more than|under|below|exceeds?) \$?\d/i;
const FOLLOW = /follow (it|them|the|instructions)|do what (it|the page) says|and follow/i;
const SHARE = /share|partner|export|send (the )?data|hand off/i;

const STOPWORDS = new Set(["issue", "get", "lookup", "look", "apply", "create", "run", "do", "make", "tool", "records", "database", "file", "data", "customer", "customers", "the", "a", "to", "url", "code", "help", "center", "search", "bulk"]);

export function runRules(model: AgentModel): Finding[] {
  const drafts: Draft[] = [];
  const effects = new Map(model.tools.map((t) => [t.name, effectOf(t)]));
  const promptLines = model.prompts.flatMap((p) => p.lines.map((l) => ({ ...l, file: p.file })));
  const dangerous = model.tools.filter((t) => ["money", "delete", "exec", "send", "external-write"].includes(effects.get(t.name)!.kind));
  const piiTools = model.tools.filter((t) => piiFields(t).length >= 2);

  for (const tool of model.tools) {
    const effect = effects.get(tool.name)!;
    drafts.push(...toolRules(tool, effect, { dangerous, piiTools, promptLines, model }));
  }
  // Tool-level prompt rules only make sense for tool-calling agents.
  if (model.tools.length) drafts.push(...promptRules(model, promptLines, effects));
  drafts.push(...functionRules(model));
  drafts.push(...generalPromptRules(model, new Set(drafts.flatMap((d) => [d.loc, ...d.related]).map((l) => `${l.file}:${l.line}`))));

  return dedupeIds(mergeSiblings(drafts).map((d) => finalize(model, d)));
}

interface RuleCtx {
  dangerous: ToolDef[];
  piiTools: ToolDef[];
  promptLines: (PromptLine & { file: string })[];
  model: AgentModel;
}

function toolRules(tool: ToolDef, effect: Effect, ctx: RuleCtx): Draft[] {
  const out: Draft[] = [];
  const base = { tool: tool.name, related: [] as SourceLoc[] };
  const flags = tool.params.filter((p) => p.type === "boolean" && DANGEROUS_FLAGS.test(p.name)).map((p) => p.name);

  // Params that flow straight into a shell / SQL / eval sink.
  for (const call of tool.calls) {
    const sqlLike = /\b(DELETE|UPDATE|INSERT|DROP|SELECT|ALTER)\b/i.test(call.args.join(" ")) || /\.(query|exec|raw|unsafe|execute)$/.test(call.callee);
    if (!isExecSink(call.callee) && !sqlLike) continue;
    for (const p of tool.params.filter((p) => p.type === "string" && flowsInto(p.name, call.args))) {
      const isCode = CODE_PARAM.test(p.name);
      out.push({
        ...base,
        rule: "arbitrary-exec",
        severity: isCode ? 5 : 3,
        title: `${tool.name} passes \`${p.name}\` straight into ${call.callee}`,
        param: p.name,
        loc: call.loc,
        related: [p.loc],
        facts: { sink: call.callee, sql: sqlLike && !isExecSink(call.callee), dangerousFlags: flags },
      });
    }
  }

  // Filesystem access with a model-controlled path and no containment check.
  const fsCalls = tool.calls.filter((c) => isFsWrite(c.callee) || isFsRead(c.callee));
  const contained = /startsWith\(|path\.relative\(|allow(ed)?(List|Paths|Dirs)|within|isInside|sandbox/i.test(tool.executeSource);
  for (const p of tool.params.filter((p) => PATH_PARAM.test(p.name))) {
    if (contained || !fsCalls.length) continue;
    const write = fsCalls.some((c) => isFsWrite(c.callee));
    out.push({
      ...base,
      rule: "unrestricted-path",
      severity: write ? 5 : 4,
      title: `${tool.name} can ${write ? "write" : "read"} any path on disk`,
      param: p.name,
      loc: p.loc,
      related: [fsCalls[0]!.loc],
      facts: { mode: write ? "write" : "read", sink: fsCalls[0]!.callee },
    });
  }

  // Irreversible actions with no approval step.
  if (["money", "delete", "exec", "send", "external-write"].includes(effect.kind) && !tool.hasApproval) {
    out.push({
      ...base,
      rule: "no-confirmation",
      severity: effect.kind === "external-write" ? 4 : 5,
      title: `${tool.name} ${effect.does} with no confirmation step`,
      loc: tool.loc,
      related: tool.executeLoc ? [tool.executeLoc] : [],
      facts: { effect: effect.kind, act: effect.act, dangerousFlags: flags, notes: notesOf(tool) },
    });
  }

  // Numeric inputs with no ceiling.
  const sideEffect = effect.kind !== "read";
  const mention = promptMention(tool, ctx.promptLines);
  for (const p of tool.params.filter((p) => p.type === "number" && !p.bounded && !p.guarded)) {
    const money = MONEY_PARAM.test(p.name) || effect.kind === "money";
    if (!money && !sideEffect) continue;
    out.push({
      ...base,
      rule: "missing-limit",
      severity: money ? (p.optional ? 3 : 5) : 3,
      title: `${tool.name} accepts any \`${p.name}\` — no cap in the schema or handler`,
      param: p.name,
      loc: p.loc,
      related: mention ? [{ file: mention.file, line: mention.line }] : [],
      facts: { money, percent: /percent|pct/i.test(p.name), optional: p.optional, threshold: thresholdFor(p, ctx.promptLines), promptQuote: mention?.text.replace(/^[-*]\s*/, "") ?? "" },
    });
  }

  // Lists of targets with no ceiling.
  for (const p of tool.params.filter((p) => p.type === "array" && !p.bounded)) {
    if (!["send", "delete", "write", "money", "external-write"].includes(effect.kind)) continue;
    out.push({
      ...base,
      rule: "unbounded-list",
      severity: effect.kind === "send" || effect.kind === "delete" ? 5 : 4,
      title: `${tool.name} accepts an unbounded \`${p.name}\` list`,
      param: p.name,
      loc: p.loc,
      facts: { effect: effect.kind },
    });
  }

  // Data leaving through a destination the model chooses.
  const destParams = tool.params.filter((p) => DEST_PARAM.test(p.name) && p.type !== "array");
  for (const p of destParams) {
    const outbound = tool.calls.find((c) => flowsInto(p.name, c.args) && (c.callee === "fetch" || /send|mail|post|upload|put/i.test(c.callee)));
    if (!outbound) continue;
    const ownPii = piiFields(tool);
    const otherPii = ctx.piiTools.filter((t) => t.name !== tool.name).map((t) => t.name);
    if (!ownPii.length && !otherPii.length && effect.kind !== "external-write" && !/url/i.test(p.name)) continue;
    const prompt = ctx.promptLines.find((l) => SHARE.test(l.text));
    out.push({
      ...base,
      rule: "data-exfiltration",
      severity: ownPii.length || /upload|put|post/i.test(outbound.args.join(",")) || effect.kind === "external-write" ? 5 : 4,
      title: `${tool.name} sends data to whatever \`${p.name}\` the model picks`,
      param: p.name,
      loc: outbound.loc,
      related: [p.loc, ...(prompt ? [{ file: prompt.file, line: prompt.line }] : [])],
      facts: { dest: p.name, piiSources: otherPii, ownPii: piiFields(tool, true), promptQuote: prompt?.text ?? "" },
    });
  }

  // Untrusted text flowing back into the context.
  const external =
    tool.calls.some((c) => c.callee === "fetch" || /\.(text|json)$/.test(c.callee)) ||
    tool.calls.some((c) => /third-party|external|user-generated|contractors|can edit|public/i.test(c.calleeNotes ?? "")) ||
    /fetch|scrape|browse|web|inbox|read_?email|article|ticket|review|comment|help_?center/.test(words(tool.name).join("_"));
  if (external && effect.kind === "read" && !destParams.some((p) => /url/i.test(p.name) && tool.calls.some((c) => /method:\s*["'](PUT|POST)/.test(c.args.join(","))))) {
    const follow = ctx.promptLines.find((l) => FOLLOW.test(l.text));
    const dangerousOthers = ctx.dangerous.filter((t) => t.name !== tool.name).map((t) => t.name);
    out.push({
      ...base,
      rule: "injection-surface",
      severity: dangerousOthers.length ? 5 : 4,
      title: `${tool.name} puts untrusted text into the conversation`,
      loc: tool.loc,
      related: follow ? [{ file: follow.file, line: follow.line }] : [],
      facts: {
        dangerousTools: dangerousOthers,
        source: tool.calls.find((c) => c.calleeNotes)?.calleeNotes ?? (tool.calls.some((c) => c.callee === "fetch") ? "arbitrary web pages" : "external content"),
        promptQuote: follow?.text ?? "",
      },
    });
  }

  // Secrets the model has to see and choose, because they're tool parameters.
  for (const p of tool.params.filter((p) => SECRET_PARAM.test(p.name))) {
    out.push({
      ...base,
      rule: "secret-in-params",
      severity: 5,
      title: `${tool.name} takes \`${p.name}\` as a parameter, so the model handles it`,
      param: p.name,
      loc: p.loc,
      facts: { secret: p.name, effect: effect.kind },
    });
  }

  // Sensitive fields returned to the model.
  const pii = piiFields(tool, true);
  if (piiFields(tool).length >= 2 && effect.kind === "read") {
    out.push({
      ...base,
      rule: "pii-exposure",
      severity: 4,
      title: `${tool.name} returns ${pii.join(", ")}`,
      loc: tool.loc,
      facts: { fields: pii, labels: piiFields(tool) },
    });
  }

  // A description that promises less than the code allows.
  if (/read-?only|only reads|safe|non-destructive/i.test(tool.description)) {
    const codeParam = tool.params.find((p) => CODE_PARAM.test(p.name));
    if (codeParam) {
      out.push({
        ...base,
        rule: "description-mismatch",
        severity: 4,
        title: `${tool.name} is described as "${tool.description}" but runs any \`${codeParam.name}\``,
        param: codeParam.name,
        loc: findLine(ctx.model, tool.loc.file, tool.description) ?? tool.loc,
        related: [codeParam.loc],
        facts: { description: tool.description },
      });
    }
  }

  return out;
}

function promptRules(model: AgentModel, lines: (PromptLine & { file: string })[], effects: Map<string, Effect>): Draft[] {
  const out: Draft[] = [];
  const unguarded = model.tools.filter((t) => !t.hasApproval && effects.get(t.name)!.kind !== "read");

  // Policies the prompt states but the tool code doesn't enforce.
  for (const l of lines) {
    if (!POLICY.test(l.text) || AUTONOMY.test(l.text) || FOLLOW.test(l.text)) continue;
    const lineWords = new Set(words(l.text).map(stem));
    for (const tool of model.tools) {
      const toolWords = [tool.name, ...(tool.aliases ?? [])].flatMap(words).map(stem).filter((w) => !STOPWORDS.has(w));
      if (!toolWords.some((w) => lineWords.has(w))) continue;
      // A line about what the agent may *say* ("Do not invent flight details") isn't a policy on the tool.
      if (effects.get(tool.name)!.kind === "read" && !/\$\s?\d|approv|confirm|consent|opt/i.test(l.text)) continue;
      const amount = /\$\s?([\d,]+)|(\d+)\s?%/.exec(l.text);
      const numeric = tool.params.find((p) => p.type === "number" && MONEY_PARAM.test(p.name));
      const enforced = amount && numeric ? numeric.bounded || numeric.guarded : tool.hasApproval || enforcesInCode(tool, l.text);
      if (enforced) continue;
      out.push({
        rule: "prompt-unenforced-policy",
        severity: 5,
        tool: tool.name,
        param: amount && numeric ? numeric.name : undefined,
        title: `Prompt says "${l.text.replace(/^[-*]\s*/, "")}" but ${tool.name} doesn't enforce it`,
        loc: { file: l.file, line: l.line },
        related: [numeric && amount ? numeric.loc : tool.loc],
        symbols: [tool.name, ...(tool.symbol ? [tool.symbol] : [])],
        facts: { quote: l.text.replace(/^[-*]\s*/, ""), threshold: amount ? amount[0].replace(/\s/g, "") : "", enforcement: amount ? "cap" : "approval" },
      });
    }
  }

  // Lines that push the agent to act without checking in.
  for (const l of lines.filter((l) => AUTONOMY.test(l.text))) {
    const quote = l.text.replace(/^[-*]\s*/, "");
    const lineWords = new Set(words(l.text).map(stem));
    const target =
      unguarded.find((t) => /clean|tidy|delete|remove|stale/.test(l.text.toLowerCase()) && effects.get(t.name)!.kind === "delete") ??
      unguarded.find((t) => words(t.name).map(stem).some((w) => !STOPWORDS.has(w) && lineWords.has(w)));
    // Prefer a caution line that isn't already a policy finding, so the two questions don't overlap.
    const policyLines = new Set(out.filter((f) => f.rule === "prompt-unenforced-policy").map((f) => f.loc.line));
    const cautions = lines.filter((c) => c !== l && CAUTION.test(c.text) && !AUTONOMY.test(c.text));
    let caution = cautions.find((c) => !policyLines.has(c.line));
    const irreversible = unguarded.filter((t) => ["money", "delete", "send", "exec"].includes(effects.get(t.name)!.kind)).map((t) => t.name);
    if (!target && !caution && irreversible.length >= 2) {
      out.push({
        rule: "prompt-autonomy-conflict",
        severity: 5,
        title: `Prompt says "${quote}" while ${irreversible.length} tools act with no confirmation`,
        loc: { file: l.file, line: l.line },
        related: irreversible.slice(0, 3).map((n) => model.tools.find((t) => t.name === n)!.loc),
        symbols: [quote.split(/[.:;]/)[0]!.slice(0, 40), ...irreversible],
        facts: { quote, targets: irreversible.slice(0, 4), cautionQuote: "", cautionLine: 0, target: "" },
      });
      continue;
    }
    caution ??= cautions[0];
    if (!target && !caution) continue;
    const pairKey = target?.name ?? `caution:${caution!.line}`;
    if (out.some((f) => f.rule === "prompt-autonomy-conflict" && (f.tool ?? `caution:${f.facts.cautionLine}`) === pairKey)) continue;
    out.push({
      rule: "prompt-autonomy-conflict",
      severity: target || unguarded.length ? 5 : 4,
      tool: target?.name,
      title: caution && !target ? `Prompt says "${quote}" and also "${caution.text.replace(/^[-*]\s*/, "")}"` : `Prompt says "${quote}" and ${target?.name} has no confirmation`,
      loc: { file: l.file, line: l.line },
      related: [...(caution && !target ? [{ file: caution.file, line: caution.line }] : []), ...(target ? [target.loc] : [])],
      symbols: [quote.split(/[.:;]/)[0]!.slice(0, 40), ...(target ? [target.name] : [])],
      facts: {
        quote,
        cautionQuote: caution && !target ? caution.text.replace(/^[-*]\s*/, "") : "",
        cautionLine: caution && !target ? caution.line : 0,
        target: target?.name ?? "",
        targetEffect: target ? effects.get(target.name)!.kind : "",
      },
    });
  }
  return out;
}

/** A prompt line that talks about this tool's subject, e.g. "offer account credit" for apply_credit. */
function promptMention(tool: ToolDef, lines: (PromptLine & { file: string })[]) {
  const toolWords = [tool.name, ...(tool.aliases ?? [])].flatMap(words).map(stem).filter((w) => !STOPWORDS.has(w));
  return lines.find((l) => words(l.text).map(stem).some((w) => toolWords.includes(w)));
}

function enforcesInCode(tool: ToolDef, policy: string): boolean {
  const src = tool.executeSource;
  if (/opt(ed)?[- ]?in|consent|subscribed/i.test(policy)) return /opt|consent|subscri|unsubscribe/i.test(src);
  if (/verify|verified/i.test(policy)) return /verif/i.test(src);
  return /throw|approval|approve|confirm/i.test(src);
}

function stem(w: string): string {
  return w.replace(/(ies)$/, "y").replace(/(es|s)$/, "").replace(/ing$/, "");
}

function flowsInto(param: string, args: string[]): boolean {
  // `command`, or Mastra-v0 style `context.command` / `input.command`.
  const re = new RegExp(`(^|[^\\w.]|\\b(context|input|inputData|args|params|data|props)\\.)${param}\\b`);
  return args.some((a) => re.test(a));
}

function piiFields(tool: ToolDef, raw = false): string[] {
  const hits = tool.returnedFields.filter((f) => PII_FIELDS[f.toLowerCase()]);
  return raw ? hits : [...new Set(hits.map((f) => PII_FIELDS[f.toLowerCase()]!))];
}

function notesOf(tool: ToolDef): string {
  return tool.calls.find((c) => c.calleeNotes)?.calleeNotes ?? "";
}

function thresholdFor(p: ToolParam, lines: PromptLine[]): string {
  const mentioned = lines.map((l) => /\$\s?([\d,]+)/.exec(l.text)?.[0]).find(Boolean);
  if (/percent|pct/i.test(p.name)) return "50%";
  if (/credit/i.test(p.name + (p.description ?? ""))) return "$50";
  if (MONEY_PARAM.test(p.name)) return mentioned?.replace(/\s/g, "") ?? "$500";
  if (/redemption|uses|count|quantity|limit/i.test(p.name)) return "1,000";
  return "100";
}

function findLine(model: AgentModel, file: string, needle: string): SourceLoc | undefined {
  for (let line = 1; line < 2000; line++) {
    const text = lineText(model.root, { file, line });
    if (text === "" && line > 400) break;
    if (needle && text.includes(needle.slice(0, 30))) return { file, line };
  }
  return undefined;
}

function finalize(model: AgentModel, d: Draft): Finding {
  const tool = d.tool ? model.tools.find((t) => t.name === d.tool) : undefined;
  const symbols = d.symbols ?? [...(tool ? [tool.name, ...(tool.aliases ?? []), ...(tool.symbol ? [tool.symbol] : [])] : []), ...(d.param ? [d.param] : [])];
  return {
    ...d,
    id: [d.rule, d.tool ?? `${d.loc.file}:${d.loc.line}`, d.param].filter(Boolean).join(":"),
    evidence: lineText(model.root, d.loc),
    symbols: [...new Set(symbols)],
  };
}

/**
 * Several web tools feeding the same dangerous tools are one risk, not five questions; two tools
 * covered by the same prompt line are one policy. Merge them, keeping the rest as related lines.
 */
function mergeSiblings(drafts: Draft[]): Draft[] {
  const out: Draft[] = [];
  const groups = new Map<string, Draft[]>();
  for (const d of drafts) {
    const key =
      d.rule === "injection-surface"
        ? `inj:${[...((d.facts.dangerousTools as string[]) ?? [])].sort().join(",")}`
        : d.rule === "prompt-unenforced-policy"
          ? `pol:${d.loc.file}:${d.loc.line}`
          : d.rule === "unrestricted-path"
            ? `path:${d.facts.mode}`
            : d.rule === "missing-limit" && d.facts.optional
              ? `opt:${d.param}`
              : undefined;
    if (!key) out.push(d);
    else groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  for (const group of groups.values()) {
    const [first, ...rest] = [...group].sort((a, b) => b.severity - a.severity);
    if (!rest.length) {
      out.push(first!);
      continue;
    }
    const names = [first!.tool!, ...rest.map((r) => r.tool!)];
    out.push({
      ...first!,
      related: [...first!.related, ...rest.map((r) => r.loc)],
      symbols: [...new Set([...(first!.symbols ?? []), ...names])],
      facts: { ...first!.facts, alsoTools: names.slice(1) },
    });
  }
  return out;
}

function dedupeIds(findings: Finding[]): Finding[] {
  const seen = new Map<string, number>();
  return findings.map((f) => {
    const n = seen.get(f.id) ?? 0;
    seen.set(f.id, n + 1);
    return n ? { ...f, id: `${f.id}#${n + 1}` } : f;
  });
}

export const RULE_LABELS: Record<RuleId, string> = {
  "prompt-unenforced-policy": "prompt policy not enforced in code",
  "arbitrary-exec": "model input reaches a shell/SQL sink",
  "data-exfiltration": "data can leave to a model-chosen destination",
  "no-confirmation": "irreversible action with no confirmation",
  "missing-limit": "no upper limit",
  "unbounded-list": "unbounded list of targets",
  "unrestricted-path": "unrestricted file path",
  "injection-surface": "untrusted text enters the context",
  "pii-exposure": "returns personal data",
  "description-mismatch": "description promises less than the code allows",
  "prompt-autonomy-conflict": "prompt pushes autonomy over caution",
  "model-review": "found by model review",
  "secret-in-params": "the model handles a secret",
  "prompt-output-rule": "prompt rule on an output nothing checks",
  "prompt-decision-rule": "prompt rule with no check in code",
  "untrusted-input-in-prompt": "untrusted text pasted into the prompt",
};
