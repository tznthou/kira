// 用系統 WKWebView（Tauri 在 macOS 的同一顆引擎）渲染頁面：截圖 + 執行量測 JS。
// 用法: wk-shot <url> <width> <height> <out.png|-> [js-file|-] [delay-sec|ready]
//   out.png 為 "-" 時不截圖；js-file 的回傳值（字串）印到 stdout。
//   最後一個參數給 "ready"：輪詢 html[data-ready]，"1" 才繼續、"error" 即失敗（取代固定秒數）。
// 截圖前注入 CSS 關掉 animation/transition（取終態）；輸出尺寸必須是 viewport × 2，否則失敗。
// WebView 用不保存的資料儲存區，每次執行互不影響。
import Cocoa
import WebKit

let args = CommandLine.arguments
guard args.count >= 5 else {
  FileHandle.standardError.write("usage: wk-shot <url> <w> <h> <out.png|-> [js-file|-] [delay|ready]\n".data(using: .utf8)!)
  exit(2)
}
let url = URL(string: args[1])!
let width = Double(args[2])!, height = Double(args[3])!
let outPath = args[4]
let jsPath = args.count > 5 ? args[5] : "-"
let waitMode = args.count > 6 ? args[6] : "1.2"
let scale = 2.0

let freeze = """
(() => { const s = document.createElement('style');
  s.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}';
  document.head.appendChild(s); })();
"""

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write("wk-shot: \(msg)\n".data(using: .utf8)!)
  exit(1)
}

final class Shooter: NSObject, WKNavigationDelegate {
  let webView: WKWebView
  init(_ w: WKWebView) { webView = w }

  var started = false
  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // dev server 下 didFinish 可能觸發兩次；只跑一輪，否則量測與截圖會重複
    guard !started else { return }
    started = true
    if waitMode == "ready" {
      pollReady(deadline: Date().addingTimeInterval(20))
    } else {
      DispatchQueue.main.asyncAfter(deadline: .now() + (Double(waitMode) ?? 1.2)) { self.measure() }
    }
  }

  func pollReady(deadline: Date) {
    webView.evaluateJavaScript("document.documentElement.dataset.ready || ''") { result, _ in
      let state = (result as? String) ?? ""
      if state == "1" { return self.measure() }
      if state == "error" || Date() > deadline {
        self.webView.evaluateJavaScript("JSON.stringify(window.__fidelityLog || [])") { log, _ in
          fail("page not ready (state=\(state.isEmpty ? "timeout" : state)) log=\(log ?? "n/a")")
        }
        return
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self.pollReady(deadline: deadline) }
    }
  }

  func measure() {
    guard jsPath != "-", let js = try? String(contentsOfFile: jsPath, encoding: .utf8) else { return shoot() }
    webView.evaluateJavaScript(js) { result, error in
      if let s = result as? String { print(s) } else if let e = error { print("js error:", e) }
      self.shoot()
    }
  }

  func shoot() {
    guard outPath != "-" else { exit(0) }
    webView.evaluateJavaScript(freeze) { _, _ in
      DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
        let cfg = WKSnapshotConfiguration()
        cfg.rect = NSRect(x: 0, y: 0, width: width, height: height)
        cfg.afterScreenUpdates = true
        self.webView.takeSnapshot(with: cfg) { image, error in
          guard let image = image, let tiff = image.tiffRepresentation,
                let rep = NSBitmapImageRep(data: tiff),
                let png = rep.representation(using: .png, properties: [:]) else {
            fail("snapshot failed: \(String(describing: error))")
          }
          let want = (Int(width * scale), Int(height * scale))
          guard rep.pixelsWide == want.0, rep.pixelsHigh == want.1 else {
            fail("snapshot is \(rep.pixelsWide)x\(rep.pixelsHigh), expected \(want.0)x\(want.1) (@\(Int(scale))x) — is the main display non-Retina?")
          }
          do { try png.write(to: URL(fileURLWithPath: outPath)) } catch { fail("write failed: \(error)") }
          print("saved \(outPath) \(rep.pixelsWide)x\(rep.pixelsHigh)")
          exit(0)
        }
      }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
let config = WKWebViewConfiguration()
config.websiteDataStore = .nonPersistent()
// 放進畫面外的 borderless 視窗，避免 WebKit 對無視窗 view 節流繪製
let window = NSWindow(contentRect: NSRect(x: -20000, y: -20000, width: width, height: height),
                      styleMask: [.borderless], backing: .buffered, defer: false)
let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: width, height: height), configuration: config)
window.contentView = webView
window.orderBack(nil)
let shooter = Shooter(webView)
webView.navigationDelegate = shooter
if url.isFileURL {
  webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
} else {
  webView.load(URLRequest(url: url))
}
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { fail("global timeout") }
app.run()
