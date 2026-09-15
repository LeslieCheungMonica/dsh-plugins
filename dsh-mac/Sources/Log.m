/**
 * Diagnostics for the app and the host it starts.
 *
 * A GUI app has nowhere to print: launched from Finder its stdout is swallowed
 * by the unified log, and a host-startup failure happens behind a window that
 * is still showing its spinner. So every interesting event goes to two places —
 * stderr (visible when the app is started from a shell) and
 * `~/Library/Logs/DSHWeb.log`, which the error page points the operator at.
 */
#import "DSHWeb.h"

NSString *DSHLogFilePath(void) {
    static NSString *path;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        NSString *library = [NSSearchPathForDirectoriesInDomains(NSLibraryDirectory, NSUserDomainMask, YES) firstObject];
        path = [(library ?: NSHomeDirectory()) stringByAppendingPathComponent:@"Logs/DSHWeb.log"];
    });
    return path;
}

void DSHLog(NSString *format, ...) {
    va_list arguments;
    va_start(arguments, format);
    NSString *message = [[NSString alloc] initWithFormat:format arguments:arguments];
    va_end(arguments);

    NSISO8601DateFormatter *formatter = [[NSISO8601DateFormatter alloc] init];
    NSString *line = [NSString stringWithFormat:@"[%@] %@\n", [formatter stringFromDate:[NSDate date]], message];
    NSData *data = [line dataUsingEncoding:NSUTF8StringEncoding];

    fwrite(data.bytes, 1, data.length, stderr);

    static dispatch_queue_t queue;
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        queue = dispatch_queue_create("local.dsh.web.log", DISPATCH_QUEUE_SERIAL);
    });
    dispatch_async(queue, ^{
        NSFileManager *manager = [NSFileManager defaultManager];
        NSString *path = DSHLogFilePath();
        if (![manager fileExistsAtPath:path]) {
            [manager createFileAtPath:path contents:nil attributes:nil];
        }
        NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
        if (handle == nil) { return; }
        @try {
            [handle seekToEndOfFile];
            [handle writeData:data];
        } @catch (__unused NSException *exception) {
            // Logging must never be the reason the app fails.
        }
        [handle closeFile];
    });
}
