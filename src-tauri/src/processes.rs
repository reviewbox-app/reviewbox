/// A subprocess group belongs to one operation. Its descendants must not outlive it.
pub struct ProcessGroup {
    pid: u32,
    active: std::sync::atomic::AtomicBool,
}
impl ProcessGroup {
    pub fn new(pid: u32) -> Self {
        Self {
            pid,
            active: std::sync::atomic::AtomicBool::new(true),
        }
    }
    pub fn terminate(&self) {
        if !self
            .active
            .swap(false, std::sync::atomic::Ordering::Relaxed)
        {
            return;
        }
        #[cfg(unix)]
        {
            let _ = std::process::Command::new("kill")
                .args(["-KILL", "--", &format!("-{}", self.pid)])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
        #[cfg(windows)]
        {
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &self.pid.to_string(), "/T", "/F"])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status();
        }
    }
}
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        self.terminate();
    }
}
