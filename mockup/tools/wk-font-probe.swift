// 用系統 WKWebView（Tauri 在 macOS 用的同一顆引擎）量測系統字的實際行為：
// 1. system-ui 的中間字重（550/560/620…）是否連續，或吸附到具名字重
// 2. ui-monospace 是否解析成 SF Mono（與 Menlo 比 advance width）
// 3. system-ui 與 -apple-system、PingFang TC 的寬度關係
import Cocoa
import WebKit

let html = """
<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><style>
body { margin: 0; }
span { font-size: 100px; white-space: nowrap; position: absolute; }
</style></head><body><div id="host"></div><script>
function w(family, weight, text) {
  const s = document.createElement("span");
  s.style.fontFamily = family;
  s.style.fontWeight = String(weight);
  s.textContent = text;
  document.getElementById("host").appendChild(s);
  const v = s.getBoundingClientRect().width;
  s.remove();
  return Math.round(v * 100) / 100;
}
function measure() {
  const out = {};
  const latin = "Kira Graph Density 0123";
  out.weights = {};
  for (const wt of [300, 400, 450, 500, 510, 550, 560, 590, 600, 620, 630, 640, 650, 680, 700]) {
    out.weights[wt] = w("system-ui", wt, latin);
  }
  const mono = "abcdefghij0123456789";
  out.mono = {
    "ui-monospace": w("ui-monospace", 400, mono),
    "SF Mono (by name)": w("'SF Mono'", 400, mono),
    "Menlo": w("Menlo", 400, mono),
    "monospace (generic)": w("monospace", 400, mono),
    "Spline Sans Mono (not installed)": w("'Spline Sans Mono', serif", 400, mono)
  };
  out.monoWeights = {};
  for (const wt of [400, 500, 550, 600]) out.monoWeights[wt] = w("ui-monospace", wt, mono);
  out.ui = {
    "system-ui": w("system-ui", 400, latin),
    "-apple-system": w("-apple-system", 400, latin),
    "SF Pro (by name)": w("'SF Pro', serif", 400, latin),
    "Helvetica Neue": w("'Helvetica Neue'", 400, latin)
  };
  const cjk = "雲母路線圖提交訊息";
  out.cjk = {
    "system-ui": w("system-ui", 400, cjk),
    "PingFang TC": w("'PingFang TC'", 400, cjk),
    "serif (control)": w("serif", 400, cjk)
  };

  out.calc = {
    "calc(600 + var(--fwd)) fwd=-50": (() => { const s = document.createElement("span"); s.style.setProperty("--fwd", "-50"); s.style.fontFamily = "system-ui"; s.style.fontWeight = "calc(600 + var(--fwd))"; s.textContent = latin; document.getElementById("host").appendChild(s); const v = Math.round(s.getBoundingClientRect().width * 100) / 100; const cw = getComputedStyle(s).fontWeight; s.remove(); return v + " (computed " + cw + ")"; })(),
    "550 direct": w("system-ui", 550, latin)
  };
  out.flar = (() => { const s = document.createElement("span"); s.style.fontFamily = "system-ui"; s.style.fontVariationSettings = '"FLAR" 100'; s.textContent = latin; document.getElementById("host").appendChild(s); const v = Math.round(s.getBoundingClientRect().width * 100) / 100; s.remove(); return v; })();
  out.supports = {
    startViewTransition: typeof document.startViewTransition,
    oklch: CSS.supports("color", "oklch(0.5 0.1 200)"),
    colorMixOklab: CSS.supports("color", "color-mix(in oklab, red, blue)"),
    relativeColor: CSS.supports("color", "oklch(from red calc(l - 0.1) c h)"),
    scrollbarColor: CSS.supports("scrollbar-color", "red blue"),
    scrollbarWidthThin: CSS.supports("scrollbar-width", "thin"),
    viewTransitionPseudo: CSS.supports("selector(::view-transition-old(root))"),
    transformBoxFill: CSS.supports("transform-box", "fill-box"),
    hasSelector: CSS.supports("selector(:has(a))"),
    overscrollBehavior: CSS.supports("overscroll-behavior", "contain"),
    fontWeightCalc: CSS.supports("font-weight", "calc(600 + -50)")
  };
  out.ua = navigator.userAgent;
  return out;
}
</script></body></html>
"""

final class Probe: NSObject, WKNavigationDelegate {
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    webView.evaluateJavaScript("JSON.stringify(measure(), null, 1)") { result, error in
      if let s = result as? String { print(s) } else { print("error:", error ?? "nil") }
      exit(0)
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 2400, height: 400))
let probe = Probe()
webView.navigationDelegate = probe
webView.loadHTMLString(html, baseURL: nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 20) { print("timeout"); exit(1) }
app.run()
