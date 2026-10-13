// 用系統 WKWebView（Tauri 在 macOS 的同一顆引擎）對頁面上一點送原生滾輪事件，再跑量測 JS。
// 用法: wk-wheel <url> <w> <h> <locate.js> <probe.js> <dy> <count> <legacy|trackpad|trackpad-nomb> [delay-sec|ready]
//   locate.js 回傳 "x,y"（viewport CSS px）：事件送到那一點；回傳 "none" → exit 3（捲動區在、卻找不到要量的東西），
//   "absent" → exit 4（要量的捲動區不在頁面上）。兩種都不是通過，由呼叫端決定哪一種可以略過。
//   probe.js 的回傳值（字串）印到 stdout。dy > 0 = 往下捲（scrollTop 變大），送 count 次。
//   legacy：滑鼠滾輪，沒有 phase、每次 1 行（WebKit 約 40px）
//   trackpad：觸控板，先 MayBegin（手指放上去，位移 0），再 Began / Changed / Ended，每次 dy px
//   trackpad-nomb：少了 MayBegin 的觸控板——只供診斷：WebKit 在 MayBegin 那一刻決定手勢交給哪個捲動容器，
//     少了它，「hunk 把手勢吃掉」那種卡住量不到（2026-10-12 就是這樣先誤判觸控板不受影響）
// 環境變數：WK_WHEEL_GAP 事件間隔秒數（預設 0.016）；WK_WHEEL_LOG=1 在 document 開頭注入被動 wheel 監聽，
//   window.__wheel 記錄 WebKit 收到的事件（座標、目標），用來驗座標換算。
// JS 合成的 WheelEvent 不會真的捲動，所以要原生事件。編譯：swiftc -O -o wk-wheel wk-wheel.swift（wheel_check.py 會自動編）
import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 9 else {
  FileHandle.standardError.write("usage: wk-wheel <url> <w> <h> <locate.js> <probe.js> <dy> <count> <legacy|trackpad|trackpad-nomb> [delay|ready]\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(string: args[1])!
let width = Double(args[2])!, height = Double(args[3])!
let locatePath = args[4], probePath = args[5]
let dy = Int32(args[6])!, count = Int(args[7])!
let mode = args[8]
let waitMode = args.count > 9 ? args[9] : "1.2"
let gap = Double(ProcessInfo.processInfo.environment["WK_WHEEL_GAP"] ?? "") ?? 0.016
guard ["legacy", "trackpad", "trackpad-nomb"].contains(mode) else {
  FileHandle.standardError.write("wk-wheel: unknown mode \(mode)\n".data(using: .utf8)!)
  exit(2)
}
let trackpad = mode != "legacy"

func fail(_ msg: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write("wk-wheel: \(msg)\n".data(using: .utf8)!)
  exit(code)
}
func read(_ p: String) -> String {
  guard let s = try? String(contentsOfFile: p, encoding: .utf8) else { fail("cannot read \(p)") }
  return s
}

final class Driver: NSObject, WKNavigationDelegate {
  let webView: WKWebView
  init(_ w: WKWebView) { webView = w }
  var started = false

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // dev server 下 didFinish 可能觸發兩次；只跑一輪
    guard !started else { return }
    started = true
    if waitMode == "ready" { pollReady(deadline: Date().addingTimeInterval(20)) }
    else { DispatchQueue.main.asyncAfter(deadline: .now() + (Double(waitMode) ?? 1.2)) { self.locate() } }
  }

  func pollReady(deadline: Date) {
    webView.evaluateJavaScript("document.documentElement.dataset.ready || ''") { result, _ in
      let state = (result as? String) ?? ""
      // 就緒後再等一下：版面與捲動層要先交給 UI 端，太早送事件會打在還沒建好的捲動樹上
      if state == "1" { return DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.locate() } }
      if state == "error" || Date() > deadline { fail("page not ready (state=\(state.isEmpty ? "timeout" : state))") }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.pollReady(deadline: deadline) }
    }
  }

  func locate() {
    webView.evaluateJavaScript(read(locatePath)) { result, error in
      guard let s = result as? String else { fail("locate failed: \(String(describing: error))") }
      if s == "absent" { fail("locate: the scroller is not on the page", code: 4) }
      if s == "none" { fail("locate found nothing to measure", code: 3) }
      let parts = s.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
      guard parts.count == 2 else { fail("locate returned \(s)") }
      print("target \(Int(parts[0])),\(Int(parts[1]))")
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { self.send(x: parts[0], y: parts[1], i: trackpad && mode == "trackpad" ? -1 : 0) }
    }
  }

  // WebKit 把 locationInWindow 當視窗座標（convertPoint:fromView:nil）；事件不掛視窗時 locationInWindow = 螢幕座標，
  // 所以讓「螢幕座標」等於目標點的視窗座標（左下原點）(x, h − y)；CG 全域座標是左上原點，以主螢幕高度翻轉
  func event(x: Double, y: Double, delta: Int32, phase: Int64?) -> NSEvent {
    guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: trackpad ? .pixel : .line, wheelCount: 1,
                           wheel1: delta, wheel2: 0, wheel3: 0) else { fail("CGEvent") }
    cg.location = CGPoint(x: x, y: NSScreen.screens.first!.frame.height - (height - y))
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: trackpad ? 1 : 0)
    if let p = phase { cg.setIntegerValueField(CGEventField(rawValue: 99)!, value: p) } // kCGScrollWheelEventScrollPhase
    guard let ev = NSEvent(cgEvent: cg) else { fail("NSEvent") }
    return ev
  }

  // i = -1：MayBegin（phase 128）；0…count-1：Began（1）/ Changed（2）；之後 Ended（4）
  func send(x: Double, y: Double, i: Int) {
    if i < 0 {
      webView.scrollWheel(with: event(x: x, y: y, delta: 0, phase: 128))
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { self.send(x: x, y: y, i: 0) }
      return
    }
    if i < count {
      // CG 的 wheel1 正值 = 往上：往下捲給負值。legacy 一次 1 行
      let d: Int32 = trackpad ? -dy : (dy > 0 ? -1 : 1)
      webView.scrollWheel(with: event(x: x, y: y, delta: d, phase: trackpad ? (i == 0 ? 1 : 2) : nil))
      DispatchQueue.main.asyncAfter(deadline: .now() + gap) { self.send(x: x, y: y, i: i + 1) }
      return
    }
    if trackpad { webView.scrollWheel(with: event(x: x, y: y, delta: 0, phase: 4)) }
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { self.probe() }
  }

  func probe() {
    webView.evaluateJavaScript(read(probePath)) { result, error in
      if let s = result as? String { print(s) } else { fail("probe failed: \(String(describing: error))") }
      exit(0)
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
if ProcessInfo.processInfo.environment["WK_WHEEL_LOG"] == "1" {
  let src = """
  window.__wheel = [];
  addEventListener('wheel', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[class]') : null;
    window.__wheel.push({ x: Math.round(e.clientX), y: Math.round(e.clientY), dy: e.deltaY, mode: e.deltaMode,
      on: t ? String(t.className).slice(0, 40) : String(e.target && e.target.nodeName) });
  }, { capture: true, passive: true });
  """
  config.userContentController.addUserScript(WKUserScript(source: src, injectionTime: .atDocumentStart, forMainFrameOnly: true))
}
// 放進畫面外的 borderless 視窗，避免 WebKit 對無視窗 view 節流繪製（同 wk-shot）
let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: width, height: height),
                      styleMask: [.borderless], backing: .buffered, defer: false)
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
window.contentView = webView
window.orderBack(nil)
let driver = Driver(webView)
webView.navigationDelegate = driver
if url.isFileURL { webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent()) }
else { webView.load(URLRequest(url: url)) }
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { fail("global timeout") }
app.run()
