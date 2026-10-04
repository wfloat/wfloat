#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
typedef BOOL (^WFNextCancelled)(void);
typedef void (^WFNextEmit)(NSDictionary *event);
// All asset operations and pin mutations are serialized by the caller.
@interface WfloatNextAssets : NSObject
+ (NSRecursiveLock *)sharedLock;
- (instancetype)initWithRootURL:(NSURL *)root;
- (id)perform:(NSDictionary *)command emit:(WFNextEmit)emit cancelled:(WFNextCancelled)cancelled;
- (void)pinPaths:(NSArray<NSString *> *)paths;
- (void)unpinPaths:(NSArray<NSString *> *)paths;
@end
FOUNDATION_EXPORT void WFNextFail(NSString *message);
FOUNDATION_EXPORT NSString *WFNextJSON(id value);
NS_ASSUME_NONNULL_END
