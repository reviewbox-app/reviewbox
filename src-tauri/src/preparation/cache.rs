//! Disposable private translations. Never stores capture-specific document references.
use super::*;
use rusqlite::{Connection, OptionalExtension, params};
use std::time::Duration;
const LIMIT: u64 = 256 * 1024 * 1024;
#[derive(Clone)]
pub(super) struct TranslationCache(PathBuf);
impl TranslationCache {
    pub(super) fn new(storage: &Storage) -> AppResult<Self> {
        let cache = Self(storage.root().join("translation-cache-logic-v2.sqlite3"));
        cache.connection()?.execute_batch("CREATE TABLE IF NOT EXISTS translations (key TEXT PRIMARY KEY, body BLOB NOT NULL, used INTEGER NOT NULL)")?;
        Ok(cache)
    }
    fn connection(&self) -> AppResult<Connection> {
        let db = Connection::open(&self.0)?;
        db.busy_timeout(Duration::from_secs(5))?;
        Ok(db)
    }
    pub(super) fn get(&self, key: &str) -> AppResult<Option<Value>> {
        let db = self.connection()?;
        let bytes: Option<Vec<u8>> = db
            .query_row("SELECT body FROM translations WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()?;
        let Some(bytes) = bytes else { return Ok(None) };
        match serde_json::from_slice(&bytes) {
            Ok(value) => {
                db.execute(
                    "UPDATE translations SET used=?2 WHERE key=?1",
                    params![key, now()],
                )?;
                Ok(Some(value))
            }
            Err(_) => {
                db.execute("DELETE FROM translations WHERE key=?1", [key])?;
                Ok(None)
            }
        }
    }
    pub(super) fn put(&self, key: &str, value: &Value) -> AppResult<()> {
        self.put_with_limit(key, value, LIMIT)
    }
    fn put_with_limit(&self, key: &str, value: &Value, limit: u64) -> AppResult<()> {
        let body = serde_json::to_vec(value)?;
        if body.len() as u64 > limit {
            return Ok(());
        }
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        tx.execute("INSERT INTO translations(key,body,used) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET body=excluded.body,used=excluded.used", params![key,body,now()])?;
        // Keep the newest entries whose cumulative encoded size fits the limit.
        tx.execute("DELETE FROM translations WHERE key IN (SELECT key FROM (SELECT key,SUM(length(body)) OVER (ORDER BY used DESC,rowid DESC) AS bytes FROM translations) WHERE bytes>?1)", [limit as i64])?;
        tx.commit()?;
        Ok(())
    }
}
pub(super) fn relative(segment: &Segment) -> Segment {
    Segment {
        start_line: 1,
        end_line: segment.end_line - segment.start_line + 1,
        text: segment.text.clone(),
    }
}
pub(super) fn rebase(value: &Value, offset: u32, subtract: bool) -> AppResult<Value> {
    let mut result: TranslationResult = serde_json::from_value(value.clone())?;
    for block in &mut result.blocks {
        let shift = |line: u32| {
            if subtract {
                line.checked_sub(offset)
            } else {
                line.checked_add(offset)
            }
        };
        block.start_line = shift(block.start_line)
            .ok_or_else(|| invalid("Invalid cached translation coordinates."))?;
        block.end_line = shift(block.end_line)
            .ok_or_else(|| invalid("Invalid cached translation coordinates."))?;
    }
    Ok(serde_json::to_value(result)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cache_rebases_and_bounds_eviction() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Storage::open(dir.path().into()).unwrap();
        let cache = TranslationCache::new(&storage).unwrap();
        let value = json!({"blocks":[{"startLine":1,"endLine":2,"text":"Remember values"}]});
        let moved = rebase(&value, 200, false).unwrap();
        assert_eq!(moved["blocks"][0]["startLine"], 201);
        assert_eq!(rebase(&moved, 200, true).unwrap(), value);
        cache.put_with_limit("a", &value, 110).unwrap();
        cache.put_with_limit("b", &value, 110).unwrap();
        assert!(cache.get("a").unwrap().is_none());
        assert_eq!(cache.get("b").unwrap(), Some(value));
    }
}
