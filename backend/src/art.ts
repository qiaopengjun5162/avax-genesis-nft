/**
 * 创世图生成：每个钱包一张确定性 SVG。
 * v2：data URI 用 **base64** 编码（data:image/svg+xml;base64,…）
 *    —— 最兼容形式，避免 % 编码/单引号/charset 在不同浏览器的渲染怪癖
 *    （v1 的 utf8 百分号编码形式在部分环境会整图白屏）
 */
function hashSeed(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return h;
}

export function genesisArt(wallet: string, index: number): string {
  const hue = hashSeed(wallet.toLowerCase());
  const bg = `hsl(${hue}, 65%, 12%)`;
  const fg = `hsl(${(hue + 40) % 360}, 85%, 60%)`;
  const accent = `hsl(${(hue + 180) % 360}, 80%, 55%)`;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">` +
    `<rect width="400" height="400" fill="${bg}"/>` +
    `<circle cx="200" cy="190" r="120" fill="none" stroke="${fg}" stroke-width="10"/>` +
    `<circle cx="200" cy="190" r="80" fill="${accent}" opacity="0.25"/>` +
    `<text x="200" y="208" text-anchor="middle" font-family="monospace" font-size="120" fill="${fg}">G</text>` +
    `<text x="200" y="330" text-anchor="middle" font-family="monospace" font-size="36" fill="#ffffff" opacity="0.8">GENESIS #${index}</text>` +
    `<text x="200" y="372" text-anchor="middle" font-family="monospace" font-size="18" fill="#ffffff" opacity="0.45">${wallet.slice(0, 6)}...${wallet.slice(-4)}</text>` +
    `</svg>`;
  // base64 版（utf8 → base64，避免任何转义问题）
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
