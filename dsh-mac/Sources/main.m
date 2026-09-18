/**
 * The window: a single WKWebView showing the DSH web UI served by the host this
 * app attached to or started.
 *
 * Deliberate choices:
 *
 * - **One window, one web view.** The page is an application, not a document
 *   browser: no tabs, no address bar, no history.
 * - **The default website data store.** The UI keeps durable browser state
 *   (selected session, panel widths, preferences the browser owns), so an
 *   ephemeral store would reset it on every launch.
 * - **A real Edit menu.** The composer is a text field: without the standard
 *   Cut/Copy/Paste/Select All responder-chain actions, Cmd+V would do nothing.
 * - **`dshweb://` for app-internal actions.** The loading and error pages are
 *   documents, so their Retry control has to be a link; the navigation delegate
 *   intercepts that scheme before it becomes a request.
 */
#import "DSHWeb.h"

/** The application delegate: owns the window, the web view, and the host. */
@interface DSHAppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate>
@end

@implementation DSHAppDelegate {
    NSWindow *_window;
    WKWebView *_webView;
    DSHServer *_server;
    dispatch_queue_t _resolutionQueue;
    NSTimer *_appearanceTimer;
    BOOL _pageLoaded;
}

- (instancetype)init {
    if ((self = [super init])) {
        _server = [[DSHServer alloc] init];
        _resolutionQueue = dispatch_queue_create("local.dsh.web.resolve", DISPATCH_QUEUE_SERIAL);
    }
    return self;
}

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    [self buildMenu];
    [self buildWindow];
    DSHLog(@"app launched (bundle: %@)", [NSBundle mainBundle].bundlePath);
    [self resolve];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }

- (void)applicationWillTerminate:(NSNotification *)notification {
    [_server stopStartedHost];
    DSHLog(@"app terminated");
}

#pragma mark - Window

- (void)buildWindow {
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore defaultDataStore];

    _webView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 1320, 860) configuration:configuration];
    _webView.navigationDelegate = self;
    _webView.UIDelegate = self;
    if (@available(macOS 13.0, *)) {
        _webView.underPageBackgroundColor = [NSColor colorWithSRGBRed:0.07 green:0.08 blue:0.11 alpha:1.0];
    }

    // A standard opaque title bar on purpose: with a full-size content view the
    // traffic lights sit on top of the page's own top-left corner, which is the
    // sidebar's brand row — the UI would start under the window buttons.
    _window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1320, 860)
                                          styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable
                                                     | NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                                            backing:NSBackingStoreBuffered
                                              defer:NO];
    _window.title = @"DSH Web";
    _window.minSize = NSMakeSize(720, 480);
    _window.contentView = _webView;
    // Remembers position and size across launches without a preferences file.
    _window.frameAutosaveName = @"DSHWebMainWindow";
    [_window center];
    [_window makeKeyAndOrderFront:nil];
    [NSApp activateIgnoringOtherApps:YES];

    // The page owns light/dark; keep the window chrome in step with it.
    _appearanceTimer = [NSTimer scheduledTimerWithTimeInterval:2.0
                                                       target:self
                                                     selector:@selector(syncChromeAppearance:)
                                                     userInfo:nil
                                                      repeats:YES];

    [self showHTML:DSHLoadingPage(@"正在准备…")];
}

/**
 * Read the page's theme and match the window chrome to it, so a dark UI never
 * sits under a light title bar (the OS appearance and the DSH theme are
 * independent settings).
 * @param timer - the repeating timer.
 */
- (void)syncChromeAppearance:(NSTimer *)timer {
    if (!_pageLoaded) { return; }
    [_webView evaluateJavaScript:@"document.body ? (document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light') : ''"
               completionHandler:^(id result, NSError *error) {
        if (![result isKindOfClass:[NSString class]]) { return; }
        BOOL dark = [(NSString *)result isEqualToString:@"dark"];
        if ([(NSString *)result length] == 0) { return; }
        NSString *name = dark ? NSAppearanceNameDarkAqua : NSAppearanceNameAqua;
        dispatch_async(dispatch_get_main_queue(), ^{
            if ([self->_window.effectiveAppearance.name isEqualToString:name]) { return; }
            self->_window.appearance = [NSAppearance appearanceNamed:name];
        });
    }];
}

- (void)buildMenu {
    NSMenu *main = [[NSMenu alloc] init];

    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    NSMenu *appMenu = [[NSMenu alloc] init];
    [appMenu addItemWithTitle:@"关于 DSH Web" action:@selector(showAbout:) keyEquivalent:@""].target = self;
    [appMenu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *browser = [[NSMenuItem alloc] initWithTitle:@"在浏览器中打开" action:@selector(openInBrowser:) keyEquivalent:@"o"];
    browser.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    browser.target = self;
    [appMenu addItem:browser];
    NSMenuItem *copyURL = [[NSMenuItem alloc] initWithTitle:@"复制页面地址" action:@selector(copyPageURL:) keyEquivalent:@"l"];
    copyURL.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagShift;
    copyURL.target = self;
    [appMenu addItem:copyURL];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"隐藏 DSH Web" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"退出 DSH Web" action:@selector(terminate:) keyEquivalent:@"q"];
    appItem.submenu = appMenu;
    [main addItem:appItem];

    // Edit: the composer needs these responder-chain actions verbatim.
    NSMenuItem *editItem = [[NSMenuItem alloc] init];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"编辑"];
    NSArray<NSArray<NSString *> *> *editRows = @[
        @[@"撤销", @"undo:", @"z"], @[@"重做", @"redo:", @"Z"],
        @[@"剪切", @"cut:", @"x"], @[@"拷贝", @"copy:", @"c"],
        @[@"粘贴", @"paste:", @"v"], @[@"全选", @"selectAll:", @"a"],
    ];
    for (NSArray<NSString *> *row in editRows) {
        [editMenu addItemWithTitle:row[0] action:NSSelectorFromString(row[1]) keyEquivalent:row[2]];
    }
    editItem.submenu = editMenu;
    [main addItem:editItem];

    NSMenuItem *viewItem = [[NSMenuItem alloc] init];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"显示"];
    NSMenuItem *reload = [[NSMenuItem alloc] initWithTitle:@"重新载入页面" action:@selector(reloadPage:) keyEquivalent:@"r"];
    reload.target = self;
    [viewMenu addItem:reload];
    [viewMenu addItem:[NSMenuItem separatorItem]];
    [viewMenu addItemWithTitle:@"实际大小" action:@selector(actualSize:) keyEquivalent:@"0"];
    [viewMenu addItemWithTitle:@"放大" action:@selector(zoomIn:) keyEquivalent:@"+"];
    [viewMenu addItemWithTitle:@"缩小" action:@selector(zoomOut:) keyEquivalent:@"-"];
    [viewMenu addItem:[NSMenuItem separatorItem]];
    NSMenuItem *full = [[NSMenuItem alloc] initWithTitle:@"进入全屏幕" action:@selector(toggleFullScreen:) keyEquivalent:@"f"];
    full.keyEquivalentModifierMask = NSEventModifierFlagCommand | NSEventModifierFlagControl;
    [viewMenu addItem:full];
    viewItem.submenu = viewMenu;
    [main addItem:viewItem];

    NSMenuItem *windowItem = [[NSMenuItem alloc] init];
    NSMenu *windowMenu = [[NSMenu alloc] initWithTitle:@"窗口"];
    [windowMenu addItemWithTitle:@"最小化" action:@selector(performMiniaturize:) keyEquivalent:@"m"];
    [windowMenu addItemWithTitle:@"缩放" action:@selector(performZoom:) keyEquivalent:@""];
    [windowMenu addItem:[NSMenuItem separatorItem]];
    [windowMenu addItemWithTitle:@"前置全部窗口" action:@selector(arrangeInFront:) keyEquivalent:@""];
    windowItem.submenu = windowMenu;
    [main addItem:windowItem];
    NSApp.windowsMenu = windowMenu;

    NSApp.mainMenu = main;
}

#pragma mark - Server resolution

- (void)resolve {
    _pageLoaded = NO;
    [self showHTML:DSHLoadingPage(@"正在准备…")];
    dispatch_async(_resolutionQueue, ^{
        DSHServer *server = self->_server;
        DSHResolution *outcome = [server resolveWithProgress:^(NSString *status) {
            [self setStatus:status];
        }];
        dispatch_async(dispatch_get_main_queue(), ^{
            switch (outcome.kind) {
                case DSHResolutionKindAttached:
                    DSHLog(@"showing attached host on port %ld", (long)outcome.port);
                    [self loadPort:outcome.port];
                    break;
                case DSHResolutionKindStarted:
                    DSHLog(@"showing started host on port %ld", (long)outcome.port);
                    [self loadPort:outcome.port];
                    break;
                case DSHResolutionKindFailed:
                    DSHLog(@"resolution failed: %@", outcome.message);
                    [self showHTML:DSHErrorPage(outcome.message, DSHLogFilePath())];
                    break;
            }
        });
    });
}

- (void)loadPort:(NSInteger)port {
    NSURL *url = [NSURL URLWithString:[_server urlStringForPort:port]];
    [_webView loadRequest:[NSURLRequest requestWithURL:url]];
}

- (void)setStatus:(NSString *)text {
    dispatch_async(dispatch_get_main_queue(), ^{
        if (self->_pageLoaded) { return; }
        NSString *quoted = [[text stringByReplacingOccurrencesOfString:@"\\" withString:@"\\\\"]
                            stringByReplacingOccurrencesOfString:@"'" withString:@"\\'"];
        quoted = [quoted stringByReplacingOccurrencesOfString:@"\n" withString:@" "];
        [self->_webView evaluateJavaScript:[NSString stringWithFormat:
            @"window.dshStatus && window.dshStatus('%@')", quoted] completionHandler:nil];
    });
}

- (void)showHTML:(NSString *)html {
    NSURL *base = [NSURL URLWithString:[NSString stringWithFormat:@"%@://page", DSHInternalScheme]];
    [_webView loadHTMLString:html baseURL:base];
}

#pragma mark - Actions

- (void)reloadPage:(id)sender {
    if (_pageLoaded) { [_webView reload]; } else { [self resolve]; }
}

- (void)openInBrowser:(id)sender {
    if (_pageLoaded && _webView.URL != nil) { [[NSWorkspace sharedWorkspace] openURL:_webView.URL]; }
}

- (void)copyPageURL:(id)sender {
    if (!_pageLoaded || _webView.URL == nil) { return; }
    NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
    [pasteboard clearContents];
    [pasteboard setString:_webView.URL.absoluteString forType:NSPasteboardTypeString];
}

- (void)showAbout:(id)sender {
    NSString *version = [[NSBundle mainBundle] objectForInfoDictionaryKey:@"CFBundleShortVersionString"] ?: @"0.1.0";
    [NSApp orderFrontStandardAboutPanelWithOptions:@{
        NSAboutPanelOptionApplicationName: @"DSH Web",
        NSAboutPanelOptionApplicationVersion: version,
        NSAboutPanelOptionCredits: [[NSAttributedString alloc] initWithString:@"DeepSeek Harness 浏览器 UI 的原生窗口。"],
    }];
}

#pragma mark - WKNavigationDelegate

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    NSURL *url = navigationAction.request.URL;
    if ([url.scheme isEqualToString:DSHInternalScheme]) {
        if ([url.host isEqualToString:@"retry"]) { [self resolve]; }
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    // Only the host's HTTP document is the real UI; app pages are not.
    if ([webView.URL.scheme isEqualToString:@"http"] && !_pageLoaded) {
        _pageLoaded = YES;
        _window.title = @"DSH Web";
        DSHLog(@"page loaded: %@", webView.URL.absoluteString);
        // Let the client plugin tree mount, then record what the window is
        // actually rendering. This is the app's own answer to "did the native
        // shell really show the UI", and the first thing to read when a report
        // says the window is blank.
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(4.0 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [self reportPageHealth];
        });
    }
}

/** Log the rendered page's own account of itself. */
- (void)reportPageHealth {
    NSString *script =
        @"JSON.stringify({"
         "title: document.title,"
         "bootGraph: typeof window.__DSH_BOOT__ === 'object',"
         "routedToHost: location.port,"
         "sidebarColumn: !!document.querySelector('[data-wui=\"column\"]'),"
         "projectRow: !!document.querySelector('[data-wui=\"projectRow\"]'),"
         "newSession: !!document.querySelector('[data-wui=\"newSession\"]'),"
         "browserSeat: (document.querySelector('[data-slot=\"sidebar.workspaces\"]') || {}).childElementCount || 0,"
         "settingsSeat: (document.querySelector('[data-slot=\"sidebar.settings\"]') || {}).childElementCount || 0,"
         "slotErrors: document.querySelectorAll('[data-slot-error]').length,"
         "conversation: !!document.querySelector('[data-conversation-scroll]')"
         "})";
    [_webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        if (error != nil) {
            DSHLog(@"page health: unavailable (%@)", error.localizedDescription);
            return;
        }
        DSHLog(@"page health: %@", result);
    }];
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self handleLoadFailure:error];
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    [self handleLoadFailure:error];
}

/**
 * A cancelled navigation is our own `dshweb://` interception; anything else
 * after the page was up means the host went away.
 * @param error - the navigation error.
 */
- (void)handleLoadFailure:(NSError *)error {
    if ([error.domain isEqualToString:NSURLErrorDomain] && error.code == NSURLErrorCancelled) { return; }
    if (!_pageLoaded) { return; }
    _pageLoaded = NO;
    DSHLog(@"page load failed: %@", error.localizedDescription);
    [self showHTML:DSHErrorPage([NSString stringWithFormat:@"页面加载失败：%@", error.localizedDescription],
                                DSHLogFilePath())];
}

#pragma mark - WKUIDelegate

- (WKWebView *)webView:(WKWebView *)webView
    createWebViewWithConfiguration:(WKWebViewConfiguration *)configuration
               forNavigationAction:(WKNavigationAction *)navigationAction
                    windowFeatures:(WKWindowFeatures *)windowFeatures {
    // The UI has no secondary windows; keep target=_blank links in place.
    if (navigationAction.targetFrame == nil && navigationAction.request.URL != nil) {
        [webView loadRequest:navigationAction.request];
    }
    return nil;
}

@end

#pragma mark - Entry point

/** Create an executable stub at `path`, making its parents as needed. */
static BOOL DSHWriteStub(NSString *path) {
    NSFileManager *manager = [NSFileManager defaultManager];
    [manager createDirectoryAtPath:[path stringByDeletingLastPathComponent]
       withIntermediateDirectories:YES attributes:nil error:NULL];
    if (![manager createFileAtPath:path contents:[@"#!/bin/sh\n" dataUsingEncoding:NSUTF8StringEncoding]
                        attributes:nil]) { return NO; }
    return [manager setAttributes:@{NSFilePosixPermissions: @(0755)} ofItemAtPath:path error:NULL];
}

/**
 * CLI discovery against a synthetic home: a `dsh` installed through nvm, fnm or
 * pnpm must be found, because a Finder-launched app's minimal `PATH` cannot
 * reach any of them.
 *
 * Hermetic on purpose — it builds its own tree under `/tmp` and never consults
 * the operator's real home, so it passes on a machine with no DSH at all.
 * @returns the number of failed checks.
 */
static int DSHRunDiscoveryChecks(void) {
    NSFileManager *manager = [NSFileManager defaultManager];
    // A fixed root, not a pid-derived one: a run that dies mid-check leaves its
    // tree behind, and the next run should sweep it rather than accumulate.
    NSString *root = @"/tmp/dsh-discovery-selftest";
    [manager removeItemAtPath:root error:NULL];

    NSString *home = [root stringByAppendingPathComponent:@"home"];
    NSString *nvmOld = [home stringByAppendingPathComponent:@".nvm/versions/node/v18.20.8/bin"];
    NSString *nvmNew = [home stringByAppendingPathComponent:@".nvm/versions/node/v22.22.2/bin"];
    NSString *pnpm = [home stringByAppendingPathComponent:@"Library/pnpm"];
    NSString *volta = [home stringByAppendingPathComponent:@".volta/bin"];
    // fnm keeps its installs outside the home entirely; only the node path
    // knows where it lives, which is why the node-adjacent rule matters.
    NSString *fnm = [root stringByAppendingPathComponent:@"fnm/node-versions/v20.11.0/installation/bin"];

    NSArray<NSString *> *stubs = @[
        [nvmOld stringByAppendingPathComponent:@"dsh"], [nvmOld stringByAppendingPathComponent:@"node"],
        [nvmNew stringByAppendingPathComponent:@"dsh"], [nvmNew stringByAppendingPathComponent:@"node"],
        [pnpm stringByAppendingPathComponent:@"dsh"],
        [volta stringByAppendingPathComponent:@"dsh"],
        [fnm stringByAppendingPathComponent:@"dsh"], [fnm stringByAppendingPathComponent:@"node"],
    ];
    for (NSString *stub in stubs) {
        if (!DSHWriteStub(stub)) { printf("discovery: setup failed for %s\n", stub.UTF8String); return 1; }
    }

    NSString *fnmNode = [fnm stringByAppendingPathComponent:@"node"];
    NSString *fnmDsh = [fnm stringByAppendingPathComponent:@"dsh"];
    NSString *explicit = [root stringByAppendingPathComponent:@"explicit/dsh"];
    DSHWriteStub(explicit);

    NSArray<NSString *> *found = [DSHServer cliCandidatesWithHome:home
                                                        nodePath:fnmNode
                                                    explicitPath:nil
                                                          onPath:nil];
    __block int failures = 0;
    void (^expect)(BOOL, NSString *) = ^(BOOL ok, NSString *what) {
        if (!ok) { printf("discovery: FAIL %s\n", what.UTF8String); failures++; }
        else { printf("discovery: ok   %s\n", what.UTF8String); }
    };

    NSString *nvmNewDsh = [nvmNew stringByAppendingPathComponent:@"dsh"];
    NSString *nvmOldDsh = [nvmOld stringByAppendingPathComponent:@"dsh"];
    expect([found containsObject:nvmNewDsh], @"nvm install is found");
    expect([found containsObject:nvmOldDsh], @"every nvm version is found");
    expect([found indexOfObject:nvmNewDsh] < [found indexOfObject:nvmOldDsh],
           @"highest nvm version wins");
    expect([found containsObject:[pnpm stringByAppendingPathComponent:@"dsh"]], @"pnpm global is found");
    expect([found containsObject:[volta stringByAppendingPathComponent:@"dsh"]], @"volta global is found");
    expect([found containsObject:fnmDsh], @"a dsh beside the node we would use is found");

    // Order: an explicit $DSH_BIN still beats everything, and the machine's
    // real home never leaks into a synthetic one.
    NSArray<NSString *> *withExplicit = [DSHServer cliCandidatesWithHome:home
                                                               nodePath:fnmNode
                                                           explicitPath:explicit
                                                                 onPath:nil];
    expect(withExplicit.count > 0 && [withExplicit.firstObject isEqualToString:explicit],
           @"$DSH_BIN outranks every discovered path");
    for (NSString *candidate in found) {
        expect(![candidate hasPrefix:NSHomeDirectory()],
               [NSString stringWithFormat:@"candidate stays inside the synthetic home: %@", candidate]);
    }

    // A home with no DSH anywhere yields nothing, rather than the operator's own.
    NSArray<NSString *> *empty = [DSHServer cliCandidatesWithHome:[root stringByAppendingPathComponent:@"empty-home"]
                                                        nodePath:nil explicitPath:nil onPath:nil];
    expect(empty.count == 0, @"an empty home yields no candidates");

    [manager removeItemAtPath:root error:NULL];
    return failures;
}

/**
 * The checkout fallback and the first-run failure text.
 *
 * Hermetic: it drives `$DSH_CHECKOUT` through `setenv`, which is what
 * `NSProcessInfo.environment` actually reads. The environment is restored
 * before returning, so a caller's own `DSH_CHECKOUT` still reaches discovery.
 * @returns the number of failed checks.
 */
static int DSHRunCheckoutChecks(void) {
    __block int failures = 0;
    void (^expect)(BOOL, NSString *) = ^(BOOL ok, NSString *what) {
        if (!ok) { printf("checkout: FAIL %s\n", what.UTF8String); failures++; }
        else { printf("checkout: ok   %s\n", what.UTF8String); }
    };

    NSString *saved = [NSProcessInfo processInfo].environment[@"DSH_CHECKOUT"];

    // The whole point: an app built on one machine must not assume that
    // machine's layout on anybody else's.
    unsetenv("DSH_CHECKOUT");
    NSString *unset = [DSHServer configuredCheckoutPath];
    expect(unset == nil, @"no checkout is assumed when $DSH_CHECKOUT is unset");

    setenv("DSH_CHECKOUT", "", 1);
    expect([DSHServer configuredCheckoutPath] == nil, @"an empty $DSH_CHECKOUT counts as unset");

    setenv("DSH_CHECKOUT", "~/some-checkout", 1);
    expect([[DSHServer configuredCheckoutPath] isEqualToString:
            [@"~/some-checkout" stringByExpandingTildeInPath]],
           @"$DSH_CHECKOUT is expanded against the home directory");

    // First-run text: name what was searched, and only what was configured.
    // Asserting on the home directory rather than on any one builder path keeps
    // this honest without baking that path into the shipped binary.
    NSString *bare = [DSHServer missingCLIMessageWithCheckout:nil];
    expect(![bare containsString:NSHomeDirectory()], @"no machine-specific home path leaks into the failure text");
    expect(![bare containsString:@"apps/cli/lib/bin.js"], @"no checkout entry point leaks either");
    expect([bare containsString:@"DSH_BIN"], @"the failure text still says how to point at a dsh");
    expect([bare containsString:@"@deepseek-ai/dsh"], @"the failure text says how to install dsh");
    expect([bare containsString:@"pnpm"], @"the failure text names the node-manager locations searched");
    NSString *configured = [DSHServer missingCLIMessageWithCheckout:@"/opt/checkout"];
    expect([configured containsString:@"/opt/checkout/apps/cli/lib/bin.js"],
           @"a configured checkout is named in the failure text");

    if (saved != nil) { setenv("DSH_CHECKOUT", saved.UTF8String, 1); } else { unsetenv("DSH_CHECKOUT"); }
    return failures;
}

/**
 * Headless verification of everything except the window: CLI discovery, the
 * attach probe, and — with `DSH_SELFTEST_SPAWN=1` — a real host start and stop.
 * Run it with an isolated `DSH_HOME` when spawning, so a test host never shares
 * storage with the operator's own server.
 * @returns the process exit code.
 */
static int DSHRunSelfTest(void) {
    int failures = DSHRunDiscoveryChecks() + DSHRunCheckoutChecks();
    printf("selftest: local checks %s\n", failures == 0 ? "OK" : "FAIL");
    if (failures != 0) { return 1; }

    DSHServer *server = [[DSHServer alloc] init];
    NSString *checkout = [DSHServer configuredCheckoutPath];
    printf("selftest: checkout=%s\n", checkout != nil ? checkout.UTF8String : "(none configured)");

    NSString *cli = [server discoveredCLIDisplay];
    if (cli == nil) {
        printf("selftest: FAIL no dsh CLI discovered\n");
        // Print what the window would show, so the headless run is a faithful
        // preview of the first-run experience rather than a terse code.
        printf("%s\n", [DSHServer missingCLIMessageWithCheckout:[DSHServer configuredCheckoutPath]].UTF8String);
        return 1;
    }
    printf("selftest: cli=%s\n", cli.UTF8String);

    NSInteger serving = 0;
    for (NSInteger port = 3080; port <= 3090; port++) {
        if ([server isServingPort:port]) { serving = port; break; }
    }
    printf("selftest: attach probe %s\n", serving != 0
        ? [[NSString stringWithFormat:@"found a DSH server on port %ld", (long)serving] UTF8String]
        : "found no DSH server on 3080-3090");
    printf("selftest: first free port=%ld\n", (long)[server firstFreePort]);

    if (![[[NSProcessInfo processInfo] environment][@"DSH_SELFTEST_SPAWN"] isEqualToString:@"1"]) {
        printf("selftest: OK (attach path only; set DSH_SELFTEST_SPAWN=1 to start a host)\n");
        return 0;
    }

    DSHResolution *outcome = [server resolveWithProgress:^(NSString *status) {
        printf("selftest: %s\n", status.UTF8String);
    }];
    switch (outcome.kind) {
        case DSHResolutionKindStarted: {
            BOOL alive = [server isServingPort:outcome.port];
            printf("selftest: started a host on port %ld (serving=%s, DSH_HOME=%s)\n",
                   (long)outcome.port, alive ? "yes" : "no",
                   ([NSProcessInfo processInfo].environment[@"DSH_HOME"] ?: @"(inherited)").UTF8String);
            [server stopStartedHost];
            printf("selftest: %s (spawn path)\n", alive ? "OK" : "FAIL");
            return alive ? 0 : 1;
        }
        case DSHResolutionKindAttached:
            printf("selftest: attached to port %ld (set DSH_WEB_PORT to a free port to exercise the spawn path)\n",
                   (long)outcome.port);
            return 0;
        case DSHResolutionKindFailed:
            printf("selftest: FAIL %s\n", outcome.message.UTF8String);
            return 1;
    }
    return 1;
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        for (int index = 1; index < argc; index++) {
            if (strcmp(argv[index], "--selftest") == 0) {
                return DSHRunSelfTest();
            }
        }
        NSApplication *application = [NSApplication sharedApplication];
        DSHAppDelegate *delegate = [[DSHAppDelegate alloc] init];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        [application run];
    }
    return 0;
}
