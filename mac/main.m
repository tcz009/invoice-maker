// Invoice Maker — native macOS wrapper around the invoice web app.
// Serves the bundled web folder on 127.0.0.1:47823 (so localStorage persists),
// displays it in a WKWebView, and prints by rendering the A4 sheet to PDF first.

#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <PDFKit/PDFKit.h>

#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <unistd.h>

static const uint16_t kPort = 47823;
static NSString *const kBaseURLString = @"http://127.0.0.1:47823/";

#pragma mark - Local HTTP server

@interface LocalServer : NSObject
@property (nonatomic, copy) NSString *root;
- (instancetype)initWithRoot:(NSString *)root;
- (BOOL)startWithError:(NSString **)errorMessage;
- (void)stop;
@end

@implementation LocalServer {
    int _listenFD;
}

- (instancetype)initWithRoot:(NSString *)root {
    if ((self = [super init])) {
        _root = [[root stringByStandardizingPath] copy];
        _listenFD = -1;
    }
    return self;
}

- (BOOL)startWithError:(NSString **)errorMessage {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) {
        if (errorMessage) *errorMessage = @"socket() failed";
        return NO;
    }

    int yes = 1;
    setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes));

    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_len = sizeof(addr);
    addr.sin_family = AF_INET;
    addr.sin_port = htons(kPort);
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);

    if (bind(fd, (struct sockaddr *)&addr, sizeof(addr)) != 0) {
        if (errorMessage) *errorMessage = [NSString stringWithFormat:@"Could not bind to port %d (errno %d).", kPort, errno];
        close(fd);
        return NO;
    }
    if (listen(fd, 16) != 0) {
        if (errorMessage) *errorMessage = [NSString stringWithFormat:@"listen() failed (errno %d).", errno];
        close(fd);
        return NO;
    }

    signal(SIGPIPE, SIG_IGN);
    _listenFD = fd;

    dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
        [self acceptLoop];
    });
    return YES;
}

- (void)stop {
    if (_listenFD >= 0) {
        close(_listenFD);
        _listenFD = -1;
    }
}

- (void)acceptLoop {
    while (_listenFD >= 0) {
        int client = accept(_listenFD, NULL, NULL);
        if (client < 0) {
            if (errno == EINTR) continue;
            break;
        }
        int yes = 1;
        setsockopt(client, SOL_SOCKET, SO_NOSIGPIPE, &yes, sizeof(yes));
        dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
            [self serveClient:client];
        });
    }
}

- (void)serveClient:(int)client {
    @autoreleasepool {
        char buffer[16384];
        ssize_t received = recv(client, buffer, sizeof(buffer) - 1, 0);
        if (received > 0) {
            buffer[received] = '\0';
            NSString *request = [NSString stringWithUTF8String:buffer] ?: @"";
            NSData *response = [self responseForRequest:request];
            const uint8_t *bytes = response.bytes;
            NSUInteger total = response.length;
            NSUInteger sent = 0;
            while (sent < total) {
                ssize_t n = send(client, bytes + sent, total - sent, 0);
                if (n <= 0) break;
                sent += (NSUInteger)n;
            }
        }
        close(client);
    }
}

- (NSData *)responseForRequest:(NSString *)request {
    NSArray<NSString *> *lines = [request componentsSeparatedByString:@"\r\n"];
    NSString *firstLine = lines.count ? lines[0] : @"";
    NSArray<NSString *> *parts = [firstLine componentsSeparatedByString:@" "];
    if (parts.count < 2) return [self errorPage:400 message:@"Bad request"];

    NSString *rawPath = parts[1];
    NSRange query = [rawPath rangeOfString:@"?"];
    if (query.location != NSNotFound) rawPath = [rawPath substringToIndex:query.location];
    if (rawPath.length == 0 || [rawPath isEqualToString:@"/"]) rawPath = @"/index.html";

    NSString *decoded = [rawPath stringByRemovingPercentEncoding] ?: rawPath;
    NSString *full = [[self.root stringByAppendingPathComponent:decoded] stringByStandardizingPath];
    if (![full hasPrefix:[self.root stringByAppendingString:@"/"]]) {
        return [self errorPage:403 message:@"Forbidden"];
    }

    NSData *data = [NSData dataWithContentsOfFile:full];
    if (!data) return [self errorPage:404 message:@"Not found"];

    NSString *header = [NSString stringWithFormat:
        @"HTTP/1.1 200 OK\r\nContent-Type: %@\r\nContent-Length: %lu\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        [self mimeTypeForExtension:full.pathExtension], (unsigned long)data.length];

    NSMutableData *out = [NSMutableData dataWithData:[header dataUsingEncoding:NSUTF8StringEncoding]];
    [out appendData:data];
    return out;
}

- (NSString *)mimeTypeForExtension:(NSString *)extension {
    NSString *ext = extension.lowercaseString ?: @"";
    if ([ext isEqualToString:@"html"] || [ext isEqualToString:@"htm"]) return @"text/html; charset=utf-8";
    if ([ext isEqualToString:@"css"]) return @"text/css; charset=utf-8";
    if ([ext isEqualToString:@"js"] || [ext isEqualToString:@"mjs"]) return @"text/javascript; charset=utf-8";
    if ([ext isEqualToString:@"json"]) return @"application/json; charset=utf-8";
    if ([ext isEqualToString:@"png"]) return @"image/png";
    if ([ext isEqualToString:@"jpg"] || [ext isEqualToString:@"jpeg"]) return @"image/jpeg";
    if ([ext isEqualToString:@"svg"]) return @"image/svg+xml";
    if ([ext isEqualToString:@"ico"]) return @"image/x-icon";
    return @"application/octet-stream";
}

- (NSData *)errorPage:(NSInteger)code message:(NSString *)message {
    NSString *body = [NSString stringWithFormat:@"<!doctype html><meta charset=utf-8><h1>%ld — %@</h1>", (long)code, message];
    NSData *bodyData = [body dataUsingEncoding:NSUTF8StringEncoding];
    NSString *header = [NSString stringWithFormat:
        @"HTTP/1.1 %ld %@\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %lu\r\nConnection: close\r\n\r\n",
        (long)code, message, (unsigned long)bodyData.length];
    NSMutableData *out = [NSMutableData dataWithData:[header dataUsingEncoding:NSUTF8StringEncoding]];
    [out appendData:bodyData];
    return out;
}

@end

#pragma mark - App delegate

@interface AppDelegate : NSObject <NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate,
                                  WKScriptMessageHandler, WKDownloadDelegate>
@property (nonatomic, strong) NSWindow *window;
@property (nonatomic, strong) WKWebView *webView;
@property (nonatomic, strong) LocalServer *server;
@property (nonatomic, strong) NSMutableArray<WKDownload *> *downloads;
@property (nonatomic) BOOL connected;

@property (nonatomic, copy) NSString *printTestPath;
@property (nonatomic, copy) NSString *importTestPath;
@property (nonatomic, strong) WKWebView *renderWebView;
@property (nonatomic, strong) NSWindow *renderWindow;
@property (nonatomic, copy) void (^renderCompletion)(NSData *data);
@end

@implementation AppDelegate

#pragma mark lifecycle

- (void)applicationDidFinishLaunching:(NSNotification *)notification {
    // Single instance: focus the copy that is already running.
    NSString *bundleID = NSBundle.mainBundle.bundleIdentifier ?: @"";
    for (NSRunningApplication *other in [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleID]) {
        if (other.processIdentifier != NSProcessInfo.processInfo.processIdentifier) {
            [other activateWithOptions:NSApplicationActivateAllWindows];
            [NSApp terminate:nil];
            return;
        }
    }

    self.downloads = [NSMutableArray array];
    [self buildMenu];
    [self buildWindow];

    NSString *webRoot = [NSBundle.mainBundle.resourceURL URLByAppendingPathComponent:@"web"].path;
    if (!webRoot) {
        [self failWithMessage:@"The bundled invoice files are missing from the app."];
        return;
    }

    NSString *error = nil;
    self.server = [[LocalServer alloc] initWithRoot:webRoot];
    if (![self.server startWithError:&error]) {
        [self failWithMessage:error ?: @"The local invoice server could not start."];
        return;
    }

    NSArray<NSString *> *arguments = NSProcessInfo.processInfo.arguments;
    NSUInteger importFlag = [arguments indexOfObject:@"--import-test"];
    if (importFlag != NSNotFound && importFlag + 1 < arguments.count) {
        NSDictionary *parsed = [self parseStatementFromURL:[NSURL fileURLWithPath:arguments[importFlag + 1]]];
        NSData *json = parsed ? [NSJSONSerialization dataWithJSONObject:parsed options:NSJSONWritingPrettyPrinted error:NULL] : nil;
        printf("%s\n", json ? [[[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding] UTF8String] : "null");
        [NSApp terminate:nil];
        return;
    }

    NSUInteger printFlag = [arguments indexOfObject:@"--print-to"];
    if (printFlag != NSNotFound && printFlag + 1 < arguments.count) {
        self.printTestPath = arguments[printFlag + 1];
    }

    [self.webView loadRequest:[NSURLRequest requestWithURL:[NSURL URLWithString:kBaseURLString]]];
    [NSApp activateIgnoringOtherApps:YES];
}

- (void)applicationWillTerminate:(NSNotification *)notification {
    [self.server stop];
}

- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
    return YES;
}

- (BOOL)applicationShouldHandleReopen:(NSApplication *)sender hasVisibleWindows:(BOOL)flag {
    if (!flag) [self.window makeKeyAndOrderFront:nil];
    return YES;
}

#pragma mark window + web view

- (void)buildWindow {
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore defaultDataStore];
    [configuration.userContentController addScriptMessageHandler:self name:@"print"];
    [configuration.userContentController addScriptMessageHandler:self name:@"saveFile"];
    [configuration.userContentController addScriptMessageHandler:self name:@"savePDF"];
    [configuration.userContentController addScriptMessageHandler:self name:@"importStatement"];
    [configuration.userContentController addUserScript:[[WKUserScript alloc]
        initWithSource:@"(function(){var n=window.print;window.print=function(){try{if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.print){window.webkit.messageHandlers.print.postMessage(null);}else if(n){n.call(window);}}catch(e){if(n){n.call(window);}}};})();"
        injectionTime:WKUserScriptInjectionTimeAtDocumentEnd
        forMainFrameOnly:YES]];

    self.webView = [[WKWebView alloc] initWithFrame:NSZeroRect configuration:configuration];
    self.webView.navigationDelegate = self;
    self.webView.UIDelegate = self;

    self.window = [[NSWindow alloc]
        initWithContentRect:NSMakeRect(0, 0, 1440, 980)
                  styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
                             NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable)
                    backing:NSBackingStoreBuffered
                      defer:NO];
    self.window.title = @"Invoice Maker";
    self.window.minSize = NSMakeSize(980, 680);
    self.window.contentView = self.webView;
    [self.window setFrameAutosaveName:@"InvoiceMakerMainWindow"];
    [self.window center];
    [self.window makeKeyAndOrderFront:nil];
}

- (void)failWithMessage:(NSString *)message {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleCritical;
    alert.messageText = @"Invoice Maker could not start";
    alert.informativeText = message ?: @"";
    [alert addButtonWithTitle:@"Quit"];
    [alert runModal];
    [NSApp terminate:nil];
}

#pragma mark menu

- (void)buildMenu {
    NSMenu *mainMenu = [[NSMenu alloc] init];

    NSMenuItem *appItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:appItem];
    NSMenu *appMenu = [[NSMenu alloc] initWithTitle:@"Invoice Maker"];
    appItem.submenu = appMenu;
    [appMenu addItemWithTitle:@"About Invoice Maker" action:@selector(orderFrontStandardAboutPanel:) keyEquivalent:@""];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Hide Invoice Maker" action:@selector(hide:) keyEquivalent:@"h"];
    [appMenu addItem:[NSMenuItem separatorItem]];
    [appMenu addItemWithTitle:@"Quit Invoice Maker" action:@selector(terminate:) keyEquivalent:@"q"];

    NSMenuItem *fileItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:fileItem];
    NSMenu *fileMenu = [[NSMenu alloc] initWithTitle:@"File"];
    fileItem.submenu = fileMenu;
    NSMenuItem *importStatementItem = [fileMenu addItemWithTitle:@"Import Statement PDF…" action:@selector(importStatement:) keyEquivalent:@"I"];
    importStatementItem.target = self;
    NSMenuItem *savePdfItem = [fileMenu addItemWithTitle:@"Save PDF…" action:@selector(savePDFMenuItem:) keyEquivalent:@"S"];
    savePdfItem.target = self;
    NSMenuItem *printItem = [fileMenu addItemWithTitle:@"Print…" action:@selector(printInvoice:) keyEquivalent:@"p"];
    printItem.target = self;
    [fileMenu addItem:[NSMenuItem separatorItem]];
    [fileMenu addItemWithTitle:@"Close Window" action:@selector(performClose:) keyEquivalent:@"w"];

    NSMenuItem *editItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:editItem];
    NSMenu *editMenu = [[NSMenu alloc] initWithTitle:@"Edit"];
    editItem.submenu = editMenu;
    [editMenu addItemWithTitle:@"Undo" action:@selector(undo:) keyEquivalent:@"z"];
    [editMenu addItemWithTitle:@"Redo" action:@selector(redo:) keyEquivalent:@"Z"];
    [editMenu addItem:[NSMenuItem separatorItem]];
    [editMenu addItemWithTitle:@"Cut" action:@selector(cut:) keyEquivalent:@"x"];
    [editMenu addItemWithTitle:@"Copy" action:@selector(copy:) keyEquivalent:@"c"];
    [editMenu addItemWithTitle:@"Paste" action:@selector(paste:) keyEquivalent:@"v"];
    [editMenu addItemWithTitle:@"Select All" action:@selector(selectAll:) keyEquivalent:@"a"];

    NSMenuItem *viewItem = [[NSMenuItem alloc] init];
    [mainMenu addItem:viewItem];
    NSMenu *viewMenu = [[NSMenu alloc] initWithTitle:@"View"];
    viewItem.submenu = viewMenu;
    NSMenuItem *reloadItem = [viewMenu addItemWithTitle:@"Reload" action:@selector(reloadPage:) keyEquivalent:@"r"];
    reloadItem.target = self;

    NSApp.mainMenu = mainMenu;
}

#pragma mark printing

#pragma mark statement import

- (void)importStatement:(id)sender {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.allowedContentTypes = @[ UTTypePDF ];
    panel.allowsMultipleSelection = NO;
    panel.canChooseDirectories = NO;
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        if (result == NSModalResponseOK && panel.URL) {
            [self importStatementFromURL:panel.URL];
        }
    }];
}

- (NSDictionary *)parseStatementFromURL:(NSURL *)url {
    PDFDocument *document = [[PDFDocument alloc] initWithURL:url];
    return [self parseStatementFromText:(document.string ?: @"")];
}

- (NSDictionary *)parseStatementFromText:(NSString *)text {
    if (text.length == 0) return nil;

    NSRegularExpression *totalPattern = [NSRegularExpression
        regularExpressionWithPattern:@"Total\\s*Pay\\s*:?\\s*£?\\s*([0-9][0-9,]*(?:\\.[0-9]{2})?)"
                             options:NSRegularExpressionCaseInsensitive
                               error:NULL];
    NSTextCheckingResult *totalMatch = [totalPattern firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (!totalMatch) return nil;

    NSString *amount = [text substringWithRange:[totalMatch rangeAtIndex:1]];
    amount = [amount stringByReplacingOccurrencesOfString:@"," withString:@""];

    NSMutableDictionary *parsed = [NSMutableDictionary dictionary];
    parsed[@"total"] = amount;
    parsed[@"source"] = @"statement";

    NSRegularExpression *periodPattern = [NSRegularExpression
        regularExpressionWithPattern:@"([0-9]{2})/([0-9]{2})/([0-9]{4})\\s*To\\s*([0-9]{2})/([0-9]{2})/([0-9]{4})"
                             options:NSRegularExpressionCaseInsensitive
                               error:NULL];
    NSTextCheckingResult *periodMatch = [periodPattern firstMatchInString:text options:0 range:NSMakeRange(0, text.length)];
    if (periodMatch) {
        NSString *from = [NSString stringWithFormat:@"%@-%@-%@",
            [text substringWithRange:[periodMatch rangeAtIndex:3]],
            [text substringWithRange:[periodMatch rangeAtIndex:2]],
            [text substringWithRange:[periodMatch rangeAtIndex:1]]];
        NSString *to = [NSString stringWithFormat:@"%@-%@-%@",
            [text substringWithRange:[periodMatch rangeAtIndex:6]],
            [text substringWithRange:[periodMatch rangeAtIndex:5]],
            [text substringWithRange:[periodMatch rangeAtIndex:4]]];
        parsed[@"from"] = from;
        parsed[@"to"] = to;
    }
    return parsed;
}

- (void)importStatementFromURL:(NSURL *)url {
    NSDictionary *parsed = [self parseStatementFromURL:url];
    if (!parsed) {
        [self showStatementError];
        return;
    }

    NSData *json = [NSJSONSerialization dataWithJSONObject:parsed options:0 error:NULL];
    NSString *jsonText = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    NSString *script = [NSString stringWithFormat:@"window.importStatement(%@);", jsonText];

    [self.webView evaluateJavaScript:script completionHandler:^(id result, NSError *error) {
        if (error || ![result boolValue]) {
            [self showStatementError];
        }
    }];
}

- (void)showStatementError {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.alertStyle = NSAlertStyleWarning;
    alert.messageText = @"Could not read that statement";
    alert.informativeText = @"No “Total Pay” figure was found in the PDF. You can still type the amount in yourself.";
    [alert beginSheetModalForWindow:self.window completionHandler:nil];
}

- (void)savePDFMenuItem:(id)sender {
    [self saveInvoicePDF:nil];
}

- (void)printInvoice:(id)sender {
    if (!self.connected) {
        NSBeep();
        return;
    }

    [self generateInvoicePDF:^(NSData *pdfData) {
        if (pdfData.length == 0) {
            NSBeep();
            return;
        }
        PDFDocument *document = [[PDFDocument alloc] initWithData:pdfData];
        if (!document) {
            NSBeep();
            return;
        }

        NSPrintInfo *info = [NSPrintInfo sharedPrintInfo];
        info.paperSize = NSMakeSize(595.28, 841.89); // A4
        info.topMargin = 0;
        info.bottomMargin = 0;
        info.leftMargin = 0;
        info.rightMargin = 0;
        info.horizontalPagination = NSFitPagination;
        info.verticalPagination = NSAutoPagination;

        NSPrintOperation *operation = [document printOperationForPrintInfo:info
                                                              scalingMode:kPDFPrintPageScaleToFit
                                                                autoRotate:YES];
        if (!operation) {
            NSBeep();
            return;
        }
        operation.showsPrintPanel = YES;
        operation.showsProgressPanel = YES;
        [operation runOperation];
    }];
}

// Used by `--print-to <file>` for automated checks; saves the rendered PDF without a dialog.
- (void)printToFile:(NSString *)path {
    [self generateInvoicePDF:^(NSData *pdfData) {
        if (pdfData.length) {
            [pdfData writeToFile:path atomically:YES];
        }
        [NSApp terminate:nil];
    }];
}

- (void)generateInvoicePDF:(void (^)(NSData *data))completion {
    if (!self.connected) {
        completion(nil);
        return;
    }

    // Flush the latest edits to the shared web store, then render a paper-only page at A4 size.
    [self.webView evaluateJavaScript:@"try { saveNow(); } catch (e) {}"
                   completionHandler:^(id result, NSError *error) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.25 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self startInvoiceRender:completion];
        });
    }];
}

- (void)startInvoiceRender:(void (^)(NSData *data))completion {
    WKWebViewConfiguration *configuration = [[WKWebViewConfiguration alloc] init];
    configuration.websiteDataStore = [WKWebsiteDataStore defaultDataStore];

    self.renderWebView = [[WKWebView alloc] initWithFrame:NSMakeRect(0, 0, 793, 1122)
                                          configuration:configuration];
    self.renderWebView.navigationDelegate = self;

    self.renderWindow = [[NSWindow alloc] initWithContentRect:NSMakeRect(-4000, -4000, 793, 1122)
                                                    styleMask:NSWindowStyleMaskBorderless
                                                      backing:NSBackingStoreBuffered
                                                        defer:NO];
    self.renderWindow.contentView = self.renderWebView;
    [self.renderWindow orderBack:nil];

    self.renderCompletion = [completion copy];
    NSURL *url = [NSURL URLWithString:[kBaseURLString stringByAppendingString:@"index.html?print=1"]];
    [self.renderWebView loadRequest:[NSURLRequest requestWithURL:url]];
}

- (void)capturePDF {
    WKPDFConfiguration *configuration = [[WKPDFConfiguration alloc] init];
    configuration.rect = CGRectMake(0, 0, 793, 1122);

    [self.renderWebView createPDFWithConfiguration:configuration
                                 completionHandler:^(NSData *pdfData, NSError *error) {
        if (error) {
            NSLog(@"Invoice Maker: PDF render failed: %@", error);
        }

        void (^completion)(NSData *) = self.renderCompletion;
        self.renderCompletion = nil;

        [self.renderWindow orderOut:nil];
        self.renderWindow = nil;
        self.renderWebView = nil;

        if (completion) completion(pdfData);
    }];
}

- (void)reloadPage:(id)sender {
    [self.webView reload];
}

#pragma mark script messages

- (void)userContentController:(WKUserContentController *)userContentController
      didReceiveScriptMessage:(WKScriptMessage *)message {
    if ([message.name isEqualToString:@"print"]) {
        [self printInvoice:nil];
    } else if ([message.name isEqualToString:@"saveFile"]) {
        [self saveFileFromBody:message.body];
    } else if ([message.name isEqualToString:@"savePDF"]) {
        [self saveInvoicePDF:message.body];
    } else if ([message.name isEqualToString:@"importStatement"]) {
        [self importStatement:nil];
    }
}

- (void)saveFileFromBody:(id)body {
    if (![body isKindOfClass:[NSDictionary class]]) return;
    NSDictionary *payload = (NSDictionary *)body;
    NSString *filename = payload[@"filename"];
    NSString *text = payload[@"text"];
    NSString *base64 = payload[@"base64"];
    NSString *kind = payload[@"kind"];

    NSData *binary = nil;
    if ([base64 isKindOfClass:[NSString class]]) {
        binary = [[NSData alloc] initWithBase64EncodedString:base64 options:NSDataBase64DecodingIgnoreUnknownCharacters];
    }
    if (!binary && ![text isKindOfClass:[NSString class]]) return;

    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.nameFieldStringValue = [filename isKindOfClass:[NSString class]] ? filename : @"invoice";
    panel.canCreateDirectories = YES;
    if (@available(macOS 11.0, *)) {
        if ([kind isEqualToString:@"png"]) {
            panel.allowedContentTypes = @[ UTTypePNG ];
        } else if ([kind isEqualToString:@"xlsx"]) {
            panel.allowedContentTypes = @[ UTTypeSpreadsheet ];
        } else if ([kind isEqualToString:@"csv"]) {
            panel.allowedContentTypes = @[ UTTypeCommaSeparatedText ];
        } else {
            panel.allowedContentTypes = @[ UTTypeJSON ];
        }
    }
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        if (response != NSModalResponseOK || !panel.URL) return;
        if (binary) {
            [binary writeToURL:panel.URL atomically:YES];
        } else {
            [text writeToURL:panel.URL atomically:YES encoding:NSUTF8StringEncoding error:NULL];
        }
    }];
}

// "Download ▸ PDF" and File ▸ Save PDF… — render the sheet and save it without the print dialog.
- (void)saveInvoicePDF:(id)body {
    NSString *suggested = @"Invoice.pdf";
    if ([body isKindOfClass:[NSDictionary class]]) {
        NSString *name = ((NSDictionary *)body)[@"filename"];
        if ([name isKindOfClass:[NSString class]] && name.length) suggested = name;
    }

    [self generateInvoicePDF:^(NSData *pdfData) {
        if (pdfData.length == 0) {
            NSBeep();
            return;
        }
        NSSavePanel *panel = [NSSavePanel savePanel];
        panel.nameFieldStringValue = suggested;
        panel.canCreateDirectories = YES;
        if (@available(macOS 11.0, *)) {
            panel.allowedContentTypes = @[ UTTypePDF ];
        }
        [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
            if (response == NSModalResponseOK && panel.URL) {
                [pdfData writeToURL:panel.URL atomically:YES];
            }
        }];
    }];
}

#pragma mark navigation

- (void)webView:(WKWebView *)webView didFinishNavigation:(WKNavigation *)navigation {
    if (webView == self.renderWebView) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.35 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self capturePDF];
        });
        return;
    }

    self.connected = YES;

    if (self.printTestPath) {
        NSString *path = self.printTestPath;
        self.printTestPath = nil;
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(0.8 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
            [self printToFile:path];
        });
    }
}

- (void)webView:(WKWebView *)webView didFailNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (webView != self.renderWebView) self.connected = NO;
}

- (void)webView:(WKWebView *)webView didFailProvisionalNavigation:(WKNavigation *)navigation withError:(NSError *)error {
    if (webView != self.renderWebView) self.connected = NO;
}

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationAction:(WKNavigationAction *)navigationAction
                    decisionHandler:(void (^)(WKNavigationActionPolicy))decisionHandler {
    if (navigationAction.shouldPerformDownload) {
        decisionHandler(WKNavigationActionPolicyDownload);
        return;
    }

    NSURL *url = navigationAction.request.URL;
    if (!url) {
        decisionHandler(WKNavigationActionPolicyAllow);
        return;
    }

    NSString *scheme = url.scheme.lowercaseString;
    BOOL localHost = [url.host isEqualToString:@"127.0.0.1"] || [url.host isEqualToString:@"localhost"];
    BOOL externalHTTP = [scheme isEqualToString:@"http"] && !localHost;
    BOOL knownScheme = [@[@"http", @"https", @"file", @"about", @"blob", @"data"] containsObject:scheme];

    if (externalHTTP || !knownScheme) {
        [[NSWorkspace sharedWorkspace] openURL:url];
        decisionHandler(WKNavigationActionPolicyCancel);
        return;
    }
    decisionHandler(WKNavigationActionPolicyAllow);
}

- (void)webView:(WKWebView *)webView
    decidePolicyForNavigationResponse:(WKNavigationResponse *)navigationResponse
                     decisionHandler:(void (^)(WKNavigationResponsePolicy))decisionHandler {
    decisionHandler(navigationResponse.canShowMIMEType ? WKNavigationResponsePolicyAllow
                                                       : WKNavigationResponsePolicyDownload);
}

- (void)webView:(WKWebView *)webView
    navigationAction:(WKNavigationAction *)navigationAction
     didBecomeDownload:(WKDownload *)download {
    download.delegate = self;
    [self.downloads addObject:download];
}

- (void)webView:(WKWebView *)webView
    navigationResponse:(WKNavigationResponse *)navigationResponse
       didBecomeDownload:(WKDownload *)download {
    download.delegate = self;
    [self.downloads addObject:download];
}

#pragma mark downloads

- (void)download:(WKDownload *)download
    decideDestinationUsingResponse:(NSURLResponse *)response
                 suggestedFilename:(NSString *)suggestedFilename
                 completionHandler:(void (^)(NSURL *_Nullable))completionHandler {
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.nameFieldStringValue = suggestedFilename ?: @"download";
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        completionHandler(result == NSModalResponseOK ? panel.URL : nil);
    }];
}

- (void)downloadDidFinish:(WKDownload *)download {
    [self.downloads removeObject:download];
}

- (void)download:(WKDownload *)download didFailWithError:(NSError *)error resumeData:(NSData *)resumeData {
    [self.downloads removeObject:download];
}

#pragma mark JavaScript panels

- (void)webView:(WKWebView *)webView
    runJavaScriptAlertPanelWithMessage:(NSString *)message
                      initiatedByFrame:(WKFrameInfo *)frame
                     completionHandler:(void (^)(void))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = message ?: @"";
    [alert addButtonWithTitle:@"OK"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        completionHandler();
    }];
}

- (void)webView:(WKWebView *)webView
    runJavaScriptConfirmPanelWithMessage:(NSString *)message
                        initiatedByFrame:(WKFrameInfo *)frame
                       completionHandler:(void (^)(BOOL))completionHandler {
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = message ?: @"";
    [alert addButtonWithTitle:@"OK"];
    [alert addButtonWithTitle:@"Cancel"];
    [alert beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse response) {
        completionHandler(response == NSAlertFirstButtonReturn);
    }];
}

- (void)webView:(WKWebView *)webView
    runOpenPanelWithParameters:(WKOpenPanelParameters *)parameters
              initiatedByFrame:(WKFrameInfo *)frame
             completionHandler:(void (^)(NSArray<NSURL *> *_Nullable))completionHandler {
    NSOpenPanel *panel = [NSOpenPanel openPanel];
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection;
    panel.canChooseDirectories = NO;
    if (@available(macOS 11.0, *)) {
        panel.allowedContentTypes = @[ UTTypeJSON ];
    }
    [panel beginSheetModalForWindow:self.window completionHandler:^(NSModalResponse result) {
        completionHandler(result == NSModalResponseOK ? panel.URLs : nil);
    }];
}

@end

#pragma mark - main

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        NSApplication *application = [NSApplication sharedApplication];
        AppDelegate *delegate = [[AppDelegate alloc] init];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyRegular];
        [application run];
    }
    return 0;
}
