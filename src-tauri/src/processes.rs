use std::{
    collections::BTreeMap,
    sync::{
        Arc, LazyLock, Mutex, Weak,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Default)]
struct Registry {
    stopping: bool,
    groups: BTreeMap<u32, Weak<AtomicBool>>,
}
static GROUPS: LazyLock<Mutex<Registry>> = LazyLock::new(Mutex::default);

/// A subprocess group belongs to one operation. Its descendants must not outlive it.
pub struct ProcessGroup {
    pid: u32,
    active: Arc<AtomicBool>,
}
impl ProcessGroup {
    pub fn new(pid: u32) -> Self {
        let group = Self {
            pid,
            active: Arc::new(AtomicBool::new(true)),
        };
        let mut registry = GROUPS.lock().unwrap_or_else(|e| e.into_inner());
        if registry.stopping {
            drop(registry);
            group.terminate();
        } else {
            registry.groups.insert(pid, Arc::downgrade(&group.active));
        }
        group
    }
    pub fn terminate(&self) {
        if !self.active.swap(false, Ordering::Relaxed) {
            return;
        }
        let mut registry = GROUPS.lock().unwrap_or_else(|e| e.into_inner());
        if registry.groups.get(&self.pid).is_some_and(|active| {
            active
                .upgrade()
                .is_some_and(|active| Arc::ptr_eq(&active, &self.active))
        }) {
            registry.groups.remove(&self.pid);
        }
        drop(registry);
        terminate(self.pid);
    }
}

/// Quit cannot rely on the async runtime polling cancellation or dropping futures.
/// Registering a process after this point terminates it immediately as well.
pub(crate) fn shutdown() {
    let mut registry = GROUPS.lock().unwrap_or_else(|e| e.into_inner());
    registry.stopping = true;
    let groups = std::mem::take(&mut registry.groups);
    drop(registry);
    for (pid, active) in groups {
        if active
            .upgrade()
            .is_some_and(|active| active.swap(false, Ordering::Relaxed))
        {
            terminate(pid);
        }
    }
}

fn terminate(pid: u32) {
    #[cfg(unix)]
    let mut command = {
        let mut command = std::process::Command::new("kill");
        command.args(["-KILL", "--", &format!("-{pid}")]);
        command
    };
    #[cfg(windows)]
    let mut command = {
        let mut command = std::process::Command::new("taskkill");
        command.args(["/PID", &pid.to_string(), "/T", "/F"]);
        command
    };
    let _ = command
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::{fs, os::unix::process::CommandExt, process::Command, time::Duration};

    #[test]
    fn shutdown_terminates_children_even_without_dropping_handles() {
        // Isolate the permanent shutdown latch from the rest of the test suite.
        if let Some(directory) = std::env::var_os("REVIEWBOX_SHUTDOWN_TEST") {
            let directory = std::path::PathBuf::from(directory);
            let mut child = Command::new("sh")
                .args(["-c", "sleep 60 & echo $! > \"$1\"; wait", "shutdown-test"])
                .arg(directory.join("descendant"))
                .process_group(0)
                .spawn()
                .unwrap();
            let group = ProcessGroup::new(child.id());
            fs::write(directory.join("leader"), child.id().to_string()).unwrap();
            for _ in 0..200 {
                if fs::read_to_string(directory.join("descendant"))
                    .is_ok_and(|value| value.trim().parse::<u32>().is_ok())
                {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            shutdown();
            shutdown();
            assert!(!child.wait().unwrap().success());
            let mut late = Command::new("sleep")
                .arg("60")
                .process_group(0)
                .spawn()
                .unwrap();
            let late_group = ProcessGroup::new(late.id());
            assert!(!late.wait().unwrap().success());
            std::mem::forget(group);
            std::mem::forget(late_group);
            std::process::exit(0);
        }
        let directory = tempfile::tempdir().unwrap();
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "processes::tests::shutdown_terminates_children_even_without_dropping_handles",
                "--nocapture",
            ])
            .env("REVIEWBOX_SHUTDOWN_TEST", directory.path())
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        for name in ["leader", "descendant"] {
            let pid = fs::read_to_string(directory.path().join(name)).unwrap();
            let output = Command::new("ps")
                .args(["-o", "stat=", "-p", pid.trim()])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            assert!(
                state.trim().is_empty() || state.trim().starts_with('Z'),
                "A subprocess still runs: {pid} {state}"
            );
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}
