/**
 * The pages the window shows while it has no server to show.
 *
 * They are inline documents, not resources: the app must be able to explain
 * itself before any host exists (and when one fails to start), so nothing here
 * may depend on the network or on a bundle file. The palette mirrors the DSH
 * web UI's own dark tokens, so the step into the real page is not a jump.
 */
#import "DSHWeb.h"

NSString *const DSHInternalScheme = @"dshweb";

/** Escape text for insertion into HTML. */
static NSString *DSHEscape(NSString *text) {
    NSMutableString *escaped = [text mutableCopy];
    [escaped replaceOccurrencesOfString:@"&" withString:@"&amp;" options:0 range:NSMakeRange(0, escaped.length)];
    [escaped replaceOccurrencesOfString:@"<" withString:@"&lt;" options:0 range:NSMakeRange(0, escaped.length)];
    [escaped replaceOccurrencesOfString:@">" withString:@"&gt;" options:0 range:NSMakeRange(0, escaped.length)];
    return escaped;
}

/** Shared document chrome. */
static NSString *DSHPage(NSString *title, NSString *body) {
    return [NSString stringWithFormat:
    @"<!doctype html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"utf-8\" />\n<title>%@</title>\n<style>\n"
     "  :root { color-scheme: dark; }\n"
     "  * { box-sizing: border-box; }\n"
     "  body { margin: 0; height: 100vh; display: grid; place-items: center; background: #12141b; color: #f9fafb;\n"
     "         font: 14px/1.6 -apple-system, BlinkMacSystemFont, \"PingFang SC\", \"Helvetica Neue\", sans-serif;\n"
     "         -webkit-user-select: none; user-select: none; }\n"
     "  .card { width: min(560px, 84vw); padding: 28px 32px; border-radius: 14px; background: #1a1d26;\n"
     "          border: 1px solid #2a2e3a; box-shadow: 0 18px 48px rgba(0,0,0,.45); }\n"
     "  h1 { margin: 0 0 6px; font-size: 17px; font-weight: 600; letter-spacing: .01em; }\n"
     "  p { margin: 0; color: #a7adbb; }\n"
     "  .row { display: flex; align-items: center; gap: 12px; }\n"
     "  .spinner { width: 18px; height: 18px; flex: none; border-radius: 50%%;\n"
     "             border: 2px solid rgba(255,255,255,.18); border-top-color: #4176e2; animation: spin .8s linear infinite; }\n"
     "  @keyframes spin { to { transform: rotate(360deg); } }\n"
     "  pre { margin: 14px 0 0; padding: 12px 14px; max-height: 240px; overflow: auto; border-radius: 10px;\n"
     "        background: #0e1016; border: 1px solid #242833; color: #c9cfdb;\n"
     "        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;\n"
     "        white-space: pre-wrap; word-break: break-word; -webkit-user-select: text; user-select: text; }\n"
     "  button { margin-top: 16px; padding: 8px 16px; border: 0; border-radius: 9px; background: #4176e2;\n"
     "           color: #fff; font: inherit; font-weight: 600; cursor: pointer; }\n"
     "  button:hover { background: #3064d6; }\n"
     "  .hint { margin-top: 14px; font-size: 12px; color: #7b8290; }\n"
     "  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #c9cfdb; }\n"
     "</style>\n</head>\n<body>%@</body>\n</html>\n", title, body];
}

NSString *DSHLoadingPage(NSString *message) {
    NSString *body = [NSString stringWithFormat:
    @"<div class=\"card\">\n"
     "  <div class=\"row\">\n"
     "    <div class=\"spinner\"></div>\n"
     "    <div>\n"
     "      <h1>正在连接 DeepSeek Harness</h1>\n"
     "      <p id=\"status\">%@</p>\n"
     "    </div>\n"
     "  </div>\n"
     "  <div class=\"hint\">已经在运行的宿主会被直接使用；没有则自动启动一个。</div>\n"
     "</div>\n"
     "<script>\n"
     "  window.dshStatus = function (text) {\n"
     "    var node = document.getElementById('status');\n"
     "    if (node) { node.textContent = text; }\n"
     "  };\n"
     "</script>\n", DSHEscape(message)];
    return DSHPage(@"DSH Web", body);
}

NSString *DSHErrorPage(NSString *message, NSString *logPath) {
    NSString *body = [NSString stringWithFormat:
    @"<div class=\"card\">\n"
     "  <h1>无法连接 DeepSeek Harness 宿主</h1>\n"
     "  <pre>%@</pre>\n"
     "  <button onclick=\"location.href='%@://retry'\">重试</button>\n"
     "  <div class=\"hint\">完整日志：<code>%@</code><br />"
     "也可以在终端里手动运行 <code>dsh web</code>，再回来点“重试”。</div>\n"
     "</div>\n", DSHEscape(message), DSHInternalScheme, DSHEscape(logPath)];
    return DSHPage(@"DSH Web — 启动失败", body);
}
