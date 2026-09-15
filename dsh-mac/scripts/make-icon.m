/**
 * Draws the app icon and writes a complete `.iconset`, ready for `iconutil`.
 *
 * Usage: clang -fobjc-arc -framework Cocoa -o make-icon scripts/make-icon.m && ./make-icon <out.iconset>
 *
 * The mark is a rounded square in the DeepSeek blue family — the same accent
 * the companion web plugin paints its controls with — carrying a white "DSH"
 * monogram. Below 64px the monogram turns to mush, so small sizes draw a
 * simplified speech-bubble mark instead: legible in the Dock and in a Finder
 * list, from the same palette.
 */
#import <Cocoa/Cocoa.h>

/** Sizes an .iconset must contain: (file name, pixel size). */
static NSArray<NSArray<id> *> *DSHIconVariants(void) {
    return @[
        @[@"icon_16x16", @16], @[@"icon_16x16@2x", @32],
        @[@"icon_32x32", @32], @[@"icon_32x32@2x", @64],
        @[@"icon_128x128", @128], @[@"icon_128x128@2x", @256],
        @[@"icon_256x256", @256], @[@"icon_256x256@2x", @512],
        @[@"icon_512x512", @512], @[@"icon_512x512@2x", @1024],
    ];
}

/**
 * Render one icon bitmap.
 * @param size - pixel edge length.
 * @returns PNG data.
 */
static NSData *DSHRenderIcon(NSInteger size) {
    CGFloat edge = (CGFloat)size;
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc]
        initWithBitmapDataPlanes:NULL pixelsWide:size pixelsHigh:size
                    bitsPerSample:8 samplesPerPixel:4 hasAlpha:YES isPlanar:NO
                   colorSpaceName:NSCalibratedRGBColorSpace bytesPerRow:0 bitsPerPixel:0];
    NSGraphicsContext *context = [NSGraphicsContext graphicsContextWithBitmapImageRep:bitmap];
    [NSGraphicsContext saveGraphicsState];
    [NSGraphicsContext setCurrentContext:context];
    context.imageInterpolation = NSImageInterpolationHigh;

    // Rounded-square body with the macOS icon inset (~5.5% at large sizes).
    CGFloat inset = size >= 64 ? edge * 0.055 : 0.0;
    NSRect body = NSMakeRect(inset, inset, edge - inset * 2, edge - inset * 2);
    CGFloat radius = body.size.width * (size >= 64 ? 0.235 : 0.22);
    NSBezierPath *path = [NSBezierPath bezierPathWithRoundedRect:body xRadius:radius yRadius:radius];

    NSGradient *gradient = [[NSGradient alloc] initWithColors:@[
        [NSColor colorWithSRGBRed:0.10 green:0.16 blue:0.32 alpha:1.0],
        [NSColor colorWithSRGBRed:0.25 green:0.46 blue:0.89 alpha:1.0],
    ]];
    [gradient drawInBezierPath:path angle:-90];

    // Soft top highlight, so the tile reads as a surface rather than a swatch.
    [NSGraphicsContext saveGraphicsState];
    [path addClip];
    NSGradient *highlight = [[NSGradient alloc] initWithColors:@[
        [NSColor colorWithWhite:1.0 alpha:0.20], [NSColor colorWithWhite:1.0 alpha:0.0],
    ]];
    [highlight drawInRect:NSMakeRect(body.origin.x, body.origin.y + body.size.height / 2,
                                     body.size.width, body.size.height / 2) angle:-90];
    [NSGraphicsContext restoreGraphicsState];

    if (size >= 64) {
        CGFloat fontSize = body.size.width * 0.30;
        NSFont *font = [NSFont systemFontOfSize:fontSize weight:NSFontWeightHeavy];
        NSAttributedString *text = [[NSAttributedString alloc] initWithString:@"DSH" attributes:@{
            NSFontAttributeName: font,
            NSForegroundColorAttributeName: [NSColor whiteColor],
            NSKernAttributeName: @(-fontSize * 0.02),
        }];
        NSSize bounds = text.size;
        [text drawAtPoint:NSMakePoint(body.origin.x + (body.size.width - bounds.width) / 2,
                                      body.origin.y + (body.size.height - bounds.height) / 2
                                          + body.size.height * 0.01)];
    } else {
        // Small sizes: a speech bubble reads where three letters cannot.
        NSRect bubble = NSMakeRect(body.origin.x + body.size.width * 0.26,
                                   body.origin.y + body.size.height * 0.30,
                                   body.size.width * 0.48,
                                   body.size.height * 0.38);
        [[NSColor whiteColor] setFill];
        [[NSBezierPath bezierPathWithRoundedRect:bubble
                                        xRadius:bubble.size.height * 0.34
                                        yRadius:bubble.size.height * 0.34] fill];
        NSBezierPath *tail = [NSBezierPath bezierPath];
        [tail moveToPoint:NSMakePoint(bubble.origin.x + bubble.size.width * 0.22,
                                      bubble.origin.y + bubble.size.height * 0.10)];
        [tail lineToPoint:NSMakePoint(bubble.origin.x + bubble.size.width * 0.22,
                                      bubble.origin.y - bubble.size.height * 0.34)];
        [tail lineToPoint:NSMakePoint(bubble.origin.x + bubble.size.width * 0.58,
                                      bubble.origin.y + bubble.size.height * 0.10)];
        [tail closePath];
        [tail fill];
    }

    [NSGraphicsContext restoreGraphicsState];
    return [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
}

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        if (argc < 2) {
            fprintf(stderr, "usage: make-icon <output.iconset>\n");
            return 2;
        }
        NSString *output = [NSString stringWithUTF8String:argv[1]];
        [[NSFileManager defaultManager] createDirectoryAtPath:output
                                  withIntermediateDirectories:YES attributes:nil error:NULL];

        NSMutableDictionary<NSNumber *, NSData *> *cache = [NSMutableDictionary dictionary];
        NSInteger written = 0;
        for (NSArray<id> *variant in DSHIconVariants()) {
            NSString *name = variant[0];
            NSNumber *size = variant[1];
            NSData *data = cache[size];
            if (data == nil) {
                data = DSHRenderIcon(size.integerValue);
                cache[size] = data;
            }
            NSString *file = [output stringByAppendingPathComponent:[name stringByAppendingString:@".png"]];
            if (![data writeToFile:file atomically:YES]) {
                fprintf(stderr, "icon: failed to write %s\n", file.UTF8String);
                return 1;
            }
            written++;
        }
        printf("icon: wrote %ld PNGs to %s\n", (long)written, output.UTF8String);
    }
    return 0;
}
