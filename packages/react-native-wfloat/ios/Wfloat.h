#import <Foundation/Foundation.h>

#ifdef RCT_NEW_ARCH_ENABLED

#import "generated/RNWfloatSpec/RNWfloatSpec.h"
@interface Wfloat : NativeWfloatSpecBase <NativeWfloatSpec>

#else

#import <React/RCTBridgeModule.h>
@interface Wfloat : NSObject <RCTBridgeModule>

#endif

@end
