// 基準殼層互動流程（Phase 0b）：假時鐘跑完計時器後，從 DOM 讀結果逐條斷言。
// 由 shell_flows.py 以 wk-shot 載入（網址帶 flow=<name>），回傳一行一個 PASS/FAIL。
// 頁面腳本在 IIFE 內，這裡只碰 DOM（點擊、讀文字與屬性），不碰內部狀態。
(() => {
  let now = 1e6;
  const q = [];
  Date.now = () => now;
  window.setTimeout = (fn, ms = 0) => { q.push({ at: now + ms, fn }); return q.length; };
  window.clearTimeout = () => {};
  const run = (ms) => {
    const end = now + ms;
    for (;;) {
      q.sort((a, b) => a.at - b.at);
      if (!q.length || q[0].at > end) break;
      const t = q.shift();
      now = t.at;
      t.fn();
    }
    now = end;
  };
  const $ = (id) => document.getElementById(id);
  const out = [];
  const ok = (name, cond, got) => out.push(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : `  (got ${JSON.stringify(got)})`}`);
  const eq = (name, got, want) => ok(name, got === want, got);
  const label = (id) => $(id).querySelector(".label").textContent;
  const shown = (el) => !!el && getComputedStyle(el).display !== "none";
  const noticeOn = () => document.documentElement.classList.contains("has-notice");
  const noticeText = () => $("notice-text").textContent;
  const firstRowRefs = () => document.querySelector("#rows .row .refs").textContent.replace(/\s+/g, " ").trim();
  // a row's refs by full name: a shortened label ("origin", a cut name) keeps the full name in its title
  const refNames = (row) => [...row.querySelectorAll(".refs .ref")].map((r) =>
    r.classList.contains("more") ? r.textContent : r.lastElementChild.title || r.lastElementChild.textContent);
  const allRefNames = () => [...document.querySelectorAll("#rows .row")].flatMap(refNames);
  const current = () => { const c = document.querySelector("#branch-list .branch.current .b-name"); return c ? c.textContent : null; };
  // the same for a screen reader: the rows that say they are the current branch (aria-current), by name
  const ariaCurrent = () => [...document.querySelectorAll("#branch-list [aria-current]")].map((b) => `${b.dataset.branch}=${b.getAttribute("aria-current")}`).join();
  const stats = () => [...document.querySelectorAll("#branch-list .branch.current .b-stats")].map((s) => s.className + ":" + s.textContent);
  const remotes = () => [...document.querySelectorAll("#branch-list .branch.remote .b-name")].map((s) => s.textContent);
  const key = (el, k) => el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  const flow = new URLSearchParams(location.search).get("flow");
  // Phase 0b P5 helpers: the legend by branch name, the panes by what they say
  const branchBtn = (n) => document.querySelector(`#branch-list .branch-btn[data-branch="${CSS.escape(n)}"]`);
  const rdOf = (n) => branchBtn(n).querySelector(".rd");
  const rdLook = (el) => el.classList.contains("beyond") ? "dash" : el.classList.contains("lodge") ? "ring" : `${el.classList.contains("hollow") ? "hollow " : ""}${el.textContent}`;
  // innerText: blocks side by side (a heading, then its hint) read apart, as on screen; textContent would glue them
  const text = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : null);
  const visible = (el) => !!el && !el.hidden && !el.closest("[hidden]") && getComputedStyle(el).display !== "none";
  const focusIs = (el) => document.activeElement === el;
  // where focus is, for a failed check: id, else the first class, else the tag
  const act = () => { const a = document.activeElement; return a && (a.id || String(a.className).split(" ")[0] || a.tagName); };
  const type = (s) => { const m = $("msg"); m.value = s; m.dispatchEvent(new Event("input", { bubbles: true })); };
  const files = (id) => [...document.querySelectorAll(`#${id} .file .fname`)].map((f) => f.title);
  const headRefs = (id) => refNames(document.getElementById(`r-${id}`));
  // Phase 5 Q-H: a diff line's coloured tokens ("k:await t:string …"), the line found by part of its code
  const codeLine = (part) => [...$("diff").querySelectorAll(".dl code")].find((c) => c.textContent.includes(part));
  const tokens = (code) => (code ? [...code.querySelectorAll("span")].map((s) => `${s.className}:${s.textContent}`).join(" ") : null);
  const hunkHeads = () => [...$("diff").querySelectorAll(".hunk-head")].map(text);

  if (flow === "push") {
    eq("push enabled at rest", $("push").disabled, false);
    eq("ahead count shows 2", shown($("ahead")) && $("ahead").textContent, "2");
    $("push").click();
    run(50);
    ok("label shows a percentage while pushing", /^\d+%$/.test(label("push")), label("push"));
    eq("pull disabled while pushing", $("pull").title, "Disabled while pushing");
    eq("refresh disabled while pushing", $("refresh").disabled, true);
    run(3000);
    eq("label back to Push", label("push"), "Push");
    eq("push disabled with nothing left", $("push").disabled, true);
    eq("push says why", $("push").title, "Nothing to push");
    eq("ahead count hidden", shown($("ahead")), false);
    eq("upstream moved to HEAD's row", refNames(document.querySelector("#rows .row")).join(), "feat/t15g-graph-density,origin/feat/t15g-graph-density");
    eq("beside its branch it says only where it is", firstRowRefs(), "Tfeat/t15g-graph-densityTorigin");
    eq("legend: no ↑ left", stats().length, 0);
    eq("pull enabled again", $("pull").disabled, false);
  } else if (flow === "diverged") {
    eq("behind count shows 3", shown($("behind")) && $("behind").textContent, "3");
    ok("behind count is the outline kind", $("behind").classList.contains("in"), $("behind").className);
    eq("legend shows ↑2 and ↓3", stats().join(" "), "b-stats:↑2 b-stats in:↓3");
    $("push").click();
    run(3000);
    eq("push rejected → notice", noticeOn() && noticeText(), "Push rejected. Pull first.");
    eq("push usable again", $("push").disabled, false);
    eq("ahead count kept", $("ahead").textContent, "2");
    ok("sign hides the station while the notice stands", !shown(document.querySelector(".youare")), "youare shown");
    $("pull").click();
    eq("starting another op clears the notice", noticeOn(), false);
    run(2000);
    eq("pull cannot fast-forward → notice", noticeOn() && noticeText(), "Can't fast-forward. Merge manually.");
    $("notice-x").click();
    eq("dismiss hides the notice", noticeOn(), false);
    ok("station is back", shown(document.querySelector(".youare")), "youare hidden");
    eq("focus returns to the op that failed", document.activeElement && document.activeElement.id, "pull");
  } else if (flow === "publish") {
    eq("push reads Publish", label("push"), "Publish");
    eq("publish explains itself", $("push").title, "Publish feat/t15g-graph-density to origin and track it");
    eq("pull disabled without upstream", $("pull").disabled, true);
    eq("pull says why", $("pull").title, "No upstream — publish this branch first");
    ok("no remote-tracking ref for the branch", !allRefNames().includes("origin/feat/t15g-graph-density"), "still there");
    ok("legend lacks the remote", !remotes().includes("origin/feat/t15g-graph-density"), remotes());
    eq("legend shows no ↑ without upstream", stats().length, 0);
    $("push").click();
    run(50);
    ok("publishing shows a percentage", /^\d+%$/.test(label("push")), label("push"));
    run(3000);
    eq("label becomes Push", label("push"), "Push");
    eq("then nothing to push", $("push").title, "Nothing to push");
    eq("pull enabled once tracked", $("pull").disabled, false);
    eq("upstream ref at HEAD", refNames(document.querySelector("#rows .row")).join(), "feat/t15g-graph-density,origin/feat/t15g-graph-density");
    eq("legend gains the remote in name order", remotes().join(","),
      "origin/feat/t15e-graph-layout,origin/feat/t15f-motion,origin/feat/t15g-graph-density,origin/feat/t9d-watcher,origin/fix/toolbar-jump,origin/main");
  } else if (flow === "behind") {
    eq("behind count shows 3", $("behind").textContent, "3");
    eq("push disabled: nothing to push", $("push").title, "Nothing to push");
    eq("legend shows ↓3 only", stats().join(" "), "b-stats in:↓3");
    $("pull").click();
    eq("pull label while pulling", label("pull"), "Pulling…");
    eq("push disabled while pulling", $("push").title, "Disabled while pulling");
    run(2000);
    eq("behind count gone", shown($("behind")), false);
    eq("legend clear", stats().length, 0);
    eq("no notice", noticeOn(), false);
  } else if (flow === "account") {
    const acct = $("account"), menu = $("acct-menu");
    eq("menu button semantics", acct.getAttribute("aria-haspopup"), "menu");
    acct.click();
    eq("click opens the menu", menu.hidden, false);
    eq("aria-expanded follows", acct.getAttribute("aria-expanded"), "true");
    eq("focus moves into the menu", document.activeElement && document.activeElement.id, "signout");
    key($("signout"), "Escape");
    eq("Esc closes", menu.hidden, true);
    eq("focus back on the account", document.activeElement && document.activeElement.id, "account");
    acct.click();
    document.querySelector(".graph-pane").click();
    eq("click outside closes", menu.hidden, true);
    acct.click();
    $("signout").click();
    eq("signed out label", $("acct-name").textContent, "Connect GitHub");
    ok("signed out look", acct.classList.contains("out"), acct.className);
    eq("no menu once signed out", acct.hasAttribute("aria-haspopup"), false);
    acct.click();
    eq("connecting label", $("acct-name").textContent, "Connecting…");
    eq("connecting disables", acct.disabled, true);
    run(2000);
    eq("signed back in", $("acct-name").textContent, "tznthou");
    eq("avatar initials", $("avatar").textContent, "TZ");
  } else if (flow === "account-fail") {
    const acct = $("account");
    acct.click();
    $("signout").click();
    eq("failed sign-out → notice", noticeOn() && noticeText(), "Sign out failed. Try again.");
    eq("still signed in", $("acct-name").textContent, "tznthou");
    acct.click();
    $("signout").click();
    eq("retry signs out", $("acct-name").textContent, "Connect GitHub");
    eq("retry cleared the notice", noticeOn(), false);
    acct.click();
    run(2000);
    eq("failed connect → notice", noticeOn() && noticeText(), "GitHub sign-in failed. Check your network.");
    eq("back to Connect GitHub", $("acct-name").textContent, "Connect GitHub");
    acct.click();
    run(2000);
    eq("retry connects", $("acct-name").textContent, "tznthou");
  } else if (flow === "detached") {
    eq("sign label", $("you-lbl").textContent, "Detached at");
    eq("sign shows the commit", $("you-bn").textContent, "7b03d5e");
    eq("roundel of the line it sits on", $("you-rd").textContent, "T");
    eq("pull disabled", $("pull").title, "Detached HEAD — check out a branch first");
    eq("push disabled", $("push").title, "Detached HEAD — check out a branch first");
    eq("no current branch in the legend", current(), null);
    eq("…nor for a screen reader", ariaCurrent(), "");
    eq("accent follows the HEAD station's line", document.documentElement.dataset.line, "rokusho");
    eq("HEAD's row is selected", document.querySelector('#rows .row[aria-selected="true"]').dataset.id, "7b03d5e");
    eq("a HEAD pill on the station HEAD stopped at", refNames(document.getElementById("r-7b03d5e")).join(), "HEAD");
    const msg = $("msg");
    msg.value = "chore: try something detached";
    msg.dispatchEvent(new Event("input", { bubbles: true }));
    $("commit").click();
    run(2000);
    const top = document.querySelector("#rows .row");
    eq("new commit on top", top.querySelector(".subject").textContent, "chore: try something detached");
    eq("no branch moved onto it, only the HEAD pill", refNames(top).join(), "HEAD");
    eq("the old station lost its pill", refNames(document.getElementById("r-7b03d5e")).join(), "");
    eq("sign follows HEAD", $("you-bn").textContent, top.dataset.id);
    eq("no ↑ for a detached commit", stats().length, 0);
    document.querySelector('#branch-list .branch-btn[data-branch="main"]').click();
    eq("checkout leaves detached", $("you-lbl").textContent, "You are on");
    eq("now on main", $("you-bn").textContent, "main");
    eq("main has nothing to push", $("push").title, "Nothing to push");
    eq("pull usable on main", $("pull").disabled, false);
  } else if (flow === "no-remote") {
    eq("pull says why", $("pull").title, "No remote configured");
    eq("push says why", $("push").title, "No remote configured");
    eq("push is not Publish without a remote", label("push"), "Push");
    eq("both disabled", $("pull").disabled && $("push").disabled, true);
    eq("legend has no remotes", remotes().length, 0);
    eq("map has no remote refs", document.querySelectorAll("#rows .ref.remote").length, 0);
  } else if (flow === "both-blocked") {
    // the app checks the branch before the remote (PushPullBar: !branch, then !remote)
    eq("detached outranks no remote (pull)", $("pull").title, "Detached HEAD — check out a branch first");
    eq("detached outranks no remote (push)", $("push").title, "Detached HEAD — check out a branch first");
  } else if (flow === "signed-out") {
    eq("label", $("acct-name").textContent, "Connect GitHub");
    eq("title", $("account").title, "Connect GitHub to see pull requests");
    ok("person glyph instead of initials", !!$("avatar").querySelector("use"), $("avatar").innerHTML);
  } else if (flow === "menu-open") {
    eq("menu drawn open", $("acct-menu").hidden, false);
    eq("aria-expanded", $("account").getAttribute("aria-expanded"), "true");
    ok("a drawn state does not take focus", document.activeElement === document.body, document.activeElement && document.activeElement.id);
  } else if (flow === "static") {
    // ?state=error-push / ?chrome=full
    const p = new URLSearchParams(location.search);
    if (p.get("chrome") === "full") {
      eq("traffic lights gone", shown(document.querySelector(".traffic")), false);
      eq("sign starts at your line", getComputedStyle(document.querySelector(".topbar")).paddingLeft, "4px");
    } else {
      eq("notice sits in the top bar", document.querySelector(".notice").parentElement.className, "topbar");
      ok("station hidden", !shown(document.querySelector(".station")), "shown");
      eq("notice text", noticeText(), "Push rejected. Pull first.");
      eq("alert role", $("notice").getAttribute("role"), "alert");
      ok("nothing below moves", getComputedStyle(document.querySelector(".app")).gridTemplateRows.split(" ").length === 3, "grid changed");
    }
  // ---------------- Phase 0b P5: the sidebar, the right pane, the diff ----------------
  } else if (flow === "beyond-checkout") {
    // feat/t9d-watcher: its tip is older than the window, so it has no line on the map (decision C)
    eq("beyond the window: dashed roundel", rdLook(rdOf("feat/t9d-watcher")), "dash");
    eq("its remote too", rdLook(rdOf("origin/feat/t9d-watcher")), "dash");
    ok("no ref of it on the map", !allRefNames().some((n) => n.includes("t9d")), allRefNames());
    eq("other branches' counts as plain text", text(branchBtn("feat/t9d-watcher").querySelector(".b-stats.plain")), "↑1 ↓2");
    eq("…titled in words", branchBtn("feat/t9d-watcher").querySelector(".b-stats").title, "1 commit not pushed · 2 commits on origin not pulled");
    eq("branches level with origin show none", branchBtn("fix/toolbar-jump").querySelectorAll(".b-stats").length + branchBtn("main").querySelectorAll(".b-stats").length, 0);
    eq("the current row says so to a screen reader", ariaCurrent(), "feat/t15g-graph-density=true");
    branchBtn("feat/t9d-watcher").click();
    eq("checked out", $("you-bn").textContent, "feat/t9d-watcher");
    eq("aria-current moves with it", ariaCurrent(), "feat/t9d-watcher=true");
    eq("HEAD's letter comes first: T (decision D, computeRoutes)", $("you-rd").textContent, "T");
    eq("accent = its preferred colour", document.documentElement.dataset.line, "shinsha");
    eq("no gold flake on the map", document.querySelectorAll("#lanes polygon").length, 0);
    ok("the end of the map says where you are", text($("graph-end")).includes("You are further down the line.") && text($("graph-end")).includes("feat/t9d-watcher is older than these commits."), text($("graph-end")));
    eq("its row wears its letter now", rdLook(rdOf("feat/t9d-watcher")), "T");
    eq("and its remote, hollow", rdLook(rdOf("origin/feat/t9d-watcher")), "hollow T");
    eq("feat/t15g-graph-density gives T up: G on the map", text(document.querySelector("#r-c9e41f2 .refs .rd")), "G");
    eq("and in the legend", rdLook(rdOf("feat/t15g-graph-density")), "G");
    eq("push counts its 1", $("ahead").textContent, "1");
    eq("pull counts its 2", $("behind").textContent, "2");
    eq("feat/t15g-graph-density now counts as another branch", text(branchBtn("feat/t15g-graph-density").querySelector(".b-stats.plain")), "↑2");
    branchBtn("main").click();
    eq("…and to main", ariaCurrent(), "main=true");
    eq("leaving it: T back to feat/t15g-graph-density", text(document.querySelector("#r-c9e41f2 .refs .rd")), "T");
    eq("and the dashed roundel back", rdLook(rdOf("feat/t9d-watcher")), "dash");
    eq("the end of the map no longer says you are further down", text($("graph-end")).includes("further down"), false);
  } else if (flow === "lodger-checkout") {
    eq("a lodger: hollow ring, no letter", rdLook(rdOf("release/0.1")), "ring");
    branchBtn("release/0.1").click();
    eq("checked out", $("you-bn").textContent, "release/0.1");
    eq("its own letter (decision D): A", $("you-rd").textContent, "A");
    eq("accent = its preferred colour, not the trunk's", document.documentElement.dataset.line, "shinsha");
    eq("HEAD pill at the merge it lodges on, its remote beside it", headRefs("63421cf").join(), "release/0.1,origin/release/0.1");
    eq("the pill wears A", text(document.querySelector("#r-63421cf .ref.head .rd")), "A");
    eq("its remote says only origin, hollow A", text(document.querySelector("#r-63421cf .ref.remote")), "A origin");
    ok("…hollow", document.querySelector("#r-63421cf .ref.remote .rd").classList.contains("hollow"), "filled");
    eq("legend row: A", rdLook(rdOf("release/0.1")), "A");
    eq("legend remote: hollow A", rdLook(rdOf("origin/release/0.1")), "hollow A");
    eq("nothing to push", $("push").title, "Nothing to push");
    branchBtn("main").click();
    eq("leaving it, a lodger again", rdLook(rdOf("release/0.1")), "ring");
    eq("and on the map", headRefs("63421cf").join(), "release/0.1,origin/release/0.1");
    eq("map roundel ringed again", document.querySelector("#r-63421cf .ref.local .rd").classList.contains("lodge"), true);
    eq("accent back to the trunk", document.documentElement.dataset.line, "trunk");
  } else if (flow === "checkout-fail") {
    // ?fail=refresh,checkout
    $("refresh").click();
    run(2000);
    eq("refresh failed first", noticeText(), "Refresh failed.");
    branchBtn("fix/toolbar-jump").click();
    eq("checkout failed → the sign says so (the dialog closes in the app)", noticeOn() && noticeText(), "Checkout failed. Commit or stash first.");
    eq("still where you were", $("you-bn").textContent, "feat/t15g-graph-density");
    $("notice-x").click();
    ok("dismissing puts the focus back on the row you pressed", focusIs(branchBtn("fix/toolbar-jump")), document.activeElement && document.activeElement.outerHTML.slice(0, 80));
    branchBtn("fix/toolbar-jump").click();
    eq("the retry checks out", $("you-bn").textContent, "fix/toolbar-jump");
    eq("no notice", noticeOn(), false);
  } else if (flow === "clear-checkout") {
    // ?state=error-push: a notice already up; the next op you start clears it
    branchBtn("main").click();
    eq("checking out clears the notice", noticeOn(), false);
  } else if (flow === "clear-stage") {
    document.querySelector('.stage-btn[data-op="stage"]').click();
    eq("staging clears the notice", noticeOn(), false);
  } else if (flow === "clear-commit") {
    type("docs: note");
    $("commit").click();
    eq("committing clears the notice", noticeOn(), false);
  } else if (flow === "stage-fail") {
    // ?fail=stage
    const btn = () => document.querySelector('.stage-btn[data-path="docs/PLAN.md"][data-op="stage"]');
    btn().click();
    eq("stage failed → the sign says so", noticeOn() && noticeText(), "Stage failed.");
    ok("the file stays unstaged", files("unstaged").includes("docs/PLAN.md"), files("unstaged"));
    $("notice-x").click();
    ok("focus back on its stage button", focusIs(btn()), document.activeElement && document.activeElement.outerHTML.slice(0, 80));
    btn().click();
    ok("the retry stages it", files("staged").includes("docs/PLAN.md"), files("staged"));
    eq("no notice", noticeOn(), false);
  } else if (flow === "commit-fail") {
    // ?fail=commit
    type("feat: try");
    $("commit").click();
    run(2000);
    eq("GIT_IDENTITY_MISSING → the sign says so", noticeOn() && noticeText(), "Commit failed. Set your git name and email.");
    eq("the message stays", $("msg").value, "feat: try");
    eq("the staged files stay", $("n-staged").textContent, "2");
    eq("no new commit", document.querySelector("#rows .row").dataset.id, "c9e41f2");
    eq("Commit usable again", $("commit").disabled, false);
    $("notice-x").click();
    ok("focus back on Commit", focusIs($("commit")), document.activeElement && document.activeElement.id);
  } else if (flow === "busy-legend") {
    $("refresh").click();
    const b = branchBtn("main");
    eq("rows wait while refreshing", b.getAttribute("aria-disabled"), "true");
    eq("and say why", b.title, "Disabled while refreshing");
    eq("rows do not fade", getComputedStyle(b).opacity, "1");
    eq("+ New branch waits", $("create-branch").disabled, true);
    eq("+ New branch says why", $("create-branch").title, "Disabled while refreshing");
    b.click();
    eq("a press while busy does nothing", $("you-bn").textContent, "feat/t15g-graph-density");
    run(2000);
    eq("after: row free", branchBtn("main").hasAttribute("aria-disabled"), false);
    eq("after: title back", branchBtn("main").title, "Switch to main");
    eq("after: + New branch free", $("create-branch").disabled, false);
  } else if (flow === "status-fail") {
    // ?fail=status: the refresh's status read fails, and swallows its own error
    type("feat: try");
    $("refresh").click();
    run(2000);
    eq("no notice in the sign", noticeOn(), false);
    ok("the pane says it could not read", visible($("changes-state")) && text($("changes-state")).includes("Couldn't read your changes."), text($("changes-state")));
    eq("…as an alert", $("changes-state").getAttribute("role"), "alert");
    eq("the old lists are gone", visible($("stage-lists")), false);
    eq("Commit off while the status is unknown", $("commit").disabled, true);
    $("changes-retry").click();
    eq("Retry reads again", visible($("stage-lists")), true);
    ok("focus stays in the Changes pane", focusIs($("panel-changes")), act());
    eq("the error is gone", visible($("changes-state")), false);
    eq("Commit back", $("commit").disabled, false);
  } else if (flow === "conflict") {
    const c = $("conflicted");
    eq("Conflicted, counted", text(c.querySelector(".stage-head h3")), "Conflicted 3");
    eq("the strip says what to do", text(c.querySelector(".strip")), "3 files have conflicts. Fix them in your editor, then git add them.");
    eq("git's short status", [...c.querySelectorAll(".badge")].map((x) => x.textContent).join(), "UU,UU,DU");
    eq("titled in words", [...c.querySelectorAll(".badge")].map((x) => x.title).join(), "Both modified,Both modified,Deleted by us");
    eq("no stage buttons on conflicts", c.querySelectorAll(".stage-btn").length, 0);
    ok("above the staged list", c.compareDocumentPosition($("staged")) & Node.DOCUMENT_POSITION_FOLLOWING, "order");
    type("Merge branch 'main'");
    eq("Commit off", $("commit").disabled, true);
    eq("…and says why", $("commit").title, "Resolve conflicts first");
    // resolved in an editor and git add-ed in a terminal; the next refresh reads them staged
    $("refresh").click();
    run(2000);
    eq("conflicts gone", c.children.length, 0);
    ok("the resolved files are staged", ["src/App.tsx", "src/lib/graphLayout.ts"].every((p) => files("staged").includes(p)), files("staged"));
    eq("Commit usable", $("commit").disabled, false);
    eq("no reason left", $("commit").hasAttribute("title"), false);
  } else if (flow === "prs-signin") {
    // ?state=signed-out&tab=prs
    const box = $("prs-state");
    eq("the pane asks you to connect", text(box), "Connect GitHub to see pull requests Connect GitHub");
    $("prs-connect").click();
    eq("connecting: the account", $("acct-name").textContent, "Connecting…");
    eq("connecting: the pane's button", $("prs-connect").disabled && $("prs-connect").textContent, "Connecting…");
    run(950);
    eq("signed in", $("acct-name").textContent, "tznthou");
    eq("the pull requests are read again: a skeleton", document.querySelectorAll("#prs .sk-pr").length, 3);
    run(1000);
    eq("then the list", document.querySelectorAll("#prs .pr").length, 3);
    eq("the pane's message is gone", visible(box), false);
  } else if (flow === "prs-signin-fail") {
    // ?state=signed-out&tab=prs&fail=connect
    $("prs-connect").click();
    run(2000);
    eq("sign-in failed → the sign", noticeOn() && noticeText(), "GitHub sign-in failed. Check your network.");
    eq("the pane offers it again", $("prs-connect").textContent, "Connect GitHub");
    $("notice-x").click();
    ok("focus back on the pane's button", focusIs($("prs-connect")), document.activeElement && document.activeElement.id);
  } else if (flow === "signout-prs") {
    // ?tab=prs
    $("account").click();
    $("signout").click();
    eq("signed out: the pane asks to connect", text($("prs-state")), "Connect GitHub to see pull requests Connect GitHub");
  } else if (flow === "prs-retry") {
    // ?state=prs-error&tab=prs
    eq("the pane says it could not load", text($("prs-state")), "Couldn't load pull requests. Check your network, then try again. Retry");
    eq("…as an alert", $("prs-state").getAttribute("role"), "alert");
    $("prs-retry").click();
    eq("Retry: a skeleton", document.querySelectorAll("#prs .sk-pr").length, 3);
    ok("focus in the pane while it reads", focusIs($("panel-prs")), act());
    run(1000);
    eq("then the list", document.querySelectorAll("#prs .pr").length, 3);
    ok("…and still there", focusIs($("panel-prs")), act());
  } else if (flow === "prs-rate") {
    eq("rate limit: when to try again", text($("prs-state")), "GitHub's rate limit is used up. Try again after 14:32. Retry");
  } else if (flow === "prs-states") {
    // the pane under the shell's and the graph's states (§1.4): ?state=<s>&tab=prs, the state is in the url
    const s = new URLSearchParams(location.search).get("state");
    const want = { "no-remote": "No GitHub remote Pull requests come from origin on github.com.", empty: "No GitHub remote Pull requests come from origin on github.com.",
      // the backend asks whether origin is on GitHub before it reads the token
      "no-remote,signed-out": "No GitHub remote Pull requests come from origin on github.com.",
      young: "No GitHub remote Pull requests come from origin on github.com.", routes: "No open pull requests", "prs-empty": "No open pull requests",
      "error-auth": "Connect GitHub to see pull requests Connect GitHub", connecting: "Connect GitHub to see pull requests Connecting…" }[s];
    eq(`${s}: the pane says`, text($("prs-state")), want);
  } else if (flow === "pr-diff") {
    // ?tab=prs: an open pull request shows every file
    eq("both files of #38", document.querySelectorAll(".pr.open .dfile").length, 2);
    // the line each one runs on, read off the map: letter and name (#39's head is on no ref)
    eq("via: the line each pull request runs on", [...document.querySelectorAll("#prs .via")].map((v) =>
      `${v.querySelector(".rd").textContent}:${v.lastChild.textContent}`).join(" | "), "J:fix/toolbar-jump | T:feat/t15g-graph-density");
  } else if (flow === "pr-via-loading") {
    // ?state=loading&tab=prs: git_get_graph has not answered, so there is no map to read a line off (Phase 5 Q-L)
    eq("the list is there", document.querySelectorAll("#prs .pr").length, 3);
    eq("no via before the map", document.querySelectorAll("#prs .via").length, 0);
  } else if (flow === "pr-diff-limits") {
    // ?state=pr-diff-limits&tab=prs: #38 also updates a lock file too large to show on its own (B1)
    const body = document.querySelector(".pr.open .pr-body");
    const strips = [...body.querySelectorAll(".strip")];
    eq("one strip counts what is kept back", strips.map(text).join(" | "), "1 of 3 files not shown. 1 too large.");
    eq("every file is there", body.querySelectorAll(".dfile").length, 3);
    eq("the lock file's cell gives no command: not a local commit", text(body.querySelector(".dcell")), "Too large to show. 3,412 lines · 140.2 KiB");
    const edges = (el) => (el ? (({ left, right }) => [left, right].map(Math.round).join())(el.getBoundingClientRect()) : null);
    eq("the strip lines up with the files", edges(strips[0]), edges(body.querySelector(".dfile")));
  } else if (flow === "pr-diff-too-large") {
    // ?state=pr-diff-too-large&tab=prs: over GitHub's limits for a diff, or over Kira's 1 MB — no Retry would get it
    const body = document.querySelector(".pr.open .pr-body");
    eq("a strip says so, and nothing else", text(body), "Too large to show here. Read this pull request on GitHub.");
    eq("…as a strip", text(body.querySelector(".strip")), "Too large to show here. Read this pull request on GitHub.");
    eq("no Retry", body.querySelectorAll("button").length, 0);
    eq("a fact, not an alert", body.querySelectorAll("[role=alert]").length, 0);
  } else if (flow === "pr-diff-retry") {
    // ?state=pr-diff-error&tab=prs
    eq("one line in the pull request", text(document.querySelector(".pr.open .pr-body")), "Couldn't load the files. Retry");
    $("pr-diff-retry").click();
    eq("Retry: the files", document.querySelectorAll(".pr.open .dfile").length, 2);
    ok("focus on the pull request whose files they are", focusIs(document.querySelector(".pr.open .pr-row")), act());
  } else if (flow === "branches-retry") {
    // ?state=branches-error: opening the repo could not read the branch list (Phase 5 Q-B)
    eq("one line in the list", text($("branch-list")), "Couldn't read branches. Retry");
    eq("…the verdict as an alert", text($("branch-list").querySelector("[role=alert]")), "Couldn't read branches.");
    eq("no rows", document.querySelectorAll("#branch-list .branch").length, 0);
    eq("+ New branch still usable", $("create-branch").disabled, false);
    $("branches-retry").click();
    ok("Retry reads again: the rows", document.querySelectorAll("#branch-list .branch").length > 0, text($("branch-list")).slice(0, 60));
    eq("the line is gone", $("branch-list").querySelectorAll("[role=alert]").length, 0);
    ok("focus stays in the list, not lost with the button", focusIs($("branch-list")), act());
    eq("…which is named", $("branch-list").getAttribute("aria-label"), "Branches");
  } else if (flow === "branches-fail") {
    // ?fail=branches: a Refresh you pressed cannot read the branch list (Phase 5 Q-B)
    $("refresh").click();
    run(2000);
    eq("no notice in the sign", noticeOn(), false);
    eq("the list says it could not read", text($("branch-list")), "Couldn't read branches. Retry");
    eq("the old rows are gone", document.querySelectorAll("#branch-list .branch").length, 0);
    $("refresh").click();
    eq("+ New branch waits while refreshing, error or not", $("create-branch").disabled, true);
    run(2000);
    ok("the next Refresh reads it", document.querySelectorAll("#branch-list .branch").length > 0, text($("branch-list")).slice(0, 60));
    eq("…and the line is gone", $("branch-list").querySelectorAll("[role=alert]").length, 0);
  } else if (flow === "on-after-state") {
    // ?state=lodger&on=release/0.1: ?on= comes after the states, so a branch a state adds can be the one checked out
    eq("checked out", $("you-bn").textContent, "release/0.1");
    eq("its own letter (decision D): A", $("you-rd").textContent, "A");
    eq("accent = its preferred colour", document.documentElement.dataset.line, "shinsha");
    eq("current in the legend", current(), "release/0.1");
    eq("…and for a screen reader", ariaCurrent(), "release/0.1=true");
    eq("HEAD pill at the merge it lodges on", headRefs("63421cf").join(), "release/0.1,origin/release/0.1");
    const sel = document.querySelector('#rows .row[aria-selected="true"]');
    eq("HEAD's station selected", sel && sel.dataset.id, "63421cf");
  } else if (flow === "diff-retry") {
    // ?state=diff-error
    run(300);
    eq("the diff area says it could not load", text($("diff")), "Couldn't load this diff. Try again, or pick another station. Retry");
    $("diff-retry").click();
    run(300);
    ok("Retry loads it", $("diff").querySelectorAll(".dfile").length > 0, text($("diff")).slice(0, 80));
    ok("focus stays in the diff", focusIs($("diff")), act());
  } else if (flow === "diff-limits") {
    // ?state=diff-limits: the merge of #36 at the display limit
    run(300);
    const d = $("diff");
    eq("the strip counts what is kept back", text(d.querySelector(".strip")), "2 of 9 files not shown. 1 too large, 1 over the display limit.");
    const cells = [...d.querySelectorAll(".dcell")].map(text);
    eq("cells, in path order", cells.join(" | "), [
      "Over 10 MB. Diff skipped.",
      "Not shown. The files before it used up the display limit. 812 lines · 41.2 KiB In a terminal: git show -m --first-parent 63421cf5f0a3 -- ':(literal)docs/notes/v8 port [draft].md'",
      "Too large to show. 3,412 lines · 140.2 KiB In a terminal: git show -m --first-parent 63421cf5f0a3 -- package-lock.json",
      "No text changes",
      "Binary file",
    ].join(" | "));
    eq("the rename's badge", d.querySelector(".dfile:last-child .badge").textContent, "R");
    eq("a line over 2,000 characters is not highlighted", d.querySelector(".dfile .dl.add code").children.length, 0);
    // a file that only gains its newline at the end: git's note sits under the line it is about, with no numbers,
    // not counted in the hunk header, not coloured, in the dim ink of the numbers (Phase 5, libgit2's real hunk)
    const cap = [...d.querySelectorAll(".dfile")].find((f) => text(f.querySelector(".dpath")) === "src-tauri/capabilities/default.json");
    eq("the newline-only file's hunk counts git's lines", text(cap && cap.querySelector(".hunk-head")), "@@ -13,4 +13,4 @@");
    eq("…its rows", cap && [...cap.querySelectorAll(".dl")].map((r) => r.className.replace("dl ", "")).join(), "ctx,ctx,ctx,del,eof,add");
    const eof = cap && cap.querySelector(".dl.eof");
    eq("the note reads as git writes it", text(eof && eof.querySelector("code")), "\\ No newline at end of file");
    eq("…with no numbers, no mark and no colour", eof && [...eof.querySelectorAll(".ln, .og")].map(text).join("|") + "|" + eof.querySelector("code").children.length, "|||0");
    const dim = eof ? getComputedStyle(eof.querySelector("code")).color === getComputedStyle(eof.querySelector(".ln")).color : null;
    eq("…in the dim ink of the numbers", dim, true);
    // a commit with one parent gives the plain command
    document.getElementById("r-c9e41f2").click();
    run(300);
    eq("one parent: no -m --first-parent", text(d.querySelector(".dcell code")), "git show c9e41f25f0a3 -- src-tauri/Cargo.lock");
  } else if (flow === "diff-at") {
    // ?diffat=<path>: once the diff has drawn, it is scrolled to that file's header, 12px under the top of the diff
    // (the padding's worth), so the comparison shots reach what is below the first screen
    run(300);
    const d = $("diff");
    const cap = [...d.querySelectorAll(".dfile")].find((f) => text(f.querySelector(".dpath")) === "src-tauri/capabilities/default.json");
    // within a pixel: the layout has half pixels and scrollTop is a whole number
    const top = cap ? cap.getBoundingClientRect().top - d.getBoundingClientRect().top : null;
    ok("the file's header sits 12px under the top of the diff", top !== null && Math.abs(top - 12) < 1, top);
    ok("…so the diff is scrolled", d.scrollTop > 0, d.scrollTop);
  } else if (flow === "diff-code") {
    // Phase 5 B2 / Q-H: a hunk header names the line above it, as libgit2 does; keywords are the file's language's
    run(300);
    eq("HEAD's hunk names the line above it (the fixture repository's)", hunkHeads().join(" | "),
      "@@ -13,5 +13,9 @@ export const HASH_COL_WIDTH = 60; | @@ -112,4 +112,9 @@ export function computeLayout(");
    $("r-e81d6b0").click();
    run(300);
    eq("true is a keyword", tokens(codeLine("onClick={() => void handleRefresh(")), "k:void f:handleRefresh k:true");
    eq("…and null", tokens(codeLine("disabled={refreshing || pushPullOp !== null}")), "k:null");
    $("r-7b03d5e").click();
    run(300);
    eq("a hunk below the imports names the last one above it", hunkHeads()[0], '@@ -4,4 +4,4 @@ import type { CommitNode } from "./tauri";');
    eq("describe is a call, not a keyword", tokens(codeLine('describe("lane gutter budget"')), 'f:describe s:"lane gutter budget"');
  } else if (flow === "diff-code-young") {
    // ?state=young: a TypeScript keyword and type the first highlighter left out; Markdown is not coloured
    run(300);
    eq("await and string", tokens(codeLine("const commits = await invoke")), 'k:const k:await t:string s:"list_commits" s:"."');
    // review decision A (2026-10-12): the first line of a template literal is a string to its end, the line inside it is
    // code that knows nothing of it, its last line is the closing backtick's. The reference before it has no such lines
    eq("a template literal's first line", tokens(codeLine("const banner = `Kira")), "k:const s:`Kira");
    eq("…the line inside it is code", tokens(codeLine("${commits.length} commits on main")), "");
    eq("…its last line", tokens(codeLine("`;")), "s:`;");
    eq("a file added in the same commit", tokens(codeLine("export function App(")), "k:export k:function t:App t:Props");
    // a JSX text line holding an expression is not text (Q-H3), and every single quote starts a string, an apostrophe too
    // (third review, 2026-10-12): from the apostrophe to the end of the line it reads as a string (You before it is a
    // capitalised name, so a type). On the rule before it the apostrophe kept the line's code colours, and a legal
    // string's opening quote in the same place let a call after it read as a comment
    eq("an apostrophe in JSX text holding an expression", tokens(codeLine("<p>You're in")), "t:You s:'re in {branch} with {commits.length} new commits</p>");
    $("r-5e0d9a3").click();
    run(300);
    // the last line has code in it: a line of text alone would read as text in JavaScript too (Q-H3)
    eq("the README is not coloured", [...$("diff").querySelectorAll(".dl code")].map((c) => c.children.length).join(), "0,0,0,0");
    eq("…and reads as written", text($("diff").querySelectorAll(".dl code")[3]), "Run it with `npm run tauri dev` (needs Rust).");
  } else if (flow === "diff-bidi") {
    // ?state=diff-bidi: bidirectional controls are named, not obeyed (Phase 5 Q-T)
    run(300);
    const d = $("diff");
    eq("nothing is left to reorder the diff", /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(d.textContent), false);
    eq("the line's controls, named in order", [...d.querySelectorAll(".dl .bidi")].map((b) => b.textContent).join(), "RLO,LRI,PDI,LRI,LS");
    eq("…and the hunk header's", [...d.querySelectorAll(".hunk-head .bidi")].map((b) => b.textContent).join(), "LRI,PDI");
    eq("each says its code point", (d.querySelector(".dl .bidi") || {}).title, "U+202E");
    eq("the line reads in the order it runs", text(codeLine("if (role")), 'if (role != "readerRLO LRI// Check if ownerPDI LRI") {');
    // …and a file name hiding an .exe as a shell script: named in the header, read in the order it is stored
    eq("the file name's control, named", [...d.querySelectorAll(".dpath .bidi")].map((b) => b.textContent).join(), "RLO");
    eq("…so it reads as the .exe it is", text(d.querySelector(".dfile .dpath")), "scripts/setupRLOhs.exe");
    // a bare carriage return in a line stays one line (review 2026-10-11): written as &#13; it survives innerHTML, where
    // the HTML parser would have turned it into a line feed and a second row
    // (textContent, not text(): that helper folds whitespace, which is what is being checked here)
    const logCode = codeLine("log(");
    const raw = logCode ? logCode.textContent : "";
    eq("a bare carriage return is still there", raw.includes(String.fromCharCode(13)), true);
    eq("…and did not become a line feed", raw.includes(String.fromCharCode(10)), false);
    const rowHeight = (c) => (c ? c.closest(".dl").getBoundingClientRect().height : -1);
    eq("…so its row is as tall as the next line's", rowHeight(logCode), rowHeight(codeLine("await listPRs")));
    // a line separator (U+2028) is named too (second review 2026-10-12): under white-space: pre WebKit broke the row at
    // it, so a line git counts as one showed as two; named, nothing is left to break the row and it is as tall as its
    // neighbour. The reference before this has no such line
    const lsCode = codeLine('log("split');
    eq("a line separator is named", lsCode ? [...lsCode.querySelectorAll(".bidi")].map((b) => b.textContent + "@" + b.title).join() : null, "LS@U+2028");
    eq("…and nothing is left to break the row", lsCode ? lsCode.textContent.includes(String.fromCharCode(0x2028)) : null, false);
    // (rounded: the marker's inline box adds a twentieth of a pixel; a second row would add twenty)
    eq("…so the separator's row is one row, as tall as the next line's", Math.round(rowHeight(lsCode)), Math.round(rowHeight(codeLine("await listPRs"))));
  } else if (flow === "panel-static") {
    // one check per drawn state (?state= in the url)
    const s = new URLSearchParams(location.search).get("state");
    run(300);
    if (s === "opening") {
      eq("pull: upstream unknown", $("pull").title, "Upstream status unknown — Refresh to retry");
      eq("push: upstream unknown, no count", $("push").title + "|" + shown($("ahead")), "Upstream status unknown — Refresh to retry|false");
      eq("branch skeleton", document.querySelectorAll("#branch-list .sk-branch").length, 4);
      eq("no counts yet", $("n-staged").textContent + $("n-unstaged").textContent, "");
      eq("status skeleton", document.querySelectorAll("#staged .sk-file, #unstaged .sk-file").length, 5);
      eq("pull requests skeleton", document.querySelectorAll("#prs .sk-pr").length, 3);
      eq("Commit off", $("commit").disabled, true);
    } else if (s === "pruned") {
      const tag = branchBtn("fix/toolbar-jump").querySelector(".b-tag");
      eq("pruned, said in the row", text(tag), "pruned");
      eq("…with the reason", tag.title, "Upstream is set, but origin/fix/toolbar-jump no longer exists");
      eq("no counts for it", branchBtn("fix/toolbar-jump").querySelectorAll(".b-stats").length, 0);
      ok("its remote is gone", !remotes().includes("origin/fix/toolbar-jump"), remotes());
    } else if (s === "many-changes") {
      eq("counted as 5,000+", $("n-unstaged").textContent, "5,000+");
      eq("5,000 listed", document.querySelectorAll("#unstaged .file").length, 5000);
      eq("the strip", text($("unstaged-note")), "Only the first 5,000 files are listed. Add a .gitignore to leave out build output.");
      eq("Stage all off", $("stage-all").disabled, true);
      eq("…and says why", $("stage-all").title, "Not every file is listed, so not all at once");
    } else if (s === "empty") {
      eq("no branches yet", text($("branch-list")), "No branches yet");
      eq("no Remote heading", document.querySelectorAll("#branch-list .group-label").length, 0);
      eq("the diff area: nothing to compare", text($("diff")), "Nothing to compare yet Your first commit will show here.");
      eq("no keys to press", $("diff").querySelectorAll("kbd").length, 0);
    } else if (s === "young") {
      eq("no Remote heading without remotes", document.querySelectorAll("#branch-list .group-label").length, 0);
    } else if (s === "diff-many") {
      eq("the strip", text($("diff").querySelector(".strip")), "Showing the first 500 files. This commit changes more.");
      eq("500 files", $("diff").querySelectorAll(".dfile").length, 500);
    } else if (s === "diff-empty") {
      eq("no file changes", text($("diff")), "No file changes This commit changes no files.");
    } else if (s === "loading") {
      // the graph is still out: the names are read, the roundels wait for the route map (Phase 5 Q-L)
      const rows = document.querySelectorAll("#branch-list .branch").length;
      ok("branches listed", rows > 0, rows);
      eq("every row's roundel is a skeleton dot", document.querySelectorAll("#branch-list .branch .sk-rd").length, rows);
      eq("no roundel yet", document.querySelectorAll("#branch-list .rd").length, 0);
      eq("the names are there", text(branchBtn("main").querySelector(".b-name")), "main");
    } else {
      out.push(`FAIL  panel-static has no check for ${s}`);
    }
  } else {
    out.push(`FAIL  unknown flow ${flow}`);
  }
  return out.join("\n");
})()
