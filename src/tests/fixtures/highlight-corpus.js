// diff 上色器的驗收語料（Phase 5 Q-H / Q-H3 / Q-T）。一段運算式、不 import 任何東西：用到的 highlight / langOf /
// escCode 由跑的人給，回傳一行一筆 PASS / FAIL 的字串（FAIL 帶 want / got）。同一個檔跑三處：
//   vitest：src/tests/v8Highlight.test.ts 拿 app 的副本（src/lib/v8-highlight.js）跑，CI 也跑
//   mockup/tools/hl_probe.mjs：拿基準的 highlight 區塊在 Node（vm）與 WebKit（wk-shot，系統 WKWebView = app 的引擎）各跑一次
// 兩個引擎的正規式實作不同（2026-10-11 實測：JSC 對「第一個分支是 lookbehind」的處理跟 V8 不一樣），只在 V8 過不算數。
// 這個檔不放原始雙向字元，要用就從碼位組（下面 Q-T 那段的 U()）
(() => {
  const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
  const tokensOf = (html) => [...html.matchAll(/<span class="(\w+)">([^<]*)<\/span>/g)].map(([, c, t]) => `${c}:${unescape(t)}`);
  const out = [];
  const check = (name, got, want) => {
    const pass = JSON.stringify(got) === JSON.stringify(want);
    out.push(`${pass ? "PASS" : "FAIL"}  ${name}${pass ? "" : `\n      want ${JSON.stringify(want)}\n      got  ${JSON.stringify(got)}`}`);
  };

  // [path, line, tokens]: path picks the language
  const CASES = [
    // Rust: what was left out before (pub fn impl use match mut self true false) is coloured; lifetimes are not strings
    ["lib.rs", "pub fn main() -> Result<(), Error> {", ["k:pub", "k:fn", "f:main", "t:Result", "t:Error"]],
    ["lib.rs", "impl Display for BranchRef {", ["k:impl", "t:Display", "k:for", "t:BranchRef"]],
    ["lib.rs", "use std::collections::HashMap;", ["k:use", "t:HashMap"]],
    ["lib.rs", "    match self.kind { Kind::Local => true, _ => false }", ["k:match", "k:self", "t:Kind", "t:Local", "k:true", "k:false"]],
    ["lib.rs", "    let mut out = Vec::new();", ["k:let", "k:mut", "t:Vec", "f:new"]],
    ["lib.rs", '    println!("{} items", n as u32);', ["f:println!", 's:"{} items"', "k:as", "t:u32"]],
    ["lib.rs", "fn parse<'a>(s: &'a str) -> Option<u8> { s.bytes().next() }", ["k:fn", "f:parse", "t:str", "t:Option", "t:u8", "f:bytes", "f:next"]],
    ["lib.rs", "    let c = '\\n'; let x = 0xFFu8 + 1_000usize;", ["k:let", "s:'\\n'", "k:let", "n:0xFFu8", "n:1_000usize"]],
    ["lib.rs", "    matches!(b, b'\\x7f' | '\\u{1F600}' | 'a')", ["f:matches!", "s:'\\x7f'", "s:'\\u{1F600}'", "s:'a'"]],
    ["lib.rs", "#[derive(Debug, Clone)]", ["f:derive", "t:Debug", "t:Clone"]],
    ["lib.rs", "    if a!=b { return Err(e); } // fn in a comment", ["k:if", "k:return", "t:Err", "c:// fn in a comment"]],
    ["lib.rs", "    let v = vec![1, 2];", ["k:let", "f:vec!", "n:1", "n:2"]],
    // TypeScript / JavaScript
    ["load.ts", "export async function load(id: string): Promise<void> {", ["k:export", "k:async", "k:function", "f:load", "t:string", "t:Promise", "k:void"]],
    ["load.ts", "  for (const x of xs) await run(x);", ["k:for", "k:const", "k:of", "k:await", "f:run"]],
    ["load.ts", "  class Foo extends Bar { constructor() { this.n = null; } }", ["k:class", "t:Foo", "k:extends", "t:Bar", "f:constructor", "k:this", "k:null"]],
    ["load.ts", "const s = `total: ${n}`;", ["k:const", "s:`total: ${n}`"]],
    ["load.ts", "if (x.default) set.delete(key);", ["k:if", "f:delete"]],
    ["load.ts", 'typeof value === "string" && value !== undefined', ["k:typeof", 's:"string"', "k:undefined"]],
    ["load.ts", "const big = 0x1f + 1_000n;", ["k:const", "n:0x1f", "n:1_000n"]],
    ["Legend.tsx", '    <ul className="legend">', ['s:"legend"']],
    ["graph.test.ts", 'describe("lane", () => { it("works", () => {});', ["f:describe", 's:"lane"', "f:it", 's:"works"']],
    ["a.mjs", "  /** a doc comment */ return 1;", ["c:/** a doc comment */", "k:return", "n:1"]],
    ["a.cjs", "   *  the middle of a block comment", ["c:   *  the middle of a block comment"]],
    // JSON: strings, numbers, true / false / null
    ["package.json", '  "name": "kira", "version": "0.1.0", "private": true,', ['s:"name"', 's:"kira"', 's:"version"', 's:"0.1.0"', 's:"private"', "k:true"]],
    ["package.json", '  "count": 12, "ratio": 0.38, "none": null', ['s:"count"', "n:12", 's:"ratio"', "n:0.38", 's:"none"', "k:null"]],
    // CSS: comments, strings, at-rules and !important, numbers with units and colours, functions
    ["v8.css", "  .dl { display: grid; font-size: 12.5px; color: var(--ink-3); }", ["n:12.5px", "f:var"]],
    ["v8.css", "@media (prefers-color-scheme: dark) {", ["k:@media"]],
    ["v8.css", "  margin: -4px 0 calc(100% - 2px) #fff !important; /* note */", ["n:-4px", "n:0", "f:calc", "n:100%", "n:2px", "n:#fff", "k:!important", "c:/* note */"]],
    ["v8.css", '  background: url("a.png"); // css has no line comments', ["f:url", 's:"a.png"']],
    ["v8.css", "h1, .col-2 { }", []],
    // where two kinds start at the same place the first listed wins (keyword over call, keyword over type). JSC broke
    // that order for an alternative that starts with a lookbehind (2026-10-11, see hl_probe.mjs), so these run on both engines
    ["a.js", "const f = function(a) { return a; };", ["k:const", "k:function", "k:return"]],
    ["a.js", "    super(props);", ["k:super"]],
    ["a.js", "if(x) for(;;) while(y) switch(z) {}", ["k:if", "k:for", "k:while", "k:switch"]],
    ["a.js", 'const m = await import("./x");', ["k:const", "k:await", "k:import", 's:"./x"']],
    ["a.js", "catch(e) { typeof(e); }", ["k:catch", "k:typeof"]],
    ["a.ts", "x.default(1); y.if(2)", ["f:default", "n:1", "f:if", "n:2"]],
    ["a.rs", "impl Self { fn new() -> Self { Self::default() } }", ["k:impl", "k:Self", "k:fn", "f:new", "k:Self", "k:Self", "f:default"]],
    ["a.css", "  margin: -4px; top: calc(-1 * var(--x));", ["n:-4px", "f:calc", "n:-1", "f:var"]],
    // JSX text stays as it is (Q-H3): between a tag and its closing tag, or a whole line with nothing of code in it
    ["Comp.tsx", "      <li>1. Open the verification URL in your browser.</li>", []],
    ["Comp.tsx", '      <Button variant="primary" onClick={reset}>Close</Button>', ["t:Button", 's:"primary"', "t:Button"]],
    ["Comp.tsx", "        Sign in to see pull requests for this repo.", []],
    ["Comp.tsx", "        Couldn't reach GitHub. Try again in a minute.", []],
    ["Comp.tsx", "      + New branch", []],
    ["Comp.tsx", '      {error && <p role="alert">Couldn\'t reach GitHub.</p>}', ['s:"alert"']],
    // …and what it cannot tell from code, so leaves coloured: a line starting with a keyword, text mixed with tags
    ["Comp.tsx", "        for you, and you can sign out at any time.", ["k:for", "t:any"]],
    ["Comp.tsx", "      Signed in as <b>{username}</b>", ["t:Signed", "k:in", "k:as"]],
    // code lines that look like text keep their colours: a list's line, a ternary, a statement, a trailing comment
    ["a.ts", "  type GraphData,", ["k:type", "t:GraphData"]],
    ["a.ts", "  CASING_W,", ["t:CASING_W"]],
    ["a.ts", "    ? null", ["k:null"]],
    ["a.ts", "  return state.progress", ["k:return"]],
    ["a.ts", "    number, // line number", ["t:number", "c:// line number"]],
    ["a.ts", "  x.foo(bar) // call", ["f:foo", "c:// call"]],
    // the cost: a lone name or number on its own line of a longer expression reads as text
    ["a.ts", "    NoLanes", []],
    ["a.ts", "    2", []],
    // text inside a template literal that runs over lines reads as text, not as code
    ["a.ts", "  Some browsers are trying to remove spaces from email inputs and after", []],
    // prose and what it does not know: nothing coloured
    ["README.md", "Before it ships, make it work.", []],
    ["README.md", "A small repository to try Kira on.", []],
    // …prose alone would not show it: JS leaves a line of text as it is too (Q-H3), so a README line with code in it
    ["README.md", "Run it with `npm run tauri dev` (needs Rust).", []],
    ["notes.txt", "export const x = 1;", []],
    ["Makefile", "build: fn(1)", []],
    ["tool.py", "def main(): return True", []],
  ];
  for (const [path, line, want] of CASES) check(`${path}  ${line}`, tokensOf(highlight(line, langOf(path))), want);

  // the language from the extension (the last one, case-insensitive); names Object.prototype has are not languages
  const LANG_CASES = [
    ["a.ts", "js"], ["A.TSX", "js"], ["x.d.ts", "js"], ["x.mjs", "js"], ["x.cts", "js"], ["lib.rs", "rs"],
    ["package.json", "json"], ["v8.css", "css"], ["README.md", null], ["Makefile", null], [".gitignore", null],
    ["dir.v2/file", null], ["x.constructor", null], ["x.__proto__", null], ["x.toString", null], ["x.", null],
  ];
  for (const [path, want] of LANG_CASES) check(`langOf(${path})`, langOf(path), want);

  // HTML is escaped, coloured or not
  check("escaped, coloured", highlight('const s = "<b>&</b>"; // <i>', "js"),
    '<span class="k">const</span> s = <span class="s">&quot;&lt;b&gt;&amp;&lt;/b&gt;&quot;</span>; <span class="c">// &lt;i&gt;</span>');
  check("escaped, JSX text", highlight('<script>alert("x")</script> & </span>', "js"),
    "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &lt;/span&gt;");
  check("escaped, not coloured", highlight('<b>&"x"</b>', null), "&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;");
  check("escaped inside a string", highlight("'</span><img src=x onerror=alert(1)>'", "js"),
    `<span class="s">'&lt;/span&gt;&lt;img src=x onerror=alert(1)&gt;'</span>`);
  // a line over 2,000 characters is not coloured; 2,000 is
  const line2000 = "const a = 1;".repeat(167).slice(0, 2000);
  check("2,000 characters: coloured", highlight(line2000, "js").includes("<span"), true);
  check("2,001 characters: not coloured", highlight(`${line2000} `, "js").includes("<span"), false);
  // the same regex again: no state left over from the last line
  check("twice in a row", highlight("const a = 1;", "js"), highlight("const a = 1;", "js"));

  // bidirectional controls are named, not obeyed (Q-T): every one, in coloured and plain output alike. Built from code
  // points so this file holds none of them itself
  const U = (n) => String.fromCharCode(n);
  const marker = (code, name) => `<span class="bidi" title="U+${code}">${name}</span>`;
  const NAMED = [[0x202a, "202A", "LRE"], [0x202b, "202B", "RLE"], [0x202c, "202C", "PDF"], [0x202d, "202D", "LRO"],
    [0x202e, "202E", "RLO"], [0x2066, "2066", "LRI"], [0x2067, "2067", "RLI"], [0x2068, "2068", "FSI"], [0x2069, "2069", "PDI"],
    [0x200e, "200E", "LRM"], [0x200f, "200F", "RLM"], [0x061c, "061C", "ALM"],
    // second review 2026-10-12: the line and paragraph separators break the row under white-space: pre, so they are named too
    [0x2028, "2028", "LS"], [0x2029, "2029", "PS"]];
  for (const [n, code, name] of NAMED) check(`escCode names ${name}`, escCode(`a${U(n)}b`), `a${marker(code, name)}b`);
  check("escCode still escapes", escCode(`<${U(0x2066)}>&`), `&lt;${marker("2066", "LRI")}&gt;&amp;`);
  check("a zero-width joiner stays (emoji are made of them)", escCode(`👨${U(0x200d)}👩`), `👨${U(0x200d)}👩`);
  // the stretched string: the controls inside the string token are named where they are
  const trojan = `if (role != "reader${U(0x202e)} ${U(0x2066)}// Check if owner${U(0x2069)} ${U(0x2066)}") {`;
  check("the stretched string, coloured", highlight(trojan, "js"),
    `<span class="k">if</span> (role != <span class="s">&quot;reader${marker("202E", "RLO")} ${marker("2066", "LRI")}// Check if owner`
    + `${marker("2069", "PDI")} ${marker("2066", "LRI")}&quot;</span>) {`);
  check("…not coloured (Markdown)", highlight(`a${U(0x202e)}b`, langOf("README.md")), `a${marker("202E", "RLO")}b`);
  check("…over 2,000 characters", highlight(`${"x".repeat(2001)}${U(0x202e)}`, "js").endsWith(marker("202E", "RLO")), true);
  check("…JSX text left as it is still names them", highlight(`        Sign in${U(0x202e)} here`, "js"), `        Sign in${marker("202E", "RLO")} here`);

  // review 2026-10-11: a carriage return inside a line is a character reference (the HTML parser would make it a line
  // feed); a block comment that cannot close and holds U+2028 is one comment to the end of the line; a prose line's
  // comma rule reads the whole line once (the same answers as before)
  const CR = U(13), LS = U(0x2028);
  check("escCode writes CR as a reference", escCode(`a${CR}b`), "a&#13;b");
  check("CR inside a string, coloured", highlight(`"a${CR}b"`, "js"), `<span class="s">&quot;a&#13;b&quot;</span>`);
  check("CR not coloured", highlight(`a${CR}b`, null), "a&#13;b");
  // (U+2028 is named inside the token since the second review, so these compare the whole HTML)
  check("an unclosed block comment holding U+2028", highlight(`/*a${LS}b /*c`, "js"), `<span class="c">/*a${marker("2028", "LS")}b /*c</span>`);
  check("…in CSS", highlight(`/*a${LS}b`, "css"), `<span class="c">/*a${marker("2028", "LS")}b</span>`);
  check("a line comment runs past U+2028", highlight(`x; // a${LS}b`, "js"), `x; <span class="c">// a${marker("2028", "LS")}b</span>`);
  check("a prose line ending in a comma and spaces is not prose", tokensOf(highlight("Sign in here,   ", "js")), ["t:Sign", "k:in"]);
  check("a prose line ending in a comma inside is prose", tokensOf(highlight("Sign in, here", "js")), []);
  // review 2026-10-11 (decision A): a string the line does not close runs to the end of the line, as the first line
  // of a template literal does in an editor — one match instead of a new attempt from every quote inside it
  // (quadratic on JavaScriptCore). The lines after it know nothing of it and are coloured as code, as before
  check("an unclosed string runs to the end of the line", tokensOf(highlight('const s = "abc', "js")), ["k:const", 's:"abc']);
  check("…single-quoted", tokensOf(highlight("x = 'unterminated; y = 1", "js")), ["s:'unterminated; y = 1"]);
  check("…a template literal's first line", tokensOf(highlight("const t = `Kira ${v}", "js")), ["k:const", "s:`Kira ${v}"]);
  check("…its last line", tokensOf(highlight("`;", "js")), ["s:`;"]);
  check("…in Rust", tokensOf(highlight('let s = "abc', "rs")), ["k:let", 's:"abc']);
  check("…in JSON", tokensOf(highlight('"key": "unterminated', "json")), ['s:"key"', 's:"unterminated']);
  check("…in CSS", tokensOf(highlight('content: "abc', "css")), ['s:"abc']);
  check("a closed string still ends where it closes", tokensOf(highlight('const s = "a" + b;', "js")), ["k:const", 's:"a"']);
  check("a Rust lifetime is still not a string", tokensOf(highlight("fn f<'a>(s: &'a str)", "rs")), ["k:fn", "f:f", "t:str"]);
  check("a Rust char is still a string", tokensOf(highlight("let c = 'x';", "rs")), ["k:let", "s:'x'"]);
  // third review 2026-10-12: every single quote starts a string, an apostrophe too, so a line of JSX text holding an
  // expression reads as a string from the apostrophe to the end of the line (a known limit). A rule that took some
  // quotes for apostrophes took the opening quote of a legal string in the same place too, and the line could then
  // show a call after it as a comment (the cases further down)
  check("an apostrophe inside a word opens a string to the end of the line", tokensOf(highlight("<p>You're in {branch} with {commits.length} new commits</p>", "js")), ["t:You", "s:'re in {branch} with {commits.length} new commits</p>"]);
  check("…in CSS a single quote after a space still opens one", tokensOf(highlight("content: 'abc", "css")), ["s:'abc"]);
  // 2026-10-12: a string's escape crosses U+2028 and a carriage return too (with . it stopped there, and every escaped
  // quote before it was tried as the opening one: the same quadratic by another door)
  check("a string's escape crosses U+2028", highlight(`"a\\${LS}b`, "js"), `<span class="s">&quot;a\\${marker("2028", "LS")}b</span>`);
  check("…and a carriage return (written as its reference)", tokensOf(highlight(`"a\\${CR}b`, "js")), [`s:"a\\&#13;b`]);
  // second review 2026-10-12 (three reviewers): a lone backslash at the end of the line is taken by the unclosed branch
  // (the escape could not take it, and $ before it did not match, so every quote before it was tried again: quadratic on
  // JavaScriptCore); the string before it is coloured, as decision A says
  const TB = String.fromCharCode(92);
  check("a lone trailing backslash ends an unclosed string", tokensOf(highlight(`const s = "abc${TB}`, "js")), ["k:const", `s:"abc${TB}`]);
  check("…single-quoted", tokensOf(highlight(`x = 'abc${TB}`, "js")), [`s:'abc${TB}`]);
  check("…a template literal", tokensOf(highlight(`const t = \`abc${TB}`, "js")), ["k:const", `s:\`abc${TB}`]);
  check("…in Rust", tokensOf(highlight(`let s = "abc${TB}`, "rs")), ["k:let", `s:"abc${TB}`]);
  check("…in JSON", tokensOf(highlight(`"k": "abc${TB}`, "json")), ['s:"k"', `s:"abc${TB}`]);
  check("…in CSS", tokensOf(highlight(`content: "abc${TB}`, "css")), [`s:"abc${TB}`]);
  check("a closed string followed by a lone backslash is still closed", tokensOf(highlight(`"a" ${TB}`, "js")), ['s:"a"']);
  // …and a quote right after a keyword starts a string like any other (minified code: return'x', case'x':)
  check("a string glued to return", tokensOf(highlight("return'success';", "js")), ["k:return", "s:'success'"]);
  check("…to case", tokensOf(highlight("case'action':", "js")), ["k:case", "s:'action'"]);
  check("…to from", tokensOf(highlight("import a from'./x'", "js")), ["k:import", "k:from", "s:'./x'"]);
  check("…to typeof", tokensOf(highlight("typeof'string'", "js")), ["k:typeof", "s:'string'"]);
  check("…holding a keyword", tokensOf(highlight("return'hello world function(){'+x", "js")), ["k:return", "s:'hello world function(){'"]);
  check("…but not to a name", tokensOf(highlight("x = y+'z'", "js")), ["s:'z'"]);
  // third review 2026-10-12: legal code puts a string right after a closing brace or a word, and with a quote there taken
  // for an apostrophe the // inside the string read as a comment that swallowed the call after it
  check("a string right after a block", tokensOf(highlight("if(ok){}'// benign';deleteBranch(repo);", "js")), ["k:if", "s:'// benign'", "f:deleteBranch"]);
  check("…after a block that returns", tokensOf(highlight("if(c){return}'use strict'", "js")), ["k:if", "k:return", "s:'use strict'"]);
  check("…a method named by a string after get", tokensOf(highlight("({get'// benign'(){}});deleteBranch(repo);", "js")), ["s:'// benign'", "f:deleteBranch"]);
  check("…after static", tokensOf(highlight("class A{static'// benign'(){}};deleteBranch(repo);", "js")), ["k:class", "t:A", "k:static", "s:'// benign'", "f:deleteBranch"]);
  check("…after void", tokensOf(highlight("void'// benign';deleteBranch(repo);", "js")), ["k:void", "s:'// benign'", "f:deleteBranch"]);
  check("…after as (TypeScript)", tokensOf(highlight("x as'string'", "js")), ["k:as", "s:'string'"]);
  check("…after an at-rule's name (CSS)", tokensOf(highlight("@charset'utf-8';", "css")), ["k:@charset", "s:'utf-8'"]);
  // pinned as they are (the known limit above): JSX text after an expression, a template literal's continuation line, a
  // keyword's possessive
  check("an apostrophe after } in JSX text", tokensOf(highlight("<p>{user.name}'s dashboard</p>", "js")), ["s:'s dashboard</p>"]);
  check("…in a template literal's continuation line", tokensOf(highlight("  ${x}'s turn`;", "js")), ["s:'s turn`;"]);
  check("…after a keyword", tokensOf(highlight("<p>{name} is using someone else's key</p>", "js")), ["k:else", "s:'s key</p>"]);
  // pinned as it is: a regular expression literal holding a lone quote reads as a string from that quote on (this
  // highlighter knows no regular expression literals; before decision A the quote simply found no partner)
  check("a regular expression holding one quote", tokensOf(highlight("s.replace(/'/g, x)", "js")), ["f:replace", "s:'/g, x)"]);
  // …and one holding // (or /*) reads as a comment from there to the end of the line, a call after it too: a known limit
  // (third review 2026-10-12, side agent; every version of this highlighter does it, on both engines)
  check("a regular expression holding //", tokensOf(highlight("if (/^https?:\\/\\//.test(url)) open(url);", "js")), ["k:if", "c://.test(url)) open(url);"]);
  // the separators are named inside a token and in plain text alike
  const PS = U(0x2029);
  check("a paragraph separator in a string is named", highlight(`"a${PS}b"`, "js"), `<span class="s">&quot;a${marker("2029", "PS")}b&quot;</span>`);
  check("a line separator, not coloured", highlight(`a${LS}b`, null), `a${marker("2028", "LS")}b`);
  return out.join("\n");
})()
