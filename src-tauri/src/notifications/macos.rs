//! Typed UserNotifications bridge; no shell process or browser audio is involved.
// Objective-C delegate declarations and block callbacks require narrow unsafe
// boundaries. Their ABI, ownership and threading contracts are documented below.
#![allow(unsafe_code)]

use block2::{DynBlock, RcBlock};
use objc2::{
    AnyThread, DefinedClass, define_class, msg_send,
    rc::Retained,
    runtime::{Bool, ProtocolObject},
};
use objc2_foundation::{NSBundle, NSError, NSObject, NSObjectProtocol, NSString, ns_string};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification,
    UNNotificationDefaultActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

pub(super) struct DelegateIvars {
    app: tauri::AppHandle,
}

define_class!(
    // SAFETY: NSObject permits subclassing; the only ivar is a thread-safe
    // AppHandle. UserNotifications can invoke its delegate on a background queue.
    #[unsafe(super = NSObject)]
    #[ivars = DelegateIvars]
    pub(super) struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            // Present once even with ReviewBox in front; Focus and system sound
            // preferences remain authoritative. Never use critical alerts.
            completion.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::List
                | UNNotificationPresentationOptions::Sound,));
        }

        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &DynBlock<dyn Fn()>,
        ) {
            // SAFETY: Apple's process-lifetime NSString constant is immutable.
            if response
                .actionIdentifier()
                .isEqualToString(unsafe { UNNotificationDefaultActionIdentifier })
                && let Some(target) = super::parse_identifier(
                    &response.notification().request().identifier().to_string(),
                )
            {
                let app = self.ivars().app.clone();
                let main_app = app.clone();
                let _ = app.run_on_main_thread(move || super::activate(&main_app, target));
            }
            // The OS owns this block; call it exactly once before returning.
            completion.call(());
        }
    }
);

// SAFETY: the delegate has no UI-thread-bound state. Its only Rust field is
// AppHandle (Send + Sync), all mutable routing state is protected by a mutex,
// and all window operations are dispatched to the main thread. NSObject's
// reference-count operations are thread-safe.
unsafe impl Send for Delegate {}
unsafe impl Sync for Delegate {}

pub(super) type DelegateOwner = Retained<Delegate>;

pub(super) fn install(app: tauri::AppHandle) -> DelegateOwner {
    let allocated = Delegate::alloc().set_ivars(DelegateIvars { app });
    // SAFETY: NSObject's designated initializer, with initialized Rust ivars.
    let delegate: Retained<Delegate> = unsafe { msg_send![super(allocated), init] };
    UNUserNotificationCenter::currentNotificationCenter()
        .setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    // The center's delegate is weak; Tauri state retains it until shutdown.
    delegate
}

pub(super) fn uninstall() {
    UNUserNotificationCenter::currentNotificationCenter().setDelegate(None);
}

pub(super) fn is_bundled(identifier: &str) -> bool {
    NSBundle::mainBundle()
        .bundleIdentifier()
        .is_some_and(|id| id.to_string() == identifier)
}

fn log_error(error: *mut NSError) {
    // SAFETY: the system supplies an optional NSError valid for the duration of
    // the completion block. Only its description is copied before returning.
    if let Some(error) = unsafe { error.as_ref() } {
        eprintln!("ReviewBox notification: {}", error.localizedDescription());
    }
}

pub(super) fn request_permission() {
    let completion = RcBlock::new(|_: Bool, error: *mut NSError| log_error(error));
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &completion,
        );
}

pub(super) fn show(
    target: &crate::contracts::ReviewNotificationTarget,
    repository: &str,
    review: &str,
) {
    let identifier = super::identifier(target);
    let subtitle = format!("{repository} · {review}");
    let thread = format!("reviewbox:reviews:{}", target.repository_id);
    // Also await authorization here: very short reviews can finish while the
    // first permission prompt is still open. A denial never affects the review.
    let completion = RcBlock::new(move |granted: Bool, error: *mut NSError| {
        log_error(error);
        if !granted.as_bool() {
            return;
        }
        let content = UNMutableNotificationContent::new();
        content.setTitle(ns_string!("Rev has finished preparing your review"));
        content.setSubtitle(&NSString::from_str(&subtitle));
        content.setBody(ns_string!("Your review is ready. Click to read it."));
        content.setThreadIdentifier(&NSString::from_str(&thread));
        // Avoid Apple's louder default fallback if a development bundle lacks
        // the bundled, low-amplitude PCM chime.
        if NSBundle::mainBundle()
            .pathForResource_ofType(Some(ns_string!("review-ready")), Some(ns_string!("wav")))
            .is_some()
        {
            content.setSound(Some(&UNNotificationSound::soundNamed(ns_string!(
                "review-ready.wav"
            ))));
        }
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
            &NSString::from_str(&identifier),
            &content,
            None,
        );
        let submitted = RcBlock::new(|error: *mut NSError| log_error(error));
        UNUserNotificationCenter::currentNotificationCenter()
            .addNotificationRequest_withCompletionHandler(&request, Some(&submitted));
    });
    UNUserNotificationCenter::currentNotificationCenter()
        .requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound,
            &completion,
        );
}
