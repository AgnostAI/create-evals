import type { ToolDef } from "../core/types.js";

export type EffectKind = "money" | "delete" | "exec" | "send" | "external-write" | "write" | "read";

export interface Effect {
  kind: EffectKind;
  /** Short verb phrase for question text, e.g. "issues a refund". */
  does: string;
  /** Infinitive for "should the agent ever ___", e.g. "issue a refund". */
  act: string;
}

const WORDS: [EffectKind, RegExp][] = [
  ["money", /refund|charge|payout|pay\b|payment|transfer|credit|discount|coupon|invoice|price|billing|escrow|withdraw|deposit|swap|trade|buy|sell|purchase|wallet|mint|stake|bet\b|tip\b|(place|create|submit)_?order/],
  ["delete", /delete|remove|drop|purge|wipe|destroy|truncate|cancel|terminate|revoke|ban|deactivate|archive/],
  ["exec", /\bexec|shell|command|terminal|bash|eval\b|run_?code|script/],
  ["send", /send|email|mail|sms|text_?message|notify|post_?message|publish|tweet|slack|campaign/],
  ["write", /write|create|update|overwrite|save|upload|push|deploy|commit|merge|insert|set_/],
];

const READ_VERBS = /^(get|lookup|look|fetch|list|search|read|find|check|view|query|describe|show|count|load|retrieve|inspect|analy[sz]e|summari[sz]e|resolve_?airport)$/;
const VERBS = /^(issue|apply|refund|charge|pay|transfer|cancel|delete|remove|drop|purge|wipe|destroy|send|email|post|publish|create|update|write|overwrite|save|upload|push|deploy|commit|merge|insert|set|resolve|run|exec|execute|mint|stake|swap|buy|sell|withdraw|deposit|revoke|ban|archive|terminate|book|reserve|submit|place)$/;
const EXEC_SINKS = /^(execSync|exec|execFile|execFileSync|spawn|spawnSync|execa|\$|eval|Function|child_process\.\w+|cp\.\w+)$/;
const FS_WRITE = /(^|\.)(writeFile|writeFileSync|appendFile|rm|rmSync|unlink|unlinkSync|rmdir|createWriteStream|rename|copyFile)$/;
const FS_READ = /(^|\.)(readFile|readFileSync|createReadStream|readdir|readdirSync)$/;

/** Split `issue_refund` / `issueRefund` / `send-bulk-email` into lowercase words. */
export function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function effectOf(tool: ToolDef): Effect {
  const nameText = [tool.name, ...(tool.aliases ?? []), tool.symbol ?? ""].map((n) => words(n).join("_")).join(" ");
  const calls = tool.calls.map((c) => c.callee);
  const callText = calls.join(" ").toLowerCase();

  if (calls.some((c) => EXEC_SINKS.test(c))) {
    return calls.some((c) => /^(eval|Function)$/.test(c))
      ? { kind: "exec", does: "evaluates code", act: "evaluate code" }
      : { kind: "exec", does: "runs a shell command", act: "run a shell command" };
  }
  // get_escrow_info, list_orders, search_flights: reads, whatever the noun.
  const nameWords = words(tool.name);
  const readish = READ_VERBS.test(nameWords[0] ?? "") || (nameWords.some((w) => READ_VERBS.test(w)) && !nameWords.some((w) => VERBS.test(w)));
  if (readish && !calls.some((c) => FS_WRITE.test(c) || /(writeContract|sendTransaction)$/.test(c))) return { kind: "read", does: "reads data", act: "read data" };
  if (calls.some((c) => /(writeContract|sendTransaction|signTransaction|sendRawTransaction)$/.test(c))) return describe("money", tool);
  for (const [kind, re] of WORDS) {
    if (re.test(nameText)) return describe(kind, tool);
  }
  if (calls.some((c) => FS_WRITE.test(c))) return describe("write", tool);
  if (tool.calls.some((c) => c.callee === "fetch" && /method:\s*["'](PUT|POST|PATCH|DELETE)["']/.test(c.args.join(",")))) {
    return { kind: "external-write", does: "sends data to an external URL", act: "send data to an external URL" };
  }
  // Callee names are noisy (`provider.execute(...)` is everywhere); only trust the unambiguous ones.
  for (const [kind, re] of WORDS) {
    if (kind !== "exec" && kind !== "write" && re.test(callText)) return describe(kind, tool);
  }
  return { kind: "read", does: "reads data", act: "read data" };
}

function describe(kind: EffectKind, tool: ToolDef): Effect {
  const w = words(tool.name);
  // memoryDelete → verb "delete", object "memory"
  const found = w.findIndex((x) => VERBS.test(x));
  // No recognizable verb (backgroundJobs): talk about calling the tool instead of inventing one.
  if (found < 0) return { kind, does: `${tool.name} takes effect`, act: `call \`${tool.name}\`` };
  const vi = found;
  const verb = w[vi]!;
  const object = [...w.slice(0, vi), ...w.slice(vi + 1)].join(" ") || "this action";
  const article = /^[aeiou]/.test(object) ? "an" : "a";
  switch (kind) {
    case "money":
      return { kind, does: `moves money (${tool.name})`, act: `${verb} ${article} ${object}` };
    case "delete":
      return { kind, does: `${verb}s ${object} immediately`, act: `${verb} ${article} ${object}` };
    case "send":
      return { kind, does: `sends ${object.replace(/^bulk /, "bulk ")} for real`, act: `send ${object.replace(/^bulk /, "a bulk ")}` };
    case "write":
      return { kind, does: `${verb}s ${object}`, act: `${verb} ${object}` };
    default:
      return { kind, does: `${verb}s ${object}`, act: `${verb} ${object}` };
  }
}

export function isFsWrite(callee: string) {
  return FS_WRITE.test(callee);
}
export function isFsRead(callee: string) {
  return FS_READ.test(callee);
}
export function isExecSink(callee: string) {
  return EXEC_SINKS.test(callee);
}

export const PII_FIELDS: Record<string, string> = {
  email: "email",
  phone: "phone",
  phonenumber: "phone",
  address: "home address",
  dateofbirth: "date of birth",
  dob: "date of birth",
  birthdate: "date of birth",
  ssn: "SSN",
  socialsecuritynumber: "SSN",
  cardlast4: "card last 4",
  last4: "card last 4",
  cardnumber: "card number",
  passport: "passport number",
  salary: "salary",
  taxid: "tax ID",
};
