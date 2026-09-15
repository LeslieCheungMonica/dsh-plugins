/**
 * Resolving the host the window shows, and owning it when we started it.
 *
 * Resolution order is attach-then-start, and the order is a correctness
 * requirement rather than a preference: DSH stores its workspace and session
 * projections as plain JSON under `$DSH_HOME/storages` with last-writer-wins
 * semantics and no lock, so starting a second host beside a live one risks
 * clobbering the first one's state. The app therefore probes a small band of
 * ports for an existing server, uses it if it answers, and only starts a host
 * when nothing answers at all — then stops exactly that child on quit.
 *
 * The host is a Node program, and a Finder-launched app inherits a minimal PATH
 * (no nvm, no Homebrew), so the child receives an environment whose PATH begins
 * with the directory holding the node binary that belongs to the discovered CLI.
 */
#import "DSHWeb.h"
#import <arpa/inet.h>
#import <netinet/in.h>
#import <signal.h>
#import <sys/socket.h>
#import <unistd.h>

#pragma mark - Resolution result

@implementation DSHResolution

+ (instancetype)kind:(DSHResolutionKind)kind port:(NSInteger)port message:(NSString *)message {
    DSHResolution *resolution = [[DSHResolution alloc] init];
    resolution->_kind = kind;
    resolution->_port = port;
    resolution->_message = [message copy];
    return resolution;
}

@end

#pragma mark - Output tail

/** Bounded tail of a child's output, so a startup failure can quote the host. */
@interface DSHLogTail : NSObject
/** The last few thousand characters the host printed. */
@property (nonatomic, readonly, copy) NSString *text;
/**
 * Append a chunk, keeping only the tail.
 * @param chunk - text read from the child.
 */
- (void)append:(NSString *)chunk;
@end

@implementation DSHLogTail {
    NSMutableString *_buffer;
    NSLock *_lock;
}

- (instancetype)init {
    if ((self = [super init])) {
        _buffer = [NSMutableString string];
        _lock = [[NSLock alloc] init];
    }
    return self;
}

- (NSString *)text {
    [_lock lock];
    NSString *text = [[_buffer copy] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
    [_lock unlock];
    return text;
}

- (void)append:(NSString *)chunk {
    [_lock lock];
    [_buffer appendString:chunk];
    if (_buffer.length > 4000) {
        [_buffer deleteCharactersInRange:NSMakeRange(0, _buffer.length - 4000)];
    }
    [_lock unlock];
}

@end

#pragma mark - Server

@implementation DSHServer {
    NSString *_host;
    NSInteger _preferredPort;
    NSArray<NSNumber *> *_probePorts;
    NSTimeInterval _readinessTimeout;
    NSString *_explicitBinary;
    /** Directory prepended to the child's PATH so it can reach its own node. */
    NSString *_nodeDirectory;

    NSTask *_child;
    NSPipe *_childPipe;
    DSHLogTail *_tail;
}

- (instancetype)init {
    if ((self = [super init])) {
        NSDictionary<NSString *, NSString *> *environment = [NSProcessInfo processInfo].environment;
        _host = environment[@"DSH_WEB_HOST"] ?: @"127.0.0.1";
        NSInteger preferred = environment[@"DSH_WEB_PORT"].integerValue;
        _preferredPort = preferred != 0 ? preferred : 3080;
        double timeout = environment[@"DSH_START_TIMEOUT"].doubleValue;
        _readinessTimeout = timeout > 0 ? timeout : 180.0;
        _explicitBinary = environment[@"DSH_BIN"];
        NSMutableArray<NSNumber *> *ports = [NSMutableArray array];
        for (NSInteger offset = 0; offset <= 10; offset++) {
            [ports addObject:@(_preferredPort + offset)];
        }
        _probePorts = ports;
        _tail = [[DSHLogTail alloc] init];
        // Resolve the node directory once: every candidate CLI may need it, and
        // discovery walks the filesystem.
        _nodeDirectory = [[self findNode] stringByDeletingLastPathComponent];
    }
    return self;
}

- (BOOL)startedHost { return _child != nil; }

- (NSString *)urlStringForPort:(NSInteger)port {
    return [NSString stringWithFormat:@"http://%@:%ld/", _host, (long)port];
}

#pragma mark Resolution

- (DSHResolution *)resolveWithProgress:(void (^)(NSString *))progress {
    void (^report)(NSString *) = ^(NSString *line) {
        if (progress != nil) { progress(line); }
    };

    // 1. Attach to anything already serving.
    for (NSNumber *candidate in _probePorts) {
        report([NSString stringWithFormat:@"正在检查端口 %@ 上的 DSH 服务…", candidate]);
        if ([self isServingPort:candidate.integerValue]) {
            _port = candidate.integerValue;
            DSHLog(@"attached to existing host on port %ld", (long)_port);
            return [DSHResolution kind:DSHResolutionKindAttached port:_port message:@""];
        }
    }

    // 2. Nothing is serving: start one on a free port.
    NSInteger freePort = [self firstFreePort];
    if (freePort < 0) {
        return [DSHResolution kind:DSHResolutionKindFailed port:0 message:
                [NSString stringWithFormat:@"端口 %@–%@ 都被占用，找不到空闲端口。",
                 _probePorts.firstObject, _probePorts.lastObject]];
    }
    NSArray<NSString *> *cli = [self discoveredCLI];
    if (cli == nil) {
        return [DSHResolution kind:DSHResolutionKindFailed port:0 message:
                [NSString stringWithFormat:
                 @"找不到 `dsh` 命令。\n\n已检查：$DSH_BIN、~/.local/bin/dsh、/usr/local/bin/dsh、"
                 @"/opt/homebrew/bin/dsh、你的 PATH，以及检出目录 %@/apps/cli/lib/bin.js。\n\n"
                 @"可以显式指定后再启动：\n  DSH_BIN=/path/to/dsh open -a \"DSH Web\"",
                 [DSHServer defaultCheckoutPath]]];
    }

    report([NSString stringWithFormat:@"正在启动宿主：%@ web --port %ld", cli.firstObject, (long)freePort]);
    DSHLog(@"starting host: %@ web --port %ld --no-open", [cli componentsJoinedByString:@" "], (long)freePort);
    NSTask *process = [self launchCLI:cli port:freePort];
    if (process == nil) {
        return [DSHResolution kind:DSHResolutionKindFailed port:0 message:
                [NSString stringWithFormat:@"宿主进程无法启动（%@）。", cli.firstObject]];
    }
    _port = freePort;

    // Wait for the port to answer; a host that dies early reports immediately.
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:_readinessTimeout];
    while ([deadline timeIntervalSinceNow] > 0) {
        if (!process.isRunning) {
            int status = process.terminationStatus;
            NSString *output = [self outputExcerpt];
            [self teardownChild];
            return [DSHResolution kind:DSHResolutionKindFailed port:0 message:
                    [NSString stringWithFormat:@"宿主在启动过程中退出（状态码 %d）。\n\n%@", status, output]];
        }
        if ([self isServingPort:freePort]) {
            DSHLog(@"host is serving on port %ld", (long)freePort);
            return [DSHResolution kind:DSHResolutionKindStarted port:freePort message:@""];
        }
        report([NSString stringWithFormat:@"等待宿主在端口 %ld 上开始服务…", (long)freePort]);
        [NSThread sleepForTimeInterval:0.4];
    }
    NSString *output = [self outputExcerpt];
    [self teardownChild];
    return [DSHResolution kind:DSHResolutionKindFailed port:0 message:
            [NSString stringWithFormat:@"宿主在 %ld 秒内没有开始服务。\n\n%@", (long)_readinessTimeout, output]];
}

- (void)stopStartedHost {
    NSTask *process = _child;
    if (process == nil) { return; }
    if (process.isRunning) {
        DSHLog(@"stopping host pid %d", process.processIdentifier);
        [process terminate];
        NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:8.0];
        while (process.isRunning && [deadline timeIntervalSinceNow] > 0) {
            [NSThread sleepForTimeInterval:0.2];
        }
        if (process.isRunning) {
            DSHLog(@"host ignored SIGTERM; killing pid %d", process.processIdentifier);
            kill(process.processIdentifier, SIGKILL);
        }
    }
    [self teardownChild];
}

/** Drop the child's bookkeeping (pipe reader, process handle). */
- (void)teardownChild {
    _childPipe.fileHandleForReading.readabilityHandler = nil;
    _childPipe = nil;
    _child = nil;
}

/** The host's own last words, for an error page. */
- (NSString *)outputExcerpt {
    NSString *text = _tail.text;
    return text.length > 0 ? text : @"（没有捕获到宿主的输出）";
}

#pragma mark Probing

- (BOOL)isServingPort:(NSInteger)port {
    NSURL *url = [NSURL URLWithString:[self urlStringForPort:port]];
    NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:url];
    request.timeoutInterval = 1.5;
    request.cachePolicy = NSURLRequestReloadIgnoringLocalAndRemoteCacheData;

    dispatch_semaphore_t semaphore = dispatch_semaphore_create(0);
    __block BOOL serving = NO;
    NSURLSessionDataTask *task = [[NSURLSession sharedSession] dataTaskWithRequest:request
        completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
            NSHTTPURLResponse *http = [response isKindOfClass:[NSHTTPURLResponse class]]
                ? (NSHTTPURLResponse *)response : nil;
            if (error == nil && http.statusCode == 200 && data.length > 0) {
                NSUInteger length = MIN((NSUInteger)8192, data.length);
                NSData *head = [data subdataWithRange:NSMakeRange(0, length)];
                NSString *text = [[NSString alloc] initWithData:head encoding:NSUTF8StringEncoding];
                // The index injects the boot graph: that is what makes it DSH
                // rather than some other service that happens to own the port.
                serving = [text containsString:@"__DSH_BOOT__"];
                if (!serving) {
                    // …unless that host GATES its document. A Feishu-login gate
                    // answers `/` with a redirect to its own login page, which
                    // carries neither the boot graph nor any other DSH marker,
                    // so an ungated-only test concludes "nothing is serving" and
                    // this app starts a SECOND host on the next port — one whose
                    // redirect URI the gate was never registered for, so the QR
                    // in that window fails with 20029. Recognise the door rather
                    // than walking past it: the document reached here is the
                    // plugin's login page when it advertises itself, or when the
                    // redirect landed on the plugin's default login path.
                    NSString *finalPath = response.URL.path ?: @"";
                    serving = [finalPath hasPrefix:@"/login"]
                        || [text containsString:@"dsh-feishu-login"];
                }
            }
            dispatch_semaphore_signal(semaphore);
        }];
    [task resume];
    if (dispatch_semaphore_wait(semaphore, dispatch_time(DISPATCH_TIME_NOW, (int64_t)(3.0 * NSEC_PER_SEC))) != 0) {
        [task cancel];
    }
    return serving;
}

- (NSInteger)firstFreePort {
    for (NSNumber *candidate in _probePorts) {
        if ([self isPortFree:candidate.integerValue]) { return candidate.integerValue; }
    }
    return -1;
}

- (BOOL)isPortFree:(NSInteger)port {
    int descriptor = socket(AF_INET, SOCK_STREAM, 0);
    if (descriptor < 0) { return NO; }
    int reuse = 1;
    setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    struct sockaddr_in address;
    memset(&address, 0, sizeof(address));
    address.sin_len = sizeof(address);
    address.sin_family = AF_INET;
    address.sin_port = htons((uint16_t)port);
    address.sin_addr.s_addr = inet_addr(_host.UTF8String);
    BOOL free = bind(descriptor, (struct sockaddr *)&address, sizeof(address)) == 0;
    close(descriptor);
    return free;
}

#pragma mark CLI discovery

/** The checkout the app falls back to when no installed CLI exists. */
+ (NSString *)defaultCheckoutPath {
    NSString *configured = [NSProcessInfo processInfo].environment[@"DSH_CHECKOUT"];
    if (configured.length > 0) { return configured; }
    return [@"~/vscodeProjects/deepseek-harness" stringByExpandingTildeInPath];
}

- (nullable NSString *)discoveredCLIDisplay {
    NSArray<NSString *> *cli = [self discoveredCLI];
    return cli == nil ? nil : [cli componentsJoinedByString:@" "];
}

/**
 * A usable host command: element 0 is the executable, the rest lead the app's
 * own arguments.
 * @returns the command, or nil when nothing usable exists.
 */
- (nullable NSArray<NSString *> *)discoveredCLI {
    NSFileManager *manager = [NSFileManager defaultManager];
    NSMutableArray<NSString *> *shims = [NSMutableArray array];
    if (_explicitBinary.length > 0) {
        [shims addObject:[_explicitBinary stringByExpandingTildeInPath]];
    }
    for (NSString *candidate in @[@"~/.local/bin/dsh", @"/usr/local/bin/dsh",
                                  @"/opt/homebrew/bin/dsh", @"~/bin/dsh"]) {
        [shims addObject:[candidate stringByExpandingTildeInPath]];
    }
    NSString *onPath = [self executableOnPath:@"dsh"];
    if (onPath != nil) { [shims addObject:onPath]; }

    for (NSString *shim in shims) {
        if ([manager isExecutableFileAtPath:shim]) { return @[shim]; }
    }

    NSString *checkout = [DSHServer defaultCheckoutPath];
    NSString *entry = [checkout stringByAppendingPathComponent:@"apps/cli/lib/bin.js"];
    NSString *node = [self findNode];
    if ([manager fileExistsAtPath:entry] && node != nil) {
        return @[node, entry];
    }
    return nil;
}

- (NSString *)executableOnPath:(NSString *)name {
    NSMutableArray<NSString *> *directories = [NSMutableArray array];
    NSString *path = [NSProcessInfo processInfo].environment[@"PATH"];
    if (path.length > 0) {
        [directories addObjectsFromArray:[path componentsSeparatedByString:@":"]];
    }
    [directories addObjectsFromArray:@[@"/usr/local/bin", @"/opt/homebrew/bin", @"/usr/bin"]];
    for (NSString *directory in directories) {
        NSString *candidate = [[directory stringByExpandingTildeInPath] stringByAppendingPathComponent:name];
        if ([[NSFileManager defaultManager] isExecutableFileAtPath:candidate]) { return candidate; }
    }
    return nil;
}

/**
 * Find a node binary, including the nvm-managed installs a Finder-launched app
 * cannot reach through the shell's PATH.
 * @returns the node path, or nil.
 */
- (nullable NSString *)findNode {
    NSString *explicit = [NSProcessInfo processInfo].environment[@"DSH_NODE"];
    if (explicit.length > 0) {
        NSString *expanded = [explicit stringByExpandingTildeInPath];
        return [[NSFileManager defaultManager] isExecutableFileAtPath:expanded] ? expanded : nil;
    }
    NSString *onPath = [self executableOnPath:@"node"];
    if (onPath != nil) { return onPath; }

    NSString *versions = [@"~/.nvm/versions/node" stringByExpandingTildeInPath];
    NSArray<NSString *> *entries = [[NSFileManager defaultManager] contentsOfDirectoryAtPath:versions error:NULL];
    // Highest version first: a reverse lexical sort is enough for vNN.NN.NN names.
    for (NSString *entry in [[entries sortedArrayUsingSelector:@selector(compare:)] reverseObjectEnumerator]) {
        NSString *candidate = [[versions stringByAppendingPathComponent:entry]
                               stringByAppendingPathComponent:@"bin/node"];
        if ([[NSFileManager defaultManager] isExecutableFileAtPath:candidate]) { return candidate; }
    }
    return nil;
}

#pragma mark Spawning

- (nullable NSTask *)launchCLI:(NSArray<NSString *> *)cli port:(NSInteger)port {
    NSTask *process = [[NSTask alloc] init];
    process.executableURL = [NSURL fileURLWithPath:cli.firstObject];
    NSMutableArray<NSString *> *arguments = [NSMutableArray array];
    if (cli.count > 1) {
        [arguments addObjectsFromArray:[cli subarrayWithRange:NSMakeRange(1, cli.count - 1)]];
    }
    [arguments addObjectsFromArray:@[@"web", @"--port", [NSString stringWithFormat:@"%ld", (long)port], @"--no-open"]];
    process.arguments = arguments;

    NSMutableDictionary<NSString *, NSString *> *environment = [[[NSProcessInfo processInfo] environment] mutableCopy];
    NSMutableArray<NSString *> *prefixParts = [NSMutableArray array];
    for (NSString *part in @[_nodeDirectory ?: @"", @"/usr/local/bin", @"/opt/homebrew/bin", @"/usr/bin", @"/bin"]) {
        if (part.length > 0) { [prefixParts addObject:part]; }
    }
    environment[@"PATH"] = [NSString stringWithFormat:@"%@:%@",
                            [prefixParts componentsJoinedByString:@":"], environment[@"PATH"] ?: @""];
    process.environment = environment;

    NSPipe *pipe = [NSPipe pipe];
    process.standardOutput = pipe;
    process.standardError = pipe;
    DSHLogTail *tail = _tail;
    pipe.fileHandleForReading.readabilityHandler = ^(NSFileHandle *handle) {
        NSData *data = handle.availableData;
        if (data.length == 0) { return; }
        NSString *text = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if (text == nil) { return; }
        [tail append:text];
        DSHLog(@"host | %@", [text stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]]);
    };

    NSError *error = nil;
    if (![process launchAndReturnError:&error]) {
        DSHLog(@"host launch failed: %@", error.localizedDescription);
        pipe.fileHandleForReading.readabilityHandler = nil;
        return nil;
    }
    _child = process;
    _childPipe = pipe;
    return process;
}

@end
