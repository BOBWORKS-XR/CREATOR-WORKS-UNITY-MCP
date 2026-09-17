//! Bounded, cancellable package transfers. Payloads never enter a whole-file Vec.
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub const MAX_PACKAGE: u64 = 256 * 1024 * 1024;

#[derive(Default)]
pub struct Transfers(Mutex<Option<Arc<Operation>>>);

pub struct Operation {
    id: String,
    cancel: AtomicBool,
    received: AtomicU64,
    total: u64,
    phase: Mutex<String>,
}

#[derive(Serialize)]
pub struct Progress {
    id: String,
    received: u64,
    total: u64,
    phase: String,
    cancellable: bool,
}

pub struct Transfer<'a> {
    owner: &'a Transfers,
    pub operation: Arc<Operation>,
}
impl Transfers {
    pub fn begin(&self, id: Option<String>, total: u64) -> Result<Transfer<'_>, String> {
        let id = id.unwrap_or_else(|| "untracked".into());
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || total == 0
            || total > MAX_PACKAGE
        {
            return Err("Invalid community transfer.".into());
        }
        let mut active = self.0.lock().map_err(|_| "Community transfer is busy.")?;
        if active.is_some() {
            return Err("A community transfer is already running.".into());
        }
        let operation = Arc::new(Operation {
            id,
            cancel: AtomicBool::new(false),
            received: AtomicU64::new(0),
            total,
            phase: Mutex::new("downloading".into()),
        });
        *active = Some(operation.clone());
        Ok(Transfer {
            owner: self,
            operation,
        })
    }
    pub fn status(&self) -> Result<Option<Progress>, String> {
        let active = self.0.lock().map_err(|_| "Community transfer is busy.")?;
        Ok(active.as_ref().map(|op| {
            let phase = op.phase.lock().unwrap_or_else(|e| e.into_inner()).clone();
            Progress {
                id: op.id.clone(),
                received: op.received.load(Ordering::SeqCst),
                total: op.total,
                cancellable: matches!(phase.as_str(), "downloading" | "checking"),
                phase,
            }
        }))
    }
    pub fn cancel(&self, id: &str) -> Result<(), String> {
        let active = self.0.lock().map_err(|_| "Community transfer is busy.")?;
        if let Some(op) = active.as_ref().filter(|op| op.id == id) {
            let phase = op.phase.lock().map_err(|_| "Community transfer is busy.")?;
            if matches!(phase.as_str(), "downloading" | "checking") {
                op.cancel.store(true, Ordering::SeqCst);
            }
        }
        Ok(())
    }
}
impl Drop for Transfer<'_> {
    fn drop(&mut self) {
        *self.owner.0.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}
impl Operation {
    pub fn check(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::SeqCst) {
            Err("Download cancelled. No import was queued.".into())
        } else {
            Ok(())
        }
    }
    pub fn phase(&self, phase: &str) -> Result<(), String> {
        let mut current = self
            .phase
            .lock()
            .map_err(|_| "Community transfer is busy.")?;
        self.check()?;
        *current = phase.into();
        Ok(())
    }
    pub fn cancelled(&self) -> &AtomicBool {
        &self.cancel
    }
}

async fn cancellable<T>(
    future: impl std::future::Future<Output = T>,
    op: &Operation,
) -> Result<T, String> {
    tokio::pin!(future);
    loop {
        op.check()?;
        tokio::select! {
            result = &mut future => return Ok(result),
            _ = tokio::time::sleep(Duration::from_millis(50)) => {}
        }
    }
}

pub fn download(
    url: &str,
    length: u64,
    expected: &str,
    target: &mut File,
    op: &Operation,
) -> Result<(), String> {
    if length == 0 || length > MAX_PACKAGE || op.total != length {
        return Err("Invalid package size.".into());
    }
    tauri::async_runtime::block_on(async {
        let client = reqwest::Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .timeout(Duration::from_secs(30 * 60))
            .redirect(super::redirect_policy())
            .build()
            .map_err(|_| "Cannot initialize package download.")?;
        let response = cancellable(client.get(url).send(), op)
            .await?
            .and_then(|r| r.error_for_status())
            .map_err(|_| "Package unavailable. Check your connection and retry.")?;
        receive(response, length, expected, target, op).await
    })
}

async fn receive(
    mut response: reqwest::Response,
    length: u64,
    expected: &str,
    target: &mut File,
    op: &Operation,
) -> Result<(), String> {
    if response.content_length().is_some_and(|size| size != length) {
        return Err("Package size differs from its listing.".into());
    }
    let mut received = 0u64;
    let mut sha = Sha256::new();
    while let Some(chunk) = cancellable(response.chunk(), op)
        .await?
        .map_err(|_| "Package download interrupted. Retry when connected.")?
    {
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or("Package exceeds its size limit.")?;
        if received > length {
            return Err("Package exceeds its size limit.".into());
        }
        target
            .write_all(&chunk)
            .map_err(|_| "Could not save package. Check free disk space.")?;
        sha.update(&chunk);
        op.received.store(received, Ordering::SeqCst);
    }
    op.check()?;
    if received != length || format!("{:x}", sha.finalize()) != expected {
        return Err("Package size or checksum does not match its listing.".into());
    }
    target
        .sync_all()
        .map_err(|_| "Could not finish saving package.")?;
    target
        .rewind()
        .map_err(|_| "Could not read the downloaded package.")?;
    Ok(())
}

pub fn verify(reader: &mut (impl Read + Seek), length: u64, expected: &str) -> Result<(), String> {
    if length == 0 || length > MAX_PACKAGE {
        return Err("Package exceeds its size limit.".into());
    }
    reader.rewind().map_err(|_| "Cannot read package.")?;
    let mut sha = Sha256::new();
    let mut count = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let size = reader
            .read(&mut buffer)
            .map_err(|_| "Cannot read package.")?;
        if size == 0 {
            break;
        }
        count += size as u64;
        if count > length {
            return Err("Package size differs from its listing.".into());
        }
        sha.update(&buffer[..size]);
    }
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|_| "Cannot rewind package.")?;
    if count != length || format!("{:x}", sha.finalize()) != expected {
        return Err("Package size or checksum does not match its listing.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn network_stream_checks_headers_chunked_overrun_truncation_and_checksum() {
        let hash = format!("{:x}", Sha256::digest(b"abc"));
        for (headers, body, valid) in [
            ("Content-Length: 3", "abc", true),
            ("Content-Length: 4", "abcd", false),
            ("Content-Length: 3", "ab", false),
            ("Content-Length: 3", "abd", false),
            ("Transfer-Encoding: chunked", "3\r\nabc\r\n0\r\n\r\n", true),
            (
                "Transfer-Encoding: chunked",
                "4\r\nabcd\r\n0\r\n\r\n",
                false,
            ),
        ] {
            let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/", server.local_addr().unwrap());
            let response =
                format!("HTTP/1.1 200 OK\r\n{headers}\r\nConnection: close\r\n\r\n{body}");
            let thread = std::thread::spawn(move || {
                let (mut socket, _) = server.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut request = [0; 4096];
                let _ = socket.read(&mut request);
                let _ = socket.write_all(response.as_bytes());
            });
            let owner = Transfers::default();
            let active = owner.begin(None, 3).unwrap();
            let folder = tempfile::tempdir().unwrap();
            let mut file = tempfile::NamedTempFile::new_in(folder.path()).unwrap();
            let result = tauri::async_runtime::block_on(async {
                let response = reqwest::Client::new().get(&url).send().await.unwrap();
                receive(response, 3, &hash, file.as_file_mut(), &active.operation).await
            });
            assert_eq!(result.is_ok(), valid, "{headers} / {body}: {result:?}");
            assert!(file.as_file().metadata().unwrap().len() <= 3);
            drop(file);
            assert_eq!(std::fs::read_dir(folder.path()).unwrap().count(), 0);
            thread.join().unwrap();
        }
    }
    #[test]
    fn cancellation_interrupts_a_stalled_read() {
        let owner = Transfers::default();
        let active = owner.begin(None, 3).unwrap();
        let op = active.operation.clone();
        let thread = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(80));
            op.cancel.store(true, Ordering::SeqCst);
        });
        let started = std::time::Instant::now();
        let result = tauri::async_runtime::block_on(cancellable(
            std::future::pending::<()>(),
            &active.operation,
        ));
        assert!(result.unwrap_err().contains("cancelled"));
        assert!(started.elapsed() < Duration::from_secs(2));
        thread.join().unwrap();
    }
    #[test]
    fn cancellation_is_scoped_and_drop_allows_retry() {
        let state = Transfers::default();
        let transfer = state.begin(Some("first".into()), 3).unwrap();
        assert!(state.begin(None, 3).is_err());
        state.cancel("different").unwrap();
        transfer.operation.check().unwrap();
        state.cancel("first").unwrap();
        assert!(transfer.operation.check().is_err());
        drop(transfer);
        let next = state.begin(Some("next".into()), 3).unwrap();
        state.cancel("first").unwrap();
        next.operation.check().unwrap();
        next.operation.phase("review").unwrap();
        state.cancel("next").unwrap();
        next.operation.check().unwrap();
        assert!(!state.status().unwrap().unwrap().cancellable);
    }
    #[test]
    fn stream_verification_rejects_corruption_and_wrong_lengths() {
        let hash = format!("{:x}", Sha256::digest(b"abc"));
        for (data, valid) in [
            (b"abc".as_slice(), true),
            (b"ab", false),
            (b"abd", false),
            (b"abcd", false),
        ] {
            assert_eq!(
                verify(&mut std::io::Cursor::new(data), 3, &hash).is_ok(),
                valid
            );
        }
    }
}
