use super::*;

fn input(message: &str) -> DiagnosticInput {
    DiagnosticInput {
        source: "rev".into(),
        operation: "review_preparation".into(),
        code: "provider_error".into(),
        message: message.into(),
        details: Some("HTTP 401; Authorization: Bearer private-credential".into()),
        stack: None,
        context: [
            ("reviewId".into(), "review-1".into()),
            ("prompt".into(), "private source code".into()),
        ]
        .into(),
    }
}

#[test]
fn persistence_deduplication_and_redaction_survive_restart() {
    let dir = tempfile::tempdir().unwrap();
    let log = Diagnostics::new(dir.path().join("logs"));
    let first = log.record(input("Could not complete")).unwrap();
    assert_eq!(
        log.record(input("Could not complete")).unwrap().id,
        first.id
    );
    let text = fs::read_to_string(log.directory.join(FILES[0])).unwrap();
    assert_eq!(text.lines().count(), 1);
    assert!(!text.contains("private-credential"));
    assert!(!text.contains("private source code"));
    let restarted = Diagnostics::new(log.directory.clone());
    let read = restarted.read().unwrap();
    assert_eq!(read.entries.len(), 1);
    assert_eq!(read.entries[0].id, first.id);
    assert_eq!(read.entries[0].error.context["reviewId"], "review-1");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&log.directory).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(log.directory.join(FILES[0]))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

#[test]
fn rotation_is_bounded_and_reads_newest_first_skipping_partial_records() {
    let dir = tempfile::tempdir().unwrap();
    let mut log = Diagnostics::new(dir.path().join("logs"));
    log.max_file_bytes = 1024;
    for index in 0..30 {
        log.record(input(&format!("Error {index}"))).unwrap();
    }
    assert_eq!(fs::read_dir(&log.directory).unwrap().count(), 3);
    for name in FILES {
        assert!(fs::metadata(log.directory.join(name)).unwrap().len() <= 1024);
    }
    fs::OpenOptions::new()
        .append(true)
        .open(log.directory.join(FILES[0]))
        .unwrap()
        .write_all(b"{incomplete\n")
        .unwrap();
    let records = log.read().unwrap().entries;
    assert_eq!(records[0].error.message, "Error 29");
    assert!(records.len() < 30);
    assert!(
        records
            .windows(2)
            .all(|w| w[0].error.message[6..].parse::<usize>().unwrap()
                > w[1].error.message[6..].parse::<usize>().unwrap())
    );
}

#[test]
fn redaction_covers_credentials_truncation_and_multiline_keys() {
    for secret in [
        "Authorization: Bearer secret-value",
        "api_key='secret-value with spaces'",
        "{\"token\":\"secret-value with spaces\"}",
        "password=secret-value",
        "https://user:secret-value@example.test",
        "-----BEGIN PRIVATE KEY-----\nsecret-value\n-----END PRIVATE KEY-----",
        "client_secret=\"secret-value with spaces",
    ] {
        assert!(!redact(secret, 2048).contains("secret-value"), "{secret}");
    }
    let text = "é".repeat(100_000);
    assert!(redact(&text, 200).ends_with("[truncated]"));
    assert!(redact(&text, 200).chars().count() < 220);
}

#[test]
fn absent_logs_and_io_failures_are_explicit_without_panics() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("logs");
    let log = Diagnostics::new(path.clone());
    assert!(log.read().unwrap().entries.is_empty());
    fs::write(path, "not a directory").unwrap();
    assert!(log.record(input("failure")).is_err());
}

#[test]
fn incomplete_utf8_append_does_not_hide_previous_or_subsequent_errors() {
    let dir = tempfile::tempdir().unwrap();
    let log = Diagnostics::new(dir.path().join("logs"));
    log.record(input("First")).unwrap();
    fs::OpenOptions::new()
        .append(true)
        .open(log.directory.join(FILES[0]))
        .unwrap()
        .write_all(b"{\"message\":\"\xc3")
        .unwrap();
    assert_eq!(log.read().unwrap().entries.len(), 1);
    log.record(input("Next")).unwrap();
    let entries = log.read().unwrap().entries;
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].error.message, "Next");
    assert_eq!(entries[1].error.message, "First");
}

#[test]
#[cfg(unix)]
fn logs_never_follow_a_symlink_out_of_private_storage() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let external = dir.path().join("other-file");
    fs::write(&external, "must remain intact").unwrap();
    let log = Diagnostics::new(dir.path().join("logs"));
    log.ensure_directory().unwrap();
    symlink(&external, log.directory.join(FILES[0])).unwrap();
    assert!(log.record(input("failure")).is_err());
    assert!(log.read().is_err());
    assert_eq!(fs::read_to_string(external).unwrap(), "must remain intact");
}
