import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * 加载 backend/.env（不引第三方 dotenv，保持零依赖教学友好）
 *
 * 支持：# 注释行 / 行尾注释 / 成对引号剥离 / export 前缀 / 键值两端空白
 * 目的：手写 .env 时最常见的事故是给值加了引号（SIGNER_PRIVATE_KEY="0x…"）
 *       被原样当成密钥，导致"看起来配置对了但签名地址不对"。
 */
export function loadEnv(
  path = resolve(import.meta.dirname, "../.env"),
): Record<string, string> {
  const out: Record<string, string> = {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    /* .env 不存在时静默，留给调用方报错 */
    return out;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;

    let key = trimmed.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(eq + 1).trim();

    // 成对引号整体剥离（只剥一对，且要求首尾同一类引号）
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    } else {
      // 未加引号时才认行尾注释：`PORT=8787 # 端口` → 8787
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }

    out[key] = value;
  }

  return out;
}

export const env = loadEnv();
