use std::process::{Command, Stdio};

/// Capture descendants before stopping the shell: job control gives children
/// different process groups, so killing only -shell_pid leaks running jobs.
#[cfg(unix)]
fn descendants(pid: u32) -> Vec<u32> {
    let Ok(output) = Command::new("ps").args(["-axo", "pid=,ppid="]).output() else {
        return vec![];
    };
    let relations: Vec<(u32, u32)> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .collect();
    let mut result = vec![pid];
    let mut index = 0;
    while index < result.len() {
        for &(child, parent) in &relations {
            if parent == result[index] && !result.contains(&child) {
                result.push(child);
            }
        }
        index += 1;
    }
    result
}
pub(super) fn terminate(pid: Option<u32>, foreground: Option<u32>) {
    let Some(pid) = pid else {
        return;
    };
    #[cfg(unix)]
    {
        let children = descendants(pid);
        let mut targets: Vec<String> = children.iter().rev().map(ToString::to_string).collect();
        targets.push(format!("-{pid}"));
        if let Some(group) = foreground.filter(|group| *group != pid) {
            targets.push(format!("-{group}"));
        }
        // HUP is the normal terminal close signal; KILL bounds teardown of jobs
        // that ignore it. Deliberately daemonized/detached processes are outside ownership.
        for signal in ["-HUP", "-KILL"] {
            let _ = Command::new("kill")
                .arg(signal)
                .arg("--")
                .args(&targets)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            if signal == "-HUP" {
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = foreground;
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

pub(super) fn cwd(pid: Option<u32>) -> Option<std::path::PathBuf> {
    let pid = pid?;
    #[cfg(target_os = "macos")]
    {
        let result = Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
            .ok()?;
        String::from_utf8_lossy(&result.stdout)
            .lines()
            .find_map(|line| line.strip_prefix('n').map(std::path::PathBuf::from))
    }
    #[cfg(target_os = "linux")]
    {
        std::fs::read_link(format!("/proc/{pid}/cwd")).ok()
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        None
    }
}
