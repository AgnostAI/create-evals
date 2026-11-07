// Module loader hooks: imports of a replaced module resolve to its fake instead. Registered by the
// runner with { data: { map: { [realFileUrl]: fakeFileUrl } } }.
let map: Record<string, string> = {};

export async function initialize(data: { map: Record<string, string> }) {
  map = data?.map ?? {};
}

export async function resolve(specifier: string, context: any, next: (s: string, c: any) => Promise<{ url: string }>) {
  const result = await next(specifier, context);
  const replacement = map[result.url.replace(/[?#].*$/, "")];
  // The fake itself may import the real module (to reuse types or helpers): let it.
  if (replacement && context.parentURL !== replacement) return { ...result, url: replacement, shortCircuit: true };
  return result;
}
