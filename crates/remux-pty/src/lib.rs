#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use remux_core::TerminalSize;
use thiserror::Error;
use tokio::sync::broadcast;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PtyCommand {
    program: Option<String>,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    env: BTreeMap<String, String>,
}

impl PtyCommand {
    #[must_use]
    pub fn new(program: impl Into<String>) -> Self {
        Self {
            program: Some(program.into()),
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn default_shell() -> Self {
        Self {
            program: None,
            args: Vec::new(),
            cwd: None,
            env: BTreeMap::new(),
        }
    }

    #[must_use]
    pub fn arg(mut self, arg: impl Into<String>) -> Self {
        self.args.push(arg.into());
        self
    }

    #[must_use]
    pub fn args<I, S>(mut self, args: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        self.args.extend(args.into_iter().map(Into::into));
        self
    }

    #[must_use]
    pub fn cwd(mut self, cwd: impl Into<PathBuf>) -> Self {
        self.cwd = Some(cwd.into());
        self
    }

    #[must_use]
    pub fn env(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.env.insert(key.into(), value.into());
        self
    }

    fn into_builder(self) -> CommandBuilder {
        let mut builder = match self.program {
            Some(program) => {
                let mut builder = CommandBuilder::new(program);
                builder.args(self.args);
                builder
            }
            None => CommandBuilder::new_default_prog(),
        };

        if let Some(cwd) = self.cwd {
            builder.cwd(cwd);
        }

        for (key, value) in self.env {
            builder.env(key, value);
        }

        builder
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Output(Vec<u8>),
    Exited {
        exit_code: u32,
        signal: Option<String>,
    },
}

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("failed to open PTY: {0}")]
    Open(#[source] anyhow::Error),
    #[error("failed to spawn command: {0}")]
    Spawn(#[source] anyhow::Error),
    #[error("failed to clone PTY reader: {0}")]
    Reader(#[source] anyhow::Error),
    #[error("failed to acquire PTY writer: {0}")]
    Writer(#[source] anyhow::Error),
    #[error("failed to resize PTY: {0}")]
    Resize(#[source] anyhow::Error),
    #[error("failed to query PTY size: {0}")]
    Size(#[source] anyhow::Error),
    #[error("failed to write to PTY: {0}")]
    Write(#[source] std::io::Error),
    #[error("failed to kill PTY child: {0}")]
    Kill(#[source] std::io::Error),
}

pub struct PortablePtyProcess {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    size: Mutex<TerminalSize>,
    process_id: Option<u32>,
    events: broadcast::Sender<PtyEvent>,
}

impl PortablePtyProcess {
    pub fn spawn(command: PtyCommand, size: TerminalSize) -> Result<Arc<Self>, PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(to_portable_size(size))
            .map_err(PtyError::Open)?;
        let builder = command.into_builder();
        let child = pair.slave.spawn_command(builder).map_err(PtyError::Spawn)?;
        let process_id = child.process_id();
        let killer = child.clone_killer();
        let reader = pair.master.try_clone_reader().map_err(PtyError::Reader)?;
        let writer = pair.master.take_writer().map_err(PtyError::Writer)?;
        let (events, _) = broadcast::channel(256);

        spawn_reader_loop(reader, events.clone());
        spawn_wait_loop(child, events.clone());

        Ok(Arc::new(Self {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            size: Mutex::new(size),
            process_id,
            events,
        }))
    }

    #[must_use]
    pub fn process_id(&self) -> Option<u32> {
        self.process_id
    }

    #[must_use]
    pub fn subscribe(&self) -> broadcast::Receiver<PtyEvent> {
        self.events.subscribe()
    }

    pub fn write_all(&self, data: &[u8]) -> Result<(), PtyError> {
        let mut writer = self.writer.lock().expect("PTY writer lock poisoned");
        writer.write_all(data).map_err(PtyError::Write)?;
        writer.flush().map_err(PtyError::Write)
    }

    pub fn resize(&self, size: TerminalSize) -> Result<(), PtyError> {
        let master = self.master.lock().expect("PTY master lock poisoned");
        master
            .resize(to_portable_size(size))
            .map_err(PtyError::Resize)?;
        drop(master);
        *self.size.lock().expect("PTY size lock poisoned") = size;
        Ok(())
    }

    pub fn size(&self) -> Result<TerminalSize, PtyError> {
        let master = self.master.lock().expect("PTY master lock poisoned");
        let size = master.get_size().map_err(PtyError::Size)?;
        Ok(TerminalSize {
            cols: size.cols,
            rows: size.rows,
        })
    }

    pub fn kill(&self) -> Result<(), PtyError> {
        let mut killer = self.killer.lock().expect("PTY killer lock poisoned");
        killer.kill().map_err(PtyError::Kill)
    }
}

fn spawn_reader_loop(mut reader: Box<dyn Read + Send>, events: broadcast::Sender<PtyEvent>) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(size) => {
                    let chunk = buffer[..size].to_vec();
                    let _ = events.send(PtyEvent::Output(chunk));
                }
                Err(_) => break,
            }
        }
    });
}

fn spawn_wait_loop(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    events: broadcast::Sender<PtyEvent>,
) {
    thread::spawn(move || {
        if let Ok(status) = child.wait() {
            let _ = events.send(PtyEvent::Exited {
                exit_code: status.exit_code(),
                signal: status.signal().map(ToOwned::to_owned),
            });
        }
    });
}

fn to_portable_size(size: TerminalSize) -> PtySize {
    PtySize {
        rows: size.rows,
        cols: size.cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::{sleep, timeout};

    use super::*;

    #[tokio::test]
    async fn streams_output_from_spawned_command() {
        let process = PortablePtyProcess::spawn(test_output_command(), TerminalSize::new(80, 24))
            .expect("spawn output command");
        let mut receiver = process.subscribe();

        let output = timeout(Duration::from_secs(5), async {
            loop {
                match receiver.recv().await.expect("PTY event") {
                    PtyEvent::Output(chunk) => {
                        let text = String::from_utf8_lossy(&chunk);
                        if text.contains("remux-pty-ready") {
                            return text.to_string();
                        }
                    }
                    PtyEvent::Exited { .. } => {}
                }
            }
        })
        .await
        .expect("output timeout");

        assert!(output.contains("remux-pty-ready"));
    }

    #[tokio::test]
    async fn resizes_live_pty_and_reports_latest_size() {
        let process =
            PortablePtyProcess::spawn(test_long_running_command(), TerminalSize::new(80, 24))
                .expect("spawn long running command");

        assert_eq!(
            process.size().expect("initial size"),
            TerminalSize::new(80, 24)
        );

        process
            .resize(TerminalSize::new(120, 40))
            .expect("resize PTY");

        sleep(Duration::from_millis(100)).await;
        assert_eq!(
            process.size().expect("resized size"),
            TerminalSize::new(120, 40)
        );
        process.kill().expect("kill PTY process");
    }

    fn test_output_command() -> PtyCommand {
        #[cfg(windows)]
        {
            PtyCommand::new("cmd.exe").args(["/C", "echo remux-pty-ready"])
        }

        #[cfg(not(windows))]
        {
            PtyCommand::new("/bin/sh").args(["-lc", "printf 'remux-pty-ready\\n'"])
        }
    }

    fn test_long_running_command() -> PtyCommand {
        #[cfg(windows)]
        {
            PtyCommand::new("cmd.exe").args(["/C", "timeout /T 10 /NOBREAK >NUL"])
        }

        #[cfg(not(windows))]
        {
            PtyCommand::new("/bin/sh").args(["-lc", "sleep 10"])
        }
    }
}
