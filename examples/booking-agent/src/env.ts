// Loads .env (if present) before anything reads process.env.
try {
  process.loadEnvFile(new URL("../.env", import.meta.url));
} catch {
  // No .env: rely on the real environment.
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Run \`npm run auth\` first (see README).`);
  return value;
}
