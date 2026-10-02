use crate::{contracts::*, snapshots::MAX_FILE};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};

/// One bounded Git stream per comparison, including object size in each reply.
pub(super) struct Objects {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
}
impl Objects {
    pub fn open(root: &Path) -> AppResult<Self> {
        let mut child = Command::new("git")
            .args(["cat-file", "--batch"])
            .current_dir(root)
            .env("GIT_NO_LAZY_FETCH", "1")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| AppError::new("git", "Missing Git input."))?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or_else(|| AppError::new("git", "Missing Git output."))?,
        );
        Ok(Self {
            child,
            input,
            output,
        })
    }
    pub fn read(&mut self, mode: &str, oid: &str) -> AppResult<Vec<u8>> {
        if mode == "000000" {
            return Ok(Vec::new());
        }
        if mode == "160000" {
            return Ok(oid.as_bytes().to_vec());
        }
        writeln!(self.input, "{oid}")?;
        self.input.flush()?;
        let mut header = String::new();
        self.output.read_line(&mut header)?;
        let size = header
            .split_whitespace()
            .nth(2)
            .and_then(|v| v.parse::<usize>().ok())
            .ok_or_else(|| AppError::new("git", "Git object is unavailable."))?;
        if size as u64 > MAX_FILE {
            return Err(AppError::new(
                "large_file",
                "A changed file exceeds the 64 MiB capture limit.",
            ));
        }
        let mut bytes = vec![0; size];
        self.output.read_exact(&mut bytes)?;
        let mut newline = [0];
        self.output.read_exact(&mut newline)?;
        Ok(bytes)
    }
}
impl Drop for Objects {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
