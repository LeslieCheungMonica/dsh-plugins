/**
 * DSH Web — shared declarations.
 *
 * The whole app is four small Objective-C objects: a logger, the host
 * resolver, the app-owned HTML pages, and the AppKit delegate that owns the
 * window. Objective-C rather than Swift is a deliberate, load-bearing choice:
 * this machine's Command Line Tools ship a Swift compiler that refuses the
 * installed SDK's module interfaces ("SDK is not supported by the compiler"),
 * while clang builds AppKit + WebKit code in about a second with no toolchain
 * of its own to install.
 */
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>

NS_ASSUME_NONNULL_BEGIN

#pragma mark - Logging

/** Where the app writes its diagnostics (stderr and ~/Library/Logs/DSHWeb.log). */
FOUNDATION_EXPORT NSString *DSHLogFilePath(void);

/**
 * Append one line to stderr and the log file.
 * @param format - printf-style format.
 */
FOUNDATION_EXPORT void DSHLog(NSString *format, ...) NS_FORMAT_FUNCTION(1, 2);

#pragma mark - Host resolution

/** How the app obtained its server. */
typedef NS_ENUM(NSInteger, DSHResolutionKind) {
    /** The app obtained its server by attaching to one that was already serving. */
    DSHResolutionKindAttached,
    /** The app obtained its server by starting a host process it now owns. */
    DSHResolutionKindStarted,
    /** Resolution failed; `message` explains why in operator-facing terms. */
    DSHResolutionKindFailed,
};

/** Outcome of one resolution attempt. */
@interface DSHResolution : NSObject
/** Which of the three outcomes this is. */
@property (nonatomic, readonly) DSHResolutionKind kind;
/** Resolved port; 0 when resolution failed. */
@property (nonatomic, readonly) NSInteger port;
/** Failure text, empty otherwise. */
@property (nonatomic, readonly, copy) NSString *message;

/**
 * Build an outcome.
 * @param kind - the outcome kind.
 * @param port - the resolved port (0 for a failure).
 * @param message - failure text.
 * @returns the outcome.
 */
+ (instancetype)kind:(DSHResolutionKind)kind port:(NSInteger)port message:(NSString *)message;
@end

/**
 * Finds the `dsh web` host the window shows: an already-serving one when
 * possible, otherwise a process this object starts and later stops.
 *
 * Attaching before starting is a hard constraint: two hosts sharing one
 * `$DSH_HOME` write the same storage files without locking, so a second host
 * beside an existing one can clobber its state.
 */
@interface DSHServer : NSObject

/**
 * The checkout the operator pointed at, whose `apps/cli/lib/bin.js` is the
 * last-resort CLI. There is no built-in default: guessing a path that only
 * exists on the machine this app was built on would send every other operator
 * to a directory they never created.
 * @returns the expanded `$DSH_CHECKOUT`, or nil when it is unset or empty.
 */
+ (nullable NSString *)configuredCheckoutPath;

/**
 * The text shown when no `dsh` command could be found.
 *
 * A separate function because it is the whole first-run experience for an
 * operator who has not installed DSH yet: it has to name the places that were
 * actually searched, and nothing else.
 *
 * @param checkout - the configured checkout, or nil; named only when it exists.
 * @returns operator-facing failure text.
 */
+ (NSString *)missingCLIMessageWithCheckout:(nullable NSString *)checkout;

/** Port this instance resolved to, or 0 before resolution. */
@property (nonatomic, readonly) NSInteger port;

/** Whether this instance started a host (and must therefore stop it on quit). */
@property (nonatomic, readonly) BOOL startedHost;

/**
 * Resolve a host synchronously. Call off the main thread: it probes ports and
 * may wait minutes for a fresh host to serve.
 * @param progress - receives operator-facing status lines.
 * @returns the outcome.
 */
- (DSHResolution *)resolveWithProgress:(void (^_Nullable)(NSString *status))progress;

/** Stop the host if this app started it; a host we merely attached to is left running. */
- (void)stopStartedHost;

/**
 * The index URL for a port.
 * @param port - the resolved port.
 * @returns its URL string.
 */
- (NSString *)urlStringForPort:(NSInteger)port;

/**
 * Whether a DSH server is serving on a loopback port.
 * @param port - port to probe.
 * @returns YES when the index answers with the DSH boot document.
 */
- (BOOL)isServingPort:(NSInteger)port;

/**
 * First candidate port nothing is listening on.
 * @returns the port, or -1 when every candidate is taken.
 */
- (NSInteger)firstFreePort;

/**
 * The `dsh` command this app would run, as an operator-facing string.
 * @returns the display path, or nil when nothing was discovered.
 */
- (nullable NSString *)discoveredCLIDisplay;

/**
 * Every *usable* `dsh` command for one home directory, in priority order.
 *
 * Each returned path exists and is executable; discovery is the first element.
 * Split out from discovery so the search order is testable against a synthetic
 * home instead of the operator's real one: a `dsh` installed through a node
 * version manager (nvm, fnm, volta) or pnpm lives somewhere neither the fixed
 * shim list nor a Finder-launched app's minimal `PATH` can reach.
 *
 * @param home - the user's home directory to resolve `~`-relative candidates against.
 * @param nodePath - the node binary the app would use, or nil; a `dsh` installed
 *   by that node's own `npm -g` sits beside it.
 * @param explicitPath - `$DSH_BIN`, or nil.
 * @param onPath - `dsh` as found on `PATH`, or nil.
 * @returns absolute executable paths, highest priority first.
 */
+ (NSArray<NSString *> *)cliCandidatesWithHome:(NSString *)home
                                      nodePath:(nullable NSString *)nodePath
                                  explicitPath:(nullable NSString *)explicitPath
                                        onPath:(nullable NSString *)onPath;

@end

#pragma mark - App-owned pages

/**
 * The startup document, whose status line updates in place.
 * @param message - first status line.
 * @returns an HTML document.
 */
FOUNDATION_EXPORT NSString *DSHLoadingPage(NSString *message);

/**
 * The failure document: what went wrong, the host's own last words, and a retry.
 * @param message - failure text (may quote host output).
 * @param logPath - log file to point the operator at.
 * @returns an HTML document.
 */
FOUNDATION_EXPORT NSString *DSHErrorPage(NSString *message, NSString *logPath);

/** URL scheme app-internal controls (Retry) navigate to. */
FOUNDATION_EXPORT NSString *const DSHInternalScheme;

NS_ASSUME_NONNULL_END
