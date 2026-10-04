//! Cocoa termination (menu, Cmd+Q and Dock) bypasses Tauri's ExitRequested.
//! Install the missing delegate callback while retaining Tao's existing delegate.
//! Upstream tracking: https://github.com/tauri-apps/tauri/issues/12978
use objc2::{
    MainThreadMarker,
    runtime::{AnyObject, Imp, Sel},
    sel,
};
use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
use std::sync::OnceLock;

// Cocoa calls a C function without a Rust context argument. The application
// handle lives for the process; mutable editor state remains Tauri-owned.
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

extern "C-unwind" fn should_terminate(
    _: &AnyObject,
    _: Sel,
    _: &NSApplication,
) -> NSApplicationTerminateReply {
    if APP.get().is_some_and(super::commands::confirm_exit) {
        NSApplicationTerminateReply::TerminateCancel
    } else {
        NSApplicationTerminateReply::TerminateNow
    }
}

#[allow(unsafe_code)]
pub(crate) fn install(app: &tauri::AppHandle) -> std::io::Result<()> {
    let mtm = MainThreadMarker::new()
        .ok_or_else(|| std::io::Error::other("Install the quit guard on the main thread."))?;
    let delegate = NSApplication::sharedApplication(mtm)
        .delegate()
        .ok_or_else(|| std::io::Error::other("The native application delegate is unavailable."))?;
    let delegate: &AnyObject = (*delegate).as_ref();
    APP.set(app.clone())
        .map_err(|_| std::io::Error::other("The quit guard is already installed."))?;
    type Callback =
        extern "C-unwind" fn(&AnyObject, Sel, &NSApplication) -> NSApplicationTerminateReply;
    // SAFETY: Cocoa's applicationShouldTerminate: returns NSUInteger and receives
    // self, _cmd and NSApplication. Both supported macOS architectures are 64-bit
    // (Q@:@). Only add this missing public delegate method; never replace an
    // existing implementation or any of Tao's lifecycle callbacks. The callback
    // and AppHandle outlive every invocation. Remove once Tao provides this hook.
    let added = unsafe {
        objc2::ffi::class_addMethod(
            delegate.class() as *const _ as *mut _,
            sel!(applicationShouldTerminate:),
            std::mem::transmute::<Callback, Imp>(should_terminate),
            c"Q@:@".as_ptr(),
        )
    };
    if !added.as_bool() {
        return Err(std::io::Error::other(
            "Unable to install the native quit guard.",
        ));
    }
    Ok(())
}
