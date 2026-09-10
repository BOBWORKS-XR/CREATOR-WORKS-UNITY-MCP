//! Bounded, local write-ahead outcomes. Never retain arguments, results or secrets.
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
};

const LIMIT: usize = 32;
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Record {
    session: String,
    id: u64,
    command: String,
    outcome: Outcome,
}
#[derive(Clone, Copy, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "kebab-case")]
enum Outcome {
    Accepted,
    ReturnedOk,
    ReturnedError,
    UnknownAcknowledged,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Data {
    revision: u32,
    records: Vec<Record>,
}
pub struct Journal {
    path: PathBuf,
    data: Data,
}

impl Journal {
    pub fn open(directory: &Path) -> Result<Self, String> {
        let path = directory.join("hosted-operation-outcomes.json");
        let data = match std::fs::File::open(&path) {
            Ok(file) => {
                let mut bytes = Vec::new();
                file.take(65537)
                    .read_to_end(&mut bytes)
                    .map_err(|_| "Cannot read hosted outcomes.")?;
                if bytes.len() > 65536 {
                    return Err(
                        "Hosted outcome record is too large; it was not overwritten.".into(),
                    );
                }
                let data: Data = serde_json::from_slice(&bytes)
                    .map_err(|_| "Invalid hosted outcome record; it was not overwritten.")?;
                if data.revision != 1
                    || data.records.len() > LIMIT
                    || data.records.iter().any(|record| {
                        record.session.len() != 64
                            || !record.session.bytes().all(|c| c.is_ascii_hexdigit())
                            || record.id == 0
                            || record.id > 9_007_199_254_740_991
                            || record.command.len() > 128
                            || record.command.is_empty()
                            || !record
                                .command
                                .bytes()
                                .all(|c| c.is_ascii_alphanumeric() || c == b'_')
                    })
                {
                    return Err("Unsupported hosted outcome record; it was not overwritten.".into());
                }
                data
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Data {
                revision: 1,
                records: Vec::new(),
            },
            Err(_) => return Err("Cannot read hosted outcomes; changes remain disabled.".into()),
        };
        Ok(Self { path, data })
    }
    fn persist(&self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&self.data).map_err(|_| "Cannot encode hosted outcomes.")?;
        let temporary = self
            .path
            .with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        let result = (|| -> std::io::Result<()> {
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            // ReplaceFileW needs the replacement handle closed, even after a flush.
            drop(file);
            crate::publish_temporary_file(&temporary, &self.path)
        })();
        if let Err(error) = result {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!(
                "Cannot persist hosted outcome ({error}). No next command will be started."
            ));
        }
        Ok(())
    }
    pub fn pending(&self) -> Vec<&str> {
        self.data
            .records
            .iter()
            .filter(|record| record.outcome == Outcome::Accepted)
            .map(|record| record.command.as_str())
            .collect()
    }
    pub fn acknowledge_unknowns(&mut self) -> Result<(), String> {
        for record in &mut self.data.records {
            if record.outcome == Outcome::Accepted {
                record.outcome = Outcome::UnknownAcknowledged;
            }
        }
        self.persist()
    }
    pub fn begin(&mut self, session: &str, id: u64, command: &str) -> Result<(), String> {
        if !self.pending().is_empty() {
            return Err(
                "An earlier operation has an unknown outcome; inspect it before continuing.".into(),
            );
        }
        if self.data.records.len() == LIMIT {
            self.data.records.remove(0);
        }
        self.data.records.push(Record {
            session: session.to_owned(),
            id,
            command: command.to_owned(),
            outcome: Outcome::Accepted,
        });
        self.persist()
    }
    pub fn complete(&mut self, session: &str, id: u64, ok: bool) -> Result<(), String> {
        let record = self
            .data
            .records
            .last_mut()
            .ok_or("Missing accepted hosted operation.")?;
        if record.session != session || record.id != id || record.outcome != Outcome::Accepted {
            return Err("Hosted operation identity does not match its outcome record.".into());
        }
        record.outcome = if ok {
            Outcome::ReturnedOk
        } else {
            Outcome::ReturnedError
        };
        self.persist()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn unknown_is_not_replayed_or_reported_successful_and_records_are_bounded() {
        let dir = std::env::temp_dir().join(format!("creator-outcomes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let session = "a".repeat(64);
        let mut journal = Journal::open(&dir).unwrap();
        assert!(!journal.path.exists());
        journal.begin(&session, 1, "save_config").unwrap();
        drop(journal);
        let mut journal = Journal::open(&dir).unwrap();
        assert_eq!(journal.pending(), ["save_config"]);
        assert!(journal.begin(&session, 2, "save_config").is_err());
        journal.acknowledge_unknowns().unwrap();
        for id in 2..90 {
            journal.begin(&session, id, "save_config").unwrap();
            assert!(journal.complete(&session, id + 1, true).is_err());
            journal.complete(&session, id, false).unwrap();
        }
        let journal = Journal::open(&dir).unwrap();
        assert_eq!(journal.data.records.len(), LIMIT);
        assert!(journal.pending().is_empty());
        assert!(journal
            .data
            .records
            .iter()
            .all(|record| record.outcome == Outcome::ReturnedError));
        std::fs::remove_file(&journal.path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
    #[test]
    fn invalid_outcomes_are_preserved() {
        let dir = std::env::temp_dir().join(format!("creator-outcomes-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("hosted-operation-outcomes.json");
        std::fs::write(&path, b"not-json").unwrap();
        assert!(Journal::open(&dir).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), b"not-json");
        std::fs::remove_file(path).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
