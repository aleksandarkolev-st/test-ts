use rusqlite::{params, Connection, OptionalExtension};
use std::{path::Path, sync::Mutex};
pub struct Database(Mutex<Connection>);
impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let c = Connection::open(path).map_err(|e| e.to_string())?;
        c.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS meetings(id TEXT PRIMARY KEY,started_at INTEGER,ended_at INTEGER); UPDATE meetings SET ended_at=started_at WHERE ended_at IS NULL;").map_err(|e|e.to_string())?;
        Ok(Self(Mutex::new(c)))
    }
    pub fn get(&self, key: &str) -> Result<Option<String>, String> {
        self.0
            .lock()
            .unwrap()
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())
    }
    pub fn set(&self, key: &str, value: &str) -> Result<(), String> {
        self.0.lock().unwrap().execute("INSERT INTO settings VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map(|_|()).map_err(|e|e.to_string())
    }
    pub fn start(&self, id: &str, now: u64) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "INSERT INTO meetings(id,started_at) VALUES(?1,?2)",
                params![id, now],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn stop(&self, id: &str, now: u64) -> Result<(), String> {
        self.0
            .lock()
            .unwrap()
            .execute(
                "UPDATE meetings SET ended_at=?1 WHERE id=?2",
                params![now, id],
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub fn host_id(&self) -> Result<String, String> {
        if let Some(id) = self.get("ext_agent_host_id")? {
            Ok(id)
        } else {
            let id = format!("urn:uuid:{}", uuid::Uuid::new_v4());
            self.set("ext_agent_host_id", &id)?;
            Ok(id)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn host_stable_and_schema_has_no_transcripts() {
        let d = Database::open(Path::new(":memory:")).unwrap();
        assert_eq!(d.host_id().unwrap(), d.host_id().unwrap());
        d.start("a", 1).unwrap();
        d.stop("a", 2).unwrap();
        let c = d.0.lock().unwrap();
        let names: Vec<String> = c
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(names, vec!["settings", "meetings"]);
    }
}
