#include <iostream>
#include <napi.h>

#import <Foundation/Foundation.h>
#import <Cocoa/Cocoa.h>

Napi::Boolean Trash(const Napi::CallbackInfo &info) {
	uint32_t pathCount = info[0].As<Napi::Number>().Uint32Value();

	NSFileManager *fm = [NSFileManager defaultManager];

	for (uint32_t i = 0; i < pathCount; i++) {
		std::string path = info[i + 1].ToString().Utf8Value();

		NSURL *trashed;
		NSError *error;

		NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path.c_str()]];

		if (![fm trashItemAtURL:url resultingItemURL:&trashed error:&error]) {
			return Napi::Boolean::New(info.Env(), false);
		}
	}

	return Napi::Boolean::New(info.Env(), true);
}
