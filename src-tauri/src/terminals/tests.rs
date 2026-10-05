use super::*;
use std::time::{Duration, Instant};

#[test]
fn flow_ack_is_monotonic_bounded_and_rejects_future_sequences() {
    let mut flow = Flow {
        sequence: 3,
        outstanding: [(1, 10), (2, 20), (3, 30)].into(),
        bytes: 60,
    };
    flow.acknowledge(99);
    assert_eq!(flow.bytes, 60);
    flow.acknowledge(2);
    assert_eq!(flow.bytes, 30);
    flow.acknowledge(1);
    assert_eq!(flow.bytes, 30);
    flow.acknowledge(3);
    assert_eq!(flow.bytes, 0);
    assert!(flow.outstanding.is_empty());
}
#[test]
fn terminal_dimensions_are_bounded() {
    assert!(validate_size(80, 24).is_ok());
    assert!(validate_size(0, 24).is_err());
    assert!(validate_size(80, 501).is_err());
}
#[cfg(unix)]
#[test]
fn real_pty_input_resize_output_and_close() {
    let root = tempfile::tempdir().unwrap();
    let events = Arc::new(Mutex::new(Vec::new()));
    let output = events.clone();
    let manager = Terminals::default();
    let session = manager
        .start_command(
            "checkout".into(),
            root.path(),
            80,
            24,
            Arc::new(move |event| {
                output.lock().unwrap().push(event);
                true
            }),
            CommandBuilder::new("/bin/sh"),
        )
        .unwrap();
    let native = manager.session(&session.id).unwrap();
    native
        .master
        .lock()
        .unwrap()
        .as_ref()
        .unwrap()
        .resize(PtySize {
            cols: 91,
            rows: 31,
            pixel_width: 0,
            pixel_height: 0,
        })
        .unwrap();
    native
        .writer
        .lock()
        .unwrap()
        .as_mut()
        .unwrap()
        .write_all(b"printf 'REVIEWBOX_%s\\n' 'PTY_READY'; stty size\r")
        .unwrap();
    let until = Instant::now() + Duration::from_secs(8);
    loop {
        let bytes: Vec<u8> = events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|e| {
                if let TerminalEvent::Data { bytes, .. } = e {
                    Some(bytes.clone())
                } else {
                    None
                }
            })
            .flatten()
            .collect();
        let text = String::from_utf8_lossy(&bytes);
        if text.contains("REVIEWBOX_PTY_READY") && text.contains("31 91") {
            break;
        }
        assert!(
            Instant::now() < until,
            "PTY did not produce its output: {text}"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(manager.active_count(), 1);
    manager.stop_all();
    assert_eq!(manager.active_count(), 0);
    assert!(
        manager
            .start("checkout".into(), root.path(), 80, 24, Arc::new(|_| true))
            .is_err()
    );
}

#[cfg(unix)]
#[test]
fn output_waits_for_ack_without_unbounded_buffering_and_close_unblocks_it() {
    let root = tempfile::tempdir().unwrap();
    let bytes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let size = bytes.clone();
    let manager = Terminals::default();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", "yes terminal-output"]);
    let info = manager
        .start_command(
            "checkout".into(),
            root.path(),
            80,
            24,
            Arc::new(move |event| {
                if let TerminalEvent::Data { bytes, .. } = event {
                    size.fetch_add(bytes.len(), Ordering::SeqCst);
                }
                true
            }),
            command,
        )
        .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    while bytes.load(Ordering::SeqCst) < MAX_IN_FLIGHT {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    std::thread::sleep(Duration::from_millis(80));
    let stopped_at = bytes.load(Ordering::SeqCst);
    assert!(stopped_at <= MAX_IN_FLIGHT + 16384);
    let session = manager.session(&info.id).unwrap();
    let sequence = session.flow.lock().unwrap().sequence;
    session.flow.lock().unwrap().acknowledge(sequence);
    session.ready.notify_all();
    let until = Instant::now() + Duration::from_secs(5);
    while bytes.load(Ordering::SeqCst) <= stopped_at {
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    }
    manager.stop_all();
    let until = Instant::now() + Duration::from_secs(5);
    while !session.info.lock().unwrap().exited {
        assert!(
            Instant::now() < until,
            "Closing a backpressured terminal leaked its worker"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
}
#[cfg(unix)]
#[test]
fn closing_shell_stops_its_background_job() {
    let root = tempfile::tempdir().unwrap();
    let manager = Terminals::default();
    let mut command = CommandBuilder::new("/bin/sh");
    command.args(["-c", "sleep 60 & echo $! > child.pid; wait"]);
    let info = manager
        .start_command(
            "checkout".into(),
            root.path(),
            80,
            24,
            Arc::new(|_| true),
            command,
        )
        .unwrap();
    let until = Instant::now() + Duration::from_secs(5);
    let child = loop {
        if let Ok(text) = std::fs::read_to_string(root.path().join("child.pid"))
            && let Ok(pid) = text.trim().parse::<u32>()
        {
            break pid;
        }
        assert!(Instant::now() < until);
        std::thread::sleep(Duration::from_millis(10));
    };
    manager.session(&info.id).unwrap().stop();
    let output = std::process::Command::new("ps")
        .args(["-o", "stat=", "-p", &child.to_string()])
        .output()
        .unwrap();
    let state = String::from_utf8_lossy(&output.stdout);
    assert!(
        state.trim().is_empty() || state.trim().starts_with('Z'),
        "Background job survived: {state}"
    );
}
