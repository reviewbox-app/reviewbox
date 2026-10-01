use objc2::{MainThreadMarker, msg_send, runtime::NSObjectProtocol, sel};
use objc2_app_kit::{NSApplication, NSImage, NSMenuItem};
use objc2_foundation::ns_string;

/// Tauri supplies the images, but macOS 27 hides them with automatic visibility.
/// Restrict the override to our Review menu; leave system menus untouched.
pub(super) fn show_review_icons() {
    let mtm = MainThreadMarker::new().expect("review menus are updated on the main thread");
    let Some(menu) = NSApplication::sharedApplication(mtm)
        .mainMenu()
        .and_then(|menu| menu.itemWithTitle(ns_string!("Review")))
        .and_then(|item| item.submenu())
    else {
        return;
    };
    for item in menu.itemArray() {
        // Tauri's check item has no image API. An image can coexist with its
        // native checkmark, which remains bound to the durable local-only state.
        if item
            .title()
            .isEqualToString(ns_string!("Keep this review local"))
        {
            let image = NSImage::imageWithSystemSymbolName_accessibilityDescription(
                ns_string!("internaldrive"),
                None,
            );
            item.setImage(image.as_deref());
        }
        if item.image().is_some() {
            prefer_visible_image(&item);
        }
    }
}

#[allow(unsafe_code)]
fn prefer_visible_image(item: &NSMenuItem) {
    if item.respondsToSelector(sel!(setPreferredImageVisibility:)) {
        // SAFETY: this is Apple's public macOS 27 NSMenuItem setter, checked for
        // availability above. NSInteger is isize; Visible is 1. The typed item
        // is alive and NSMenuItem enforces main-thread access. Remove this bridge
        // once objc2-app-kit exposes preferredImageVisibility.
        unsafe {
            let _: () = msg_send![item, setPreferredImageVisibility: 1_isize];
        }
    }
}
