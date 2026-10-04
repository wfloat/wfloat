#import "WfloatNextAssets.h"
NS_ASSUME_NONNULL_BEGIN
@interface WfloatNextAudio : NSObject
- (id)perform:(NSDictionary *)command emit:(WFNextEmit)emit cancelled:(WFNextCancelled)cancelled;
- (void)invalidate;
@end
NS_ASSUME_NONNULL_END
