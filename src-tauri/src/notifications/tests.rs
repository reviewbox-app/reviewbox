use super::*;

fn target() -> ReviewNotificationTarget {
    ReviewNotificationTarget {
        operation_id: id(),
        repository_id: fingerprint(b"/checkout/one"),
        review_id: id(),
    }
}

#[test]
fn os_identifier_recovers_the_exact_checkout_review_and_operation() {
    let first = target();
    assert_eq!(parse_identifier(&identifier(&first)), Some(first.clone()));
    let second = ReviewNotificationTarget {
        repository_id: fingerprint(b"/checkout/two"),
        ..first.clone()
    };
    assert_ne!(identifier(&first), identifier(&second));
    assert!(parse_identifier("another-app:review").is_none());
    assert!(parse_identifier(&format!("{IDENTIFIER_PREFIX}{{}}")).is_none());
    let invalid = ReviewNotificationTarget {
        review_id: "../../outside".into(),
        ..first
    };
    assert!(parse_identifier(&identifier(&invalid)).is_none());
    assert!(parse_identifier(&"x".repeat(1025)).is_none());
}

#[test]
fn acknowledging_an_older_click_does_not_drop_the_new_destination() {
    let state = Notifications::default();
    let older = target();
    let newer = target();
    *state.pending.lock().unwrap() = Some(newer.clone());
    state.acknowledge(&older.operation_id);
    assert_eq!(*state.pending.lock().unwrap(), Some(newer.clone()));
    state.acknowledge(&newer.operation_id);
    assert!(state.pending.lock().unwrap().is_none());
}

#[test]
fn bundled_chime_is_short_pcm_audio() {
    let bytes = include_bytes!("../../../resources/sounds/review-ready.wav");
    assert_eq!(&bytes[..4], b"RIFF");
    assert_eq!(&bytes[8..12], b"WAVE");
    // WAV metadata chunks may precede or follow audio; do not assume a 44-byte header.
    let mut offset = 12;
    let mut format = None;
    let mut data = None;
    while offset + 8 <= bytes.len() {
        let size = u32::from_le_bytes(bytes[offset + 4..offset + 8].try_into().unwrap()) as usize;
        let end = offset + 8 + size;
        assert!(end <= bytes.len());
        let chunk = &bytes[offset + 8..end];
        match &bytes[offset..offset + 4] {
            b"fmt " => format = Some(chunk),
            b"data" => data = Some(chunk),
            _ => {}
        }
        offset = end + size % 2;
    }
    let format = format.expect("WAV format chunk");
    assert!(format.len() >= 16);
    assert_eq!(u16::from_le_bytes(format[..2].try_into().unwrap()), 1); // PCM
    let channels = u16::from_le_bytes(format[2..4].try_into().unwrap());
    let rate = u32::from_le_bytes(format[4..8].try_into().unwrap());
    let bits = u16::from_le_bytes(format[14..16].try_into().unwrap());
    assert_eq!((channels, rate, bits), (2, 44_100, 16));
    let data = data.expect("WAV audio chunk");
    assert_eq!(data.len() % 4, 0);
    let duration = data.len() as f64 / (f64::from(rate) * 4.0);
    assert!((0.6..0.7).contains(&duration), "duration: {duration}");
    assert!(data.iter().any(|byte| *byte != 0));
}
