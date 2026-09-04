import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 加载 backend/.env（不引第三方 dotenv，保持零依赖教学友好） */
export function loadEnv(path = resolve(import.meta.dirname, "../.env")) {
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* .env 不存在时静默，留给调用方报错 */
  }
  return out;
}

export const env = loadEnv();
