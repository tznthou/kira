// 基準的 class 名有沒有跟 Tailwind utility 撞名：撞到的話，Tailwind 會在 utilities 層產生規則，
// 而 v8 CSS 放在 components 層（Phase 3 策略）→ utility 會蓋過 v8 規則。
// 用法（repo 根目錄）：node mockup/tools/tw_class_collisions.mjs
// 作法：用專案安裝的 Tailwind 編譯器（@tailwindcss/node），把每個 class 名當候選逐一 build，有輸出就是撞名。
// 自檢：已知是 utility 的 flex / hidden / sr-only 必須被判為撞名，已知不是的 sheet 必須不撞。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "@tailwindcss/node";

const root = resolve(import.meta.dirname, "../..");
const ref = readFileSync(resolve(root, "mockup/v8-kirazuri-lines-sys.html"), "utf8");

// class 名來源：CSS 選擇器裡的 .name，加上 markup / JS 模板字串裡 class="…" 的每個字
const names = new Set();
const style = ref.slice(ref.indexOf("<style>"), ref.indexOf("</style>"));
for (const m of style.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) names.add(m[1]);
for (const m of ref.matchAll(/class="([^"]+)"/g)) {
  for (const w of m[1].split(/\s+/)) if (/^[A-Za-z][\w-]*$/.test(w)) names.add(w);
}
for (const m of ref.matchAll(/classList\.(?:add|remove|toggle)\("([\w-]+)"/g)) names.add(m[1]);

// 坑（2026-10-05 實測）：同一個 compiler 的 build() 會累積之前所有候選，輸出越來越多；
// 再用子字串比對就會讓 .f 命中 .flex、.s 命中 .sr-only。→ 每個候選用新的 compiler，選擇器比完整邊界。
const esc = (c) => c.replace(/[^\w-]/g, "\\$&");
const utilitiesFor = async (c) => {
  const compiler = await compile('@import "tailwindcss";', { base: root, onDependency: () => {} });
  const css = compiler.build([c]);
  const i = css.lastIndexOf("@layer utilities");
  return i < 0 ? "" : css.slice(i);
};
const ruleFor = (css, c) => css.match(new RegExp(`\\.${esc(c)}(?=[\\s{:,\\[])[^{]*\\{([^}]*)\\}`));
const hits = async (c) => !!ruleFor(await utilitiesFor(c), c);

// 自檢：已知的 utility 必須命中；不是 utility、且是已知 utility 開頭子字串的（f ⊂ flex、s ⊂ sr-only）必須不命中
const checks = { flex: true, hidden: true, "sr-only": true, sheet: false, f: false, s: false };
for (const [c, want] of Object.entries(checks)) {
  if ((await hits(c)) !== want) {
    console.error(`SELF-CHECK FAILED: ${c} should ${want ? "" : "not "}collide`);
    process.exit(2);
  }
}

const collide = [];
for (const c of [...names].sort()) if (await hits(c)) collide.push(c);
console.log(`${names.size} class names in the reference; ${collide.length} also generate Tailwind utilities:`);
for (const c of collide) {
  const m = ruleFor(await utilitiesFor(c), c);
  console.log(`  .${c} → ${m[1].replace(/\s+/g, " ").trim()}`);
}
